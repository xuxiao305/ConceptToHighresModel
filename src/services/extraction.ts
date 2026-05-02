/**
 * Page2 part-level extraction service.
 *
 * Two pipelines (matching Document/Design/Pipelines_Page2 exactly):
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ Pipeline 1 — "Jacket Extract"                                       │
 *   │   source: Page1 Multi-View (T-pose 4-view)                          │
 *   │   ① extractWithPrompt(EXTRACT_JACKET_PROMPT) → Banana Pro 4-view    │
 *   │   ② removeBackgroundRMBG()  → RMBG-2.0, white background            │
 *   │   ③ smartCropAndEnlargeAuto({padding:1, max_objects:16,             │
 *   │       layout:'auto', uniform_scale:true, preserve_position:true})   │
 *   │   ④ splitMultiView()        → 4 individual views                    │
 *   │ Mirrors ComfyuiWorkflow/BananaExtractJacket.json node-for-node.     │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ Pipeline 2 — "General Extract"                                      │
 *   │   source: Page1 Extraction (Remove Jacket 4-view)                   │
 *   │   ① extractWithSAM3() → user paints multi-region masks in SAM3 GUI  │
 *   │   ② applyMaskWhiteFullSize() → mask × source, white background      │
 *   │   ③ smartCropAndEnlargeAuto({padding:8, min_area:64,                │
 *   │       layout:'auto', uniform_scale:false, preserve_position:false}) │
 *   │   ④ splitMultiView()        → 4 individual views                    │
 *   │ Mirrors ComfyuiWorkflow/SAM3_ExtractParts.json node-for-node.       │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The two pipelines share the same post-process tail (③+④) — only the
 * "extract → mask-on-white" prefix differs.  Wiring lives in
 * src/pages/Page2/PartPipeline.tsx (`runExtraction`).
 */

import { generateImage } from './leihuo';

/**
 * Page1 "Remove Jacket" 节点使用的固定提示词：移除外套，补全 T 恤与手臂。
 */
export const REMOVE_JACKET_PROMPT =
  'Remove the orange jacket, and fill the short-sleeve T-shirt and arm coverred by the jacket';

/**
 * Page2 Pipeline 1 ("Jacket Extract") 使用的固定提示词：提取外套，补全被遮挡部分。
 */
export const EXTRACT_JACKET_PROMPT =
  'Extract the orange jacket, remove the other part of the character. Fill the missing part covered by the character body';

/**
 * Page2 Modify 节点使用的固定 Banana Pro 绘制/高清化提示词。
 */
export const MODIFY_HIGHRES_PROMPT =
  'note this is the SAME subject with different angle with such order:\n' +
  'top left: front view \n' +
  'top right: left view\n' +
  'bottom left: right view\n' +
  'bottom right: back view \n\n' +
  'You need to make a higher resolution of the input image, but keep the art style same in general';

// ===========================================================================
// Banana Pro extraction (Pipeline 1 step ①)
// ===========================================================================

export interface ExtractWithPromptOptions {
  /** Source image. Accepts File / Blob / URL string. */
  source: File | Blob | string;
  /** Free-text prompt — usually one of REMOVE_JACKET_PROMPT / EXTRACT_JACKET_PROMPT. */
  prompt: string;
  /** Optional progress / status callback. */
  onStatus?: (msg: string) => void;
  /** Optional fixed seed (omit for random). */
  seed?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Status verb shown in UI, defaults to “提取”. */
  statusAction?: string;
}

/**
 * Run a Banana-Pro-prompt extraction. Returns a blob: URL of the generated PNG.
 */
export async function extractWithPrompt(
  opts: ExtractWithPromptOptions,
): Promise<string> {
  const seed =
    typeof opts.seed === 'number' ? opts.seed : Math.floor(Math.random() * 2 ** 31);
  const action = opts.statusAction ?? '提取';
  opts.onStatus?.(`调用 Banana Pro ${action}（seed=${seed}）…`);
  const url = await generateImage({
    prompt: opts.prompt,
    images: [opts.source],
    seed,
    signal: opts.signal,
  });
  opts.onStatus?.(`Banana Pro ${action}完成`);
  return url;
}

// ===========================================================================
// RMBG-2.0 background removal (Pipeline 1 step ②)
// ===========================================================================

export interface RemoveBackgroundOptions {
  /** Source image. */
  source: File | Blob | string;
  /** Background color (default '#ffffff'). */
  backgroundColor?: string;
  /** RMBG model processing resolution (default 1024 — matches workflow). */
  processRes?: number;
  /** Mask sensitivity (default 1.0). */
  sensitivity?: number;
  /** Optional progress callback. */
  onStatus?: (msg: string) => void;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** Marker error: RMBG bridge is not reachable / Python failed. */
export class RMBGNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RMBGNotWiredError';
  }
}

/**
 * POSTs to the Vite dev plugin `/api/rmbg`, which spawns
 * `scripts/rmbg/rmbg_worker.py` to run RMBG-2.0 on the embedded ComfyUI Python
 * (D:\AI\ComfyUI-Easy-Install\python_embeded\python.exe). Returns a blob: URL
 * to the white-composited PNG.
 */
export async function removeBackgroundRMBG(
  opts: RemoveBackgroundOptions,
): Promise<string> {
  opts.onStatus?.('RMBG-2.0 去背景中…');
  const sourceB64 = await blobToDataUrl(await toBlob(opts.source));

  const res = await fetch('/api/rmbg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: sourceB64,
      processRes: opts.processRes ?? 1024,
      sensitivity: opts.sensitivity ?? 1.0,
      backgroundColor: opts.backgroundColor ?? '#ffffff',
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new RMBGNotWiredError(`RMBG 桥接 HTTP ${res.status}：${await res.text()}`);
  }
  const payload = (await res.json()) as
    | { ok: true; imageBase64: string }
    | { ok: false; error: string };
  if (!payload.ok) {
    throw new RMBGNotWiredError(payload.error);
  }

  const blob = await dataUrlToBlob(payload.imageBase64);
  opts.onStatus?.('RMBG-2.0 完成');
  return URL.createObjectURL(blob);
}

// ===========================================================================
// SAM3 segmentation (Pipeline 2 step ①)
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
  /** Source image. */
  source: File | Blob;
  /** Optional progress / status callback. */
  onStatus?: (msg: string) => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
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

/**
 * Result of SAM3 segmentation: original-size source PNG with the union of all
 * SAM3 regions kept (others replaced by white). Matches the
 * AILab_MaskExtractor(extract_masked_area, background=Color/#FFFFFF) step in
 * SAM3_ExtractParts.json — output keeps the source's full dimensions, no
 * cropping. The caller runs SmartCropAndEnlarge + 4-view split next.
 */
export interface SAM3MaskResult {
  /** Mask-applied PNG, same dimensions as the source. */
  blob: Blob;
  /** Grayscale mask PNG (R=G=B per region) for inspection. */
  maskBlob: Blob;
  /** Region count returned by SAM3. */
  regionCount: number;
}

/**
 * Drives the SAM3 GUI bridge:
 *   1. POSTs the source image to `/api/sam3-extract`. The plugin spawns the
 *      SAM3 GUI (PyQt window) with the image preloaded; the user does
 *      multi-region point/click segmentation and hits "导出 JSON". The
 *      window auto-closes once the export lands.
 *   2. In the browser, applies the union of SAM3 masks (any non-zero pixel
 *      counts) to the source: pixels inside the mask keep their colour,
 *      pixels outside become white. Output keeps the source's full
 *      dimensions — this matches AILab_MaskExtractor in the workflow.
 */
export async function extractWithSAM3(
  opts: ExtractWithSAM3Options,
): Promise<SAM3MaskResult> {
  const { source, onStatus, signal } = opts;

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

  const maskBlob = await dataUrlToBlob(payload.maskBase64);
  const maskedBlob = await applyMaskWhiteFullSize(source, payload.maskBase64);
  onStatus?.('已对原图应用 SAM3 mask（保留 4-view 整图）');

  return {
    blob: maskedBlob,
    maskBlob,
    regionCount: payload.json.objects.length,
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

async function toBlob(src: File | Blob | string): Promise<Blob> {
  if (typeof src === 'string') {
    const r = await fetch(src);
    return await r.blob();
  }
  return src;
}

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

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const r = await fetch(dataUrl);
  return await r.blob();
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
 * Compose source × mask → "source-where-mask, white-elsewhere" PNG, keeping
 * the source's original dimensions.  Equivalent to ComfyUI's
 * `AILab_MaskExtractor(mode=extract_masked_area, background=Color/#FFFFFF)`.
 *
 * Mask is interpreted as grayscale (R=G=B); any value > 0 is treated as
 * "inside the union of all regions", matching `SAM3MergeMasks(union)`.
 */
async function applyMaskWhiteFullSize(
  source: Blob,
  maskBase64: string,
): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(source);
  try {
    const [srcImg, maskImg] = await Promise.all([loadImage(sourceUrl), loadImage(maskBase64)]);
    const W = srcImg.naturalWidth;
    const H = srcImg.naturalHeight;

    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const octx = out.getContext('2d', { willReadFrequently: true });
    if (!octx) throw new Error('无法获取 2D Canvas 上下文');

    octx.drawImage(srcImg, 0, 0);
    const srcData = octx.getImageData(0, 0, W, H);

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = W;
    maskCanvas.height = H;
    const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mctx) throw new Error('无法获取 mask 2D Canvas 上下文');
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(maskImg, 0, 0, W, H);
    const maskData = mctx.getImageData(0, 0, W, H).data;

    const px = srcData.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        if (maskData[idx] > 0) {
          // keep src RGB; force opaque
          px[idx + 3] = 255;
        } else {
          px[idx] = 255; px[idx + 1] = 255; px[idx + 2] = 255; px[idx + 3] = 255;
        }
      }
    }
    octx.putImageData(srcData, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas.toBlob 返回空'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
