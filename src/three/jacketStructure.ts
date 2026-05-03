/**
 * Jacket / Garment Structure Detection
 *
 * Given vertex data and semantic regions (torso / left_sleeve / right_sleeve),
 * this module extracts a StructureGraph — a set of semantically meaningful
 * anchor points (collar, shoulders, cuffs, hem, armpits) plus their topological
 * connections.
 *
 * This is the pure-geometry counterpart to the AI segmentation layer. The AI
 * answers "what part is this?", and this module answers "where is this part's
 * structural endpoint?".
 *
 * Algorithm overview:
 *   1. Torso PCA → vertical axis + shoulder direction
 *   2. Each sleeve PCA → sleeve axis
 *   3. collar_center = top of torso via vertical axis
 *   4. hem_center    = bottom of torso via vertical axis
 *   5. left/right shoulder = closest point between sleeve root and torso surface
 *   6. left/right cuff     = far end of sleeve (away from shoulder)
 *   7. left/right armpit   = lowest point in the sleeve-torso junction zone
 */

import type {
  Vec3,
  StructureGraph,
  StructureAnchor,
  StructureEdge,
  GarmentRegionLabel,
  JacketStructureOptions,
} from './types';

// ── helpers ────────────────────────────────────────────────────────────────

const EPS = 1e-12;

function centroidOfIndices(vertices: Vec3[], indices: Set<number>): Vec3 {
  let cx = 0, cy = 0, cz = 0;
  let n = 0;
  for (const i of indices) {
    const [x, y, z] = vertices[i];
    cx += x; cy += y; cz += z;
    n++;
  }
  if (n === 0) return [0, 0, 0];
  return [cx / n, cy / n, cz / n];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normLen3(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function norm3(v: Vec3): Vec3 {
  const len = normLen3(v);
  return len < EPS ? [0, 0, 0] : scale3(v, 1 / len);
}

function dist3(a: Vec3, b: Vec3): number {
  return normLen3(sub3(a, b));
}

// ── PCA ────────────────────────────────────────────────────────────────────

interface PCAFrame {
  centroid: Vec3;
  axis: Vec3;       // primary (longest) axis, unit
  secondary: Vec3;  // second axis, unit
  extentMin: number; // projection min along primary
  extentMax: number; // projection max along primary
}

/**
 * Compute PCA on a set of vertices. Returns the primary axis (largest
 * eigenvalue), the secondary axis, and the projection extent along primary.
 */
function computeRegionPCA(vertices: Vec3[], indices: Set<number>): PCAFrame | null {
  const n = indices.size;
  if (n < 3) return null;

  const centroid = centroidOfIndices(vertices, indices);

  // Build covariance matrix (3x3)
  let c00 = 0, c01 = 0, c02 = 0;
  let c11 = 0, c12 = 0;
  let c22 = 0;
  for (const i of indices) {
    const p = vertices[i];
    const dx = p[0] - centroid[0];
    const dy = p[1] - centroid[1];
    const dz = p[2] - centroid[2];
    c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
    c11 += dy * dy; c12 += dy * dz;
    c22 += dz * dz;
  }
  const invN = 1 / n;
  c00 *= invN; c01 *= invN; c02 *= invN;
  c11 *= invN; c12 *= invN;
  c22 *= invN;

  // Power iteration for dominant eigenvector
  let v: Vec3 = [1, 0, 0];
  for (let iter = 0; iter < 10; iter++) {
    const x = c00 * v[0] + c01 * v[1] + c02 * v[2];
    const y = c01 * v[0] + c11 * v[1] + c12 * v[2];
    const z = c02 * v[0] + c12 * v[1] + c22 * v[2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPS) break;
    v = [x / len, y / len, z / len];
  }

  // Deflate: subtract dominant eigen-component to get second eigenvector
  const lambda1 = v[0] * (c00 * v[0] + c01 * v[1] + c02 * v[2])
                + v[1] * (c01 * v[0] + c11 * v[1] + c12 * v[2])
                + v[2] * (c02 * v[0] + c12 * v[1] + c22 * v[2]);
  const d00 = c00 - lambda1 * v[0] * v[0];
  const d01 = c01 - lambda1 * v[0] * v[1];
  const d02 = c02 - lambda1 * v[0] * v[2];
  const d11 = c11 - lambda1 * v[1] * v[1];
  const d12 = c12 - lambda1 * v[1] * v[2];
  const d22 = c22 - lambda1 * v[2] * v[2];

  let w: Vec3 = [0, 1, 0];
  // Power iteration on deflated matrix
  for (let iter = 0; iter < 10; iter++) {
    const x = d00 * w[0] + d01 * w[1] + d02 * w[2];
    const y = d01 * w[0] + d11 * w[1] + d12 * w[2];
    const z = d02 * w[0] + d12 * w[1] + d22 * w[2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPS) break;
    w = [x / len, y / len, z / len];
  }

  // Ensure secondary is orthogonal to primary
  const dotVW = dot3(v, w);
  w = [w[0] - dotVW * v[0], w[1] - dotVW * v[1], w[2] - dotVW * v[2]];
  const wLen = normLen3(w);
  if (wLen < EPS) {
    // Degenerate: pick any perpendicular vector
    w = Math.abs(v[0]) < 0.9 ? norm3([1, 0, 0]) : norm3([0, 1, 0]);
    const dp = dot3(v, w);
    w = norm3([w[0] - dp * v[0], w[1] - dp * v[1], w[2] - dp * v[2]]);
  } else {
    w = scale3(w, 1 / wLen);
  }

  // Projection extent along primary
  let extentMin = Infinity, extentMax = -Infinity;
  for (const i of indices) {
    const t = dot3(sub3(vertices[i], centroid), v);
    if (t < extentMin) extentMin = t;
    if (t > extentMax) extentMax = t;
  }

  return { centroid, axis: v, secondary: w, extentMin, extentMax };
}

// ── Anchor detection ───────────────────────────────────────────────────────

function nearestVertex(vertices: Vec3[], indices: Set<number>, target: Vec3): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (const i of indices) {
    const d = dist3(vertices[i], target);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  // Fallback to first index
  return bestIdx >= 0 ? bestIdx : indices.values().next().value ?? 0;
}

/**
 * Project all points in `indices` onto `axis` (relative to `centroid`),
 * find the vertex nearest to the extreme projection endpoint.
 * `direction`: +1 = max projection, -1 = min projection.
 */
function extremeVertex(
  vertices: Vec3[],
  indices: Set<number>,
  centroid: Vec3,
  axis: Vec3,
  direction: 1 | -1,
): { vertex: number; position: Vec3; projection: number } {
  let bestProj = direction > 0 ? -Infinity : Infinity;
  let bestVertex = -1;
  for (const i of indices) {
    const proj = dot3(sub3(vertices[i], centroid), axis);
    if (direction > 0 ? proj > bestProj : proj < bestProj) {
      bestProj = proj;
      bestVertex = i;
    }
  }
  return {
    vertex: bestVertex >= 0 ? bestVertex : (indices.values().next().value ?? 0),
    position: bestVertex >= 0 ? vertices[bestVertex] : [0, 0, 0],
    projection: bestProj,
  };
}

// ── Main detection ─────────────────────────────────────────────────────────

export interface JacketStructureInput {
  vertices: Vec3[];
  torso: Set<number>;
  left_sleeve: Set<number>;
  right_sleeve: Set<number>;
}

export interface JacketStructureResult {
  /** The detected structure graph */
  graph: StructureGraph;
  /** PCA frames for each region (diagnostics) */
  diagnostics: {
    torsoPCA: PCAFrame | null;
    leftSleevePCA: PCAFrame | null;
    rightSleevePCA: PCAFrame | null;
  };
}

export function detectJacketStructure(
  vertices: Vec3[],
  regions: {
    torso: Set<number>;
    left_sleeve: Set<number>;
    right_sleeve: Set<number>;
  },
  options: JacketStructureOptions = {},
): JacketStructureResult {
  const shoulderFraction = options.shoulderFraction ?? 0.15;

  const torsoPCA = computeRegionPCA(vertices, regions.torso);
  const leftPCA = computeRegionPCA(vertices, regions.left_sleeve);
  const rightPCA = computeRegionPCA(vertices, regions.right_sleeve);

  const anchors: StructureAnchor[] = [];
  const anchorRegionMap = new Map<string, GarmentRegionLabel>();

  // ── 1. Determine torso axes ──────────────────────────────────────────
  if (torsoPCA) {
    const torsoCentroid = torsoPCA.centroid;
    const verticalAxis = torsoPCA.axis;    // along the body

    // 1a. collar_center = top of torso
    const collarPt = extremeVertex(vertices, regions.torso, torsoCentroid, verticalAxis, 1);
    const collarVert = nearestVertex(vertices, regions.torso, collarPt.position);
    anchors.push({
      kind: 'collar_center',
      vertex: collarVert,
      position: vertices[collarVert],
      confidence: 0.85,
    });
    anchorRegionMap.set('collar_center', 'torso');

    // 1b. hem_center = bottom of torso
    const hemPt = extremeVertex(vertices, regions.torso, torsoCentroid, verticalAxis, -1);
    const hemVert = nearestVertex(vertices, regions.torso, hemPt.position);
    anchors.push({
      kind: 'hem_center',
      vertex: hemVert,
      position: vertices[hemVert],
      confidence: 0.85,
    });
    anchorRegionMap.set('hem_center', 'torso');
  }

  // ── 2. Per-sleeve processing ─────────────────────────────────────────
  const sleeveDefs: Array<{
    side: 'left' | 'right';
    region: Set<number>;
    pca: PCAFrame | null;
    shoulderKind: 'left_shoulder' | 'right_shoulder';
    cuffKind: 'left_cuff' | 'right_cuff';
    armpitKind: 'left_armpit' | 'right_armpit';
  }> = [
    { side: 'left', region: regions.left_sleeve, pca: leftPCA,
      shoulderKind: 'left_shoulder', cuffKind: 'left_cuff', armpitKind: 'left_armpit' },
    { side: 'right', region: regions.right_sleeve, pca: rightPCA,
      shoulderKind: 'right_shoulder', cuffKind: 'right_cuff', armpitKind: 'right_armpit' },
  ];

  for (const def of sleeveDefs) {
    if (!def.pca || def.region.size < 3) continue;
    const pca = def.pca;
    const region = def.region;

    // 2a. Determine which end of the sleeve axis is "shoulder" (closer to torso)
    let shoulderEnd: Vec3;
    let cuffEnd: Vec3;

    if (torsoPCA) {
      // The shoulder end is the sleeve PCA extreme closer to the torso centroid
      const projMinPt = add3(pca.centroid, scale3(pca.axis, pca.extentMin));
      const projMaxPt = add3(pca.centroid, scale3(pca.axis, pca.extentMax));
      const dMin = dist3(projMinPt, torsoPCA.centroid);
      const dMax = dist3(projMaxPt, torsoPCA.centroid);
      if (dMin < dMax) {
        shoulderEnd = projMinPt;
        cuffEnd = projMaxPt;
      } else {
        shoulderEnd = projMaxPt;
        cuffEnd = projMinPt;
      }
    } else {
      // No torso PCA: assume shoulder is the more central end
      const projMinPt = add3(pca.centroid, scale3(pca.axis, pca.extentMin));
      const projMaxPt = add3(pca.centroid, scale3(pca.axis, pca.extentMax));
      shoulderEnd = projMinPt;
      cuffEnd = projMaxPt;
    }

    // 2b. Shoulder anchor: search within shoulderFraction of the shoulder end
    const cuffSearchEnd = add3(pca.centroid, scale3(pca.axis, pca.extentMax));
    const shoulderDir = norm3(sub3(cuffSearchEnd, shoulderEnd));
    const shoulderCutDist = shoulderFraction * Math.abs(pca.extentMax - pca.extentMin);

    // Collect shoulder-zone vertices (those near the shoulder end of the axis)
    const shoulderZoneIndices: number[] = [];
    for (const i of region) {
      const proj = dot3(sub3(vertices[i], shoulderEnd), shoulderDir);
      if (Math.abs(proj) < shoulderCutDist) {
        shoulderZoneIndices.push(i);
      }
    }

    let shoulderVert: number;
    if (shoulderZoneIndices.length > 0) {
      const shoulderZone = new Set(shoulderZoneIndices);
      // If we have torso, find the vertex in the shoulder zone closest to torso
      if (torsoPCA) {
        shoulderVert = nearestVertex(vertices, shoulderZone, torsoPCA.centroid);
      } else {
        shoulderVert = shoulderZoneIndices[0];
      }
    } else {
      shoulderVert = nearestVertex(vertices, region, shoulderEnd);
    }

    anchors.push({
      kind: def.shoulderKind,
      vertex: shoulderVert,
      position: vertices[shoulderVert],
      confidence: 0.80,
    });
    anchorRegionMap.set(def.shoulderKind, `${def.side}_sleeve` as GarmentRegionLabel);

    // 2c. Cuff anchor: far end of sleeve (away from shoulder)
    const cuffSearchStart = shoulderEnd;
    const cuffSearchAxis = norm3(sub3(cuffEnd, shoulderEnd));
    // const cuffSearchLen = normLen3(sub3(cuffEnd, shoulderEnd)) * 0.35; // last 35% of sleeve
    const cuffStartT = 1 - 0.35;

    const cuffZoneIndices: number[] = [];
    for (const i of region) {
      const proj = dot3(sub3(vertices[i], cuffSearchStart), cuffSearchAxis);
      const t = proj / (normLen3(sub3(cuffEnd, shoulderEnd)) + EPS);
      if (t >= cuffStartT) cuffZoneIndices.push(i);
    }

    let cuffVert: number;
    if (cuffZoneIndices.length > 0) {
      const cuffZone = new Set(cuffZoneIndices);
      cuffVert = extremeVertex(vertices, cuffZone, shoulderEnd, cuffSearchAxis, 1).vertex;
    } else {
      cuffVert = nearestVertex(vertices, region, cuffEnd);
    }

    anchors.push({
      kind: def.cuffKind,
      vertex: cuffVert,
      position: vertices[cuffVert],
      confidence: 0.80,
    });
    anchorRegionMap.set(def.cuffKind, `${def.side}_sleeve` as GarmentRegionLabel);

    // 2d. Armpit: lowest point where sleeve meets torso
    // Look for vertices in the shoulder zone that are lowest along vertical axis
    if (torsoPCA) {
      const verticalAxis = torsoPCA.axis;
      const armpitZone = shoulderZoneIndices.length > 0
        ? shoulderZoneIndices
        : Array.from(region);

      // Armpit = lowest (most negative along vertical) among shoulder-zone
      let armpitVert = armpitZone[0];
      let lowestProj = Infinity;
      for (const i of armpitZone) {
        const proj = dot3(sub3(vertices[i], torsoPCA.centroid), verticalAxis);
        if (proj < lowestProj) {
          lowestProj = proj;
          armpitVert = i;
        }
      }

      anchors.push({
        kind: def.armpitKind,
        vertex: armpitVert,
        position: vertices[armpitVert],
        confidence: 0.70,
      });
      anchorRegionMap.set(def.armpitKind, `${def.side}_sleeve` as GarmentRegionLabel);
    }
  }

  // ── 3. Build edges ───────────────────────────────────────────────────
  const edges: StructureEdge[] = [];

  // Torso vertical edges
  edges.push({ from: 'collar_center', to: 'hem_center' });

  // Collar to shoulders
  edges.push({ from: 'collar_center', to: 'left_shoulder' });
  edges.push({ from: 'collar_center', to: 'right_shoulder' });

  // Shoulders to cuffs (sleeve axes)
  edges.push({ from: 'left_shoulder', to: 'left_cuff' });
  edges.push({ from: 'right_shoulder', to: 'right_cuff' });

  // Shoulders to armpits
  edges.push({ from: 'left_shoulder', to: 'left_armpit' });
  edges.push({ from: 'right_shoulder', to: 'right_armpit' });

  // Armpits to hem
  edges.push({ from: 'left_armpit', to: 'hem_center' });
  edges.push({ from: 'right_armpit', to: 'hem_center' });

  // Cross-shoulder
  edges.push({ from: 'left_shoulder', to: 'right_shoulder' });

  const graph: StructureGraph = { anchors, edges, anchorRegionMap };

  return {
    graph,
    diagnostics: {
      torsoPCA,
      leftSleevePCA: leftPCA,
      rightSleevePCA: rightPCA,
    },
  };
}

// ── Simple heuristic region splitter (for Phase 0 testing) ──────────────────

/**
 * Split a single set of mesh vertices (e.g., an "upper-clothes" mask) into
 * approximate torso / left_sleeve / right_sleeve regions using a simple
 * bounding-box heuristic. Assumes the garment is roughly T-pose oriented.
 *
 * This is a fallback for Phase 0 testing when no AI segmentation is available.
 * It's not accurate for arbitrary poses.
 */
export function splitGarmentByBBox(
  vertices: Vec3[],
  garmentVertices: Set<number>,
): {
  torso: Set<number>;
  left_sleeve: Set<number>;
  right_sleeve: Set<number>;
} {
  // Compute bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const i of garmentVertices) {
    const [x, y] = vertices[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  if (rangeX < EPS || rangeY < EPS) {
    return { torso: garmentVertices, left_sleeve: new Set(), right_sleeve: new Set() };
  }

  // Heuristic: top 60% of Y range = torso, bottom 40% = sleeves
  //               left side X  = left_sleeve, right side X = right_sleeve
  const sleeveYThreshold = minY + rangeY * 0.55;
  const centerX = (minX + maxX) / 2;
  // const halfWidth = rangeX * 0.28; // central 56% of X is torso

  const torso = new Set<number>();
  const left_sleeve = new Set<number>();
  const right_sleeve = new Set<number>();

  for (const i of garmentVertices) {
    const [x, y] = vertices[i];
    if (y > sleeveYThreshold) {
      // Upper portion — torso
      torso.add(i);
    } else {
      // Lower portion — sleeves
      if (x < centerX) {
        left_sleeve.add(i);
      } else {
        right_sleeve.add(i);
      }
    }
  }

  return { torso, left_sleeve, right_sleeve };
}
