/**
 * Stage 5 strategy registry barrel.
 *
 * V2 GUI 通过这里拿"策略卡 + 步骤面板"的所有声明式数据。
 * 算法 run 仍由 ModelAssemble 内部维持（V2 通过 props.onRunStrategy 回调触发）。
 */
import { poseProxyStrategy } from './poseProxyStrategy';
import { limbStructureStrategy } from './limbStructureStrategy';
import { surfaceStrategy } from './surfaceStrategy';
import { manualStrategy } from './manualStrategy';
import type { AlignStrategy, AlignStrategyId } from './types';

export const ALIGN_STRATEGIES: AlignStrategy[] = [
  poseProxyStrategy,
  limbStructureStrategy,
  surfaceStrategy,
  manualStrategy,
];

export function getStrategy(id: AlignStrategyId): AlignStrategy {
  const found = ALIGN_STRATEGIES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown align strategy: ${id}`);
  return found;
}

export type { AlignStrategy, AlignStrategyId, AlignStrategyContext, RequirementCheck, StrategyStep, StrategyReadiness } from './types';
export { summarizeReadiness } from './types';
