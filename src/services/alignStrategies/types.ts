/**
 * Stage 5 (refactor master plan) — Page3 alignment strategy registry.
 *
 * 设计意图：
 *   - 旧 ModelAssemble.tsx 把 4 套对齐模式（pose-proxy / limb-structure / surface /
 *     manual）混在 ~500 行的 handleAutoAlign 闭包里，UI 也散在 toolbar 各处。
 *   - V2 GUI 需要按"策略卡 + 步骤列表 + 就绪状态"渲染，必须有一份**声明式**注册表。
 *   - 本文件只定义元数据契约（id / label / requirements / steps）。具体算法
 *     `run` 仍由 ModelAssemble 内部维持调用（通过 onRun 回调），保证 Stage 5
 *     "行为完全一致"的验收口径，把算法搬家留给后续真正需要的时候。
 *
 * 边界：
 *   - 不持有任何 React state；纯数据 + 纯函数。
 *   - 不直接操作 DOM / 不发起 IO；run 只是触发宿主的回调。
 */

export type AlignStrategyId = 'pose-proxy' | 'limb-structure' | 'surface' | 'manual';

/** 单条 requirement 的判定结果。 */
export interface RequirementCheck {
  /** 给用户看的简短标签，如 "DWPose 服务"、"Body/Torso 区域"。 */
  label: string;
  /** ready=绿勾、missing=灰叉、optional=蓝点（缺失不阻塞）。 */
  status: 'ready' | 'missing' | 'optional';
  /** 可选补充说明，便于 hover/expand 显示。 */
  detail?: string;
}

/** Strategy 在 V2 GUI step list 中渲染一行所需的描述。 */
export interface StrategyStep {
  /** 用于稳定 React key + trace 关联。 */
  id: string;
  /** 步骤标题，如 "1. 收集源/目标关节"。 */
  title: string;
  /** 简短说明，可省略。 */
  description?: string;
  /** 是否手动触发（manual 模式下用户逐步点击）。auto 模式步骤合并成一次 run。 */
  manual?: boolean;
}

/** 策略观察上下文：requirements 函数读这里判定就绪。 */
export interface AlignStrategyContext {
  hasSource: boolean;
  hasTarget: boolean;
  hasTargetRegion: boolean;
  hasSegPack: boolean;
  hasMaskReprojection: boolean;
  hasPoseProxyJoints: boolean;
  hasOrthoCamera: boolean;
  hasBodyTorsoRegion: boolean;
  hasAdjacency: boolean;
  srcLandmarkCount: number;
  tarLandmarkCount: number;
}

/** 策略元数据（声明式）。 */
export interface AlignStrategy {
  id: AlignStrategyId;
  /** 策略卡标题。 */
  label: string;
  /** 一句话描述，显示在卡片副标题。 */
  summary: string;
  /** 是否自动模式（一次 run 完成）。manual=用户分步。 */
  kind: 'auto' | 'manual';
  /** 计算就绪状态。 */
  requirements: (ctx: AlignStrategyContext) => RequirementCheck[];
  /** 步骤列表（V2 GUI 步骤面板渲染）。 */
  steps: StrategyStep[];
}

/** requirements 聚合状态：ready=全部绿、partial=有缺但能跑、blocked=必需缺失。 */
export type StrategyReadiness = 'ready' | 'partial' | 'blocked';

export function summarizeReadiness(checks: RequirementCheck[]): StrategyReadiness {
  if (checks.some((c) => c.status === 'missing')) return 'blocked';
  if (checks.some((c) => c.status === 'optional')) return 'partial';
  return 'ready';
}
