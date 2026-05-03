import type { SAM3ExportJson } from './extraction';

export interface GarmentParseOptions {
  source: File | Blob | string;
  classes?: string[];
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface GarmentParseResult {
  json: SAM3ExportJson;
  labelMaskBase64: string;
  colorMaskBase64?: string;
  classesPresent: Array<{ id: number; label: string; pixels: number }>;
}

export class GarmentParseNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GarmentParseNotWiredError';
  }
}

/**
 * Runs SegFormer clothes parsing through the Vite dev bridge.
 *
 * Output is intentionally SAM3-compatible (`json` + grayscale mask) so Page3
 * can reuse the existing mask-region/reprojection path later. The grayscale
 * mask stores the original SegFormer class id per pixel.
 */
export async function parseGarmentsSegFormer(
  opts: GarmentParseOptions,
): Promise<GarmentParseResult> {
  opts.onStatus?.('SegFormer 服装语义分割中…');
  const sourceB64 = await blobToDataUrl(await toBlob(opts.source));

  const res = await fetch('/api/segformer-garment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: sourceB64,
      classes: opts.classes,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new GarmentParseNotWiredError(`SegFormer 桥接 HTTP ${res.status}：${await res.text()}`);
  }

  const payload = (await res.json()) as
    | {
      ok: true;
      json: SAM3ExportJson;
      labelMaskBase64: string;
      colorMaskBase64?: string;
      classesPresent: Array<{ id: number; label: string; pixels: number }>;
    }
    | { ok: false; error: string };

  if (!payload.ok) {
    throw new GarmentParseNotWiredError(payload.error);
  }

  opts.onStatus?.(`SegFormer 完成：${payload.json.objects.length} 个服装区域`);
  return payload;
}

async function toBlob(src: File | Blob | string): Promise<Blob> {
  if (typeof src === 'string') {
    const r = await fetch(src);
    return await r.blob();
  }
  return src;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      buf.subarray(i, Math.min(i + CHUNK, buf.length)) as unknown as number[],
    );
  }
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${btoa(bin)}`;
}
