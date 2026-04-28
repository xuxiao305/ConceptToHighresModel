/**
 * High-level workflow runners for the Concept → 3D pipeline.
 *
 * These call the Leihuo AI gateway directly (Gemini image-generation models)
 * — no ComfyUI in the loop. The prompts below were ported verbatim from the
 * original ComfyUI workflows under /ComfyuiWorkflow/.
 */

import { generateImage } from './leihuo';
import { editImage } from './qwenEdit';

export interface RunOptions {
  onStatus?: (msg: string) => void;
  /** Optional seed. If omitted, a random 31-bit seed is generated and reported via onStatus. */
  seed?: number;
}

const TPOSE_PROMPT =
  '将图中角色转换为正面TPose, 两臂完全水平张开，双腿微张; 正交视图，使用环境柔光，白色背景，白平衡5500k,美术风格保持和原图一致';

const MULTIVIEW_PROMPT =
  'Change the character to T-Pose, arm fully stretched horizontally, and create a professional character reference sheet based strictly on the uploaded reference image. ' +
  'Use a clean, neutral plain background and present the sheet as a technical model turnaround while matching the exact visual style of the reference (same realism level, rendering approach, texture, color treatment, and overall aesthetic). ' +
  'Arrange the composition into two horizontal rows.\n' +
  'Top row column 1: front view full body\n' +
  'Top row column 2: left profile character facing left\n' +
  'Bottom row columan 1: right profile character facing right\n' +
  'Bottom row column 2: back view\n' +
  'Maintain perfect identity consistency across every panel. Keep the subject in a relaxed A-pose and with consistent scale and alignment between views, accurate anatomy, and clear silhouette; ensure even spacing and clean panel separation, with uniform framing and consistent head height across the full-body lineup and consistent facial scale across the portraits. ' +
  'Lighting should be consistent across all panels (same direction, intensity, and softness), with natural, controlled shadows that preserve detail without dramatic mood shifts.';

/** Generate a random 31-bit positive seed (avoids JS Number sign-bit issues). */
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Concept → T-Pose: take the user-uploaded concept image and ask Gemini to
 * redraw the character in a clean front-facing T-pose on a white background.
 */
export async function runConceptToTPose(
  conceptFile: File,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;
  const seed = opts.seed ?? randomSeed();
  onStatus?.(`调用雷火 Gemini 生成 T Pose（seed=${seed}）…`);
  const url = await generateImage({
    prompt: TPOSE_PROMPT,
    images: [conceptFile],
    seed,
  });
  onStatus?.('T Pose 生成完成');
  return url;
}

/**
 * T-Pose → Multi-View: take the T-pose image and produce a 4-panel turnaround
 * sheet (front / left / right / back).
 *
 * Accepts a File / Blob or a previously-generated blob:/http(s) URL.
 */
export async function runTPoseMultiView(
  tposeInput: File | Blob | string,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;
  const seed = opts.seed ?? randomSeed();
  onStatus?.(`调用雷火 Gemini 生成 Multi-View（seed=${seed}）…`);
  const url = await generateImage({
    prompt: MULTIVIEW_PROMPT,
    images: [tposeInput],
    seed,
  });
  onStatus?.('Multi-View 生成完成');
  return url;
}

// ─── Qwen Multi-View (8 camera angles via QwenEditService) ──────────────────

/** One generated view: angle label + result blob URL. */
export interface QwenViewResult {
  key: string;
  label: string;
  imageUrl: string;
  blob: Blob;
}

const QWEN_VIEWS: { key: string; label: string; prompt: string; seed: number }[] = [
  // Keep prompts/seeds identical to ComfyuiWorkflow/Qwen_MultiView.json.
  { key: 'close_up',    label: 'Close Up',    prompt: ' Turn the camera to a close-up.\n',               seed: 1106429432136498 },
  { key: 'wide_shot',   label: 'Wide Shot',   prompt: 'Turn the camera to a wide-angle lens.\n',         seed: 864993937066247 },
  { key: '45_right',    label: '45° Right',   prompt: 'Rotate the camera 45 degrees to the right.\n',    seed: 405868421823137 },
  { key: '90_right',    label: '90° Right',   prompt: 'Rotate the camera 90 degrees to the right.\n',    seed: 507933693362283 },
  { key: 'aerial_view', label: 'Aerial View', prompt: 'Turn the camera to an aerial view.',               seed: 757958372345700 },
  { key: 'low_angle',   label: 'Low Angle',   prompt: 'Turn the camera to a low-angle view.',             seed: 495293742630408 },
  { key: '45_left',     label: '45° Left',    prompt: 'Rotate the camera 45 degrees to the left.',        seed: 941061162245235 },
  { key: '90_left',     label: '90° Left',    prompt: 'Rotate the camera 90 degrees to the left.',        seed: 202646758175812 },
];

/**
 * Match ComfyUI's ImageScaleToTotalPixels(megapixels=1) preprocessing step.
 */
async function scaleToMegapixels(image: File | Blob, megapixels = 1): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  const srcPixels = bitmap.width * bitmap.height;
  const targetPixels = Math.max(1, Math.round(megapixels * 1_000_000));
  const scale = Math.sqrt(targetPixels / srcPixels);

  // Skip tiny adjustments to avoid unnecessary re-encoding.
  if (Math.abs(scale - 1) < 0.01) {
    bitmap.close();
    return image;
  }

  const width = Math.max(64, Math.round(bitmap.width * scale));
  const height = Math.max(64, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas 2D context unavailable');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Failed to encode scaled image'));
    }, 'image/png');
  });
  return blob;
}

/**
 * Generate 8 camera-angle variants of a character image using QwenEditService.
 * Mirrors the Qwen_MultiView.json ComfyUI workflow.
 *
 * @param image     Source image (File or Blob).
 * @param opts      Optional status callback and seed.
 * @param onEach    Called after each view completes (for incremental UI updates).
 */
export async function runQwenMultiView(
  image: File | Blob,
  opts: RunOptions & { onEach?: (view: QwenViewResult) => void } = {},
): Promise<QwenViewResult[]> {
  const { onStatus, onEach } = opts;
  onStatus?.(`Qwen 多角度重绘（ComfyUI 对齐模式，共 ${QWEN_VIEWS.length} 个视角）…`);

  // Comfy workflow scales input to 1MP before VAE encode.
  const prepared = await scaleToMegapixels(image, 1);

  const results: QwenViewResult[] = [];
  for (let i = 0; i < QWEN_VIEWS.length; i++) {
    const v = QWEN_VIEWS[i];
    onStatus?.(`生成 ${v.label}（${i + 1}/${QWEN_VIEWS.length}，seed=${v.seed}）…`);
    const result = await editImage(prepared, {
      prompt: v.prompt,
      negativePrompt: '',
      steps: 4,
      cfg: 1,
      seed: v.seed,
    });
    const view: QwenViewResult = { key: v.key, label: v.label, imageUrl: result.imageUrl, blob: result.blob };
    results.push(view);
    onEach?.(view);
  }

  onStatus?.('Qwen 多角度重绘完成');
  return results;
}
