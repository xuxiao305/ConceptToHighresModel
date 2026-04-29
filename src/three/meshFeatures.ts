/**
 * Whole-mesh feature extraction — for landmarking when source/target
 * have similar shape but different topology / transforms.
 *
 * Pipeline:
 *   1.  computeVertexSaliency()
 *       For each vertex, average normal-deflection across its 1-ring
 *       neighbours.  This is a cheap rotation/scale-invariant proxy for
 *       discrete mean curvature.  High value = a corner / crease,
 *       low value = a flat region.
 *
 *   2.  pickSalientCandidates()
 *       Take the top-N most salient vertices as the candidate pool.
 *       This filters out the millions of "boring" interior points.
 *
 *   3.  farthestPointSample()
 *       Greedy spatial FPS over the candidate pool to keep K samples
 *       that are spread across the bounding volume.  This is exactly
 *       what SVD likes — maximum lever arm.
 *
 *   4.  computeMultiScaleCurvature()
 *       For each FPS sample, compute curvature averaged over ring
 *       distances 1/2/3 — gives a 3-D rotation-invariant descriptor.
 *       Bbox diagonal is used to normalize across different scales.
 *
 * See `Document/Design/半自动对齐方案.md` for design rationale.
 */

import type { Vec3, MeshAdjacency } from './types';

// ---------------------------------------------------------------------------
// Saliency
// ---------------------------------------------------------------------------

/**
 * Per-vertex saliency = average normal-deflection (radians, 0..π) to its 1-ring.
 *
 * Coincident vertices (welded == self) without neighbours get 0.
 */
export function computeVertexSaliency(
  adjacency: MeshAdjacency,
): Float32Array {
  const n = adjacency.vertexNormals.length;
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const nv = adjacency.vertexNormals[v];
    if (!nv) continue;
    const neigh = adjacency.vertexNeighbors.get(v);
    if (!neigh || neigh.size === 0) continue;
    let acc = 0;
    let count = 0;
    for (const m of neigh) {
      const nm = adjacency.vertexNormals[m];
      if (!nm) continue;
      let cos = nv[0] * nm[0] + nv[1] * nm[1] + nv[2] * nm[2];
      if (cos > 1) cos = 1;
      else if (cos < -1) cos = -1;
      acc += Math.acos(cos);
      count++;
    }
    out[v] = count > 0 ? acc / count : 0;
  }
  return out;
}

/**
 * Pick the top-N most salient vertex indices.
 * `minSaliency` further filters out flat samples.
 */
export function pickSalientCandidates(
  saliency: Float32Array,
  topN: number,
  minSaliency = 0,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < saliency.length; i++) {
    if (saliency[i] > minSaliency) indices.push(i);
  }
  indices.sort((a, b) => saliency[b] - saliency[a]);
  return indices.slice(0, Math.min(topN, indices.length));
}

// ---------------------------------------------------------------------------
// Farthest-point sampling (spatial)
// ---------------------------------------------------------------------------

/**
 * Greedy Farthest-Point Sampling on a subset of vertex indices, using
 * 3D Euclidean distance.  Guarantees samples are spread over the bbox.
 *
 * If `seedIndex` is provided it becomes sample #0; otherwise the first
 * candidate is used.
 */
export function farthestPointSample(
  vertices: Vec3[],
  candidatePool: number[],
  k: number,
  seedIndex?: number,
): number[] {
  if (candidatePool.length === 0 || k <= 0) return [];
  if (k >= candidatePool.length) return candidatePool.slice();

  const samples: number[] = [];
  const minDist = new Float64Array(candidatePool.length);
  for (let i = 0; i < minDist.length; i++) minDist[i] = Infinity;

  const startIdx = seedIndex !== undefined
    ? Math.max(0, candidatePool.indexOf(seedIndex))
    : 0;
  samples.push(candidatePool[startIdx]);
  updateMinDist(vertices, candidatePool, samples[0], minDist);

  while (samples.length < k) {
    let bestI = -1;
    let bestD = -1;
    for (let i = 0; i < candidatePool.length; i++) {
      if (minDist[i] > bestD) {
        bestD = minDist[i];
        bestI = i;
      }
    }
    if (bestI < 0 || bestD <= 0) break;
    const v = candidatePool[bestI];
    samples.push(v);
    updateMinDist(vertices, candidatePool, v, minDist);
  }

  return samples;
}

function updateMinDist(
  vertices: Vec3[],
  pool: number[],
  pivotIdx: number,
  minDist: Float64Array,
) {
  const [px, py, pz] = vertices[pivotIdx];
  for (let i = 0; i < pool.length; i++) {
    const [x, y, z] = vertices[pool[i]];
    const dx = x - px;
    const dy = y - py;
    const dz = z - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < minDist[i]) minDist[i] = d2;
  }
}

// ---------------------------------------------------------------------------
// Multi-scale curvature descriptor
// ---------------------------------------------------------------------------

/**
 * For each input vertex, compute average normal-deflection within
 * geodesic-ish ring distance 1, 2, ..., R.  Output is an [R]-dim
 * rotation/translation-invariant descriptor.
 *
 * Ring distances use the BFS topology in `adjacency`.
 */
export function computeMultiScaleCurvature(
  vertexIndices: number[],
  adjacency: MeshAdjacency,
  rings: number,
): Float32Array {
  const out = new Float32Array(vertexIndices.length * rings);
  for (let s = 0; s < vertexIndices.length; s++) {
    const seed = vertexIndices[s];
    const seedNormal = adjacency.vertexNormals[seed];
    if (!seedNormal) continue;

    const visited = new Set<number>([seed]);
    let frontier: number[] = [seed];
    for (let r = 0; r < rings; r++) {
      const next: number[] = [];
      let acc = 0;
      let count = 0;
      for (const v of frontier) {
        const neigh = adjacency.vertexNeighbors.get(v);
        if (!neigh) continue;
        for (const m of neigh) {
          if (visited.has(m)) continue;
          visited.add(m);
          next.push(m);
          const nm = adjacency.vertexNormals[m];
          if (!nm) continue;
          let cos = seedNormal[0] * nm[0] + seedNormal[1] * nm[1] + seedNormal[2] * nm[2];
          if (cos > 1) cos = 1;
          else if (cos < -1) cos = -1;
          acc += Math.acos(cos);
          count++;
        }
      }
      out[s * rings + r] = count > 0 ? acc / count : 0;
      if (next.length === 0) break;
      frontier = next;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scale-aware curvature descriptor (geometric radius bins)
// ---------------------------------------------------------------------------

/**
 * Density-invariant alternative to `computeMultiScaleCurvature`.
 *
 * Why this exists:
 *   The BFS-ring descriptor uses topological ring distance.  When two
 *   meshes have very different polygon density (e.g. an arm-only low-poly
 *   source vs. a hi-res whole-character target), 3 BFS rings on the
 *   source can cover a huge area while 3 rings on the target cover a
 *   tiny patch.  The descriptors are then computed at incompatible
 *   physical scales and matching collapses.
 *
 * What this does:
 *   For each seed, BFS-expand to collect all vertices within Euclidean
 *   radius `maxRadius`, then bin them by geometric distance into `bins`
 *   shells.  Each shell stores the average normal-deflection from the
 *   seed normal — exactly what the BFS version stored, but the bins are
 *   physically comparable across meshes.
 *
 * Output: Float32Array length = vertexIndices.length * bins
 */
export function computeScaleAwareCurvature(
  vertexIndices: number[],
  vertices: Vec3[],
  adjacency: MeshAdjacency,
  maxRadius: number,
  bins: number,
): Float32Array {
  const out = new Float32Array(vertexIndices.length * bins);
  if (maxRadius <= 0 || bins < 1) return out;
  const r2Max = maxRadius * maxRadius;
  const binWidth = maxRadius / bins;

  for (let s = 0; s < vertexIndices.length; s++) {
    const seed = vertexIndices[s];
    const seedPos = vertices[seed];
    const seedNormal = adjacency.vertexNormals[seed];
    if (!seedPos || !seedNormal) continue;

    const accBuf = new Float64Array(bins);
    const cntBuf = new Int32Array(bins);

    // BFS-grow within maxRadius
    const visited = new Set<number>([seed]);
    let frontier: number[] = [seed];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const v of frontier) {
        const neigh = adjacency.vertexNeighbors.get(v);
        if (!neigh) continue;
        for (const m of neigh) {
          if (visited.has(m)) continue;
          const mp = vertices[m];
          if (!mp) continue;
          const dx = mp[0] - seedPos[0];
          const dy = mp[1] - seedPos[1];
          const dz = mp[2] - seedPos[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2Max) continue; // outside radius — also stops BFS branch
          visited.add(m);
          next.push(m);

          const nm = adjacency.vertexNormals[m];
          if (!nm) continue;
          let cos = seedNormal[0] * nm[0] + seedNormal[1] * nm[1] + seedNormal[2] * nm[2];
          if (cos > 1) cos = 1;
          else if (cos < -1) cos = -1;
          const deflection = Math.acos(cos);

          const dist = Math.sqrt(d2);
          let bin = Math.floor(dist / binWidth);
          if (bin >= bins) bin = bins - 1;
          accBuf[bin] += deflection;
          cntBuf[bin]++;
        }
      }
      frontier = next;
    }

    for (let b = 0; b < bins; b++) {
      out[s * bins + b] = cntBuf[b] > 0 ? accBuf[b] / cntBuf[b] : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounding-volume helpers
// ---------------------------------------------------------------------------

export function bboxDiagonal(vertices: Vec3[]): number {
  if (vertices.length === 0) return 1;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const [x, y, z] of vertices) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const dx = maxx - minx;
  const dy = maxy - miny;
  const dz = maxz - minz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
}
