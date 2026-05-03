/**
 * Pose Proxy 策略元数据。
 * 算法实现仍在 ModelAssemble.handleAutoAlign('pose-proxy') 内（Stage 5 不动算法）。
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
      label: 'Page1 关节数据',
      status: ctx.hasPoseProxyJoints ? 'ready' : 'missing',
      detail: ctx.hasPoseProxyJoints ? undefined : '需先在 Page1 完成 MultiView + DWPose 检测',
    },
    {
      label: '正交渲染相机',
      status: ctx.hasOrthoCamera ? 'ready' : 'missing',
    },
  ];
}

export const poseProxyStrategy: AlignStrategy = {
  id: 'pose-proxy',
  label: 'Pose Proxy',
  summary: '关节骨架对齐：用 Page1 DWPose 关节构建骨架代理，SVD + ICP 匹配。',
  kind: 'auto',
  requirements,
  steps: [
    { id: 'collect-joints', title: '1. 收集源/目标关节', description: 'Page1.joints.front 双侧共用' },
    { id: 'build-proxy', title: '2. 构建骨架代理', description: 'buildSkeletonProxy()' },
    { id: 'svd-pose', title: '3. SVD 姿态对齐', description: 'computePoseAlignment()' },
    { id: 'icp-refine', title: '4. ICP 精修', description: '在目标区域内做最近邻精修' },
  ],
};
