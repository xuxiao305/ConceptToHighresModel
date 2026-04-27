/**
 * Tripo AI 3D 模型生成服务（雷火 AI 网关路由版本）
 *
 * 重要：`model_version` 字段不要带 `tripo-` 前缀。
 * 雷火网关路由时会自动拼接 `tripo-` 识别后端模型。
 * 例：发 `v3.1-20260211` → 网关转发为 `tripo-v3.1-20260211`。
 */

const BASE = '/tripo';
const TOKEN = (import.meta.env.VITE_TRIPO_TOKEN as string | undefined) ?? '';

export const TRIPO_MODEL_VERSIONS = [
  'v3.1-20260211',
  'P1-20260311',
  'v2.5-20250123',
  'v2.0-20240919',
] as const;

export type TripoModelVersion = (typeof TRIPO_MODEL_VERSIONS)[number];

export const DEFAULT_TRIPO_MODEL_VERSION: TripoModelVersion =
  ((import.meta.env.VITE_TRIPO_MODEL as string | undefined) as TripoModelVersion) ??
  'v3.1-20260211';

export interface TripoGenerateParams {
  model_version?: TripoModelVersion;
  texture?: boolean;
  pbr?: boolean;
  texture_quality?: 'standard' | 'detailed';
  /** 0 = 自动 */
  face_limit?: number;
  /** -1 = 随机 */
  model_seed?: number;
  /** -1 = 随机 */
  texture_seed?: number;
  enable_image_autofix?: boolean;
  texture_alignment?: 'original_image' | 'geometry';
  auto_size?: boolean;
  orientation?: 'default' | 'align_image';
  /** true = FBX，false = GLB（默认） */
  quad?: boolean;
  smart_low_poly?: boolean;
  export_uv?: boolean;
}

export type TripoStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface TripoTaskStatus {
  status: TripoStatus;
  /** 0-100 */
  progress: number;
  output: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface TripoTaskResult {
  task_id: string;
  model_url: string;
  rendered_image_url?: string;
  pbr_model_url?: string;
}

export class TripoServiceError extends Error {
  constructor(
    message: string,
    public error_code: number = 0,
    public task_id: string = ''
  ) {
    super(message);
    this.name = 'TripoServiceError';
  }
}

function ensureToken(): void {
  if (!TOKEN) {
    throw new TripoServiceError(
      'Tripo API Token 未配置：请在 .env.local 中设置 VITE_TRIPO_TOKEN'
    );
  }
}

/** 上传一张图片，得到 image_token，用于后续 createTask 引用。 */
export async function uploadImage(
  data: Blob | Uint8Array,
  filename: string = 'image.jpg'
): Promise<string> {
  ensureToken();

  const blob =
    data instanceof Blob
      ? data
      : new Blob([data as BlobPart], { type: 'image/jpeg' });
  const sizeKb = (blob.size / 1024).toFixed(1);
  console.log(`[Tripo] 上传 ${filename} (${sizeKb} KB)`);

  const form = new FormData();
  form.append('file', blob, filename);

  const resp = await fetch(`${BASE}/v2/openapi/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });

  if (!resp.ok) {
    throw new TripoServiceError(
      `上传失败 (HTTP ${resp.status}): ${await resp.text()}`
    );
  }

  const json = (await resp.json()) as {
    code?: number;
    message?: string;
    data?: { image_token?: string };
  };
  if (json.code !== 0) {
    throw new TripoServiceError(json.message ?? '上传失败', json.code ?? 0);
  }
  const token = json.data?.image_token;
  if (!token) throw new TripoServiceError('响应缺少 image_token');
  console.log(`[Tripo] image_token=${token}`);
  return token;
}

/** 提交 image_to_model 任务，得到 task_id。 */
export async function createTask(
  fileToken: string,
  params: TripoGenerateParams = {}
): Promise<string> {
  ensureToken();

  const payload: Record<string, unknown> = {
    type: 'image_to_model',
    model_version: params.model_version ?? DEFAULT_TRIPO_MODEL_VERSION,
    file: { type: 'jpg', file_token: fileToken },
    texture: params.texture ?? true,
    pbr: params.pbr ?? true,
    texture_quality: params.texture_quality ?? 'standard',
    texture_alignment: params.texture_alignment ?? 'original_image',
    auto_size: params.auto_size ?? false,
    orientation: params.orientation ?? 'default',
    quad: params.quad ?? false,
    smart_low_poly: params.smart_low_poly ?? false,
    export_uv: params.export_uv ?? true,
    enable_image_autofix: params.enable_image_autofix ?? false,
  };
  if (params.face_limit && params.face_limit > 0) {
    payload.face_limit = params.face_limit;
  }
  if (params.model_seed !== undefined && params.model_seed >= 0) {
    payload.model_seed = params.model_seed;
  }
  if (params.texture_seed !== undefined && params.texture_seed >= 0) {
    payload.texture_seed = params.texture_seed;
  }

  console.log(`[Tripo] createTask model_version=${payload.model_version}`);

  const resp = await fetch(`${BASE}/v2/openapi/task`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new TripoServiceError(
      `任务创建失败 (HTTP ${resp.status}): ${await resp.text()}`
    );
  }

  const json = (await resp.json()) as {
    code?: number;
    message?: string;
    data?: { task_id?: string };
  };
  if (json.code !== 0) {
    throw new TripoServiceError(json.message ?? '任务创建失败', json.code ?? 0);
  }
  const taskId = json.data?.task_id;
  if (!taskId) throw new TripoServiceError('响应缺少 task_id');
  console.log(`[Tripo] task_id=${taskId}`);
  return taskId;
}

function pickUrl(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return '';
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
    return (v as { url: string }).url;
  }
  return '';
}

/** 查询单次任务状态。兼容多种返回结构（code/data 包装、扁平、仅 task_id）。 */
export async function getTaskStatus(taskId: string): Promise<TripoTaskStatus> {
  ensureToken();
  const resp = await fetch(`${BASE}/v2/openapi/task/${taskId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!resp.ok) {
    throw new TripoServiceError(
      `查询失败 (HTTP ${resp.status}): ${await resp.text()}`,
      0,
      taskId
    );
  }
  const data = (await resp.json()) as Record<string, unknown>;

  // 形态 1: { code, message, data: {...} }
  if ('code' in data) {
    if (data.code !== 0) {
      throw new TripoServiceError(
        (data.message as string) ?? '查询失败',
        (data.code as number) ?? 0,
        taskId
      );
    }
    const td = (data.data as Record<string, unknown>) ?? {};
    return {
      status: ((td.status as TripoStatus) ?? 'unknown'),
      progress: (td.progress as number) ?? 0,
      output: (td.output as Record<string, unknown>) ?? {},
      raw: td,
    };
  }

  // 形态 2: 扁平 { status, progress, output }
  if ('status' in data) {
    return {
      status: data.status as TripoStatus,
      progress: (data.progress as number) ?? 0,
      output: (data.output as Record<string, unknown>) ?? {},
      raw: data,
    };
  }

  // 形态 3: 刚创建仅有 task_id
  if ('task_id' in data) {
    return { status: 'queued', progress: 0, output: {}, raw: data };
  }

  console.warn('[Tripo] 未知响应格式', data);
  return { status: 'unknown', progress: 0, output: {}, raw: data };
}

export interface WaitOptions {
  onProgress?: (progress: number, status: TripoStatus) => void;
  /** 默认 3000 ms */
  pollInterval?: number;
  /** 默认 600000 ms = 10 分钟 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 轮询直到任务终止（success / failed / cancelled）或超时。 */
export async function waitForCompletion(
  taskId: string,
  opts: WaitOptions = {}
): Promise<TripoTaskResult> {
  const interval = opts.pollInterval ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (opts.signal?.aborted) {
      throw new TripoServiceError('已取消', 0, taskId);
    }

    const s = await getTaskStatus(taskId);
    opts.onProgress?.(s.progress, s.status);

    if (s.status === 'success') {
      const modelUrl =
        pickUrl(s.output, 'model') ||
        pickUrl(s.output, 'base_model') ||
        pickUrl(s.output, 'pbr_model');
      if (!modelUrl) {
        throw new TripoServiceError('响应未包含模型 URL', 0, taskId);
      }
      return {
        task_id: taskId,
        model_url: modelUrl,
        rendered_image_url: pickUrl(s.output, 'rendered_image') || undefined,
        pbr_model_url: pickUrl(s.output, 'pbr_model') || undefined,
      };
    }

    if (s.status === 'failed' || s.status === 'cancelled') {
      throw new TripoServiceError(`任务终止：${s.status}`, 0, taskId);
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new TripoServiceError(
    `任务超时（>${Math.round(timeoutMs / 1000)}s）`,
    0,
    taskId
  );
}

/** 下载模型文件为 Blob。模型 URL 是 CDN 公开链接，不需要 Authorization。 */
export async function downloadModel(modelUrl: string): Promise<Blob> {
  console.log(`[Tripo] 下载模型 ${modelUrl}`);
  const resp = await fetch(modelUrl);
  if (!resp.ok) {
    throw new TripoServiceError(`下载失败 (HTTP ${resp.status})`);
  }
  const blob = await resp.blob();
  console.log(`[Tripo] 已下载 ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  return blob;
}

// ---------------------------------------------------------------------------
// 高层组合：单图 → GLB Blob
// ---------------------------------------------------------------------------

export interface RunImageToModelOptions {
  params?: TripoGenerateParams;
  /** 节点状态 / 进度文本回调 */
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
  pollInterval?: number;
  timeoutMs?: number;
  /** 上传时的文件名（仅用于日志，与生成无关） */
  filename?: string;
}

/**
 * 一站式：上传图片 → 创建任务 → 轮询 → 下载模型 Blob。
 * 返回值同时包含原始 result（含 model_url 等字段）以便上层记录。
 */
export async function runImageToModel(
  imageBlob: Blob,
  opts: RunImageToModelOptions = {}
): Promise<{ blob: Blob; result: TripoTaskResult }> {
  const status = (m: string) => opts.onStatus?.(m);

  status('上传图片中…');
  const fileToken = await uploadImage(imageBlob, opts.filename ?? 'input.jpg');

  status('提交任务中…');
  const taskId = await createTask(fileToken, opts.params);

  status('Tripo 生成中… 0%');
  let lastProgress = -1;
  const result = await waitForCompletion(taskId, {
    pollInterval: opts.pollInterval,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onProgress: (p, s) => {
      if (p !== lastProgress) {
        lastProgress = p;
        status(`Tripo 生成中… ${p}% (${s})`);
      }
    },
  });

  status('下载模型中…');
  const blob = await downloadModel(result.model_url);
  return { blob, result };
}
