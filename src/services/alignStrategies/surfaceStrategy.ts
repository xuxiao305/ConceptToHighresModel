/**
 * Surface (RANSAC) 策略元数据。
 * 算法实现：ModelAssemble.handleAutoAlign('surface') → matchPartialToWhole()。
 */
import type { AlignStrategy, AlignStrategyContext, RequirementCheck } from './types';

function requirements(ctx: AlignStrategyContext): RequirementCheck[] {
  return [
    {
      label: '源/目标 mesh',
      status: ctx.hasSource && ctx.hasTarget ? 'ready' : 'missing',
    },
    {
      label: '目标 SAM3 区域',
      status: ctx.hasTargetRegion ? 'ready' : 'optional',
      detail: '缺失时退化为全 mesh 匹配，易误吸到躯干',
    },
    {
      label: '邻接表 (adjacency)',
      status: ctx.hasAdjacency ? 'ready' : 'missing',
      detail: 'FPFH/曲率描述子需要',
    },
  ];
}

export const surfaceStrategy: AlignStrategy = {
  id: 'surface',
  label: 'Surface RANSAC',
  summary: '表面描述子匹配：FPFH/曲率 + RANSAC 找一致集 → SVD + ICP。',
  kind: 'auto',
  requirements,
  steps: [
    { id: 'sample-fpfh', title: '1. 采样 + FPFH/曲率描述子', description: '与 RANSAC 同一次 matchPartialToWhole 调用完成' },
    { id: 'ransac', title: '2. RANSAC 投票', description: '在 sample-fpfh 步内原子执行（底层不可拆）' },
    { id: 'svd', title: '3. SVD 拟合', description: 'alignSourceMeshByLandmarks(pairs)' },
    { id: 'icp-refine', title: '4. ICP 精修' },
  ],
};
