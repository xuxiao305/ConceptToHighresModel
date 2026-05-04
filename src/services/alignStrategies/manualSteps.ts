/**
 * Phase B — Manual Landmark 真分步。
 *
 * Manual 天然两步：svd / icp（"collect" 是 UI 交互，不是算法步骤，
 * 由 ModelAssemble 监听 landmark 拾取计数即可显示状态）。
 *
 * 直接复用 poseProxySteps 的 solveSvd / solveIcp 共享实现 —
 * 因为 manual 拿到的就是已配对的 LandmarkCandidate。
 */

import type { Vec3, LandmarkCandidate } from '../../three';

export { solveSvd, solveIcp } from './poseProxySteps';
export type {
  SolveSvdInput, SolveSvdOutput,
  SolveIcpInput, SolveIcpOutput,
  IcpConfig,
} from './poseProxySteps';
export { DEFAULT_ICP_CONFIG } from './poseProxySteps';

// ── Step 0: collectLandmarks (passive, 仅做配对组装) ───────────────

export interface CollectManualLandmarksInput {
  /** UI 已拾取的源 mesh landmark 顶点位置 + 索引列表 */
  srcLandmarks: Array<{ vertex: number; position: Vec3 }>;
  /** UI 已拾取的目标 mesh landmark */
  tarLandmarks: Array<{ vertex: number; position: Vec3 }>;
}

export interface CollectManualLandmarksOutput {
  pairs: LandmarkCandidate[];
}

const MIN_MANUAL_PAIRS = 3;

export class ManualLandmarkCountError extends Error {
  constructor(public srcCount: number, public tarCount: number) {
    super(`collectManualLandmarks: need ≥${MIN_MANUAL_PAIRS} matched pairs (got src=${srcCount}, tar=${tarCount})`);
    this.name = 'ManualLandmarkCountError';
  }
}

/**
 * Step 1: 把 UI 拾取的源/目标 landmark 按位置顺序两两配对成
 * LandmarkCandidate，给下游 SVD/ICP 用。
 *
 * 配对策略：按拾取顺序 zip（src[i] ↔ tar[i]），与 V1 行为一致。
 */
export function collectManualLandmarks(
  input: CollectManualLandmarksInput,
): CollectManualLandmarksOutput {
  const n = Math.min(input.srcLandmarks.length, input.tarLandmarks.length);
  if (n < MIN_MANUAL_PAIRS) {
    throw new ManualLandmarkCountError(input.srcLandmarks.length, input.tarLandmarks.length);
  }
  const pairs: LandmarkCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const s = input.srcLandmarks[i];
    const t = input.tarLandmarks[i];
    pairs.push({
      srcVertex: s.vertex,
      srcPosition: s.position,
      tarVertex: t.vertex,
      tarPosition: t.position,
      // 手动锚点完全可信
      confidence: 1,
      descriptorDist: 0,
      suggestAccept: true,
    });
  }
  return { pairs };
}
