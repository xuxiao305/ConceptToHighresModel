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
    let bb = tightBBox(imageData, W, q.x0, q.y0, q.x1, q.y1, whiteThr);
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

// ---------------------------------------------------------------------------
// 等比放大撑满（移植自 D:\AI\MyComfyuiNodes\SmartCropAndEnlarge nodes.py）
// ---------------------------------------------------------------------------

export interface EnlargeToFillOptions {
  /** 网格行数，默认 2（适配 2x2 多视图布局） */
  rows?: number;
  /** 网格列数，默认 2 */
  cols?: number;
  /** 在每个单元内、围绕 tight bbox 的外扩像素数，默认 8 */
  padding?: number;
  /** 视为"白底背景"的阈值：r/g/b 任一 < 该值即视为前景，默认 240 */
  whiteThreshold?: number;
  /** 若图像带 alpha，是否按 alpha>8 来判定前景（默认 false，按白底判定） */
  useAlpha?: boolean;
  /** 内容相对单元的最大占比，1.0 = 完全撑满。默认 1.0 */
  fillRatio?: number;
  /** 背景填充色，默认 '#ffffff'（白）。可用 'transparent' 关键字。 */
  background?: string;
}

/**
 * 把一张图按 rows × cols 网格切分，每个单元内：
 *   1. 找前景的紧凑包围盒（按 white_threshold 或 alpha 判定）
 *   2. 围绕 bbox 加 `padding` 像素外扩
 *   3. 把这块内容等比缩放到 (cell_w * fillRatio, cell_h * fillRatio) 的最大尺寸
 *   4. 居中粘回相同的单元位置
 *
 * 输出尺寸与输入一致，每个单元的主体都被"撑满"。
 *
 * 算法严格对照 ComfyUI 节点 SmartCropAndEnlargeGrid 的实现，便于结果一致。
 */
export async function enlargeMultiViewToFill(
  source: Blob | string,
  opts: EnlargeToFillOptions = {},
): Promise<Blob> {
  const rows = Math.max(1, Math.floor(opts.rows ?? 2));
  const cols = Math.max(1, Math.floor(opts.cols ?? 2));
  const padding = Math.max(0, Math.floor(opts.padding ?? 8));
  const whiteThr = opts.whiteThreshold ?? 240;
  const useAlpha = opts.useAlpha ?? false;
  const fillRatio = Math.max(0.05, Math.min(1.0, opts.fillRatio ?? 1.0));
  const bgColor = opts.background ?? '#ffffff';
  const transparent = bgColor.toLowerCase() === 'transparent' || bgColor.toLowerCase() === 'none';

  const img = await loadImage(source);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // 把源图绘到一张 canvas，方便逐像素读取。
  const srcCanvas = makeCanvas(W, H);
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) throw new Error('无法获取 2D Canvas 上下文');
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, W, H).data;

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

  // 单元尺寸（最后一行/列吸收余数，避免边缘 1px 黑线）
  const cellWBase = Math.floor(W / cols);
  const cellHBase = Math.floor(H / rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellWBase;
      const y0 = r * cellHBase;
      const x1 = c === cols - 1 ? W : (c + 1) * cellWBase;
      const y1 = r === rows - 1 ? H : (r + 1) * cellHBase;
      const cellW = x1 - x0;
      const cellH = y1 - y0;
      if (cellW <= 0 || cellH <= 0) continue;

      // 在单元内找 tight bbox（绝对坐标，end 不包含）
      const bb = tightBBoxFG(srcData, W, x0, y0, x1, y1, whiteThr, useAlpha);
      if (!bb) continue;

      // 把 bbox 向外扩 padding（限制在单元范围内）
      const bx0 = Math.max(x0, bb.x0 - padding);
      const by0 = Math.max(y0, bb.y0 - padding);
      const bx1 = Math.min(x1, bb.x1 + padding);
      const by1 = Math.min(y1, bb.y1 + padding);
      const fgW = bx1 - bx0;
      const fgH = by1 - by0;
      if (fgW <= 0 || fgH <= 0) continue;

      // 等比缩放到 (cellW * fillRatio, cellH * fillRatio) 内部
      const targetW = Math.max(1, Math.round(cellW * fillRatio));
      const targetH = Math.max(1, Math.round(cellH * fillRatio));
      const scale = Math.min(targetW / fgW, targetH / fgH);
      const newW = Math.max(1, Math.round(fgW * scale));
      const newH = Math.max(1, Math.round(fgH * scale));

      // 在单元内居中
      const dx = x0 + Math.floor((cellW - newW) / 2);
      const dy = y0 + Math.floor((cellH - newH) / 2);

      outCtx.drawImage(
        img,
        bx0, by0, fgW, fgH,  // src
        dx, dy, newW, newH,   // dst
      );
    }
  }

  return await canvasToBlob(outCanvas, 'image/png');
}

/**
 * 在指定矩形区域内找前景的紧凑 bbox（绝对坐标）。
 *   - useAlpha=true 且像素有 alpha：alpha > 8 即视为前景
 *   - 否则：r,g,b 任一 < whiteThr 即视为前景（同时 alpha < 8 视为背景）
 */
function tightBBoxFG(
  data: Uint8ClampedArray,
  imgW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  whiteThr: number,
  useAlpha: boolean,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;
  let found = false;

  for (let y = y0; y < y1; y++) {
    const rowBase = y * imgW * 4;
    for (let x = x0; x < x1; x++) {
      const i = rowBase + x * 4;
      const a = data[i + 3];
      let isFg: boolean;
      if (useAlpha) {
        isFg = a > 8;
      } else {
        if (a < 8) {
          isFg = false;
        } else {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          isFg = r < whiteThr || g < whiteThr || b < whiteThr;
        }
      }
      if (!isFg) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      found = true;
    }
  }
  if (!found) return null;
  // 返回 end-exclusive
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 在指定矩形区域内寻找"非近白色像素"的紧凑包围盒。返回 null 表示全是背景。 */
function tightBBox(
  data: Uint8ClampedArray,
  imgW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  whiteThr: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;
  let found = false;

  for (let y = y0; y < y1; y++) {
    const rowBase = y * imgW * 4;
    for (let x = x0; x < x1; x++) {
      const i = rowBase + x * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      // 透明 OR 近白 → 视为背景
      if (a < 8) continue;
      if (r >= whiteThr && g >= whiteThr && b >= whiteThr) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      found = true;
    }
  }

  if (!found) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

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
