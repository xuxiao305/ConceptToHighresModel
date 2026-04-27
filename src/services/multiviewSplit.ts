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
