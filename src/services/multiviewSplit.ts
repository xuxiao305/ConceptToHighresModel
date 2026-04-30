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

      // 在单元内找"最大连通分量"的紧凑 bbox（绝对坐标，end 不包含）。
      // 使用最大连通分量是为了避免把邻接象限渗过来的零碎像素算进 bbox。
      const bb = largestComponentBBox(srcData, W, x0, y0, x1, y1, whiteThr, useAlpha);
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
