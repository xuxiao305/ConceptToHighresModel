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
 *   Reserved for a future implementation that uses a SAM-class model to
 *   produce a mask directly from user clicks / boxes.
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
