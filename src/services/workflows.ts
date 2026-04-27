/**
 * High-level workflow runners for the Concept → 3D pipeline.
 *
 * These call the Leihuo AI gateway directly (Gemini image-generation models)
 * — no ComfyUI in the loop. The prompts below were ported verbatim from the
 * original ComfyUI workflows under /ComfyuiWorkflow/.
 */

import { generateImage } from './leihuo';

export interface RunOptions {
  onStatus?: (msg: string) => void;
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

/**
 * Concept → T-Pose: take the user-uploaded concept image and ask Gemini to
 * redraw the character in a clean front-facing T-pose on a white background.
 */
export async function runConceptToTPose(
  conceptFile: File,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;
  onStatus?.('调用雷火 Gemini 生成 T Pose…');
  const url = await generateImage({ prompt: TPOSE_PROMPT, images: [conceptFile] });
  onStatus?.('T Pose 生成完成');
  return url;
}

/**
 * T-Pose → Multi-View: take the T-pose image and produce a 4-panel turnaround
 * sheet (front / left / right / back).
 *
 * Accepts a File or a previously-generated blob: URL.
 */
export async function runTPoseMultiView(
  tposeInput: File | string,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;
  onStatus?.('调用雷火 Gemini 生成 Multi-View…');
  const url = await generateImage({
    prompt: MULTIVIEW_PROMPT,
    images: [tposeInput],
  });
  onStatus?.('Multi-View 生成完成');
  return url;
}
