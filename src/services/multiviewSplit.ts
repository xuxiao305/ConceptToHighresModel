/**
 * Multi-View 切分服务
 *
 * 将 ComfyUI TPoseMultiView 工作流输出的 2x2 网格图（front / left / right / back）
 * 按"非白色像素的紧凑包围盒"切成四张独立小图。
 *
 * 切分约定（与 TPoseMultiView 工作流一致）：
 *   ┌──────────────┬──────────────┐
 *   │  front (TL)  │  left  (TR)  │
 *   ├──────────────┼──────────────┤
 *   │  right (BL)  │  back  (BR)  │
 *   └──────────────┴──────────────┘
 *
 * "left / right" 指 Tripo 的多视图语义：
 *   - left  = 角色身体的左侧（在画面里通常面朝右）
 *   - right = 角色身体的右侧（在画面里通常面朝左）
 */

import type { SmartCropTransformMeta, SplitTransformMeta, SplitViewBBox } from '../types/joints';

export type ViewName = 'front' | 'left' | 'back' | 'right';

/** Tripo 多视图 API 的固定顺序：front → left → back → right */
export const VIEW_ORDER: ViewName[] = ['front', 'left', 'back', 'right'];

export interface ViewSlice {
  view: ViewName;
  /** 输出 PNG */
  blob: Blob;
  /** 切片在原图中的紧凑 bbox（像素坐标，已含 padding） */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 切片宽高（像素） */
  size: { w: number; h: number };
}

export interface SplitOptions {
  /** 围绕紧凑 bbox 的留白像素数，默认 8 */
  pad?: number;
  /** 视为"白底"的阈值：每个通道 ≥ whiteThreshold 即认为是背景。默认 240 */
  whiteThreshold?: number;
}

/**
 * 将一张 2x2 多视图图按象限自动裁切。
 * 返回的 `slices` 顺序与 `VIEW_ORDER` 一致。
 */
export async function splitMultiView(
  source: Blob | string,
  opts: SplitOptions = {},
): Promise<ViewSlice[]> {
  const pad = opts.pad ?? 8;
  const whiteThr = opts.whiteThreshold ?? 240;

  const img = await loadImage(source);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const halfW = Math.floor(W / 2);
  const halfH = Math.floor(H / 2);

  // 一次性把全图绘到 canvas，读出 ImageData
  const fullCanvas = makeCanvas(W, H);
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  if (!fullCtx) throw new Error('无法获取 2D Canvas 上下文');
  fullCtx.drawImage(img, 0, 0);
  const imageData = fullCtx.getImageData(0, 0, W, H).data;

  // 象限定义：(view, x0, y0, x1, y1)（end 不包含）
  const quadrants: { view: ViewName; x0: number; y0: number; x1: number; y1: number }[] = [
    { view: 'front', x0: 0,     y0: 0,     x1: halfW, y1: halfH },
    { view: 'left',  x0: halfW, y0: 0,     x1: W,     y1: halfH },
    { view: 'right', x0: 0,     y0: halfH, x1: halfW, y1: H     },
    { view: 'back',  x0: halfW, y0: halfH, x1: W,     y1: H     },
  ];

  const slices: ViewSlice[] = [];

  for (const view of VIEW_ORDER) {
    const q = quadrants.find((it) => it.view === view)!;
    // 使用最大连通分量，避免邻接象限渗过来的零碎像素影响 bbox。
    // largestComponentBBox 返回 end-exclusive；下方逻辑沿用 inclusive，故 -1 还原。
    const bbEx = largestComponentBBox(imageData, W, q.x0, q.y0, q.x1, q.y1, whiteThr, false);
    let bb: { x0: number; y0: number; x1: number; y1: number } | null = bbEx
      ? { x0: bbEx.x0, y0: bbEx.y0, x1: bbEx.x1 - 1, y1: bbEx.y1 - 1 }
      : null;
    if (!bb) {
      // 整个象限都是白色（不太可能，但兜底）：用整个象限
      bb = { x0: q.x0, y0: q.y0, x1: q.x1 - 1, y1: q.y1 - 1 };
    }
    const padded = {
      x0: Math.max(q.x0, bb.x0 - pad),
      y0: Math.max(q.y0, bb.y0 - pad),
      x1: Math.min(q.x1 - 1, bb.x1 + pad),
      y1: Math.min(q.y1 - 1, bb.y1 + pad),
    };
    const w = padded.x1 - padded.x0 + 1;
    const h = padded.y1 - padded.y0 + 1;

    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D Canvas 上下文');
    ctx.drawImage(img, padded.x0, padded.y0, w, h, 0, 0, w, h);
    const blob = await canvasToBlob(c, 'image/png');

    slices.push({
      view,
      blob,
      bbox: padded,
      size: { w, h },
    });
  }

  return slices;
}

/** Result of splitMultiViewWithMeta: slices plus transform metadata. */
export interface SplitMultiViewWithMetaResult {
  slices: ViewSlice[];
  meta: SplitTransformMeta;
}

/**
 * Like splitMultiView, but also returns {@link SplitTransformMeta}
 * so that global 2x2 joints can later be mapped through
 * SmartCrop → processed 2x2 → per-view split coords.
 */
export async function splitMultiViewWithMeta(
  source: Blob | string,
  opts: SplitOptions = {},
): Promise<SplitMultiViewWithMetaResult> {
  const pad = opts.pad ?? 8;
  const whiteThr = opts.whiteThreshold ?? 240;

  const img = await loadImage(source);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const halfW = Math.floor(W / 2);
  const halfH = Math.floor(H / 2);

  const fullCanvas = makeCanvas(W, H);
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  if (!fullCtx) throw new Error('无法获取 2D Canvas 上下文');
  fullCtx.drawImage(img, 0, 0);
  const imageData = fullCtx.getImageData(0, 0, W, H).data;

  const quadrants: { view: ViewName; x0: number; y0: number; x1: number; y1: number }[] = [
    { view: 'front', x0: 0,     y0: 0,     x1: halfW, y1: halfH },
    { view: 'left',  x0: halfW, y0: 0,     x1: W,     y1: halfH },
    { view: 'right', x0: 0,     y0: halfH, x1: halfW, y1: H     },
    { view: 'back',  x0: halfW, y0: halfH, x1: W,     y1: H     },
  ];

  const slices: ViewSlice[] = [];
  const viewBBoxes: SplitViewBBox[] = [];

  for (const view of VIEW_ORDER) {
    const q = quadrants.find((it) => it.view === view)!;
    const bbEx = largestComponentBBox(imageData, W, q.x0, q.y0, q.x1, q.y1, whiteThr, false);
    let bb: { x0: number; y0: number; x1: number; y1: number } | null = bbEx
      ? { x0: bbEx.x0, y0: bbEx.y0, x1: bbEx.x1 - 1, y1: bbEx.y1 - 1 }
      : null;
    if (!bb) {
      bb = { x0: q.x0, y0: q.y0, x1: q.x1 - 1, y1: q.y1 - 1 };
    }
    const padded = {
      x0: Math.max(q.x0, bb.x0 - pad),
      y0: Math.max(q.y0, bb.y0 - pad),
      x1: Math.min(q.x1 - 1, bb.x1 + pad),
      y1: Math.min(q.y1 - 1, bb.y1 + pad),
    };
    const w = padded.x1 - padded.x0 + 1;
    const h = padded.y1 - padded.y0 + 1;

    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D Canvas 上下文');
    ctx.drawImage(img, padded.x0, padded.y0, w, h, 0, 0, w, h);
    const blob = await canvasToBlob(c, 'image/png');

    slices.push({
      view,
      blob,
      bbox: padded,
      size: { w, h },
    });

    viewBBoxes.push({
      view,
      quadrant: { x0: q.x0, y0: q.y0, x1: q.x1 - 1, y1: q.y1 - 1 },
      compactBbox: bb,
      paddedBbox: padded,
      sliceSize: { w, h },
    });
  }

  const meta: SplitTransformMeta = {
    sourceSize: { width: W, height: H },
    params: { pad, whiteThreshold: whiteThr },
    views: viewBBoxes,
  };

  return { slices, meta };
}

// ---------------------------------------------------------------------------
// SmartCropAndEnlargeAuto —— 端到端移植自
// D:\AI\MyComfyuiNodes\SmartCropAndEnlarge\nodes.py 的 SmartCropAndEnlargeAuto。
//
// 算法概述：
//   1. 在整张图上扫描"前景连通分量"（white_threshold/alpha 判定）。
//   2. 丢掉面积 < min_area 的噪点；按面积从大到小截到 max_objects 个。
//   3. 对剩余 bbox 按"原图位置（行优先）"排序：先从上到下分组成行（用中位
//      高度的 0.5 当作行阈值），每行再从左到右。
//   4. 按 layout 把每个 bbox 的内容等比放大粘到输出画布上：
//        - layout='auto'        : 取 cols=ceil(sqrt(N)), rows=ceil(N/cols)
//        - layout='horizontal'  : 1 × N
//        - layout='vertical'    : N × 1
//      若 preserve_position=true，则忽略 layout，每个 bbox 围绕原中心原地
//      最大化等比缩放，不做位置重排。
//   5. uniform_scale=true 时所有 bbox 共享同一个缩放倍率（取所有候选
//      scale 的最小值），保持物体之间的相对大小关系。
// ---------------------------------------------------------------------------

export type SmartCropLayout = 'auto' | 'horizontal' | 'vertical';

export interface SmartCropAutoOptions {
  /** bbox 外扩像素，默认 8 */
  padding?: number;
  /** 近白判定阈值（rgb 任一 < 阈值即前景），默认 240 */
  whiteThreshold?: number;
  /** 若图像带 alpha，是否按 alpha>8 判前景（默认 false） */
  useAlpha?: boolean;
  /** 小于该面积的连通块视为噪点丢弃，默认 64 */
  minArea?: number;
  /** 最多保留的物体数（按面积从大到小），默认 16 */
  maxObjects?: number;
  /** 排布模式，默认 'auto' */
  layout?: SmartCropLayout;
  /** 所有物体使用同一缩放倍率（保持相对大小），默认 false */
  uniformScale?: boolean;
  /**
   * 不重新排布，每个物体围绕原位置中心原地放大。开启后忽略 layout。
   * 默认 false。
   */
  preservePosition?: boolean;
  /** 背景色，默认 '#ffffff'。可用 'transparent'。 */
  background?: string;
}

/**
 * SmartCropAndEnlargeAuto 的浏览器实现，输入输出都是 Blob，输出尺寸与输入一致。
 * 算法逐行参考 ComfyUI 节点同名实现，参数语义保持一致。
 */
export async function smartCropAndEnlargeAuto(
  source: Blob | string,
  opts: SmartCropAutoOptions = {},
): Promise<Blob> {
  const padding = Math.max(0, Math.floor(opts.padding ?? 8));
  const whiteThr = opts.whiteThreshold ?? 240;
  const useAlpha = opts.useAlpha ?? false;
  const minArea = Math.max(1, Math.floor(opts.minArea ?? 64));
  const maxObjects = Math.max(1, Math.floor(opts.maxObjects ?? 16));
  const layout = opts.layout ?? 'auto';
  const uniformScale = opts.uniformScale ?? false;
  const preservePosition = opts.preservePosition ?? false;
  const bgColor = opts.background ?? '#ffffff';
  const transparent =
    bgColor.toLowerCase() === 'transparent' || bgColor.toLowerCase() === 'none';

  const img = await loadImage(source);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // 读源像素
  const srcCanvas = makeCanvas(W, H);
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) throw new Error('无法获取 2D Canvas 上下文');
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, W, H).data;

  // 1. 找全图所有连通分量
  let bboxes = allComponentsBBoxes(srcData, W, H, whiteThr, useAlpha, minArea);

  // 2. 按面积从大到小截取
  bboxes.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  bboxes = bboxes.slice(0, maxObjects);

  // 3. 行优先排序（保持原图相对位置）
  bboxes = sortBBoxesRowMajor(bboxes);

  // 输出画布
  const outCanvas = makeCanvas(W, H);
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('无法获取 2D Canvas 上下文');
  if (!transparent) {
    outCtx.fillStyle = bgColor;
    outCtx.fillRect(0, 0, W, H);
  } else {
    outCtx.clearRect(0, 0, W, H);
  }
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';

  if (bboxes.length === 0) {
    return await canvasToBlob(outCanvas, 'image/png');
  }

  // 把每个 bbox 加 padding 后映射到原图坐标（端不包含）
  const padded = bboxes.map((b) => ({
    x0: Math.max(0, b.x0 - padding),
    y0: Math.max(0, b.y0 - padding),
    x1: Math.min(W, b.x1 + padding),
    y1: Math.min(H, b.y1 + padding),
  }));

  if (preservePosition) {
    // 围绕原中心原地最大化缩放（不重排）
    let scaleOverride: number | null = null;
    if (uniformScale) {
      const cands: number[] = [];
      for (const p of padded) {
        const fgW = p.x1 - p.x0;
        const fgH = p.y1 - p.y0;
        if (fgW <= 0 || fgH <= 0) continue;
        const cx = (p.x0 + p.x1) / 2;
        const cy = (p.y0 + p.y1) / 2;
        const [tw, th] = centeredLimitSize(cx, cy, W, H, 1.0);
        cands.push(Math.min(tw / fgW, th / fgH));
      }
      if (cands.length > 0) scaleOverride = Math.min(...cands);
    }

    for (const p of padded) {
      const fgW = p.x1 - p.x0;
      const fgH = p.y1 - p.y0;
      if (fgW <= 0 || fgH <= 0) continue;
      const cx = (p.x0 + p.x1) / 2;
      const cy = (p.y0 + p.y1) / 2;
      const [tw, th] = centeredLimitSize(cx, cy, W, H, 1.0);
      const [newW, newH] = fitWithScale(fgW, fgH, tw, th, scaleOverride);
      const [px, py] = pasteXyForCenter(cx, cy, newW, newH, W, H);
      outCtx.drawImage(img, p.x0, p.y0, fgW, fgH, px, py, newW, newH);
    }
    return await canvasToBlob(outCanvas, 'image/png');
  }

  // 网格排布
  const n = padded.length;
  let cols: number, rows: number;
  if (layout === 'horizontal') {
    rows = 1; cols = n;
  } else if (layout === 'vertical') {
    rows = n; cols = 1;
  } else {
    cols = Math.ceil(Math.sqrt(n));
    rows = Math.ceil(n / cols);
  }
  const cellWBase = Math.floor(W / cols);
  const cellHBase = Math.floor(H / rows);

  // uniform scale 候选
  let scaleOverride: number | null = null;
  if (uniformScale) {
    const cands: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx0 = c * cellWBase;
      const cy0 = r * cellHBase;
      const cx1 = c === cols - 1 ? W : (c + 1) * cellWBase;
      const cy1 = r === rows - 1 ? H : (r + 1) * cellHBase;
      const cw = cx1 - cx0;
      const ch = cy1 - cy0;
      const fgW = padded[i].x1 - padded[i].x0;
      const fgH = padded[i].y1 - padded[i].y0;
      if (cw <= 0 || ch <= 0 || fgW <= 0 || fgH <= 0) continue;
      cands.push(Math.min(cw / fgW, ch / fgH));
    }
    if (cands.length > 0) scaleOverride = Math.min(...cands);
  }

  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const cx0 = c * cellWBase;
    const cy0 = r * cellHBase;
    const cx1 = c === cols - 1 ? W : (c + 1) * cellWBase;
    const cy1 = r === rows - 1 ? H : (r + 1) * cellHBase;
    const cw = cx1 - cx0;
    const ch = cy1 - cy0;
    if (cw <= 0 || ch <= 0) continue;

    const p = padded[i];
    const fgW = p.x1 - p.x0;
    const fgH = p.y1 - p.y0;
    if (fgW <= 0 || fgH <= 0) continue;

    const [newW, newH] = fitWithScale(fgW, fgH, cw, ch, scaleOverride);
    const px = cx0 + Math.floor((cw - newW) / 2);
    const py = cy0 + Math.floor((ch - newH) / 2);
    outCtx.drawImage(img, p.x0, p.y0, fgW, fgH, px, py, newW, newH);
  }

  return await canvasToBlob(outCanvas, 'image/png');
}

// ---- helpers for SmartCropAndEnlargeAuto -----------------------------------

interface BBox { x0: number; y0: number; x1: number; y1: number; }

/**
 * 全图 4-邻接连通分量扫描；返回 area >= minArea 的所有分量 bbox（端不含）。
 * 使用 typed-array stack 模拟 DFS，避免大图递归爆栈。
 */
function allComponentsBBoxes(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  whiteThr: number,
  useAlpha: boolean,
  minArea: number,
): BBox[] {
  // 先把前景标到 mask 上（0=bg, 1=fg, 2=visited）
  const N = W * H;
  const mask = new Uint8Array(N);
  let totalFg = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = (row + x) * 4;
      const a = data[i + 3];
      let isFg: boolean;
      if (useAlpha) {
        isFg = a > 8;
      } else if (a < 8) {
        isFg = false;
      } else {
        isFg = data[i] < whiteThr || data[i + 1] < whiteThr || data[i + 2] < whiteThr;
      }
      if (isFg) {
        mask[row + x] = 1;
        totalFg++;
      }
    }
  }
  if (totalFg === 0) return [];

  const stack = new Int32Array(totalFg);
  const out: BBox[] = [];

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const start = py * W + px;
      if (mask[start] !== 1) continue;
      let top = 0;
      stack[top++] = start;
      mask[start] = 2;
      let minX = px, maxX = px, minY = py, maxY = py;
      let area = 0;
      while (top > 0) {
        const idx = stack[--top];
        const x = idx % W;
        const y = (idx - x) / W;
        area++;
        if (x < minX) minX = x; else if (x > maxX) maxX = x;
        if (y < minY) minY = y; else if (y > maxY) maxY = y;
        if (x + 1 < W && mask[idx + 1] === 1) { mask[idx + 1] = 2; stack[top++] = idx + 1; }
        if (x - 1 >= 0 && mask[idx - 1] === 1) { mask[idx - 1] = 2; stack[top++] = idx - 1; }
        if (y + 1 < H && mask[idx + W] === 1) { mask[idx + W] = 2; stack[top++] = idx + W; }
        if (y - 1 >= 0 && mask[idx - W] === 1) { mask[idx - W] = 2; stack[top++] = idx - W; }
      }
      if (area >= minArea) {
        out.push({ x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 });
      }
    }
  }
  return out;
}

/**
 * 行优先排序：先按 y 中心分行（行阈值 = 中位高度 * 0.5），每行再按 x 中心从左到右。
 * 与 SmartCropAndEnlarge nodes.py 中 _sort_bboxes_row_major 等价。
 */
function sortBBoxesRowMajor(bboxes: BBox[]): BBox[] {
  if (bboxes.length <= 1) return bboxes;
  const cy = (b: BBox) => (b.y0 + b.y1) / 2;
  const cx = (b: BBox) => (b.x0 + b.x1) / 2;

  const heights = bboxes.map((b) => Math.max(1, b.y1 - b.y0)).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const rowThreshold = Math.max(1, median * 0.5);

  const sorted = [...bboxes].sort((a, b) => cy(a) - cy(b) || cx(a) - cx(b));
  const rows: BBox[][] = [];
  for (const b of sorted) {
    if (rows.length === 0) {
      rows.push([b]);
      continue;
    }
    const lastRow = rows[rows.length - 1];
    const rowCy = lastRow.reduce((s, x) => s + cy(x), 0) / lastRow.length;
    if (Math.abs(cy(b) - rowCy) <= rowThreshold) lastRow.push(b);
    else rows.push([b]);
  }
  const out: BBox[] = [];
  for (const row of rows) {
    row.sort((a, b) => cx(a) - cx(b) || a.x0 - b.x0);
    out.push(...row);
  }
  return out;
}

function centeredLimitSize(
  cx: number, cy: number, W: number, H: number, fillCell: number,
): [number, number] {
  const f = Math.max(0.05, Math.min(1.0, fillCell));
  const maxWByCenter = Math.max(1, 2 * Math.min(cx, W - cx));
  const maxHByCenter = Math.max(1, 2 * Math.min(cy, H - cy));
  const tw = Math.min(W * f, maxWByCenter);
  const th = Math.min(H * f, maxHByCenter);
  return [Math.max(1, Math.floor(tw)), Math.max(1, Math.floor(th))];
}

function pasteXyForCenter(
  cx: number, cy: number, ow: number, oh: number, W: number, H: number,
): [number, number] {
  let px = Math.round(cx - ow / 2);
  let py = Math.round(cy - oh / 2);
  px = Math.max(0, Math.min(W - ow, px));
  py = Math.max(0, Math.min(H - oh, py));
  return [px, py];
}

function fitWithScale(
  sw: number, sh: number, dw: number, dh: number, scale: number | null,
): [number, number] {
  if (scale == null) {
    const s = Math.min(dw / sw, dh / sh);
    return [Math.max(1, Math.round(sw * s)), Math.max(1, Math.round(sh * s))];
  }
  const s = Math.min(scale, dw / sw, dh / sh);
  return [Math.max(1, Math.floor(sw * s + 1e-6)), Math.max(1, Math.floor(sh * s + 1e-6))];
}

/**
 * 在指定矩形区域内做 4-邻接连通分量扫描，返回**面积最大**那块连通分量的
 * 紧凑 bbox（绝对坐标，end 不包含）。如果区域内没有前景像素返回 null。
 *
 * 用途：Banana Pro 生成的 2x2 多视图常常会让某个 view 的主体"渗"到隔壁
 * 象限边缘几像素，单纯的 tight bbox 会被这些零碎渗漏拉宽。取最大连通分量
 * 即可只保留该象限内的"主物体"。
 *
 * 实现：先用 typed-array stack flood-fill；区域可能很大（半张 2K 图，~1M
 * 像素），所以避免递归。
 */
function largestComponentBBox(
  data: Uint8ClampedArray,
  imgW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  whiteThr: number,
  useAlpha: boolean,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const regW = x1 - x0;
  const regH = y1 - y0;
  if (regW <= 0 || regH <= 0) return null;

  // 1. 把"前景"标到一张本地 mask 上（0=bg, 1=fg, 2=visited）
  //    用 Uint8Array(regW*regH) 节省内存。
  const mask = new Uint8Array(regW * regH);
  let totalFg = 0;
  for (let y = 0; y < regH; y++) {
    const srcRow = (y + y0) * imgW * 4;
    const dstRow = y * regW;
    for (let x = 0; x < regW; x++) {
      const i = srcRow + (x + x0) * 4;
      const a = data[i + 3];
      let isFg: boolean;
      if (useAlpha) {
        isFg = a > 8;
      } else if (a < 8) {
        isFg = false;
      } else {
        isFg = data[i] < whiteThr || data[i + 1] < whiteThr || data[i + 2] < whiteThr;
      }
      if (isFg) {
        mask[dstRow + x] = 1;
        totalFg++;
      }
    }
  }
  if (totalFg === 0) return null;

  // 2. flood fill 找最大分量。stack 用 Int32Array 模拟，存 pixel index。
  //    上限：所有前景像素都在一个分量里。
  const stack = new Int32Array(totalFg);
  let bestArea = 0;
  let bestMinX = 0, bestMinY = 0, bestMaxX = 0, bestMaxY = 0;

  for (let py = 0; py < regH; py++) {
    for (let px = 0; px < regW; px++) {
      const start = py * regW + px;
      if (mask[start] !== 1) continue;

      // BFS/DFS 一个分量
      let top = 0;
      stack[top++] = start;
      mask[start] = 2;
      let minX = px, maxX = px, minY = py, maxY = py;
      let area = 0;
      while (top > 0) {
        const idx = stack[--top];
        const x = idx % regW;
        const y = (idx - x) / regW;
        area++;
        if (x < minX) minX = x;
        else if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        else if (y > maxY) maxY = y;
        // 4-邻接
        if (x + 1 < regW && mask[idx + 1] === 1) { mask[idx + 1] = 2; stack[top++] = idx + 1; }
        if (x - 1 >= 0   && mask[idx - 1] === 1) { mask[idx - 1] = 2; stack[top++] = idx - 1; }
        if (y + 1 < regH && mask[idx + regW] === 1) { mask[idx + regW] = 2; stack[top++] = idx + regW; }
        if (y - 1 >= 0   && mask[idx - regW] === 1) { mask[idx - regW] = 2; stack[top++] = idx - regW; }
      }

      if (area > bestArea) {
        bestArea = area;
        bestMinX = minX; bestMaxX = maxX;
        bestMinY = minY; bestMaxY = maxY;
      }
    }
  }

  if (bestArea === 0) return null;
  // 转回绝对坐标，end-exclusive
  return {
    x0: x0 + bestMinX,
    y0: y0 + bestMinY,
    x1: x0 + bestMaxX + 1,
    y1: y0 + bestMaxY + 1,
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function loadImage(src: Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const revoke = typeof src === 'string' ? () => {} : () => URL.revokeObjectURL(url);
    const img = new Image();
    img.onload = () => {
      revoke();
      resolve(img);
    };
    img.onerror = (e) => {
      revoke();
      reject(new Error('图片加载失败：' + String(e)));
    };
    img.src = url;
  });
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(c: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob 返回 null'))),
      type,
    );
  });
}

// ── SmartCrop with transform metadata ───────────────────────────────────
// This function mirrors smartCropAndEnlargeAuto but additionally captures
// the exact transform parameters (bbox, paste offset, scale) for each object
// so that 2D joints can be mapped from the global image space into the
// processed 2x2 image space.

export interface SmartCropWithMetaResult {
  blob: Blob;
  meta: SmartCropTransformMeta;
}

export async function smartCropAndEnlargeAutoWithMeta(
  source: Blob | string,
  opts: SmartCropAutoOptions = {},
): Promise<SmartCropWithMetaResult> {
  const padding = Math.max(0, Math.floor(opts.padding ?? 8));
  const whiteThr = opts.whiteThreshold ?? 240;
  const useAlpha = opts.useAlpha ?? false;
  const minArea = Math.max(1, Math.floor(opts.minArea ?? 64));
  const maxObjects = Math.max(1, Math.floor(opts.maxObjects ?? 16));
  const layout = opts.layout ?? 'auto';
  const uniformScale = opts.uniformScale ?? false;
  const preservePosition = opts.preservePosition ?? false;
  const bgColor = opts.background ?? '#ffffff';
  const transparent =
    bgColor.toLowerCase() === 'transparent' || bgColor.toLowerCase() === 'none';

  const img = await loadImage(source);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const srcCanvas = makeCanvas(W, H);
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) throw new Error('无法获取 2D Canvas 上下文');
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, W, H).data;

  let bboxes = allComponentsBBoxes(srcData, W, H, whiteThr, useAlpha, minArea);
  bboxes.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  bboxes = bboxes.slice(0, maxObjects);
  bboxes = sortBBoxesRowMajor(bboxes);

  const outCanvas = makeCanvas(W, H);
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('无法获取 2D Canvas 上下文');
  if (!transparent) {
    outCtx.fillStyle = bgColor;
    outCtx.fillRect(0, 0, W, H);
  } else {
    outCtx.clearRect(0, 0, W, H);
  }
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';

  // ── Capture metadata objects ──
  const metaObjects: SmartCropTransformMeta['objects'] = [];

  if (bboxes.length === 0) {
    const blob = await canvasToBlob(outCanvas, 'image/png');
    return {
      blob,
      meta: {
        sourceSize: { width: W, height: H },
        outputSize: { width: W, height: H },
        params: {
          padding, whiteThreshold: whiteThr, minArea, maxObjects,
          layout, uniformScale, preservePosition,
        },
        objects: [],
      },
    };
  }

  const padded = bboxes.map((b, i) => {
    const p = {
      x0: Math.max(0, b.x0 - padding),
      y0: Math.max(0, b.y0 - padding),
      x1: Math.min(W, b.x1 + padding),
      y1: Math.min(H, b.y1 + padding),
    };
    // Record source bbox (end-exclusive)
    metaObjects[i] = {
      srcBbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
      paddedBbox: { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1 },
      pasteX: 0,
      pasteY: 0,
      scale: 1,
      targetW: 0,
      targetH: 0,
    };
    return p;
  });

  if (preservePosition) {
    let scaleOverride: number | null = null;
    if (uniformScale) {
      const cands: number[] = [];
      for (const p of padded) {
        const fgW = p.x1 - p.x0;
        const fgH = p.y1 - p.y0;
        if (fgW <= 0 || fgH <= 0) continue;
        const cx = (p.x0 + p.x1) / 2;
        const cy = (p.y0 + p.y1) / 2;
        const [tw, th] = centeredLimitSize(cx, cy, W, H, 1.0);
        cands.push(Math.min(tw / fgW, th / fgH));
      }
      if (cands.length > 0) scaleOverride = Math.min(...cands);
    }

    for (let i = 0; i < padded.length; i++) {
      const p = padded[i];
      const fgW = p.x1 - p.x0;
      const fgH = p.y1 - p.y0;
      if (fgW <= 0 || fgH <= 0) continue;
      const cx = (p.x0 + p.x1) / 2;
      const cy = (p.y0 + p.y1) / 2;
      const [tw, th] = centeredLimitSize(cx, cy, W, H, 1.0);
      const [newW, newH] = fitWithScale(fgW, fgH, tw, th, scaleOverride);
      const [px, py] = pasteXyForCenter(cx, cy, newW, newH, W, H);
      outCtx.drawImage(img, p.x0, p.y0, fgW, fgH, px, py, newW, newH);
      // Record actual transform
      metaObjects[i].pasteX = px;
      metaObjects[i].pasteY = py;
      metaObjects[i].scale = newW / fgW;
      metaObjects[i].targetW = newW;
      metaObjects[i].targetH = newH;
    }
  } else {
    // Grid layout
    const n = padded.length;
    let cols: number, rows: number;
    if (layout === 'horizontal') {
      rows = 1; cols = n;
    } else if (layout === 'vertical') {
      rows = n; cols = 1;
    } else {
      cols = Math.ceil(Math.sqrt(n));
      rows = Math.ceil(n / cols);
    }
    const cellWBase = Math.floor(W / cols);
    const cellHBase = Math.floor(H / rows);

    let scaleOverride: number | null = null;
    if (uniformScale) {
      const cands: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const cx0 = c * cellWBase;
        const cy0 = r * cellHBase;
        const cx1 = c === cols - 1 ? W : (c + 1) * cellWBase;
        const cy1 = r === rows - 1 ? H : (r + 1) * cellHBase;
        const cw = cx1 - cx0;
        const ch = cy1 - cy0;
        const fgW = padded[i].x1 - padded[i].x0;
        const fgH = padded[i].y1 - padded[i].y0;
        if (cw <= 0 || ch <= 0 || fgW <= 0 || fgH <= 0) continue;
        cands.push(Math.min(cw / fgW, ch / fgH));
      }
      if (cands.length > 0) scaleOverride = Math.min(...cands);
    }

    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx0 = c * cellWBase;
      const cy0 = r * cellHBase;
      const cx1 = c === cols - 1 ? W : (c + 1) * cellWBase;
      const cy1 = r === rows - 1 ? H : (r + 1) * cellHBase;
      const cw = cx1 - cx0;
      const ch = cy1 - cy0;
      if (cw <= 0 || ch <= 0) continue;

      const p = padded[i];
      const fgW = p.x1 - p.x0;
      const fgH = p.y1 - p.y0;
      if (fgW <= 0 || fgH <= 0) continue;

      const [newW, newH] = fitWithScale(fgW, fgH, cw, ch, scaleOverride);
      const px = cx0 + Math.floor((cw - newW) / 2);
      const py = cy0 + Math.floor((ch - newH) / 2);
      outCtx.drawImage(img, p.x0, p.y0, fgW, fgH, px, py, newW, newH);
      metaObjects[i].pasteX = px;
      metaObjects[i].pasteY = py;
      metaObjects[i].scale = newW / fgW;
      metaObjects[i].targetW = newW;
      metaObjects[i].targetH = newH;
    }
  }

  const blob = await canvasToBlob(outCanvas, 'image/png');
  const meta: SmartCropTransformMeta = {
    sourceSize: { width: W, height: H },
    outputSize: { width: W, height: H },
    params: {
      padding, whiteThreshold: whiteThr, minArea, maxObjects,
      layout, uniformScale, preservePosition,
    },
    objects: metaObjects,
  };

  return { blob, meta };
}
