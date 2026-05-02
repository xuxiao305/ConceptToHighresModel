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

/**
 * Pipeline source mode — controls which Page1 node feeds Image Input,
 * and which extraction implementation runs:
 *   - multiview:  Pipeline 1 — Page1 Multi-View → Banana Pro (Jacket Extract) + RMBG
 *   - extraction: Pipeline 2 — Page1 Extraction → SAM3 interactive segmentation
 */
export type PipelineMode = 'extraction' | 'multiview';

/** Page2 3D Model generation mode. */
export type Model3DMode = 'single' | 'frontBack' | 'fourView';

export interface ExtractionState {
  /** 当前展示的图片 blob: URL（生成结果或选中的历史版本） */
  resultUrl: string | null;
  /** 当前展示图片对应的工程文件名（用于历史下拉、复制路径） */
  resultFile?: string | null;
  /** 错误信息（若有） */
  error?: string;
}

export interface ModifyState {
  /** 当前展示的图片 blob: URL（Banana Pro 修改/高清化结果） */
  resultUrl: string | null;
  /** 当前展示图片对应的工程文件名（用于历史下拉、复制路径） */
  resultFile?: string | null;
  /** 错误信息（若有） */
  error?: string;
}

export interface ImageInputState {
  /** 当前展示的图片 blob: URL */
  imageUrl: string | null;
  /** 当前展示图片对应的工程文件名 */
  imageFile?: string | null;
}

export interface Model3DState {
  /** 当前展示的 GLB blob: URL */
  glbUrl: string | null;
  /** 当前 GLB 对应的工程文件名 */
  glbFile?: string | null;
  /** 生成模式 */
  mode?: Model3DMode;
  /** 错误信息（若有） */
  error?: string;
}

export interface PartPipelineState {
  id: string;
  name: string;
  /** Pipeline source mode: 'extraction' uses Page1 Extraction, 'multiview' uses Page1 Multi-View */
  mode: PipelineMode;
  nodeStates: NodeState[];
  /** Optional nodes expanded flag, keyed by node index */
  expanded: Record<number, boolean>;
  /** Image Input 节点状态（第一个节点，读取源图片） */
  imageInput?: ImageInputState;
  /** Extraction 节点模式 + 结果（在 React state 中维护，未持久化到工程目录） */
  extraction?: ExtractionState;
  /** Modify 节点结果（Banana Pro 绘制/高清化，可选） */
  modify?: ModifyState;
  /** 3D Model 节点结果 */
  model3d?: Model3DState;
}

export type PageId = 'page1' | 'page2' | 'page3';
