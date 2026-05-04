/**
 * Pure runner functions extracted from V1 ModelAssemble.handleAutoAlign().
 *
 * Each runner takes mesh + strategy-specific inputs and returns a complete
 * AlignmentResult. The runners do NOT touch React state, do NOT log to UI
 * trace, and do NOT depend on Page3Session / project shape — they are safe
 * to call from V2 (or future callers) without a viewport mounted.
 *
 * Algorithm equivalence note (Stage 8/5–8/7):
 *   The two-step pipeline (SVD landmark fit → ICP refine, then choose
 *   finalMatrix via the `useIcp` predicate) is exactly the V1 pipeline at
 *   ModelAssemble.tsx L3060–3175. ICP defaults match V1 exactly.
 *
 * Phase A6:
 *   runPoseProxy 现在是 thin wrapper，委托给 poseProxySteps 的步骤函数。
 *   算法等价性由步骤函数实现保证（同一份 buildSkeletonProxy / computePoseAlignment
 *   / finalizeWithIcp 调用链）。
 *
 * V1 stays untouched until Stage 9; these are net-new functions.
 */

import type { Vec3, LandmarkCandidate, MeshAdjacency } from '../../three';
import type { AlignmentMode, AlignmentResult } from '../../three/alignment';
import type { IcpOptions, OrthoFrontCamera } from '../../three';
import type { Joint2D } from '../../types/joints';
import { buildProxies as ppBuildProxies } from './poseProxySteps';
import { detectLimbAnchors } from './limbStructureSteps';
import { surfaceMatch } from './surfaceSteps';
import {
  alignSourceMeshByLandmarks,
  applyTransform,
} from '../../three/alignment';
import {
  icpRefine,
} from '../../three';

// ── Defaults (mirror V1 ModelAssemble) ──────────────────────────────────

const DEFAULT_ALIGNMENT_MODE: AlignmentMode = 'similarity';

/** V1 ICP defaults (ModelAssemble icpMaxIterations / icpSampleCount / ...). */
export const DEFAULT_ICP: Required<Pick<IcpOptions,
  'maxIterations' | 'sampleCount' | 'rejectMultiplier' | 'convergenceImprovement'
>> = {
  maxIterations: 30,
  sampleCount: 400,
  rejectMultiplier: 2.5,
  convergenceImprovement: 0.005,
};

// ── Public types ────────────────────────────────────────────────────────

export interface RunnerMesh {
  vertices: Vec3[];
}

export interface RunnerOptions {
  /** RNG seed forwarded to ICP. */
  seed?: number;
  /** Per-call overrides on top of DEFAULT_ICP. */
  icp?: Partial<typeof DEFAULT_ICP>;
  /** SVD/ICP rigidity mode. Defaults to 'similarity' (V1 default). */
  alignmentMode?: AlignmentMode;
}

export interface RunnerOutcome {
  result: AlignmentResult;
  pairs: LandmarkCandidate[];
  method: 'ICP' | 'SVD';
  finalMatrix: number[][];
  lmFitMatrix: number[][];
  icpMatrix: number[][];
  /** ICP RMSE (NaN if ICP rejected). */
  icpRmse: number;
  /** Sparse landmark RMSE under lmFit matrix. */
  lmFitLandmarkRmse: number;
}

// ── Internal helpers ────────────────────────────────────────────────────

function matrixSimilarityScale(matrix4x4: number[][]): number {
  const sx = Math.sqrt(matrix4x4[0][0] ** 2 + matrix4x4[1][0] ** 2 + matrix4x4[2][0] ** 2);
  const sy = Math.sqrt(matrix4x4[0][1] ** 2 + matrix4x4[1][1] ** 2 + matrix4x4[2][1] ** 2);
  const sz = Math.sqrt(matrix4x4[0][2] ** 2 + matrix4x4[1][2] ** 2 + matrix4x4[2][2] ** 2);
  return (sx + sy + sz) / 3;
}

function evalRmseOnLandmarks(pairs: LandmarkCandidate[], m: number[][]): number {
  if (pairs.length === 0) return 0;
  let s = 0;
  for (const p of pairs) {
    const t = applyTransform(p.srcPosition, m);
    const dx = t[0] - p.tarPosition[0];
    const dy = t[1] - p.tarPosition[1];
    const dz = t[2] - p.tarPosition[2];
    s += dx * dx + dy * dy + dz * dz;
  }
  return Math.sqrt(s / pairs.length);
}

/**
 * Shared finalize step: SVD landmark fit → ICP refine → choose finalMatrix
 * via V1's `useIcp` predicate, then build the AlignmentResult.
 *
 * This is the verbatim common tail of V1 handleAutoAlign (L3104–3175).
 */
export function finalizeWithIcp(
  srcVertices: Vec3[],
  tarVertices: Vec3[],
  pairs: LandmarkCandidate[],
  opts: RunnerOptions = {},
  tarConstraintVertices?: Set<number>,
): RunnerOutcome {
  if (pairs.length < 3) {
    throw new Error(`finalizeWithIcp: need ≥3 pairs, got ${pairs.length}`);
  }
  const mode = opts.alignmentMode ?? DEFAULT_ALIGNMENT_MODE;
  const icpCfg = { ...DEFAULT_ICP, ...(opts.icp ?? {}) };

  // 1. SVD landmark fit on accepted pairs.
  const lmFit = alignSourceMeshByLandmarks(
    srcVertices,
    pairs.map((p) => p.srcPosition),
    pairs.map((p) => p.tarPosition),
    mode,
  );

  // 2. ICP refine, restricted to the target SAM3 region when provided.
  const icp = icpRefine(srcVertices, tarVertices, lmFit.matrix4x4, {
    maxIterations: icpCfg.maxIterations,
    sampleCount: icpCfg.sampleCount,
    rejectMultiplier: icpCfg.rejectMultiplier,
    convergenceImprovement: icpCfg.convergenceImprovement,
    firstIterMode: mode,
    subsequentMode: mode,
    seed: opts.seed,
    tarRestrictVertices: tarConstraintVertices,
  });

  const lmFitLandmarkRmse = evalRmseOnLandmarks(pairs, lmFit.matrix4x4);

  // 3. Choose ICP vs SVD using V1's predicate.
  const bestIcpIter = icp.iterations[icp.bestIteration];
  const minIcpPairsKept = Math.min(30, Math.max(6, Math.floor(icpCfg.sampleCount * 0.1)));
  const useIcp = Number.isFinite(icp.rmse)
    && icp.iterations.length > 0
    && !!bestIcpIter
    && bestIcpIter.pairsKept >= minIcpPairsKept;
  const finalMatrix = useIcp ? icp.matrix4x4 : lmFit.matrix4x4;
  const finalRmse = useIcp ? icp.rmse : lmFitLandmarkRmse;

  // 4. Build AlignmentResult — same shape V1 returns.
  const transformedVertices = srcVertices.map((v) => applyTransform(v, finalMatrix));
  const alignedSrcLandmarks = pairs.map((p) => applyTransform(p.srcPosition, finalMatrix));
  const targetLandmarks = pairs.map((p) => p.tarPosition);

  let sum = 0;
  let maxErr = 0;
  for (let i = 0; i < pairs.length; i++) {
    const a = alignedSrcLandmarks[i];
    const b = targetLandmarks[i];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    const e = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sum += e;
    if (e > maxErr) maxErr = e;
  }
  const meanError = pairs.length > 0 ? sum / pairs.length : 0;

  const result: AlignmentResult = {
    mode,
    matrix4x4: finalMatrix,
    transformedVertices,
    alignedSrcLandmarks,
    targetLandmarks,
    rmse: finalRmse,
    meanError,
    maxError: maxErr,
    scale: matrixSimilarityScale(finalMatrix),
  };

  return {
    result,
    pairs,
    method: useIcp ? 'ICP' : 'SVD',
    finalMatrix,
    lmFitMatrix: lmFit.matrix4x4,
    icpMatrix: icp.matrix4x4,
    icpRmse: icp.rmse,
    lmFitLandmarkRmse,
  };
}

// ── Strategy: Pose Proxy ────────────────────────────────────────────────

export interface RunPoseProxyInput {
  src: RunnerMesh;
  tar: RunnerMesh;
  srcJoints: Joint2D[];
  tarJoints: Joint2D[];
  srcCamera: OrthoFrontCamera;
  tarCamera: OrthoFrontCamera;
  /** Optional SAM3 region restricting ICP nearest-neighbor search. */
  tarConstraintVertices?: Set<number>;
}

export class PoseProxyAnchorError extends Error {
  constructor(public pairs: number) {
    super(`runPoseProxy: insufficient anchor pairs (got ${pairs}, need ≥3)`);
    this.name = 'PoseProxyAnchorError';
  }
}

/**
 * Pose-proxy strategy: build skeleton proxies on src + tar, run SVD pose
 * alignment, append direct shoulder/elbow joint pairs, then finalize with
 * ICP. Mirrors the 'pose-proxy' branch of V1 handleAutoAlign (L2880–2980).
 *
 * Phase A6: 现在是 thin wrapper，内部调用 poseProxySteps 的 5 个步骤函数。
 * 行为与原实现完全一致（算法等价）。
 */
export function runPoseProxy(input: RunPoseProxyInput, opts: RunnerOptions = {}): RunnerOutcome {
  // Phase A6: 委托给 poseProxySteps.buildProxies（步骤 3 的核心逻辑）。
  const proxies = ppBuildProxies({
    srcVertices: input.src.vertices,
    tarVertices: input.tar.vertices,
    srcJoints: input.srcJoints,
    tarJoints: input.tarJoints,
    srcCamera: input.srcCamera,
    tarCamera: input.tarCamera,
    tarConstraintVertices: input.tarConstraintVertices,
  });

  if (proxies.pairs.length < 3) {
    throw new PoseProxyAnchorError(proxies.pairs.length);
  }

  // Step 4 + 5: finalizeWithIcp (SVD + ICP)
  return finalizeWithIcp(
    input.src.vertices,
    input.tar.vertices,
    proxies.pairs,
    opts,
    input.tarConstraintVertices,
  );
}

// ── Strategy: Limb Structure ──────────────────────────────────

export interface RunLimbStructureInput {
  src: RunnerMesh;
  tar: RunnerMesh;
  /** Optional SAM3 region restricting both anchor detection and ICP search. */
  tarConstraintVertices?: Set<number>;
  /** Optional set of "body" vertices used to disambiguate root vs end anchor. */
  tarBodyVertices?: Set<number>;
}

export class LimbStructureMatchError extends Error {
  constructor(public reason: string, public pairs: number) {
    super(`runLimbStructure: match failed (reason=${reason}, pairs=${pairs})`);
    this.name = 'LimbStructureMatchError';
  }
}

/**
 * Limb-structure strategy: detect 3 raw limb anchors (root/bend/end) on both
 * meshes via PCA + slice histogram, then finalize with ICP. Mirrors the
 * 'limb-structure' branch of V1 handleAutoAlign (L2992–3003).
 *
 * Phase B: thin wrapper → limbStructureSteps.detectLimbAnchors + finalizeWithIcp.
 */
export function runLimbStructure(
  input: RunLimbStructureInput,
  opts: RunnerOptions = {},
): RunnerOutcome {
  let detect;
  try {
    detect = detectLimbAnchors({
      srcVertices: input.src.vertices,
      tarVertices: input.tar.vertices,
      tarConstraintVertices: input.tarConstraintVertices,
      tarBodyVertices: input.tarBodyVertices,
      alignmentMode: opts.alignmentMode ?? DEFAULT_ALIGNMENT_MODE,
    });
  } catch (e) {
    // 保持原错误类型 LimbStructureMatchError 以免上游 catch 逻辑变化
    if (e instanceof Error && e.name === 'LimbAnchorDetectError') {
      const detectErr = e as Error & { reason?: string; pairs?: number };
      throw new LimbStructureMatchError(detectErr.reason ?? 'unknown', detectErr.pairs ?? 0);
    }
    throw e;
  }

  return finalizeWithIcp(
    input.src.vertices,
    input.tar.vertices,
    detect.pairs,
    opts,
    input.tarConstraintVertices,
  );
}

// ── Strategy: Surface (partial-to-whole) ──────────────────────────

/** V1 partial-match defaults (ModelAssemble L696–707). */
export const DEFAULT_SURFACE: {
  numSrcSamples: number;
  numTarSamples: number;
  topK: number;
  iterations: number;
  inlierThresholdPct: number;
  descriptor: 'curvature' | 'fpfh';
  seedWeight: number;
  axialWeight: number;
  macroSaliencyRings: number;
} = {
  numSrcSamples: 25,
  numTarSamples: 80,
  topK: 8,
  iterations: 600,
  inlierThresholdPct: 5,
  descriptor: 'fpfh',
  seedWeight: 5.0,
  axialWeight: 5.0,
  macroSaliencyRings: 6,
};

export interface RunSurfaceInput {
  src: { vertices: Vec3[]; adjacency: MeshAdjacency };
  tar: { vertices: Vec3[]; adjacency: MeshAdjacency };
  /** Optional SAM3 region restricting target candidate pool + ICP search. */
  tarConstraintVertices?: Set<number>;
  /** Soft seed centroid (target-side bias). */
  tarSeedCentroid?: Vec3;
  /** Soft seed radius (used to scale the soft-seed penalty). */
  tarSeedRadius?: number;
}

export interface RunSurfaceOptions extends RunnerOptions {
  /** Per-call overrides on top of DEFAULT_SURFACE. */
  surface?: Partial<typeof DEFAULT_SURFACE>;
}

export class SurfaceMatchError extends Error {
  constructor(public bestInlierCount: number, public pairs: number) {
    super(`runSurface: partial-match failed (inliers=${bestInlierCount}, pairs=${pairs})`);
    this.name = 'SurfaceMatchError';
  }
}

/**
 * Surface strategy: FPFH/curvature descriptor matching + RANSAC, then
 * finalize with ICP. Mirrors the surface (else) branch of V1
 * handleAutoAlign (L3004–3029).
 *
 * Phase B: thin wrapper → surfaceSteps.surfaceMatch + finalizeWithIcp.
 */
export function runSurface(
  input: RunSurfaceInput,
  opts: RunSurfaceOptions = {},
): RunnerOutcome {
  let pm;
  try {
    pm = surfaceMatch({
      srcVertices: input.src.vertices,
      srcAdjacency: input.src.adjacency,
      tarVertices: input.tar.vertices,
      tarAdjacency: input.tar.adjacency,
      tarConstraintVertices: input.tarConstraintVertices,
      tarSeedCentroid: input.tarSeedCentroid,
      tarSeedRadius: input.tarSeedRadius,
      surface: opts.surface,
      seed: opts.seed,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'SurfaceMatchError') {
      const sErr = e as Error & { bestInlierCount?: number; pairs?: number };
      throw new SurfaceMatchError(sErr.bestInlierCount ?? 0, sErr.pairs ?? 0);
    }
    throw e;
  }

  return finalizeWithIcp(
    input.src.vertices,
    input.tar.vertices,
    pm.pairs,
    opts,
    input.tarConstraintVertices,
  );
}
