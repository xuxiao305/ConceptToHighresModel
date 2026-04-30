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
 * Extraction node mode:
 *   - banana: 用 Banana Pro (Gemini) + 文本提示词直接生成提取结果
 *   - sam3:   点击"生成"后弹出 SAM3 独立窗口进行交互式点选，
 *             用户"导出 JSON"后窗口自动关闭、结果回传。
 */
export type ExtractionMode = 'banana' | 'sam3';

export interface ExtractionState {
  mode: ExtractionMode;
  /** Banana Pro 当前选中的提示词预设索引 */
  promptIndex: number;
  /** 当前展示的图片 blob: URL（生成结果或选中的历史版本） */
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

export interface PartPipelineState {
  id: string;
  name: string;
  nodeStates: NodeState[];
  /** Optional nodes expanded flag, keyed by node index */
  expanded: Record<number, boolean>;
  /** Image Input 节点状态（第一个节点，读取源图片） */
  imageInput?: ImageInputState;
  /** Extraction 节点模式 + 结果（在 React state 中维护，未持久化到工程目录） */
  extraction?: ExtractionState;
}

export type PageId = 'page1' | 'page2' | 'page3';
