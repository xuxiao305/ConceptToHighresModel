/**
 * Leihuo (Netease) AI gateway client.
 *
 * Uses the OpenAI Chat Completions–compatible endpoint exposed at
 *   POST {VITE_LEIHUO_BASE}/v1/chat/completions
 * Authentication: Bearer token from VITE_LEIHUO_TOKEN.
 *
 * The endpoint is reached through Vite's `/leihuo` proxy in dev to avoid CORS
 * (see vite.config.ts).
 *
 * For image generation we use multimodal Gemini models (e.g.
 * `gemini-3-pro-image-preview`) which return the image as a base64 data-URL
 * embedded in the assistant message content like:
 *     ![image](data:image/png;base64,iVBOR…)
 */

const BASE = '/leihuo';
const TOKEN = (import.meta.env.VITE_LEIHUO_TOKEN as string | undefined) ?? '';
const DEFAULT_MODEL =
  (import.meta.env.VITE_LEIHUO_MODEL as string | undefined) ??
  'gemini-3-pro-image-preview';

const SYSTEM_PROMPT =
  'You are an expert image-generation engine. You must ALWAYS produce an image.\n' +
  'Interpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition.\n' +
  'If a prompt is conversational or lacks specific visual details, you must creatively invent a concrete visual scenario that depicts the concept.\n' +
  'Prioritize generating the visual representation above any text, formatting, or conversational requests.';

export interface GenerateImageOptions {
  prompt: string;
  /** Optional reference images. Accepts File objects or already-resolved
   *  data-URL / blob-URL strings. Each is sent as an `image_url` content part. */
  images?: Array<File | string>;
  model?: string;
  /** Optional seed for reproducibility. If omitted, the API picks one. */
  seed?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** Convert a File to a base64 data URL. */
async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
    r.readAsDataURL(file);
  });
}

/** Convert a blob: URL to a base64 data URL. */
async function blobUrlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法读取图片 (${res.status}): ${url}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
    r.readAsDataURL(blob);
  });
}

async function toDataUrl(input: File | string): Promise<string> {
  if (typeof input !== 'string') return fileToDataUrl(input);
  if (input.startsWith('data:')) return input;
  if (input.startsWith('blob:')) return blobUrlToDataUrl(input);
  // http(s) URL — fetch then encode
  return blobUrlToDataUrl(input);
}

/** Decode a `data:image/...;base64,...` URL to an object URL. */
function dataUrlToObjectUrl(dataUrl: string): string {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Not a base64 data URL');
  const [, mime, b64] = m;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/**
 * Call Leihuo Gemini image-generation API and return a blob: URL pointing to
 * the generated PNG.
 *
 * Throws on auth failure, network error, or if the response contains no image.
 */
export async function generateImage(opts: GenerateImageOptions): Promise<string> {
  if (!TOKEN) {
    throw new Error(
      '雷火 API Token 未配置：请在 .env.local 中设置 VITE_LEIHUO_TOKEN（值来自 ANTHROPIC_AUTH_TOKEN 环境变量）'
    );
  }

  // Build OpenAI-style content array.
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [{ type: 'text', text: opts.prompt }];

  if (opts.images && opts.images.length > 0) {
    for (const img of opts.images) {
      const url = await toDataUrl(img);
      content.push({ type: 'image_url', image_url: { url } });
    }
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    modalities: ['text', 'image'],
  };
  if (typeof opts.seed === 'number') body.seed = opts.seed;

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`雷火 API 调用失败 HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const messageContent = json.choices?.[0]?.message?.content ?? '';
  const m = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/.exec(messageContent);
  if (!m) {
    throw new Error(`雷火 API 响应中未找到图片，content: ${messageContent.slice(0, 300)}`);
  }
  return dataUrlToObjectUrl(m[0]);
}
