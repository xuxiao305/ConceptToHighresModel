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
  /** Optional reference images. Accepts File / Blob objects or already-resolved
   *  data-URL / blob-URL / http(s) URL strings. Each is sent as an
   *  `image_url` content part. */
  images?: Array<File | Blob | string>;
  model?: string;
  /** Optional seed for reproducibility. If omitted, the API picks one. */
  seed?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** 将 Uint8Array 编码为 base64（不依赖 FileReader，安全可重入）。 */
function bytesToBase64(bytes: Uint8Array): string {
  // chunk 化，避免 String.fromCharCode 一次塞太多参数
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length)) as unknown as number[],
    );
  }
  return btoa(bin);
}

/** 把 Blob 转成 `data:<mime>;base64,...` URL。 */
async function blobToDataUrl(blob: Blob, fallbackMime = 'image/png'): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || fallbackMime;
  return `data:${mime};base64,${bytesToBase64(buf)}`;
}

/** Convert a blob:/http: URL to a base64 data URL. */
async function blobUrlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法读取图片 (HTTP ${res.status}): ${url}`);
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

async function toDataUrl(input: File | Blob | string | unknown): Promise<string> {
  if (input == null) {
    throw new Error('toDataUrl: 输入为空（null/undefined）');
  }
  if (typeof input === 'string') {
    if (input.startsWith('data:')) return input;
    if (input.startsWith('blob:') || input.startsWith('http:') || input.startsWith('https:')) {
      return blobUrlToDataUrl(input);
    }
    throw new Error(`toDataUrl: 不支持的字符串输入（前缀未知）：${input.slice(0, 64)}…`);
  }
  // 鸭子类型：File/Blob 都有 arrayBuffer 方法（避免跨 HMR / iframe 边界 instanceof 失效）
  if (typeof (input as Blob).arrayBuffer === 'function') {
    return blobToDataUrl(input as Blob);
  }
  // 兜底：详细描述对象，便于诊断
  let desc = Object.prototype.toString.call(input);
  try {
    const keys = Object.keys(input as object).slice(0, 8).join(',');
    desc += ` keys=[${keys}]`;
  } catch {
    /* ignore */
  }
  throw new Error(`toDataUrl: 不支持的输入类型 ${desc}`);
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
