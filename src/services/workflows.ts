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
import tposeMultiViewTemplate from '../../ComfyuiWorkflow/TPoseMultiView.api.json';

export interface RunOptions {
  onStatus?: (msg: string) => void;
}

type WorkflowTemplate = Record<
  string,
  { inputs: Record<string, unknown>; class_type: string }
>;

/** Convert a blob URL (from a previous workflow output) back into a File for re-upload. */
async function blobUrlToFile(url: string, filename: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法读取上一步输出: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || 'image/png' });
}

/**
 * Concept → T Pose
 *
 * Steps:
 *   1. Upload the concept image to ComfyUI
 *   2. Clone workflow template, replace node "1".inputs.image with the uploaded filename
 *   3. Submit, poll until complete, fetch output image as blob URL
 */
export async function runConceptToTPose(
  conceptFile: File,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;

  onStatus?.('上传 Concept 图到 ComfyUI…');
  const uploadedName = await uploadImage(conceptFile);

  const workflow = JSON.parse(JSON.stringify(conceptToTPoseTemplate)) as WorkflowTemplate;
  workflow['1'].inputs.image = uploadedName;
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

/**
 * T Pose → Multi-View (4-view turnaround sheet: front / left / right / back)
 *
 * Accepts either a File (rare) or a previously-generated blob URL (the typical case
 * — the upstream T Pose node stored its result as an object URL).
 */
export async function runTPoseMultiView(
  tposeInput: File | string,
  opts: RunOptions = {}
): Promise<string> {
  const { onStatus } = opts;

  onStatus?.('准备 T Pose 输入…');
  const file =
    typeof tposeInput === 'string'
      ? await blobUrlToFile(tposeInput, `tpose_${Date.now()}.png`)
      : tposeInput;

  onStatus?.('上传 T Pose 图到 ComfyUI…');
  const uploadedName = await uploadImage(file);

  const workflow = JSON.parse(JSON.stringify(tposeMultiViewTemplate)) as WorkflowTemplate;
  workflow['3'].inputs.image = uploadedName;
  if (workflow['2']?.inputs && 'seed' in workflow['2'].inputs) {
    workflow['2'].inputs.seed = Math.floor(Math.random() * 2 ** 31);
  }

  onStatus?.('提交多视图工作流…');
  const promptId = await queuePrompt(workflow);

  onStatus?.('等待 Gemini 生成 Multi-View（首次较慢）…');
  const entry = await pollHistory(promptId, {
    onProgress: (s) => onStatus?.(`ComfyUI: ${s}`),
  });

  const outRef = firstOutputImage(entry);
  if (!outRef) throw new Error('ComfyUI 未返回任何输出图');

  onStatus?.('下载多视图结果…');
  return fetchOutputAsBlobURL(outRef);
}
