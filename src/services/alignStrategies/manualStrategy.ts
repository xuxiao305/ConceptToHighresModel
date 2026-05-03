/**
 * Manual Landmark 策略元数据。
 * 算法实现：ModelAssemble Ctrl+click 收集 landmark → handleRunAlign (SVD) → handleRunIcpAlign (ICP)。
 */
import type { AlignStrategy, AlignStrategyContext, RequirementCheck } from './types';

const MIN_LANDMARK_PAIRS = 3;

function requirements(ctx: AlignStrategyContext): RequirementCheck[] {
  const pairs = Math.min(ctx.srcLandmarkCount, ctx.tarLandmarkCount);
  return [
    {
      label: '源/目标 mesh',
      status: ctx.hasSource && ctx.hasTarget ? 'ready' : 'missing',
    },
    {
      label: `Landmark 对 (≥${MIN_LANDMARK_PAIRS})`,
      status: pairs >= MIN_LANDMARK_PAIRS ? 'ready' : 'missing',
      detail: `当前 src=${ctx.srcLandmarkCount} / tar=${ctx.tarLandmarkCount}`,
    },
  ];
}

export const manualStrategy: AlignStrategy = {
  id: 'manual',
  label: 'Manual Landmarks',
  summary: '手动标注：Ctrl+click 在源/目标上选对应点，SVD + ICP 分步执行。',
  kind: 'manual',
  requirements,
  steps: [
    { id: 'collect', title: '1. 收集 landmark 对', description: 'Ctrl+click 拾取', manual: true },
    { id: 'svd', title: '2. SVD landmark 对齐', manual: true },
    { id: 'icp-refine', title: '3. ICP 精修', manual: true },
  ],
};
