/**
 * Phase B — Surface (RANSAC) 真分步。
 *
 * Surface 计划四步：sample-fpfh / ransac / svd / icp。
 *
 * 注意：原 matchPartialToWhole() 把"采样 + 描述子 + RANSAC + 内部 SVD"
 * 全做完一次返回，无法在不重写底层算法的前提下做真正的 4 子步切分。
 * 因此这里：
 *   - Step "sample-fpfh + ransac" 合并为 surfaceMatch()，返回 pairs +
 *     bestInlierCount。UI 上仍可展示 4 个步条目（前两条共享一次执行）。
 *   - Step solveSvd / solveIcp 复用 poseProxySteps 共享实现。
 *
 * 行为与原 runSurface 完全等价（pairs → finalizeWithIcp → SVD + ICP）。
 */

import type { Vec3, LandmarkCandidate, MeshAdjacency } from '../../three';
import { matchPartialToWhole } from '../../three';
import { solveSvd, solveIcp } from './poseProxySteps';
export { solveSvd, solveIcp } from './poseProxySteps';
export type {
  SolveSvdInput, SolveSvdOutput,
  SolveIcpInput, SolveIcpOutput,
  IcpConfig,
} from './poseProxySteps';
export { DEFAULT_ICP_CONFIG } from './poseProxySteps';

// ── 表面策略默认参数（与 runners.ts DEFAULT_SURFACE 对齐）───────────

export interface SurfaceConfig {
  numSrcSamples: number;
  numTarSamples: number;
  topK: number;
  iterations: number;
  inlierThresholdPct: number;
  descriptor: 'curvature' | 'fpfh';
  seedWeight: number;
  axialWeight: number;
  macroSaliencyRings: number;
}

export const DEFAULT_SURFACE_CONFIG: SurfaceConfig = {
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

const PARTIAL_SAMPLE_POOL_MODE = 'robust' as const;
const PARTIAL_RADIUS_FRACTIONS = [0.08, 0.16, 0.32];

// ── Step 1+2: surfaceMatch (sample + descriptor + RANSAC) ──────────

export interface SurfaceMatchInput {
  srcVertices: Vec3[];
  srcAdjacency: MeshAdjacency;
  tarVertices: Vec3[];
  tarAdjacency: MeshAdjacency;
  tarConstraintVertices?: Set<number>;
  tarSeedCentroid?: Vec3;
  tarSeedRadius?: number;
  surface?: Partial<SurfaceConfig>;
  seed?: number;
}

export interface SurfaceMatchOutput {
  pairs: LandmarkCandidate[];
  bestInlierCount: number;
  /** matchPartialToWhole 内部 SVD 矩阵（调试用，下游不使用） */
  innerMatrix: number[][] | null;
}

export class SurfaceMatchError extends Error {
  constructor(public bestInlierCount: number, public pairs: number) {
    super(`surfaceMatch: insufficient inliers/pairs (inliers=${bestInlierCount}, pairs=${pairs})`);
    this.name = 'SurfaceMatchError';
  }
}

/**
 * Step 1+2: FPFH/曲率描述子采样 + RANSAC 投票（原子操作，
 * matchPartialToWhole 无法进一步拆分）。
 */
export function surfaceMatch(input: SurfaceMatchInput): SurfaceMatchOutput {
  const cfg = { ...DEFAULT_SURFACE_CONFIG, ...(input.surface ?? {}) };
  const hasRegion = !!input.tarConstraintVertices && input.tarConstraintVertices.size > 0;

  const pm = matchPartialToWhole(
    { vertices: input.srcVertices, adjacency: input.srcAdjacency },
    { vertices: input.tarVertices, adjacency: input.tarAdjacency },
    {
      numSrcSamples: cfg.numSrcSamples,
      numTarSamples: cfg.numTarSamples,
      topK: cfg.topK,
      iterations: cfg.iterations,
      inlierThreshold: cfg.inlierThresholdPct / 100,
      descriptor: cfg.descriptor,
      samplePoolMode: PARTIAL_SAMPLE_POOL_MODE,
      radiusFractions: PARTIAL_RADIUS_FRACTIONS,
      macroSaliencyRings: cfg.macroSaliencyRings,
      tarSeedCentroid: input.tarSeedCentroid,
      tarSeedRadius: input.tarSeedRadius,
      tarSeedWeight: hasRegion ? cfg.seedWeight : 0,
      tarConstraintVertices: input.tarConstraintVertices,
      tarConstraintUseSaliency: hasRegion,
      axialWeight: cfg.axialWeight,
      seed: input.seed,
    },
  );
  if (!pm.matrix4x4 || pm.pairs.length < 3) {
    throw new SurfaceMatchError(pm.bestInlierCount, pm.pairs.length);
  }
  return {
    pairs: pm.pairs,
    bestInlierCount: pm.bestInlierCount,
    innerMatrix: pm.matrix4x4,
  };
}

export { solveSvd as solveSvdStep, solveIcp as solveIcpStep };
