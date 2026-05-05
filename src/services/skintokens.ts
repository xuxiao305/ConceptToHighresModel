/**
 * SkinTokens / TokenRig — 3D Model Rigging 服务。
 *
 * 通过 Vite dev-server bridge plugin 调用 SkinTokens 仓库的
 * rig_worker.py，对 Tripo/TRELLIS.2 生成的 GLB 做自动骨骼绑定。
 *
 * 流程：
 *   1. POST /api/skintokens  (glb base64 + params)
 *   2. Vite bridge 写 temp .glb → spawn rig_worker.py → 读 output .glb
 *   3. 返回 { ok: true, glbBase64: "data:..." }
 *
 * SkinTokens 仓库：D:\AI\Prototypes\SkinTokens
 * 模型：experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt
 */

const BASE = '/api/skintokens';

/** 生成参数（与 rig_worker.py 参数对齐） */
export interface SkinTokensParams {
  /** top_k 采样（默认 5） */
  topK?: number;
  /** top_p 采样（默认 0.95） */
  topP?: number;
  /** 温度（默认 1.0） */
  temperature?: number;
  /** 重复惩罚（默认 2.0） */
  repetitionPenalty?: number;
  /** beam search 宽度（默认 10） */
  numBeams?: number;
  /** 是否使用已有骨架（默认 false —— 生成完整骨架+蒙皮） */
  useSkeleton?: boolean;
  /** 后处理 voxel skin 平滑（默认 true） */
  usePostprocess?: boolean;
}

export const SKINTOKENS_DEFAULTS: Required<SkinTokensParams> = {
  topK: 5,
  topP: 0.95,
  temperature: 1.0,
  repetitionPenalty: 2.0,
  numBeams: 10,
  useSkeleton: false,
  usePostprocess: true,
};

export interface SkinTokensResult {
  /** Rigged GLB blob URL */
  glbUrl: string;
  /** Raw GLB bytes blob */
  blob: Blob;
}

/** Blob → base64 data URI */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return `data:application/octet-stream;base64,${b64}`;
}

/** base64 data URI → Blob */
function base64ToBlob(dataUri: string, mimeType = 'model/gltf-binary'): Blob {
  const [, b64] = dataUri.split(',', 2);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * 对 GLB 模型执行 TokenRig 自动骨骼绑定。
 *
 * @param glb - 输入 GLB Blob（Tripo / TRELLIS.2 输出）
 * @param params - 生成参数
 * @returns Rigged GLB（object URL + Blob）
 */
export async function runSkinTokensRigging(
  glb: Blob,
  params: SkinTokensParams = {},
): Promise<SkinTokensResult> {
  const mergedParams = { ...SKINTOKENS_DEFAULTS, ...params };

  const glbBase64 = await blobToBase64(glb);

  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      glbBase64,
      params: mergedParams,
    }),
  });

  if (!res.ok) {
    let errorText = '';
    try {
      const body = (await res.json()) as { error?: string };
      errorText = body.error ?? res.statusText;
    } catch {
      errorText = res.statusText;
    }
    throw new Error(`SkinTokens rigging 失败 (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as { ok: true; glbBase64: string };

  const blob = base64ToBlob(data.glbBase64);
  const glbUrl = URL.createObjectURL(blob);

  return { glbUrl, blob };
}
