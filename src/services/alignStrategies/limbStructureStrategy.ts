/**
 * Limb Structure 策略元数据。
 * 算法实现：ModelAssemble.handleAutoAlign('limb-structure') → matchLimbStructureToWhole()。
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
      status: ctx.hasTargetRegion ? 'ready' : 'missing',
    },
    {
      label: 'Body/Torso 区域约束',
      status: ctx.hasBodyTorsoRegion ? 'ready' : 'optional',
      detail: ctx.hasBodyTorsoRegion ? undefined : '缺失会回退到无约束匹配，可能误对到躯干',
    },
  ];
}

export const limbStructureStrategy: AlignStrategy = {
  id: 'limb-structure',
  label: 'Limb Structure',
  summary: '肢体结构对齐：根/弯/末端结构锚点匹配 → SVD + ICP。',
  kind: 'auto',
  requirements,
  steps: [
    { id: 'detect-anchors', title: '1. 检测结构锚点', description: 'root/bend/end 三层' },
    { id: 'svd-anchors', title: '2. SVD 锚点对齐' },
    { id: 'icp-refine', title: '3. ICP 精修' },
  ],
};
