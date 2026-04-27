/**
 * Shared types for the pipeline UI mockup.
 *
 * NodeState drives the visual style of every node card:
 *   idle      - 灰色边框，无输入
 *   ready     - 蓝色边框，已有输入未运行
 *   running   - 蓝色边框 + spinner
 *   complete  - 绿色边框，输出可用
 *   error     - 红色边框，重试按钮
 *   optional  - 虚线边框，节点默认收起
 */
export type NodeState =
  | 'idle'
  | 'ready'
  | 'running'
  | 'complete'
  | 'error'
  | 'optional';

export type DisplayType = 'image' | 'multiview' | '3d' | 'split3d' | 'empty';

export interface NodeConfig {
  id: string;
  title: string;
  display: DisplayType;
  optional?: boolean;
  /** Description shown in the placeholder area */
  description?: string;
}

export interface PartPipelineState {
  id: string;
  name: string;
  nodeStates: NodeState[];
  /** Optional nodes expanded flag, keyed by node index */
  expanded: Record<number, boolean>;
}

export type PageId = 'page1' | 'page2' | 'page3';
