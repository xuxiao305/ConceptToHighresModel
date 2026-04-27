/**
 * ComfyUI HTTP API client (proxied through Vite dev server at /comfy).
 *
 * Workflow execution lifecycle:
 *   1. uploadImage(file)        → uploads to /upload/image, returns server filename
 *   2. queuePrompt(workflow)    → POST /prompt, returns prompt_id
 *   3. pollHistory(prompt_id)   → polls /history/{id} until status.completed === true
 *   4. fetchOutputAsBlobURL(filename, subfolder, type) → GET /view → object URL
 *
 * 注意：新版 ComfyUI 把 API 都挪到 /api/* 下，且启用了多用户后内置 API 节点
 * （如 GeminiImage2Node）需要 Comfy-User header 才能找到对应的 comfy.org 登录态。
 * 这里所有路径统一带 /api 前缀；Comfy-User header 由 Vite 代理注入（见 vite.config.ts）。
 */

const BASE = '/comfy/api';

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyHistoryEntry {
  status: { completed: boolean; status_str: string; messages: unknown[] };
  outputs: Record<string, { images?: ComfyImageRef[] }>;
}

/** Upload a File to ComfyUI's input folder. Returns the filename ComfyUI assigned. */
export async function uploadImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('image', file, file.name);
  fd.append('overwrite', 'true');
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: fd });
  if (!res.ok) {
    throw new Error(`ComfyUI upload failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { name: string };
  return data.name;
}

/** Submit a workflow (API JSON format) to the ComfyUI queue. Returns prompt_id. */
export async function queuePrompt(workflow: unknown): Promise<string> {
  // ComfyUI 多用户模式下，client_id 即用户身份；必须与 ComfyUI Web UI 使用的同一个，
  // 否则内置 API 节点（GeminiImage2Node 等）找不到对应的 comfy.org 登录态会报 Unauthorized。
  // 通过 .env.local 的 VITE_COMFY_CLIENT_ID 注入；未配置则退回到匿名 ID（仅适用于无登录需求的工作流）。
  const clientId =
    (import.meta.env.VITE_COMFY_CLIENT_ID as string | undefined) ||
    `mockup-${Date.now()}`;

  // ComfyUI 内置 API 节点（GeminiImage2Node 等）需要 comfy.org 的登录 token。
  // 它由 ComfyUI 网页前端从 comfy.org 拿到后，**通过 prompt 提交体的 extra_data 字段**
  // 传给 ComfyUI worker（参见 ComfyUI/execution.py SENSITIVE_EXTRA_DATA_KEYS）。
  // 我们的工具同样必须传这个字段，否则 worker 拿不到 token，会报 Unauthorized。
  // token 来源：在浏览器开 ComfyUI 网页（http://127.0.0.1:8188），F12 → 网络 → 点一次
  // Queue Prompt → 找到 /api/prompt 请求 → 「负载/Payload」里 extra_data.auth_token_comfy_org。
  const authToken = import.meta.env.VITE_COMFY_AUTH_TOKEN as string | undefined;
  const apiKey = import.meta.env.VITE_COMFY_API_KEY as string | undefined;
  const extraData: Record<string, unknown> = {};
  if (authToken) extraData.auth_token_comfy_org = authToken;
  if (apiKey) extraData.api_key_comfy_org = apiKey;

  const body: Record<string, unknown> = { prompt: workflow, client_id: clientId };
  if (Object.keys(extraData).length > 0) body.extra_data = extraData;

  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ComfyUI queue failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { prompt_id: string };
  // eslint-disable-next-line no-console
  console.log('[comfy] queuePrompt response:', data, '| auth_token:', authToken ? 'set' : '(none)');
  return data.prompt_id;
}

/** Poll ComfyUI history for a finished prompt. Resolves when execution completes. */
export async function pollHistory(
  promptId: string,
  opts: { intervalMs?: number; timeoutMs?: number; onProgress?: (status: string) => void } = {}
): Promise<ComfyHistoryEntry> {
  const { intervalMs = 1500, timeoutMs = 600_000, onProgress } = opts;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/history/${promptId}`);
    if (res.ok) {
      const data = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = data[promptId];
      if (entry) {
        if (entry.status?.completed) {
          if (entry.status.status_str === 'error') {
            throw new Error('ComfyUI workflow execution failed');
          }
          return entry;
        }
        onProgress?.(entry.status?.status_str ?? 'running');
      } else {
        onProgress?.('queued');
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('ComfyUI workflow polling timed out');
}

/** Build the URL for /view that serves an output image. */
export function viewUrl(ref: ComfyImageRef): string {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? '',
    type: ref.type ?? 'output',
  });
  return `${BASE}/view?${params.toString()}`;
}

/** Fetch an output image as an object URL (so it can be revoked / cached). */
export async function fetchOutputAsBlobURL(ref: ComfyImageRef): Promise<string> {
  const res = await fetch(viewUrl(ref));
  if (!res.ok) throw new Error(`Failed to fetch output image: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Extract the first output image from a finished history entry. */
export function firstOutputImage(entry: ComfyHistoryEntry): ComfyImageRef | null {
  for (const nodeId of Object.keys(entry.outputs)) {
    const imgs = entry.outputs[nodeId]?.images;
    if (imgs && imgs.length > 0) return imgs[0];
  }
  return null;
}

/** Quick health check: returns true if ComfyUI server responds. */
export async function isComfyAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
