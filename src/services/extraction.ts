/**
 * Part-level extraction service.
 *
 * Mode 1 (Banana Pro / Nano Banana Pro):
 *   Reuses the Leihuo gateway's `gemini-3-pro-image-preview` model — which is
 *   the same Gemini model that ComfyUI labels "Nano Banana Pro (Google Gemini
 *   Image)" — to extract a sub-region of the source character image using a
 *   text prompt.
 *
 * Mode 2 (SAM3 segmentation):
 *   Mirrors the ComfyUI workflow `SAM3_ExtractParts.json` step-for-step but
 *   without depending on ComfyUI:
 *
 *     1. Spawn the standalone `sam3_app` GUI in a subprocess (handled by the
 *        Vite dev plugin `sam3-extract-bridge` in vite.config.ts). The user
 *        does interactive point/click segmentation in a native PyQt window
 *        that opens with the source image preloaded; on "导出 JSON" + window
 *        close the bridge returns the resulting `<basename>.json` plus a
 *        grayscale `<basename>_mask.png` where each region has a unique
 *        gray value.
 *     2. SAM3MergeMasks(union) — implicit: any non-zero pixel in the mask is
 *        "inside the union of all regions".
 *     3. AILab_MaskExtractor(extract_masked_area, white background) — done
 *        in the browser via canvas: copy source pixels where mask>0, fill the
 *        rest with white.
 *     4. SmartCropAndEnlargeAuto — likewise canvas-side: tight bbox of the
 *        non-white area, optional padding.
 *     5. GeminiImage2Node — re-compose into a 4-view (front / left / right /
 *        back) reference sheet by calling `generateImage()` with the prompt
 *        copied verbatim from the workflow.
 *
 *   The final output has the SAME shape as Page1's Multi-View (a 2x2 grid),
 *   so we save it the same way: full PNG to `page2.extraction/<file>` and
 *   per-view splits to `<file_basename>_v0001/{front,left,back,right}_v0001.png`.
 */

import { generateImage } from './leihuo';

/** Built-in prompt presets shown in the Banana Pro mode dropdown. */
export const EXTRACTION_PROMPT_PRESETS: { label: string; prompt: string }[] = [
  {
    label: '移除外套，补全 T 恤与手臂',
    prompt:
      'Remove the orange jacket, and fill the short-sleeve T-shirt and arm coverred by the jacket',
  },
  {
    label: '提取外套，补全被遮挡部分',
    prompt:
      'Extract the orange jacket, remove the other part of the character. Fill the missing part covered by the character body',
  },
];

export interface ExtractWithPromptOptions {
  /** Source image (concept / multi-view). Accepts File / Blob / URL string. */
  source: File | Blob | string;
  /** Free-text prompt — usually one of EXTRACTION_PROMPT_PRESETS[i].prompt. */
  prompt: string;
  /** Optional progress / status callback. */
  onStatus?: (msg: string) => void;
  /** Optional fixed seed (omit for random). */
  seed?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Run a Banana-Pro-prompt extraction. Returns a blob: URL of the generated PNG.
 */
export async function extractWithPrompt(
  opts: ExtractWithPromptOptions
): Promise<string> {
  const seed =
    typeof opts.seed === 'number' ? opts.seed : Math.floor(Math.random() * 2 ** 31);
  opts.onStatus?.(`调用 Banana Pro 提取（seed=${seed}）…`);
  const url = await generateImage({
    prompt: opts.prompt,
    images: [opts.source],
    seed,
    signal: opts.signal,
  });
  opts.onStatus?.('提取完成');
  return url;
}

// ===========================================================================
// SAM3 mode
// ===========================================================================

/** JSON exported by `sam3_app` (see `_on_export_json` in app.py). */
export interface SAM3ExportJson {
  image: string;
  mask_png: string;
  objects: Array<{
    label: string;
    /** Pixel intensity (0-255) of this region in the grayscale mask PNG. */
    mask_value: number;
    bbox: { xyxy: [number, number, number, number]; xywh: [number, number, number, number] } | null;
  }>;
}

export interface ExtractWithSAM3Options {
  /** Source image (page1.multiview). */
  source: File | Blob;
  /** Optional Banana-Pro re-composition prompt; when omitted uses the default
   *  prompt copied verbatim from `SAM3_ExtractParts.json` step 11.            */
  recomposePrompt?: string;
  /** Optional progress / status callback. */
  onStatus?: (msg: string) => void;
  /** Optional fixed seed (omit for random). */
  seed?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Padding in pixels around the cropped subject before recompose. Default 12. */
  cropPadding?: number;
  /** Skip the Banana Pro recompose step and return the cropped subject PNG
   *  directly (useful for debugging / when caller wants the masked image). */
  skipRecompose?: boolean;
}

/** Marker error so the UI can distinguish bridge errors from real failures. */
export class SAM3NotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SAM3NotWiredError';
  }
}

/** Marker error: user closed the SAM3 window without exporting. */
export class SAM3CancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SAM3CancelledError';
  }
}

/** Default Banana Pro re-composition prompt — copied verbatim from
 *  `SAM3_ExtractParts.json` node "11.GeminiImage2Node". */
export const SAM3_RECOMPOSE_PROMPT =
  'note this is the SAME subject with different angle with such order:\n' +
  'top left: front view \n' +
  'top right: left view\n' +
  'bottom left: right view\n' +
  'bottom right: back view \n\n' +
  'You need enlarged the subject, scale filling its zone, but do NOT make it across to other grids\n';

/**
 * Drives the full SAM3 extraction workflow by:
 *   1. POSTing the source image to the Vite dev plugin `/api/sam3-extract`.
 *      The plugin spawns the SAM3 GUI (PyQt window) with the image
 *      preloaded; the user does point/click segmentation and hits "导出
 *      JSON". The window auto-closes on export and the plugin returns the
 *      mask PNG + JSON.
 *   2. In the browser, applies the mask to the source (extract masked area,
 *      fill the rest with white) — equivalent to ComfyUI's
 *      AILab_MaskExtractor(extract_masked_area, background=white).
 *   3. Tight-crops the result around the non-white pixels with a small
 *      padding — equivalent to SmartCropAndEnlargeAuto.
 *   4. Calls Banana Pro (Gemini) with `SAM3_RECOMPOSE_PROMPT` to re-compose
 *      a 4-view (front / left / right / back) reference sheet.
 *
 * Returns a blob: URL of the final 4-view PNG (same shape as page1.multiview).
 */
export async function extractWithSAM3(
  opts: ExtractWithSAM3Options,
): Promise<string> {
  const { source, onStatus, signal } = opts;

  // ── 1. Send to bridge → spawn SAM3 GUI → wait for export ────────────────
  onStatus?.('打开 SAM3 窗口…（请在新弹出的窗口中标注后点击"导出 JSON"）');
  const sourceB64 = await blobToDataUrl(source);

  const res = await fetch('/api/sam3-extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: sourceB64 }),
    signal,
  });

  if (!res.ok) {
    throw new SAM3NotWiredError(`SAM3 桥接 HTTP ${res.status}：${await res.text()}`);
  }

  const payload = (await res.json()) as
    | { ok: true; json: SAM3ExportJson; maskBase64: string }
    | { ok: false; error: string; cancelled?: boolean };

  if (!payload.ok) {
    if (payload.cancelled) {
      throw new SAM3CancelledError(payload.error || '用户取消了 SAM3 标注');
    }
    throw new SAM3NotWiredError(payload.error);
  }

  if (payload.json.objects.length === 0) {
    throw new Error('SAM3 导出的 JSON 里没有任何区域');
  }
  onStatus?.(`SAM3 标注完成：${payload.json.objects.length} 个区域`);

  // ── 2. Apply mask + 3. tight crop, all in one canvas pass ───────────────
  const padding = opts.cropPadding ?? 12;
  const croppedBlob = await applyMaskAndCrop(source, payload.maskBase64, padding);
  onStatus?.('已应用 mask 并裁切到主体边界');

  if (opts.skipRecompose) {
    return URL.createObjectURL(croppedBlob);
  }

  // ── 4. Banana Pro recompose into 4-view sheet ──────────────────────────
  const seed = typeof opts.seed === 'number' ? opts.seed : Math.floor(Math.random() * 2 ** 31);
  onStatus?.(`Banana Pro 4视图重组中（seed=${seed}）…`);
  const url = await generateImage({
    prompt: opts.recomposePrompt ?? SAM3_RECOMPOSE_PROMPT,
    images: [croppedBlob],
    seed,
    signal,
  });
  onStatus?.('SAM3 提取完成');
  return url;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Read a Blob/File as a `data:image/...;base64,...` URL. */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      buf.subarray(i, Math.min(i + CHUNK, buf.length)) as unknown as number[],
    );
  }
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Decode a URL or data-URL into an `HTMLImageElement`, awaiting load. */
async function loadImage(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`无法加载图片：${src.slice(0, 64)}…`));
    img.src = src;
  });
}

/**
 * Apply mask to source: pixels where mask>0 keep their source colour, the rest
 * become pure white. Then tight-crop around the non-white area with `padding`
 * pixels of margin.
 */
async function applyMaskAndCrop(
  source: Blob,
  maskBase64: string,
  padding: number,
): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(source);
  try {
    const [srcImg, maskImg] = await Promise.all([loadImage(sourceUrl), loadImage(maskBase64)]);
    const W = srcImg.naturalWidth;
    const H = srcImg.naturalHeight;

    // Step A: composite source × mask → masked-on-white canvas
    const masked = document.createElement('canvas');
    masked.width = W;
    masked.height = H;
    const mctx = masked.getContext('2d', { willReadFrequently: true });
    if (!mctx) throw new Error('无法获取 2D Canvas 上下文');

    // Draw the source first (so we can read its pixels at full resolution).
    mctx.drawImage(srcImg, 0, 0);
    const srcData = mctx.getImageData(0, 0, W, H);

    // Draw mask scaled to source size onto a temporary canvas, then read.
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = W;
    maskCanvas.height = H;
    const mcCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mcCtx) throw new Error('无法获取 mask 2D Canvas 上下文');
    mcCtx.imageSmoothingEnabled = false;
    mcCtx.drawImage(maskImg, 0, 0, W, H);
    const maskData = mcCtx.getImageData(0, 0, W, H).data;

    // Combine: where mask R-channel > 0 keep src pixel; else white.
    let minX = W, minY = H, maxX = -1, maxY = -1;
    const out = srcData.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const m = maskData[idx]; // grayscale mask: R=G=B
        if (m > 0) {
          // keep source RGB, force alpha 255
          out[idx + 3] = 255;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } else {
          out[idx] = 255;
          out[idx + 1] = 255;
          out[idx + 2] = 255;
          out[idx + 3] = 255;
        }
      }
    }
    mctx.putImageData(srcData, 0, 0);

    if (maxX < 0) {
      throw new Error('SAM3 mask 完全为空（没有任何非零像素），无法裁切');
    }

    // Step B: tight crop with padding (clamped to canvas bounds).
    const x0 = Math.max(0, minX - padding);
    const y0 = Math.max(0, minY - padding);
    const x1 = Math.min(W - 1, maxX + padding);
    const y1 = Math.min(H - 1, maxY + padding);
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;

    const cropped = document.createElement('canvas');
    cropped.width = cw;
    cropped.height = ch;
    const cctx = cropped.getContext('2d');
    if (!cctx) throw new Error('无法获取 crop 2D Canvas 上下文');
    cctx.drawImage(masked, x0, y0, cw, ch, 0, 0, cw, ch);

    return await new Promise<Blob>((resolve, reject) => {
      cropped.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas.toBlob 返回空'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
