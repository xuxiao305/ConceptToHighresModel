/**
 * TRELLIS.2 image-to-3D HTTP client.
 *
 * The actual server runs on the DanLu GPU instance and is reached through a
 * local SSH tunnel:
 *
 *   ssh -i C:/tmp/DanLu_key -p 44304 -L 8766:127.0.0.1:8766 \
 *     root@apps-sl.danlu.netease.com
 *
 * In dev mode the Vite proxy maps `/trellis` → `http://127.0.0.1:8766` (see
 * vite.config.ts), so frontend code only needs the relative path.
 *
 * Output: a textured GLB (PBR) blob.
 */

const BASE = '/trellis';

/** UI 默认值（与服务器端 GenerateRequest 默认对齐）。 */
export const TRELLIS2_DEFAULTS = {
  sparseStructureSteps: 12,
  slatSteps: 12,
  cfg: 3.0,
  decimationTarget: 200_000,
  textureSize: 2048,
  remesh: true,
  simplifyCap: 8_000_000,
} as const;

export interface Trellis2Params {
  /** Number of steps for the sparse-structure flow. 8-16 is typical. */
  sparseStructureSteps?: number;
  /** Number of steps for the SLat (shape + texture) flow. 8-16 is typical. */
  slatSteps?: number;
  /** Classifier-free-guidance strength. Default 3. */
  cfg?: number;
  /** Optional seed for deterministic results. */
  seed?: number;
  /** Final decimation target (faces). Default 200_000. */
  decimationTarget?: number;
  /** Baked PBR texture resolution. Default 2048. */
  textureSize?: number;
  /** Run remeshing pass before bake. Default true. */
  remesh?: boolean;
  /** Hard simplify cap before bake (nvdiffrast limit 16M). Default 8M. */
  simplifyCap?: number;
}

export interface Trellis2Result {
  /** GLB blob URL ready to bind to a 3D viewer. */
  glbUrl: string;
  /** Raw GLB bytes. */
  blob: Blob;
  meta: {
    seed: number;
    sparseStructureSteps: number;
    slatSteps: number;
    cfgStrength: number;
    decimationTarget: number;
    textureSize: number;
    elapsedGenSec: number;
    elapsedBakeSec: number;
    elapsedTotalSec: number;
    glbBytes: number;
  };
}

export interface Trellis2Health {
  status: string;
  modelLoaded: boolean;
  modelPath: string;
  device: string;
  gpuName?: string;
  gpuCount?: number;
  gpuMemFreeGb?: number;
  gpuMemTotalGb?: number;
}

async function fileToBase64(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

export async function getHealth(): Promise<Trellis2Health> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`TRELLIS.2 health failed: ${res.status}`);
  const j = await res.json();
  return {
    status: j.status,
    modelLoaded: !!j.model_loaded,
    modelPath: j.model_path,
    device: j.device,
    gpuName: j.gpu_name,
    gpuCount: j.gpu_count,
    gpuMemFreeGb: j.gpu_mem_free_gb,
    gpuMemTotalGb: j.gpu_mem_total_gb,
  };
}

/** Trigger pipeline load on the server. Resolves once ready. */
export async function warmup(): Promise<void> {
  const res = await fetch(`${BASE}/warmup`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TRELLIS.2 warmup failed: ${res.status} ${text}`);
  }
}

/**
 * Generate a 3D model from a single image. Uses base64 JSON transport so it
 * works behind the SSH tunnel without multipart quirks.
 */
export async function generateModel(
  image: File | Blob,
  params: Trellis2Params = {},
): Promise<Trellis2Result> {
  const body = {
    image_b64: await fileToBase64(image),
    sparse_structure_steps: params.sparseStructureSteps ?? TRELLIS2_DEFAULTS.sparseStructureSteps,
    slat_steps: params.slatSteps ?? TRELLIS2_DEFAULTS.slatSteps,
    cfg_strength: params.cfg ?? TRELLIS2_DEFAULTS.cfg,
    seed: params.seed ?? null,
    decimation_target: params.decimationTarget ?? TRELLIS2_DEFAULTS.decimationTarget,
    texture_size: params.textureSize ?? TRELLIS2_DEFAULTS.textureSize,
    remesh: params.remesh ?? TRELLIS2_DEFAULTS.remesh,
    simplify_cap: params.simplifyCap ?? TRELLIS2_DEFAULTS.simplifyCap,
  };

  const res = await fetch(`${BASE}/generate_b64`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TRELLIS.2 generate failed: ${res.status} ${text}`);
  }
  const j = await res.json();
  const bin = atob(j.glb_b64 as string);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'model/gltf-binary' });
  return {
    glbUrl: URL.createObjectURL(blob),
    blob,
    meta: {
      seed: j.seed,
      sparseStructureSteps: j.sparse_structure_steps,
      slatSteps: j.slat_steps,
      cfgStrength: j.cfg_strength,
      decimationTarget: j.decimation_target,
      textureSize: j.texture_size,
      elapsedGenSec: j.elapsed_gen_sec,
      elapsedBakeSec: j.elapsed_bake_sec,
      elapsedTotalSec: j.elapsed_total_sec,
      glbBytes: j.glb_bytes,
    },
  };
}

/**
 * Generate a 3D model from multiple views (2-8 images).
 *
 * Uses multipart/form-data to send the images + a JSON payload with generation
 * params.  The server concatenates DINOv3 patch features from all views along
 * the sequence dimension before the flow model's cross-attention.
 *
 * Image order convention (matches Tripo): `images[0]=front, images[1]=left,
 * images[2]=back, images[3]=right`.  At least 2 images are required.
 *
 * Returns GLB binary with meta parsed from `x-meta-*` response headers.
 */
export async function generateModelMultiView(
  images: (File | Blob)[],
  params: Trellis2Params = {},
): Promise<Trellis2Result> {
  if (images.length < 2) {
    throw new Error('generateModelMultiView requires at least 2 images');
  }

  const payload = {
    sparse_structure_steps: params.sparseStructureSteps ?? TRELLIS2_DEFAULTS.sparseStructureSteps,
    slat_steps: params.slatSteps ?? TRELLIS2_DEFAULTS.slatSteps,
    cfg_strength: params.cfg ?? TRELLIS2_DEFAULTS.cfg,
    seed: params.seed ?? null,
    decimation_target: params.decimationTarget ?? TRELLIS2_DEFAULTS.decimationTarget,
    texture_size: params.textureSize ?? TRELLIS2_DEFAULTS.textureSize,
    remesh: params.remesh ?? TRELLIS2_DEFAULTS.remesh,
    simplify_cap: params.simplifyCap ?? TRELLIS2_DEFAULTS.simplifyCap,
  };

  const form = new FormData();
  for (const img of images) {
    form.append('images', img);
  }
  form.append('payload', JSON.stringify(payload));

  const res = await fetch(`${BASE}/generate_mv`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TRELLIS.2 multi-view generate failed: ${res.status} ${text}`);
  }

  const glbBytes = await res.arrayBuffer();
  const blob = new Blob([glbBytes], { type: 'model/gltf-binary' });

  // Parse meta from response headers
  const h = (k: string) => res.headers.get(`x-meta-${k}`);
  const meta: Trellis2Result['meta'] = {
    seed: Number(h('seed') ?? 0),
    sparseStructureSteps: Number(h('sparse_structure_steps') ?? 0),
    slatSteps: Number(h('slat_steps') ?? 0),
    cfgStrength: Number(h('cfg_strength') ?? 0),
    decimationTarget: Number(h('decimation_target') ?? 0),
    textureSize: Number(h('texture_size') ?? 0),
    elapsedGenSec: Number(h('elapsed_gen_sec') ?? 0),
    elapsedBakeSec: Number(h('elapsed_bake_sec') ?? 0),
    elapsedTotalSec: Number(h('elapsed_total_sec') ?? 0),
    glbBytes: glbBytes.byteLength,
  };

  return {
    glbUrl: URL.createObjectURL(blob),
    blob,
    meta,
  };
}
