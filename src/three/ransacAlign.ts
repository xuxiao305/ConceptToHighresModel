/**
 * RANSAC-based geometric consistency filter for landmark candidates.
 *
 * Problem this solves:
 *   When source/target meshes have local deformations, descriptor-based
 *   matching (saliency + multi-scale curvature) can produce many wrong
 *   pairs because the deformed region's local fingerprint changes.
 *
 * Insight:
 *   Even if 40-60% of candidates are wrong, the *correct* pairs are
 *   geometrically consistent with each other (same global rigid/similarity
 *   transform).  The wrong pairs are NOT consistent with that transform.
 *
 * Algorithm:
 *   1. Random sample 3 candidate pairs
 *   2. Compute the rigid/similarity transform that maps src→tar for those 3
 *   3. Apply that transform to all other src points; count how many fall
 *      within `inlierThreshold` of their predicted tar partner
 *   4. Repeat for `iterations` trials, keep the best inlier set
 *   5. Refine: re-run SVD on all inliers for the final transform
 *
 * Output: the inlier subset of candidates (geometrically consistent)
 *         + the recovered transform.
 */

import type { Vec3, LandmarkCandidate } from './types';
import {
  computeLandmarkAlignment,
  applyTransform,
  type AlignmentMode,
} from './alignment';

export interface RansacOptions {
  /** Number of random trials (default 200). Higher = better but slower. */
  iterations?: number;
  /**
   * Distance threshold (in target mesh units) for an inlier.  A candidate
   * is an inlier if ||T(src_pos) - tar_pos|| < threshold.  Default = 5%
   * of target-mesh bbox diagonal (computed automatically when not given).
   */
  inlierThreshold?: number;
  /** Alignment mode for fitting (default 'similarity') */
  mode?: AlignmentMode;
  /** Minimum inlier count to accept the model (default 4) */
  minInliers?: number;
  /** PRNG seed for deterministic results (optional) */
  seed?: number;
}

export interface RansacResult {
  /** Subset of input candidates that survived the consistency check */
  inliers: LandmarkCandidate[];
  /** Indices (into the input) of the inlier candidates */
  inlierIndices: number[];
  /** RMSE of the inlier set after final refit (in target units) */
  rmse: number;
  /** The 4x4 transform recovered from the inliers, or null if RANSAC failed */
  matrix4x4: number[][] | null;
  /** Threshold actually used (auto or user) */
  thresholdUsed: number;
  /** Number of RANSAC iterations executed */
  iterationsRun: number;
}

const DEFAULT_ITERATIONS = 200;
const DEFAULT_MIN_INLIERS = 4;

/**
 * Run RANSAC over a set of candidate landmark pairs to extract the
 * geometrically-consistent inliers.
 */
export function ransacFilterCandidates(
  candidates: LandmarkCandidate[],
  tarVertices: Vec3[],
  options: RansacOptions = {},
): RansacResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const mode = options.mode ?? 'similarity';
  const minInliers = options.minInliers ?? DEFAULT_MIN_INLIERS;
  const threshold =
    options.inlierThreshold ??
    autoThreshold(tarVertices) ??
    0.05;
  const thresh2 = threshold * threshold;

  if (candidates.length < 3) {
    return {
      inliers: candidates.slice(),
      inlierIndices: candidates.map((_, i) => i),
      rmse: 0,
      matrix4x4: null,
      thresholdUsed: threshold,
      iterationsRun: 0,
    };
  }

  const rng = options.seed !== undefined
    ? mulberry32(options.seed)
    : Math.random;

  let bestInlierIdx: number[] = [];
  let bestMatrix: number[][] | null = null;

  for (let trial = 0; trial < iterations; trial++) {
    const sample = pick3Distinct(candidates.length, rng);
    if (!sample) continue;
    const [a, b, c] = sample;

    const srcPts: Vec3[] = [
      candidates[a].srcPosition,
      candidates[b].srcPosition,
      candidates[c].srcPosition,
    ];
    const tarPts: Vec3[] = [
      candidates[a].tarPosition,
      candidates[b].tarPosition,
      candidates[c].tarPosition,
    ];

    // Reject degenerate (near-collinear) source triples — produces unstable SVD
    if (isDegenerateTriangle(srcPts) || isDegenerateTriangle(tarPts)) continue;

    let matrix: number[][];
    try {
      matrix = computeLandmarkAlignment(srcPts, tarPts, mode).matrix4x4;
    } catch {
      continue;
    }

    // Score: count candidates whose mapped src is within threshold of tar
    const inlierIdx: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const mapped = applyTransform(candidates[i].srcPosition, matrix);
      const tp = candidates[i].tarPosition;
      const dx = mapped[0] - tp[0];
      const dy = mapped[1] - tp[1];
      const dz = mapped[2] - tp[2];
      if (dx * dx + dy * dy + dz * dz <= thresh2) inlierIdx.push(i);
    }

    if (inlierIdx.length > bestInlierIdx.length) {
      bestInlierIdx = inlierIdx;
      bestMatrix = matrix;
    }
  }

  if (bestInlierIdx.length < minInliers || !bestMatrix) {
    return {
      inliers: [],
      inlierIndices: [],
      rmse: Infinity,
      matrix4x4: null,
      thresholdUsed: threshold,
      iterationsRun: iterations,
    };
  }

  // Refit using all inliers for a much more accurate transform
  const refitSrc = bestInlierIdx.map((i) => candidates[i].srcPosition);
  const refitTar = bestInlierIdx.map((i) => candidates[i].tarPosition);
  let refitMatrix = bestMatrix;
  try {
    refitMatrix = computeLandmarkAlignment(refitSrc, refitTar, mode).matrix4x4;
  } catch {
    /* keep bestMatrix */
  }

  // Final inlier pass under the refined transform — strictly equal-or-better
  const finalInlierIdx: number[] = [];
  let sumSq = 0;
  for (let i = 0; i < candidates.length; i++) {
    const mapped = applyTransform(candidates[i].srcPosition, refitMatrix);
    const tp = candidates[i].tarPosition;
    const dx = mapped[0] - tp[0];
    const dy = mapped[1] - tp[1];
    const dz = mapped[2] - tp[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= thresh2) {
      finalInlierIdx.push(i);
      sumSq += d2;
    }
  }
  const rmse = finalInlierIdx.length > 0
    ? Math.sqrt(sumSq / finalInlierIdx.length)
    : Infinity;

  return {
    inliers: finalInlierIdx.map((i) => candidates[i]),
    inlierIndices: finalInlierIdx,
    rmse,
    matrix4x4: refitMatrix,
    thresholdUsed: threshold,
    iterationsRun: iterations,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function autoThreshold(vertices: Vec3[]): number | null {
  if (vertices.length === 0) return null;
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
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return diag > 0 ? diag * 0.05 : null; // 5% of bbox diagonal
}

function pick3Distinct(
  n: number,
  rng: () => number,
): [number, number, number] | null {
  if (n < 3) return null;
  const a = Math.floor(rng() * n);
  let b = Math.floor(rng() * n);
  if (b === a) b = (b + 1) % n;
  let c = Math.floor(rng() * n);
  if (c === a || c === b) c = (Math.max(a, b) + 1) % n;
  if (c === a || c === b) c = (Math.min(a, b) + n - 1) % n;
  if (a === b || a === c || b === c) return null;
  return [a, b, c];
}

function isDegenerateTriangle(p: Vec3[]): boolean {
  const ax = p[1][0] - p[0][0];
  const ay = p[1][1] - p[0][1];
  const az = p[1][2] - p[0][2];
  const bx = p[2][0] - p[0][0];
  const by = p[2][1] - p[0][1];
  const bz = p[2][2] - p[0][2];
  // Cross product magnitude = 2 * triangle area
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const area2 = cx * cx + cy * cy + cz * cz;
  // Compare against the squared length of the two edges to see if the
  // triangle is "thin" (near-collinear).  Rejection threshold is small.
  const lenA2 = ax * ax + ay * ay + az * az;
  const lenB2 = bx * bx + by * by + bz * bz;
  const minEdge = Math.min(lenA2, lenB2);
  if (minEdge < 1e-12) return true;
  // sin^2(angle) = area2 / (lenA2 * lenB2). Reject if angle < ~5.7°
  return area2 / (lenA2 * lenB2) < 0.01;
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
