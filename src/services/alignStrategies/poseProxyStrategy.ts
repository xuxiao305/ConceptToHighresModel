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
    { id: 'collect-joints', title: '1. 收集源/目标关节', description: 'Page1.joints.front 双侧共用，按目标相机分辨率缩放 tar 关节' },
    { id: 'render-src-ortho', title: '2. 源正交渲染', description: '渲染源 mesh 到 Page1 同尺寸画布，得到 srcCamera 供 step 3 使用' },
    { id: 'build-proxies', title: '3. 构建骨架代理 + 锚点', description: 'buildSkeletonProxy ×2 + computePoseAlignment + 直连关节锚点' },
    { id: 'svd-pose', title: '4. SVD 姿态对齐', description: 'alignSourceMeshByLandmarks()' },
    { id: 'icp-refine', title: '5. ICP 精修', description: '在目标区域内做最近邻精修' },
  ],
};
