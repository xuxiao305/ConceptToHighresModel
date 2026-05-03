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
    { id: 'sample', title: '1. 采样源/目标点' },
    { id: 'descriptor', title: '2. 计算 FPFH/曲率描述子' },
    { id: 'ransac', title: '3. RANSAC 投票' },
    { id: 'svd', title: '4. SVD 拟合' },
    { id: 'icp-refine', title: '5. ICP 精修' },
  ],
};
