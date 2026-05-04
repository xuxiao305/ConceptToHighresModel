/**
 * Phase B — Limb Structure 真分步。
 *
 * Limb 三步：detect-anchors / svd / icp。
 *
 * 注意：原始 matchLimbStructureToWhole() 内部把"检测锚点 + SVD 拟合"
 * 耦合在一起返回 (matrix4x4, pairs)。为了保留与 V1/runner 完全一致的
 * 算法行为，这里：
 *   - Step 1 detectAnchors() 调 matchLimbStructureToWhole，返回 pairs
 *     （丢弃其内部 matrix；下游 SVD 重新拟合，与 finalizeWithIcp 的
 *     行为一致）。
 *   - Step 2 solveSvd / Step 3 solveIcp 直接复用 poseProxySteps 的
 *     共享实现。
 */

import type { Vec3, LandmarkCandidate } from '../../three';
import type { AlignmentMode } from '../../three/alignment';
import { matchLimbStructureToWhole } from '../../three';
import { solveSvd, solveIcp } from './poseProxySteps';
export { solveSvd, solveIcp } from './poseProxySteps';
export type {
  SolveSvdInput, SolveSvdOutput,
  SolveIcpInput, SolveIcpOutput,
  IcpConfig,
} from './poseProxySteps';
export { DEFAULT_ICP_CONFIG } from './poseProxySteps';

// ── Step 1: detectAnchors ──────────────────────────────────────────

export interface DetectLimbAnchorsInput {
  srcVertices: Vec3[];
  tarVertices: Vec3[];
  tarConstraintVertices?: Set<number>;
  tarBodyVertices?: Set<number>;
  alignmentMode?: AlignmentMode;
}

export interface DetectLimbAnchorsOutput {
  pairs: LandmarkCandidate[];
  /** matchLimbStructureToWhole 内部 SVD 的结果矩阵（仅供调试/比较，下游不使用） */
  innerMatrix: number[][] | null;
  /** 失败原因（pairs 不足时填充） */
  reason?: string;
}

export class LimbAnchorDetectError extends Error {
  constructor(public reason: string, public pairs: number) {
    super(`detectLimbAnchors: ${reason} (pairs=${pairs})`);
    this.name = 'LimbAnchorDetectError';
  }
}

/**
 * Step 1: 在源/目标 mesh 上检测肢体结构锚点（root/bend/end 三层）。
 */
export function detectLimbAnchors(input: DetectLimbAnchorsInput): DetectLimbAnchorsOutput {
  const pm = matchLimbStructureToWhole(
    { vertices: input.srcVertices },
    { vertices: input.tarVertices },
    {
      tarConstraintVertices: input.tarConstraintVertices,
      tarBodyVertices: input.tarBodyVertices,
      mode: input.alignmentMode ?? 'similarity',
    },
  );
  const reason = typeof pm.diagnostics?.reason === 'string' ? pm.diagnostics.reason : undefined;
  if (!pm.matrix4x4 || pm.pairs.length < 3) {
    throw new LimbAnchorDetectError(reason ?? 'unknown', pm.pairs.length);
  }
  return { pairs: pm.pairs, innerMatrix: pm.matrix4x4, reason };
}

// 重新导出共享步骤以便集中导入
export { solveSvd as solveSvdStep, solveIcp as solveIcpStep };
