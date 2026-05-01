/**
 * Partial-to-whole landmark matching with RANSAC.
 *
 * Use case: source mesh is a sub-part (e.g. an arm) and target is the
 * whole character containing that part.  The full-match approach fails
 * because mutual-NN is impossible (most target points have no source
 * counterpart) and bbox-diagonal-based thresholds are way too loose.
 *
 * Key changes vs. globalCandidates / ransacAlign:
 *
 *   1. Source samples: same FPS-on-saliency strategy as before, but few
 *      (~30) and ALL of them are expected to find a partner on target.
 *
 *   2. Target candidates: pick a *much larger* salient pool on target
 *      (~600) so the partial region is well-represented.  Skip mutual-NN.
 *
 *   3. Per source point: keep TOP-K target candidates (default 5) by
 *      descriptor distance — instead of forcing 1-NN.  This expands the
 *      hypothesis space.
 *
 *   4. RANSAC sampling: pick 3 source points; for each, randomly pick
 *      one of its top-K target candidates.  Fit similarity SVD.
 *
 *   5. Inlier scoring: a source sample `s` is an inlier under transform T
 *      iff there exists ANY of its top-K candidates `t_i` such that
 *      ||T(s.pos) - t_i.pos|| < threshold.  This is fundamentally
 *      different from "the predicted partner is the closest target point"
 *      because we don't trust 1-NN.
 *
 *   6. Threshold: by default, 5% of *source* bbox diagonal (the part is
 *      much smaller than the whole, so target-bbox would be too loose).
 *
 *   7. Output: for each inlier source, the actual best-matching target
 *      candidate under the recovered transform.  These pairs are the
 *      landmarks the user accepts.
 */

import type { Vec3, MeshAdjacency, LandmarkCandidate } from './types';
import {
  bboxDiagonal,
  computeScaleAwareCurvature,
  computeVertexSaliency,
  farthestPointSample,
  pickSalientCandidates,
} from './meshFeatures';
import { computeMultiScaleFPFH } from './fpfh';
import {
  computeAxialFrame,
  computeAxialRadialBatch,
  type AxialFrame,
} from './axialFrame';
import {
  computeLandmarkAlignment,
  applyTransform,
  type AlignmentMode,
} from './alignment';

export interface PartialMatchOptions {
  /** Source FPS sample count (default 30; src is small) */
  numSrcSamples?: number;
  /** Target salient pool size; sampled by FPS too (default 200) */
  numTarSamples?: number;
  /** Salient pool size before FPS (default 800 for target, src=400) */
  saliencyPoolSrc?: number;
  saliencyPoolTar?: number;
  /** Top-K target candidates kept per source sample (default 5) */
  topK?: number;
  /**
   * Geometric radii (as fractions of *source* bbox diagonal) at which to
   * sample multi-scale curvature.  Default = [0.05, 0.10, 0.20].  Each
   * radius adds `bins` channels to the descriptor.
   */
  radiusFractions?: number[];
  /** Number of radial bins per scale (default 4) */
  bins?: number;
  /**
   * Which descriptor to use:
   *   'curvature' — multi-scale scale-aware curvature (fast, 12-dim default)
   *   'fpfh'      — Fast Point Feature Histograms (slower, 33-dim per scale,
   *                 much more discriminative for partial-to-whole)
   * Default: 'fpfh'
   */
  descriptor?: 'curvature' | 'fpfh';
  /** RANSAC iterations (default 600) */
  iterations?: number;
  /**
   * Inlier distance threshold, in *source* bbox-diagonal fraction
   * (default 0.05 = 5%).  Source is the smaller mesh, so this is the
   * right scale.  RAW units = srcBboxDiag * threshold.
   */
  inlierThreshold?: number;
  /** Alignment mode (default 'similarity') */
  mode?: AlignmentMode;
  /** Minimum inliers to accept the trial (default 4) */
  minInliers?: number;
  /** Confidence soft-cap for output ordering (default 0.5) */
  softCap?: number;
  /** Seed for deterministic results (optional) */
  seed?: number;
  /**
   * Soft seed constraint on the target side.  When provided, an extra
   * penalty is added to descriptor distance for target candidates that
   * are far from `tarSeedCentroid`.  This biases matching toward a user-
   * indicated region without hard-clipping the candidate pool, which is
   * critical when the user can only seed a small patch of the right area.
   *
   * Penalty (added to squared descriptor distance):
   *   penalty_i = tarSeedWeight * (dist_to_centroid_i / tarSeedRadius)^2
   * Set `tarSeedWeight` to 0 to disable.
   */
  tarSeedCentroid?: Vec3;
  tarSeedRadius?: number;
  tarSeedWeight?: number;
  /** Optional hard filter (kept for compatibility, prefer the soft variant) */
  tarConstraintVertices?: Set<number>;
  /**
   * When `tarConstraintVertices` is provided, choose the target FPS pool
   * from the most salient vertices inside that constraint instead of the
   * whole constraint set. Useful when the constraint is a large
   * through-projected volume and raw FPS would over-sample smooth / hidden
   * geometry. Default false to preserve the previous behavior.
   */
  tarConstraintUseSaliency?: boolean;
  /**
   * Weight for the axial+radial PCA features that are appended to the
   * descriptor.  Use a positive value (e.g. 4-6) to break the symmetry
   * of cylindrical parts (arm, leg).  0 disables the feature entirely.
   * Default = 5.
   */
  axialWeight?: number;
}

export interface PartialMatchResult {
  /** Final inlier landmark pairs (geometrically consistent) */
  pairs: LandmarkCandidate[];
  /** 4x4 transform from source to target (null on failure) */
  matrix4x4: number[][] | null;
  /** RMSE of inliers under the transform, in source-mesh units */
  rmse: number;
  /** Threshold actually used (source-mesh units) */
  thresholdUsed: number;
  /** Diagnostics */
  iterationsRun: number;
  rawSrcSamples: number;
  rawTarSamples: number;
  bestInlierCount: number;
}

const DEFAULTS = {
  numSrcSamples: 30,
  numTarSamples: 200,
  saliencyPoolSrc: 400,
  saliencyPoolTar: 800,
  topK: 5,
  radiusFractions: [0.05, 0.10, 0.20],
  bins: 4,
  descriptor: 'fpfh' as 'curvature' | 'fpfh',
  iterations: 600,
  inlierThreshold: 0.05,
  minInliers: 4,
  softCap: 0.5,
  /**
   * Weight applied to axial / radial PCA features appended to the
   * descriptor.  These two features are decisive on near-cylindrical
   * parts (arms, legs) where pure local geometric descriptors collapse.
   * Set to 0 to disable.  Default 5 makes them comparable in magnitude
   * to one FPFH scale block.
   */
  axialWeight: 5,
};

function pickSalientCandidatesInSet(
  saliency: Float32Array,
  allowed: Set<number>,
  topN: number,
  minSaliency: number,
): number[] {
  const scored: Array<{ idx: number; sal: number }> = [];
  for (const idx of allowed) {
    if (idx < 0 || idx >= saliency.length) continue;
    const sal = saliency[idx];
    if (sal > minSaliency) scored.push({ idx, sal });
  }

  if (scored.length === 0) {
    const fallback: Array<{ idx: number; sal: number }> = [];
    for (const idx of allowed) {
      if (idx < 0 || idx >= saliency.length) continue;
      fallback.push({ idx, sal: saliency[idx] });
    }
    fallback.sort((a, b) => b.sal - a.sal);
    return fallback.slice(0, topN).map(v => v.idx);
  }

  scored.sort((a, b) => b.sal - a.sal);
  return scored.slice(0, topN).map(v => v.idx);
}

export function matchPartialToWhole(
  src: { vertices: Vec3[]; adjacency: MeshAdjacency },
  tar: { vertices: Vec3[]; adjacency: MeshAdjacency },
  options: PartialMatchOptions = {},
): PartialMatchResult {
  const opt = { ...DEFAULTS, ...options };
  const mode: AlignmentMode = opt.mode ?? 'similarity';

  // 1. Saliency + FPS on both meshes
  const srcSal = computeVertexSaliency(src.adjacency);
  const tarSal = computeVertexSaliency(tar.adjacency);
  const srcPool = pickSalientCandidates(srcSal, opt.saliencyPoolSrc, 0.05);
  // Hard target constraint: when provided, IGNORE global saliency on
  // target and use the constraint set itself as the FPS pool. This
  // matches the user intent that "the SAM3 region IS the target zone";
  // mixing in a saliency funnel can starve sparsely-tessellated
  // regions of candidates.
  const tarPool =
    opt.tarConstraintVertices && opt.tarConstraintVertices.size > 0
      ? opt.tarConstraintUseSaliency
        ? pickSalientCandidatesInSet(tarSal, opt.tarConstraintVertices, opt.saliencyPoolTar, 0.05)
        : Array.from(opt.tarConstraintVertices)
      : pickSalientCandidates(tarSal, opt.saliencyPoolTar, 0.05);
  if (srcPool.length === 0 || tarPool.length === 0) {
    return emptyResult(0, opt);
  }
  const srcSamples = farthestPointSample(src.vertices, srcPool, opt.numSrcSamples);
  const tarSamples = farthestPointSample(tar.vertices, tarPool, opt.numTarSamples);

  // 2. Descriptors — density-invariant, using absolute world-space radii.
  const srcBboxDiag = bboxDiagonal(src.vertices);

  // PCA frames for axial/radial features. Source uses its full sample
  // pool (the source mesh IS the part). Target uses its constraint set
  // (the SAM3-reprojected region defines the part on the whole body).
  const useAxial = opt.axialWeight > 0;
  const srcFrame = useAxial ? computeAxialFrame(src.vertices, srcPool) : null;
  const tarFrame = useAxial ? computeAxialFrame(tar.vertices, tarPool) : null;

  // Inner pipeline: given a chosen target frame orientation (axis
  // direction + cross-section basis sign), build descriptors, do top-K,
  // run RANSAC, refit, return the result.  Axis-direction is one bit
  // (axial vs 1 - axial); cross-section basis has two sign bits because
  // axis2 / axis3 = axis × axis2 are arbitrary up to mirror.  Total = 8
  // combinations; we run them all and keep whichever yields the most
  // RANSAC inliers.
  const runPipeline = (
    flipTarAxial: boolean,
    flipTarAxis2: boolean,
    flipTarAxis3: boolean,
  ): PartialMatchResult => {
    const axialOpts =
      useAxial && srcFrame && tarFrame
        ? { srcFrame, tarFrame, flipTarAxial, flipTarAxis2, flipTarAxis3 }
        : undefined;
    const { srcDesc, tarDesc, descDim } = buildDescriptors(
      srcSamples, tarSamples, src, tar, srcBboxDiag, opt, axialOpts,
    );
    return runMatchingTail(
      srcDesc, tarDesc, descDim,
      srcSamples, tarSamples, src, tar,
      srcBboxDiag, opt, mode,
    );
  };

  if (!useAxial) {
    return runPipeline(false, false, false);
  }
  let best: PartialMatchResult | null = null;
  for (const fa of [false, true]) {
    for (const f2 of [false, true]) {
      for (const f3 of [false, true]) {
        const r = runPipeline(fa, f2, f3);
        if (!best || r.bestInlierCount > best.bestInlierCount) best = r;
      }
    }
  }
  return best!;
}

/**
 * Body of the partial-match pipeline starting from precomputed
 * descriptors: top-K candidate matching, RANSAC consistency filter,
 * refit, and final pair extraction. Extracted so the outer function can
 * call it twice (once per axial direction) when PCA features are active.
 */
function runMatchingTail(
  srcDesc: Float32Array,
  tarDesc: Float32Array,
  descDim: number,
  srcSamples: number[],
  tarSamples: number[],
  src: { vertices: Vec3[]; adjacency: MeshAdjacency },
  tar: { vertices: Vec3[]; adjacency: MeshAdjacency },
  srcBboxDiag: number,
  opt: typeof DEFAULTS & PartialMatchOptions,
  mode: AlignmentMode,
): PartialMatchResult {
  const ns = srcSamples.length;
  const nt = tarSamples.length;
  const K = Math.min(opt.topK, nt);
  if (ns < 3 || K === 0) return emptyResult(0, opt);

  const topKIdx = new Int32Array(ns * K);
  const topKDist = new Float32Array(ns * K);

  const seedPenalty = computeSeedPenalty(
    tarSamples, tar.vertices,
    opt.tarSeedCentroid, opt.tarSeedRadius, opt.tarSeedWeight,
  );

  for (let i = 0; i < ns; i++) {
    const heapIdx: number[] = [];
    const heapDist: number[] = [];
    for (let j = 0; j < nt; j++) {
      let d = 0;
      for (let r = 0; r < descDim; r++) {
        const a = srcDesc[i * descDim + r];
        const b = tarDesc[j * descDim + r];
        const dd = a - b;
        d += dd * dd;
      }
      d += seedPenalty[j];
      if (heapIdx.length < K) {
        let p = heapDist.length;
        while (p > 0 && heapDist[p - 1] > d) p--;
        heapDist.splice(p, 0, d);
        heapIdx.splice(p, 0, j);
      } else if (d < heapDist[K - 1]) {
        heapDist.pop();
        heapIdx.pop();
        let p = heapDist.length;
        while (p > 0 && heapDist[p - 1] > d) p--;
        heapDist.splice(p, 0, d);
        heapIdx.splice(p, 0, j);
      }
    }
    for (let k = 0; k < K; k++) {
      topKIdx[i * K + k] = heapIdx[k] ?? -1;
      topKDist[i * K + k] = heapDist[k] ?? Infinity;
    }
  }

  const threshold = srcBboxDiag * opt.inlierThreshold;
  const thresh2 = threshold * threshold;

  const rng = opt.seed !== undefined ? mulberry32(opt.seed) : Math.random;

  let bestInlierSrc: number[] = [];
  let bestInlierTar: number[] = [];
  let bestMatrix: number[][] | null = null;

  for (let trial = 0; trial < opt.iterations; trial++) {
    const triple = pick3Distinct(ns, rng);
    if (!triple) continue;
    const [a, b, c] = triple;

    const ta = topKIdx[a * K + Math.floor(rng() * K)];
    const tb = topKIdx[b * K + Math.floor(rng() * K)];
    const tc = topKIdx[c * K + Math.floor(rng() * K)];
    if (ta < 0 || tb < 0 || tc < 0) continue;
    if (ta === tb || tb === tc || ta === tc) continue;

    const srcPts: Vec3[] = [
      src.vertices[srcSamples[a]],
      src.vertices[srcSamples[b]],
      src.vertices[srcSamples[c]],
    ];
    const tarPts: Vec3[] = [
      tar.vertices[tarSamples[ta]],
      tar.vertices[tarSamples[tb]],
      tar.vertices[tarSamples[tc]],
    ];
    if (isDegenerateTriangle(srcPts) || isDegenerateTriangle(tarPts)) continue;

    let matrix: number[][];
    try {
      matrix = computeLandmarkAlignment(srcPts, tarPts, mode).matrix4x4;
    } catch {
      continue;
    }

    const inSrc: number[] = [];
    const inTar: number[] = [];
    for (let i = 0; i < ns; i++) {
      const sp = src.vertices[srcSamples[i]];
      const mp = applyTransform(sp, matrix);
      let bestK = -1;
      let bestD = Infinity;
      for (let k = 0; k < K; k++) {
        const tj = topKIdx[i * K + k];
        if (tj < 0) continue;
        const tp = tar.vertices[tarSamples[tj]];
        const dx = mp[0] - tp[0];
        const dy = mp[1] - tp[1];
        const dz = mp[2] - tp[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          bestK = tj;
        }
      }
      if (bestD <= thresh2 && bestK >= 0) {
        inSrc.push(i);
        inTar.push(bestK);
      }
    }

    if (inSrc.length > bestInlierSrc.length) {
      bestInlierSrc = inSrc;
      bestInlierTar = inTar;
      bestMatrix = matrix;
    }
  }

  if (bestInlierSrc.length < opt.minInliers || !bestMatrix) {
    return {
      pairs: [],
      matrix4x4: null,
      rmse: Infinity,
      thresholdUsed: threshold,
      iterationsRun: opt.iterations,
      rawSrcSamples: srcSamples.length,
      rawTarSamples: tarSamples.length,
      bestInlierCount: bestInlierSrc.length,
    };
  }

  const refitSrcPts = bestInlierSrc.map((i) => src.vertices[srcSamples[i]]);
  const refitTarPts = bestInlierTar.map((tj) => tar.vertices[tarSamples[tj]]);
  let refitMatrix = bestMatrix;
  try {
    refitMatrix = computeLandmarkAlignment(refitSrcPts, refitTarPts, mode).matrix4x4;
  } catch {
    /* keep bestMatrix */
  }

  const finalPairs: LandmarkCandidate[] = [];
  let sumSq = 0;
  let count = 0;
  for (const i of bestInlierSrc) {
    const sp = src.vertices[srcSamples[i]];
    const mp = applyTransform(sp, refitMatrix);
    let bestK = -1;
    let bestD = Infinity;
    for (let k = 0; k < K; k++) {
      const tj = topKIdx[i * K + k];
      if (tj < 0) continue;
      const tp = tar.vertices[tarSamples[tj]];
      const dx = mp[0] - tp[0];
      const dy = mp[1] - tp[1];
      const dz = mp[2] - tp[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        bestK = tj;
      }
    }
    if (bestD > thresh2 || bestK < 0) continue;

    const tarVtx = tarSamples[bestK];
    const srcVtx = srcSamples[i];
    const conf = Math.exp(-Math.sqrt(bestD) / Math.max(opt.softCap * threshold, 1e-9));
    finalPairs.push({
      srcVertex: srcVtx,
      srcPosition: src.vertices[srcVtx],
      tarVertex: tarVtx,
      tarPosition: tar.vertices[tarVtx],
      confidence: conf,
      descriptorDist: Math.sqrt(bestD),
      suggestAccept: conf >= 0.5,
    });
    sumSq += bestD;
    count++;
  }
  const rmse = count > 0 ? Math.sqrt(sumSq / count) : Infinity;

  finalPairs.sort((a, b) => b.confidence - a.confidence);

  return {
    pairs: finalPairs,
    matrix4x4: refitMatrix,
    rmse,
    thresholdUsed: threshold,
    iterationsRun: opt.iterations,
    rawSrcSamples: srcSamples.length,
    rawTarSamples: tarSamples.length,
    bestInlierCount: bestInlierSrc.length,
  };
}

// ---------------------------------------------------------------------------
// Debug visualisation
// ---------------------------------------------------------------------------

export interface PartialDebugResult {
  /** Top-N salient src vertex indices (size = saliencyPoolSrc) */
  srcSaliencyTop: number[];
  /** Top-N salient tar vertex indices (size = saliencyPoolTar) */
  tarSaliencyTop: number[];
  /** FPS-down-sampled src indices (size = numSrcSamples) */
  srcFPS: number[];
  /** FPS-down-sampled tar indices (size = numTarSamples) */
  tarFPS: number[];
  /**
   * For each src in srcFPS, list of (tar vertex index, descriptor distance).
   * Sorted by ascending distance (closest first).  Length = topK.
   */
  topKMatches: { srcVertex: number; matches: Array<{ tarVertex: number; dist: number }> }[];
  /** Average descriptor distance of the closest top-K match across all src */
  avgBestDist: number;
}

/**
 * Run the descriptor + matching pipeline and return *all* intermediate
 * results for visual debugging — no RANSAC.  Use this to see where the
 * algorithm is selecting points and whether the top-K candidates land
 * on the correct part of the target mesh.
 */
export function computePartialDebug(
  src: { vertices: Vec3[]; adjacency: MeshAdjacency },
  tar: { vertices: Vec3[]; adjacency: MeshAdjacency },
  options: PartialMatchOptions = {},
): PartialDebugResult {
  const opt = { ...DEFAULTS, ...options };

  const srcSal = computeVertexSaliency(src.adjacency);
  const tarSal = computeVertexSaliency(tar.adjacency);
  const srcSaliencyTop = pickSalientCandidates(srcSal, opt.saliencyPoolSrc, 0.05);
  const tarSaliencyTop =
    opt.tarConstraintVertices && opt.tarConstraintVertices.size > 0
      ? opt.tarConstraintUseSaliency
        ? pickSalientCandidatesInSet(tarSal, opt.tarConstraintVertices, opt.saliencyPoolTar, 0.05)
        : Array.from(opt.tarConstraintVertices)
      : pickSalientCandidates(tarSal, opt.saliencyPoolTar, 0.05);

  const srcFPS = farthestPointSample(src.vertices, srcSaliencyTop, opt.numSrcSamples);
  const tarFPS = farthestPointSample(tar.vertices, tarSaliencyTop, opt.numTarSamples);

  const srcBboxDiag = bboxDiagonal(src.vertices);
  // Match the live pipeline: include axial+radial features when enabled.
  // Debug always uses the FORWARD axial direction so what the user sees
  // here is the same as the forward run of `matchPartialToWhole`.
  const useAxial = opt.axialWeight > 0;
  const srcFrame = useAxial ? computeAxialFrame(src.vertices, srcSaliencyTop) : null;
  const tarFrame = useAxial ? computeAxialFrame(tar.vertices, tarSaliencyTop) : null;
  const axialOpts =
    useAxial && srcFrame && tarFrame
      ? { srcFrame, tarFrame, flipTarAxial: false, flipTarAxis2: false, flipTarAxis3: false }
      : undefined;
  const { srcDesc, tarDesc, descDim: _dim } = buildDescriptors(
    srcFPS, tarFPS, src, tar, srcBboxDiag, opt, axialOpts,
  );
  const totalChannels = _dim;

  const K = Math.min(opt.topK, tarFPS.length);
  const topKMatches: PartialDebugResult['topKMatches'] = [];
  let bestDistSum = 0;
  let bestDistCount = 0;

  const seedPenalty = computeSeedPenalty(
    tarFPS, tar.vertices,
    opt.tarSeedCentroid, opt.tarSeedRadius, opt.tarSeedWeight,
  );

  for (let i = 0; i < srcFPS.length; i++) {
    const heap: Array<{ tarVertex: number; dist: number }> = [];
    for (let j = 0; j < tarFPS.length; j++) {
      let d = 0;
      for (let r = 0; r < totalChannels; r++) {
        const a = srcDesc[i * totalChannels + r];
        const b = tarDesc[j * totalChannels + r];
        const dd = a - b;
        d += dd * dd;
      }
      d += seedPenalty[j];
      const distance = Math.sqrt(d);
      const entry = { tarVertex: tarFPS[j], dist: distance };
      if (heap.length < K) {
        let p = heap.length;
        while (p > 0 && heap[p - 1].dist > distance) p--;
        heap.splice(p, 0, entry);
      } else if (distance < heap[K - 1].dist) {
        heap.pop();
        let p = heap.length;
        while (p > 0 && heap[p - 1].dist > distance) p--;
        heap.splice(p, 0, entry);
      }
    }
    topKMatches.push({ srcVertex: srcFPS[i], matches: heap });
    if (heap.length > 0) {
      bestDistSum += heap[0].dist;
      bestDistCount++;
    }
  }

  return {
    srcSaliencyTop,
    tarSaliencyTop,
    srcFPS,
    tarFPS,
    topKMatches,
    avgBestDist: bestDistCount > 0 ? bestDistSum / bestDistCount : 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MeshInput = { vertices: Vec3[]; adjacency: MeshAdjacency };

function buildDescriptors(
  srcIndices: number[],
  tarIndices: number[],
  src: MeshInput,
  tar: MeshInput,
  srcBboxDiag: number,
  opt: typeof DEFAULTS,
  axialOpts?: {
    srcFrame: AxialFrame;
    tarFrame: AxialFrame;
    /** Flip the target's axial coordinate (axial → 1 - axial). */
    flipTarAxial: boolean;
    /** Negate the target's cosAz channel (mirror axis2 direction). */
    flipTarAxis2: boolean;
    /** Negate the target's sinAz channel (mirror axis3 direction). */
    flipTarAxis3: boolean;
  },
): { srcDesc: Float32Array; tarDesc: Float32Array; descDim: number } {
  const radii = opt.radiusFractions.map((f) => f * srcBboxDiag);

  // 1) Geometric channels (FPFH or curvature). These come first.
  let geomDim: number;
  let geomSrc: Float32Array;
  let geomTar: Float32Array;
  if (opt.descriptor === 'fpfh') {
    geomSrc = computeMultiScaleFPFH(srcIndices, src.vertices, src.adjacency, radii);
    geomTar = computeMultiScaleFPFH(tarIndices, tar.vertices, tar.adjacency, radii);
    geomDim = radii.length * 33;
  } else {
    const channelsPerScale = opt.bins;
    geomDim = radii.length * channelsPerScale;
    geomSrc = new Float32Array(srcIndices.length * geomDim);
    geomTar = new Float32Array(tarIndices.length * geomDim);
    for (let r = 0; r < radii.length; r++) {
      const sp = computeScaleAwareCurvature(srcIndices, src.vertices, src.adjacency, radii[r], opt.bins);
      const tp = computeScaleAwareCurvature(tarIndices, tar.vertices, tar.adjacency, radii[r], opt.bins);
      for (let i = 0; i < srcIndices.length; i++) {
        for (let b = 0; b < opt.bins; b++) {
          geomSrc[i * geomDim + r * opt.bins + b] = sp[i * opt.bins + b];
        }
      }
      for (let j = 0; j < tarIndices.length; j++) {
        for (let b = 0; b < opt.bins; b++) {
          geomTar[j * geomDim + r * opt.bins + b] = tp[j * opt.bins + b];
        }
      }
    }
  }

  // 2) Optional axial+radial+azimuth channels appended at the end.
  // Layout per sample: [axial, radial, cosAz, sinAz] all weighted.
  const useAxial = !!axialOpts && opt.axialWeight > 0;
  const extraDim = useAxial ? 4 : 0;
  const totalDim = geomDim + extraDim;
  if (!useAxial) {
    return { srcDesc: geomSrc, tarDesc: geomTar, descDim: geomDim };
  }

  const w = opt.axialWeight;
  const srcDesc = new Float32Array(srcIndices.length * totalDim);
  const tarDesc = new Float32Array(tarIndices.length * totalDim);
  // Copy geometric channels first.
  for (let i = 0; i < srcIndices.length; i++) {
    for (let c = 0; c < geomDim; c++) {
      srcDesc[i * totalDim + c] = geomSrc[i * geomDim + c];
    }
  }
  for (let j = 0; j < tarIndices.length; j++) {
    for (let c = 0; c < geomDim; c++) {
      tarDesc[j * totalDim + c] = geomTar[j * geomDim + c];
    }
  }
  // Append axial+radial+azimuth, each weighted by `axialWeight`.
  const srcAR = computeAxialRadialBatch(srcIndices, src.vertices, axialOpts.srcFrame);
  const tarAR = computeAxialRadialBatch(tarIndices, tar.vertices, axialOpts.tarFrame);
  for (let i = 0; i < srcIndices.length; i++) {
    srcDesc[i * totalDim + geomDim] = srcAR[i * 4] * w;
    srcDesc[i * totalDim + geomDim + 1] = srcAR[i * 4 + 1] * w;
    srcDesc[i * totalDim + geomDim + 2] = srcAR[i * 4 + 2] * w;
    srcDesc[i * totalDim + geomDim + 3] = srcAR[i * 4 + 3] * w;
  }
  const flipA = axialOpts.flipTarAxial;
  const sCos = axialOpts.flipTarAxis2 ? -1 : 1;
  const sSin = axialOpts.flipTarAxis3 ? -1 : 1;
  for (let j = 0; j < tarIndices.length; j++) {
    const a = flipA ? 1 - tarAR[j * 4] : tarAR[j * 4];
    tarDesc[j * totalDim + geomDim] = a * w;
    tarDesc[j * totalDim + geomDim + 1] = tarAR[j * 4 + 1] * w;
    tarDesc[j * totalDim + geomDim + 2] = sCos * tarAR[j * 4 + 2] * w;
    tarDesc[j * totalDim + geomDim + 3] = sSin * tarAR[j * 4 + 3] * w;
  }
  return { srcDesc, tarDesc, descDim: totalDim };
}

/**
 * Soft penalty per target sample for descriptor-distance scoring.
 * Returns a Float32Array same length as `tarSamples` whose value is the
 * squared-distance penalty to add to descriptor distance for that sample.
 *
 * If centroid/radius/weight are missing or weight=0, returns zeros.
 */
function computeSeedPenalty(
  tarSamples: number[],
  tarVertices: Vec3[],
  centroid?: Vec3,
  radius?: number,
  weight?: number,
): Float32Array {
  const out = new Float32Array(tarSamples.length);
  const w = weight ?? 0;
  if (!centroid || !radius || radius <= 0 || w <= 0) return out;
  const invR2 = 1 / (radius * radius);
  for (let j = 0; j < tarSamples.length; j++) {
    const p = tarVertices[tarSamples[j]];
    if (!p) continue;
    const dx = p[0] - centroid[0];
    const dy = p[1] - centroid[1];
    const dz = p[2] - centroid[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    out[j] = w * d2 * invR2;
  }
  return out;
}

function emptyResult(threshold: number, _opt: typeof DEFAULTS): PartialMatchResult {
  return {
    pairs: [],
    matrix4x4: null,
    rmse: Infinity,
    thresholdUsed: threshold,
    iterationsRun: 0,
    rawSrcSamples: 0,
    rawTarSamples: 0,
    bestInlierCount: 0,
  };
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
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const area2 = cx * cx + cy * cy + cz * cz;
  const lenA2 = ax * ax + ay * ay + az * az;
  const lenB2 = bx * bx + by * by + bz * bz;
  const minEdge = Math.min(lenA2, lenB2);
  if (minEdge < 1e-12) return true;
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
