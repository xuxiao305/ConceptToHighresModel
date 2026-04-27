/**
 * Workflow runners — high-level functions that compose ComfyUI API calls
 * with a specific workflow template (loaded from /ComfyuiWorkflow/*.json).
 */

import {
  uploadImage,
  queuePrompt,
  pollHistory,
  fetchOutputAsBlobURL,
  firstOutputImage,
  type ComfyHistoryEntry,
} from './comfyui';

import conceptToTPoseTemplate from '../../ComfyuiWorkflow/ConceptToTPose.json';

export interface RunOptions {
  onStatus?: (msg: string) => void;
}

/**
 * Concept → T Pose
 *
 * Steps:
 *   1. Upload the concept image to ComfyUI
 *   2. Clone the workflow template, replace node "1".inputs.image with the uploaded filename
 *   3. Submit, poll until complete, fetch output image as blob URL
 */
export async function runConceptToTPose(
  conceptFile: File,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;

  onStatus?.('上传 Concept 图到 ComfyUI…');
  const uploadedName = await uploadImage(conceptFile);

  // Deep clone & inject the uploaded filename into node 1 (LoadImage)
  const workflow = JSON.parse(JSON.stringify(conceptToTPoseTemplate)) as Record<
    string,
    { inputs: Record<string, unknown>; class_type: string }
  >;
  workflow['1'].inputs.image = uploadedName;

  // Optional: randomize seed in node 2 (GeminiImage2Node) so re-runs differ
  if (workflow['2']?.inputs && 'seed' in workflow['2'].inputs) {
    workflow['2'].inputs.seed = Math.floor(Math.random() * 2 ** 31);
  }

  onStatus?.('提交工作流到 ComfyUI 队列…');
  const promptId = await queuePrompt(workflow);

  onStatus?.('等待 Gemini 生成 T Pose（首次较慢）…');
  const entry: ComfyHistoryEntry = await pollHistory(promptId, {
    onProgress: (s) => onStatus?.(`ComfyUI: ${s}`),
  });

  const outRef = firstOutputImage(entry);
  if (!outRef) throw new Error('ComfyUI 未返回任何输出图');

  onStatus?.('下载生成结果…');
  return fetchOutputAsBlobURL(outRef);
}
