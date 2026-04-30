/**
 * Iterative Closest Point (ICP) refinement after partial-match.
 *
 * Input: an initial transform that already roughly aligns source to
 * target (typically the output of `matchPartialToWhole` followed by an
 * SVD landmark fit, or `computeLandmarkAlignment` on accepted pairs).
 *
 * Each iteration:
 *   1. Down-sample the source to a fixed budget (uniform stride is
 *      sufficient at this stage since we just need spread-out points
 *      and stable iteration-to-iteration sets).
 *   2. Apply the current transform to the sampled source points.
 *   3. For each transformed point find its nearest target vertex via
 *      a spatial hash. Reject pairs farther than `rejectMultiplier *
 *      median(distance)` to suppress outliers — critical for
 *      partial-to-whole because lots of source points would otherwise
 *      pull the fit toward irrelevant target geometry.
 *   4. Re-fit transform with SVD over the kept pairs (similarity for
 *      the first iteration; rigid afterwards by default — scale is
 *      already close after pass 1, this prevents scale drift).
 *   5. Stop when relative RMSE improvement < `convergenceImprovement`
 *      or after `maxIterations`.
 */

import type { Vec3 } from './types';
import {
  computeLandmarkAlignment,
  applyTransform,
  type AlignmentMode,
} from './alignment';

export interface IcpOptions {
  /** Maximum number of ICP iterations (default 30). */
  maxIterations?: number;
  /** Stop when (prev - curr) / prev < this fraction (default 0.005). */
  convergenceImprovement?: number;
  /** Number of source points sampled each iteration (default 400). */
  sampleCount?: number;
  /**
   * Pairs whose distance exceeds `rejectMultiplier * median(distance)`
   * are dropped before SVD (default 2.5). Lower = stricter outlier
   * rejection — needed for partial-to-whole.
   */
  rejectMultiplier?: number;
  /** Alignment mode for the first iteration (default 'similarity'). */
  firstIterMode?: AlignmentMode;
  /** Alignment mode for subsequent iterations (default 'rigid'). */
  subsequentMode?: AlignmentMode;
  /** Optional deterministic seed for source sub-sampling. */
  seed?: number;
  /**
   * Restrict NN search to this subset of target vertex indices.
   * Critical for partial-to-whole: without it, ICP for an arm would
   * happily slide source points to the nearest body vertex and the
   * fit collapses onto the torso.  Pass the SAM3-reprojected region
   * vertex set here.
   */
  tarRestrictVertices?: Set<number>;
}

export interface IcpIteration {
  /** 4x4 transform from original source space to target space. */
  matrix4x4: number[][];
  /** RMSE in target-space units across kept pairs. */
  rmse: number;
  /** Number of pairs kept after outlier rejection. */
  pairsKept: number;
  /** Relative improvement vs previous iter (Infinity for iter 0). */
  improvement: number;
}

export interface IcpResult {
  /** Best iteration's transform (lowest RMSE). */
  matrix4x4: number[][];
  /** Best iteration's RMSE. */
  rmse: number;
  /** Index of the best iteration in `iterations`. */
  bestIteration: number;
  /** All iterations executed (chronological). */
  iterations: IcpIteration[];
  /** Why the loop stopped. */
  stopReason: 'converged' | 'max-iterations' | 'no-pairs';
}

/**
 * Refine an initial source→target transform via ICP.
 */
export function icpRefine(
  srcVertices: Vec3[],
  tarVertices: Vec3[],
  initialMatrix: number[][],
  options: IcpOptions = {},
): IcpResult {
  const maxIterations = options.maxIterations ?? 30;
  const convThresh = options.convergenceImprovement ?? 0.005;
  const sampleCount = options.sampleCount ?? 400;
  const rejectMul = options.rejectMultiplier ?? 2.5;
  const firstMode = options.firstIterMode ?? 'similarity';
  const subMode = options.subsequentMode ?? 'rigid';
  const rng = options.seed !== undefined ? mulberry32(options.seed) : Math.random;

  const tarHash = buildSpatialHash(tarVertices, estimateCellSize(tarVertices));
  const srcSampleIdx = uniformSubsample(srcVertices.length, sampleCount, rng);

  const iterations: IcpIteration[] = [];
  let currentMatrix = initialMatrix.map((row) => row.slice());
  let prevRmse = Infinity;
  let bestIteration = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    // 1. Apply current transform to sampled source points.
    const transformed: Vec3[] = srcSampleIdx.map((i) =>
      applyTransform(srcVertices[i], currentMatrix),
    );

    // 2. Nearest target vertex for each.
    const dists: number[] = new Array(transformed.length);
    const matchedTar: Vec3[] = new Array(transformed.length);
    for (let i = 0; i < transformed.length; i++) {
      const nn = nearestNeighbor(tarHash, tarVertices, transformed[i]);
      dists[i] = nn.distance;
      matchedTar[i] = tarVertices[nn.index];
    }

    if (transformed.length < 4) {
      iterations.push({ matrix4x4: currentMatrix, rmse: Infinity, pairsKept: 0, improvement: 0 });
      return {
        matrix4x4: currentMatrix,
        rmse: Infinity,
        bestIteration,
        iterations,
        stopReason: 'no-pairs',
      };
    }

    // 3. Outlier rejection by median distance.
    const sortedD = dists.slice().sort((a, b) => a - b);
    const med = sortedD[sortedD.length >> 1];
    const cutoff = Math.max(med * rejectMul, 1e-9);

    const keptSrc: Vec3[] = [];
    const keptTar: Vec3[] = [];
    for (let i = 0; i < transformed.length; i++) {
      if (dists[i] <= cutoff) {
        // Use the ORIGINAL source vertex (not the transformed one) so
        // each iteration computes an absolute transform from source
        // space rather than composing many small transforms (which
        // accumulates drift).
        keptSrc.push(srcVertices[srcSampleIdx[i]]);
        keptTar.push(matchedTar[i]);
      }
    }

    if (keptSrc.length < 4) {
      iterations.push({ matrix4x4: currentMatrix, rmse: prevRmse, pairsKept: keptSrc.length, improvement: 0 });
      return {
        matrix4x4: currentMatrix,
        rmse: prevRmse,
        bestIteration,
        iterations,
        stopReason: 'no-pairs',
      };
    }

    // 4. Re-fit transform.
    const mode: AlignmentMode = iter === 0 ? firstMode : subMode;
    let newMatrix: number[][];
    try {
      newMatrix = computeLandmarkAlignment(keptSrc, keptTar, mode).matrix4x4;
    } catch {
      iterations.push({ matrix4x4: currentMatrix, rmse: prevRmse, pairsKept: keptSrc.length, improvement: 0 });
      return {
        matrix4x4: currentMatrix,
        rmse: prevRmse,
        bestIteration,
        iterations,
        stopReason: 'no-pairs',
      };
    }

    // 5. RMSE on the kept pairs under the freshly fit transform.
    let sumSq = 0;
    for (let i = 0; i < keptSrc.length; i++) {
      const p = applyTransform(keptSrc[i], newMatrix);
      const dx = p[0] - keptTar[i][0];
      const dy = p[1] - keptTar[i][1];
      const dz = p[2] - keptTar[i][2];
      sumSq += dx * dx + dy * dy + dz * dz;
    }
    const rmse = Math.sqrt(sumSq / keptSrc.length);
    const improvement =
      prevRmse === Infinity ? Infinity : (prevRmse - rmse) / Math.max(prevRmse, 1e-9);

    iterations.push({ matrix4x4: newMatrix, rmse, pairsKept: keptSrc.length, improvement });

    if (rmse < (iterations[bestIteration]?.rmse ?? Infinity)) {
      bestIteration = iterations.length - 1;
    }

    currentMatrix = newMatrix;

    if (improvement >= 0 && improvement < convThresh && iter > 0) {
      const best = iterations[bestIteration];
      return {
        matrix4x4: best.matrix4x4,
        rmse: best.rmse,
        bestIteration,
        iterations,
        stopReason: 'converged',
      };
    }
    prevRmse = rmse;
  }

  const best = iterations[bestIteration];
  return {
    matrix4x4: best.matrix4x4,
    rmse: best.rmse,
    bestIteration,
    iterations,
    stopReason: 'max-iterations',
  };
}

// ---------------------------------------------------------------------------
// Spatial hash for nearest-neighbor queries on the target mesh
// ---------------------------------------------------------------------------

interface SpatialHash {
  cells: Map<string, number[]>;
  cellSize: number;
}

function estimateCellSize(vertices: Vec3[]): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
  // ~30 cells across the diagonal: dozens of vertices per cell on a
  // 100k-vertex mesh, single-cell lookup hits the NN most of the time.
  return Math.max(diag / 30, 1e-6);
}

function buildSpatialHash(vertices: Vec3[], cellSize: number): SpatialHash {
  const cells = new Map<string, number[]>();
  for (let i = 0; i < vertices.length; i++) {
    const [x, y, z] = vertices[i];
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
    let cell = cells.get(key);
    if (!cell) { cell = []; cells.set(key, cell); }
    cell.push(i);
  }
  return { cells, cellSize };
}

function nearestNeighbor(
  hash: SpatialHash,
  vertices: Vec3[],
  query: Vec3,
): { index: number; distance: number } {
  const { cells, cellSize } = hash;
  const cx = Math.floor(query[0] / cellSize);
  const cy = Math.floor(query[1] / cellSize);
  const cz = Math.floor(query[2] / cellSize);
  let bestIdx = -1;
  let bestD2 = Infinity;
  // Spiral outward by ring until we find a candidate, then search one
  // more ring to guarantee we don't miss something just past the
  // boundary.
  let needOneMore = false;
  for (let r = 0; r < 30; r++) {
    let foundAny = false;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r && Math.abs(dz) !== r) continue;
          const cell = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!cell) continue;
          for (const idx of cell) {
            const [vx, vy, vz] = vertices[idx];
            const ddx = vx - query[0], ddy = vy - query[1], ddz = vz - query[2];
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestIdx = idx;
            }
            foundAny = true;
          }
        }
      }
    }
    if (foundAny) {
      if (needOneMore) break;
      needOneMore = true;
    }
  }
  return { index: bestIdx, distance: Math.sqrt(bestD2) };
}

// ---------------------------------------------------------------------------
// Source sub-sampling (uniform stride)
// ---------------------------------------------------------------------------

function uniformSubsample(n: number, k: number, rng: () => number): number[] {
  if (n <= k) {
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    return all;
  }
  const stride = n / k;
  const phase = rng() * stride;
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    out.push(Math.min(n - 1, Math.floor(phase + i * stride)));
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) | 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
