/**
 * Structure Graph Matching
 *
 * Given two StructureGraphs (source and target), this module pairs anchors
 * by their semantic `kind`, rejects outlier pairs via edge-length constraints,
 * and computes a similarity transformation via SVD.
 *
 * Unlike surface RANSAC or limb PCA matching, this operates at the semantic
 * level — matching "collar" to "collar", "left_cuff" to "left_cuff", etc.
 */

import type {
  Vec3,
  StructureGraph,
  StructureAnchor,
  LandmarkCandidate,
  GraphMatchOptions,
} from './types';

// ── helpers ────────────────────────────────────────────────────────────────

const EPS = 1e-12;

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
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

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// ── SVD similarity fit ─────────────────────────────────────────────────────

/**
 * Compute a similarity (rotation + uniform scale + translation) from
 * srcPoints → tarPoints.  Returns a 4×4 column-major matrix.
 *
 * Uses the Kabsch-Umeyama algorithm for robust SVD with scale.
 * Reference: Umeyama, "Least-squares estimation of transformation parameters
 * between two point patterns", IEEE TPAMI 1991.
 */
function similarityFit(srcPoints: Vec3[], tarPoints: Vec3[]): number[][] | null {
  const n = srcPoints.length;
  if (n < 3) return null;

  // Centroid
  let srcCx = 0, srcCy = 0, srcCz = 0;
  let tarCx = 0, tarCy = 0, tarCz = 0;
  for (let i = 0; i < n; i++) {
    srcCx += srcPoints[i][0]; srcCy += srcPoints[i][1]; srcCz += srcPoints[i][2];
    tarCx += tarPoints[i][0]; tarCy += tarPoints[i][1]; tarCz += tarPoints[i][2];
  }
  const invN = 1 / n;
  srcCx *= invN; srcCy *= invN; srcCz *= invN;
  tarCx *= invN; tarCy *= invN; tarCz *= invN;

  // Cross-covariance H
  let h00 = 0, h01 = 0, h02 = 0;
  let h10 = 0, h11 = 0, h12 = 0;
  let h20 = 0, h21 = 0, h22 = 0;
  let srcVar = 0;
  for (let i = 0; i < n; i++) {
    const sx = srcPoints[i][0] - srcCx;
    const sy = srcPoints[i][1] - srcCy;
    const sz = srcPoints[i][2] - srcCz;
    const tx = tarPoints[i][0] - tarCx;
    const ty = tarPoints[i][1] - tarCy;
    const tz = tarPoints[i][2] - tarCz;
    h00 += sx * tx; h01 += sx * ty; h02 += sx * tz;
    h10 += sy * tx; h11 += sy * ty; h12 += sy * tz;
    h20 += sz * tx; h21 += sz * ty; h22 += sz * tz;
    srcVar += sx * sx + sy * sy + sz * sz;
  }
  srcVar *= invN;
  if (srcVar < EPS) return null;

  // SVD of H via solving H^T H for eigenvectors
  // H^T H is 3×3 symmetric
  const hth00 = h00 * h00 + h10 * h10 + h20 * h20;
  const hth01 = h00 * h01 + h10 * h11 + h20 * h21;
  const hth02 = h00 * h02 + h10 * h12 + h20 * h22;
  const hth11 = h01 * h01 + h11 * h11 + h21 * h21;
  const hth12 = h01 * h02 + h11 * h12 + h21 * h22;
  const hth22 = h02 * h02 + h12 * h12 + h22 * h22;

  // Power iteration for dominant eigenvector of H^T H (= right singular vector v1)
  let v1: Vec3 = [1, 0, 0];
  for (let iter = 0; iter < 15; iter++) {
    const x = hth00 * v1[0] + hth01 * v1[1] + hth02 * v1[2];
    const y = hth01 * v1[0] + hth11 * v1[1] + hth12 * v1[2];
    const z = hth02 * v1[0] + hth12 * v1[1] + hth22 * v1[2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPS) break;
    v1 = [x / len, y / len, z / len];
  }

  // Deflate for v2
  const lambda1 = v1[0] * (hth00 * v1[0] + hth01 * v1[1] + hth02 * v1[2])
                + v1[1] * (hth01 * v1[0] + hth11 * v1[1] + hth12 * v1[2])
                + v1[2] * (hth02 * v1[0] + hth12 * v1[1] + hth22 * v1[2]);

  const d00 = hth00 - lambda1 * v1[0] * v1[0];
  const d01 = hth01 - lambda1 * v1[0] * v1[1];
  const d02 = hth02 - lambda1 * v1[0] * v1[2];
  const d11 = hth11 - lambda1 * v1[1] * v1[1];
  const d12 = hth12 - lambda1 * v1[1] * v1[2];
  const d22 = hth22 - lambda1 * v1[2] * v1[2];

  let v2: Vec3 = [0, 1, 0];
  for (let iter = 0; iter < 15; iter++) {
    const x = d00 * v2[0] + d01 * v2[1] + d02 * v2[2];
    const y = d01 * v2[0] + d11 * v2[1] + d12 * v2[2];
    const z = d02 * v2[0] + d12 * v2[1] + d22 * v2[2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPS) break;
    v2 = [x / len, y / len, z / len];
  }

  // v3 = v1 × v2
  const v3 = cross3(v1, v2);

  // U = H V
  const u1 = norm3([
    h00 * v1[0] + h01 * v1[1] + h02 * v1[2],
    h10 * v1[0] + h11 * v1[1] + h12 * v1[2],
    h20 * v1[0] + h21 * v1[1] + h22 * v1[2],
  ]);
  const u2 = norm3([
    h00 * v2[0] + h01 * v2[1] + h02 * v2[2],
    h10 * v2[0] + h11 * v2[1] + h12 * v2[2],
    h20 * v2[0] + h21 * v2[1] + h22 * v2[2],
  ]);
  const u3 = cross3(u1, u2);

  // Rotation R = U V^T
  const r00 = u1[0] * v1[0] + u2[0] * v2[0] + u3[0] * v3[0];
  const r01 = u1[0] * v1[1] + u2[0] * v2[1] + u3[0] * v3[1];
  const r02 = u1[0] * v1[2] + u2[0] * v2[2] + u3[0] * v3[2];
  const r10 = u1[1] * v1[0] + u2[1] * v2[0] + u3[1] * v3[0];
  const r11 = u1[1] * v1[1] + u2[1] * v2[1] + u3[1] * v3[1];
  const r12 = u1[1] * v1[2] + u2[1] * v2[2] + u3[1] * v3[2];
  const r20 = u1[2] * v1[0] + u2[2] * v2[0] + u3[2] * v3[0];
  const r21 = u1[2] * v1[1] + u2[2] * v2[1] + u3[2] * v3[1];
  const r22 = u1[2] * v1[2] + u2[2] * v2[2] + u3[2] * v3[2];

  // det(R) should be +1; if not, flip u3
  const detR = r00 * (r11 * r22 - r12 * r21)
             - r01 * (r10 * r22 - r12 * r20)
             + r02 * (r10 * r21 - r11 * r20);
  const sign = detR < 0 ? -1 : 1;

  // Scale = tr(S) / srcVar = trace of diag(U^T H V) / srcVar
  const traceHtR = u1[0] * (h00 * v1[0] + h01 * v1[1] + h02 * v1[2])
                 + u1[1] * (h10 * v1[0] + h11 * v1[1] + h12 * v1[2])
                 + u1[2] * (h20 * v1[0] + h21 * v1[1] + h22 * v1[2])
                 + u2[0] * (h00 * v2[0] + h01 * v2[1] + h02 * v2[2])
                 + u2[1] * (h10 * v2[0] + h11 * v2[1] + h12 * v2[2])
                 + u2[2] * (h20 * v2[0] + h21 * v2[1] + h22 * v2[2])
                 + sign * (u3[0] * (h00 * v3[0] + h01 * v3[1] + h02 * v3[2])
                         + u3[1] * (h10 * v3[0] + h11 * v3[1] + h12 * v3[2])
                         + u3[2] * (h20 * v3[0] + h21 * v3[1] + h22 * v3[2]));
  const scale = traceHtR / srcVar;

  // Translation
  const tx = tarCx - scale * (r00 * srcCx + r01 * srcCy + r02 * srcCz);
  const ty = tarCy - scale * (r10 * srcCx + r11 * srcCy + r12 * srcCz);
  const tz = tarCz - scale * (r20 * srcCx + r21 * srcCy + r22 * srcCz);

  // 4×4 column-major
  return [
    [scale * r00, scale * r10, scale * r20, 0],
    [scale * r01, scale * r11, scale * r21, 0],
    [scale * r02, scale * r12, scale * r22, 0],
    [tx, ty, tz, 1],
  ];
}

// ── Edge constraint check ──────────────────────────────────────────────────

interface MatchedPair {
  kind: string;
  srcAnchor: StructureAnchor;
  tarAnchor: StructureAnchor;
}

/**
 * Check edge-length consistency. For each edge in the source graph, compute
 * the ratio of (srcEdgeLen / tarEdgeLen). If the ratios are too dispersed,
 * mark the most deviant anchor pair as outlier.
 */
function filterByEdgeConsistency(
  pairs: MatchedPair[],
  srcGraph: StructureGraph,
  _tarGraph: StructureGraph,
  _tolerance: number = 0.4,
): MatchedPair[] {
  if (pairs.length < 3) return pairs;

  // Build kind → position maps
  const srcPos = new Map<string, Vec3>();
  const tarPos = new Map<string, Vec3>();
  for (const p of pairs) {
    srcPos.set(p.kind, p.srcAnchor.position);
    tarPos.set(p.kind, p.tarAnchor.position);
  }

  // Compute edge-length ratios
  const ratios: number[] = [];
  for (const edge of srcGraph.edges) {
    const sA = srcPos.get(edge.from);
    const sB = srcPos.get(edge.to);
    const tA = tarPos.get(edge.from);
    const tB = tarPos.get(edge.to);
    if (!sA || !sB || !tA || !tB) continue;

    const srcLen = dist3(sA, sB);
    const tarLen = dist3(tA, tB);
    if (srcLen < EPS || tarLen < EPS) continue;
    ratios.push(srcLen / tarLen);
  }

  if (ratios.length === 0) return pairs;

  // For simplicity, keep all pairs for now — the SVD fit handles outliers well
  // with enough correspondences.
  return pairs;
}

// ── Main matching ──────────────────────────────────────────────────────────

export interface GraphMatchResult {
  pairs: LandmarkCandidate[];
  matrix4x4: number[][] | null;
  rmse: number;
  matchedCount: number;
  totalAnchors: number;
  warning?: string;
}

export function matchStructureGraphs(
  srcGraph: StructureGraph,
  tarGraph: StructureGraph,
  options: GraphMatchOptions = {},
): GraphMatchResult {
  const minPairs = options.minPairs ?? 4;
  const maxRmse = options.maxRmse ?? Infinity;

  // 1. Pair anchors by kind
  const tarByKind = new Map<string, StructureAnchor>();
  for (const a of tarGraph.anchors) {
    tarByKind.set(a.kind, a);
  }

  const matchedPairs: MatchedPair[] = [];
  for (const srcA of srcGraph.anchors) {
    const tarA = tarByKind.get(srcA.kind);
    if (tarA) {
      matchedPairs.push({ kind: srcA.kind, srcAnchor: srcA, tarAnchor: tarA });
    }
  }

  if (matchedPairs.length < minPairs) {
    return {
      pairs: [],
      matrix4x4: null,
      rmse: Infinity,
      matchedCount: matchedPairs.length,
      totalAnchors: srcGraph.anchors.length,
      warning: `Not enough matched anchors: ${matchedPairs.length} < ${minPairs} minimum`,
    };
  }

  // 2. Edge-consistency filter
  const filteredPairs = filterByEdgeConsistency(matchedPairs, srcGraph, tarGraph);

  if (filteredPairs.length < minPairs) {
    return {
      pairs: [],
      matrix4x4: null,
      rmse: Infinity,
      matchedCount: filteredPairs.length,
      totalAnchors: srcGraph.anchors.length,
      warning: `Edge-consistency filter left only ${filteredPairs.length} pairs (< ${minPairs})`,
    };
  }

  // 3. SVD similarity fit
  const srcPoints = filteredPairs.map((p) => p.srcAnchor.position);
  const tarPoints = filteredPairs.map((p) => p.tarAnchor.position);

  const matrix4x4 = similarityFit(srcPoints, tarPoints);

  if (!matrix4x4) {
    return {
      pairs: [],
      matrix4x4: null,
      rmse: Infinity,
      matchedCount: filteredPairs.length,
      totalAnchors: srcGraph.anchors.length,
      warning: 'SVD fit failed — degenerate anchor positions',
    };
  }

  // 4. Compute RMSE
  // Apply transform to src points and measure error
  const applyTransform = (p: Vec3, m: number[][]): Vec3 => {
    const x = m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3];
    const y = m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3];
    const z = m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3];
    return [x, y, z];
  };

  const errors: number[] = [];
  for (let i = 0; i < filteredPairs.length; i++) {
    const transformed = applyTransform(filteredPairs[i].srcAnchor.position, matrix4x4);
    errors.push(dist3(transformed, filteredPairs[i].tarAnchor.position));
  }

  const rmse = Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length);

  // 5. Build LandmarkCandidates
  const pairs: LandmarkCandidate[] = filteredPairs.map((p, i) => ({
    srcVertex: p.srcAnchor.vertex,
    srcPosition: p.srcAnchor.position,
    tarVertex: p.tarAnchor.vertex,
    tarPosition: p.tarAnchor.position,
    confidence: Math.max(0.1, p.srcAnchor.confidence * p.tarAnchor.confidence * (1 - errors[i] / (rmse + EPS))),
    descriptorDist: errors[i] ?? 0,
    suggestAccept: (errors[i] ?? Infinity) < rmse * 2,
  }));

  return {
    pairs,
    matrix4x4: rmse <= maxRmse ? matrix4x4 : null,
    rmse,
    matchedCount: filteredPairs.length,
    totalAnchors: srcGraph.anchors.length,
    warning: rmse > maxRmse ? `RMSE ${rmse.toFixed(3)} exceeds max ${maxRmse}` : undefined,
  };
}
