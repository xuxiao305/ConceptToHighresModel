/**
 * ComfyUI HTTP API client (proxied through Vite dev server at /comfy).
 *
 * Workflow execution lifecycle:
 *   1. uploadImage(file)        → uploads to /upload/image, returns server filename
 *   2. queuePrompt(workflow)    → POST /prompt, returns prompt_id
 *   3. pollHistory(prompt_id)   → polls /history/{id} until status.completed === true
 *   4. fetchOutputAsBlobURL(filename, subfolder, type) → GET /view → object URL
 */

const BASE = '/comfy';

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
  const clientId = `mockup-${Date.now()}`;
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ComfyUI queue failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { prompt_id: string };
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
