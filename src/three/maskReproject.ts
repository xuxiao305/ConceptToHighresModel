/**
 * Reproject a 2D segmentation mask onto a 3D mesh, given the
 * deterministic orthographic camera that was used to render the mesh.
 *
 * Algorithm
 *   1. Build a per-pixel "front-most vertex index" buffer by projecting
 *      every mesh vertex to image space using the same camera that the
 *      ortho renderer used. For each pixel we keep the vertex with the
 *      largest world X (i.e. nearest to the +X camera). This is a cheap
 *      depth test that approximates the "visible vertex" assignment
 *      without rasterizing triangles.
 *   2. For each region in the segmentation mask, scan all mask pixels
 *      with that region's `mask_value`, look up the front-most vertex
 *      at that pixel, and collect a Set<vertexIndex>.
 *
 * Limitations
 *   - Vertex-only projection: if a triangle's surface covers a pixel
 *     but none of its vertices fall on that pixel, the pixel is
 *     unassigned. With reasonably tessellated character meshes this is
 *     a non-issue at character/region scale; for coarse meshes a
 *     splatting / triangle rasterization step would be needed.
 *   - Single-view: occluded back-side vertices are never reachable.
 *     This is a consequence of using one front view and is exactly the
 *     reason multi-view reprojection is the planned next step.
 */

import type { OrthoFrontCamera } from './orthoFrontRender';
import type { SegmentationRegion } from '../services/segmentationPack';
import type { Vec3 } from './types';

export interface MaskReprojectionResult {
  /** vertexIndex -> region label (only the first assignment wins). */
  assignments: Map<number, string>;
  /** label -> Set<vertexIndex>. */
  regions: Map<string, Set<number>>;
  /** Per-region pixel hit counts (for diagnostics). */
  perRegionPixelHits: Map<string, number>;
  /** Pixels in the mask that did not map to any mesh vertex (diagnostic). */
  unassignedPixels: number;
}

export interface MaskReprojectionOptions {
  /**
   * For each labeled pixel, splat the assignment to vertices in a small
   * pixel neighborhood. Helps coarse meshes where vertices don't cover
   * every pixel. Default 0 (off).
   */
  splatRadiusPx?: number;
}

/**
 * Project all mesh vertices to image pixel space using the standard
 * front-view orthographic camera.
 *
 *   imagePixelX = W/2 + (camZ - worldZ) / worldPerPx
 *   imagePixelY = H/2 - (worldY - camY) / worldPerPx
 *
 * Returns a Float32Array of size 2 * vertices.length: [u0, v0, u1, v1, ...]
 * (sub-pixel float coordinates). Vertices that fall outside the image
 * or behind the camera get u=v=NaN.
 */
export function projectVerticesToImage(
  vertices: Vec3[],
  camera: OrthoFrontCamera,
): Float32Array {
  const out = new Float32Array(vertices.length * 2);
  const cx = camera.width / 2;
  const cy = camera.height / 2;
  const inv = 1 / camera.worldPerPx;
  for (let i = 0; i < vertices.length; i++) {
    const [, wy, wz] = vertices[i];
    const u = cx + (camera.camZ - wz) * inv;
    const v = cy - (wy - camera.camY) * inv;
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}

/**
 * Build a per-pixel front-most vertex map. Each entry is either a
 * vertex index or -1 (no vertex hit). The selected vertex per pixel is
 * the one with the largest world X (nearest to a camera at +X).
 */
export function buildFrontVertexMap(
  vertices: Vec3[],
  camera: OrthoFrontCamera,
): Int32Array {
  const w = camera.width;
  const h = camera.height;
  const map = new Int32Array(w * h);
  const depth = new Float32Array(w * h);
  for (let i = 0; i < map.length; i++) {
    map[i] = -1;
    depth[i] = -Infinity;
  }
  const cx = w / 2;
  const cy = h / 2;
  const inv = 1 / camera.worldPerPx;
  for (let i = 0; i < vertices.length; i++) {
    const [wx, wy, wz] = vertices[i];
    const u = cx + (camera.camZ - wz) * inv;
    const v = cy - (wy - camera.camY) * inv;
    const px = Math.round(u);
    const py = Math.round(v);
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    const idx = py * w + px;
    if (wx > depth[idx]) {
      depth[idx] = wx;
      map[idx] = i;
    }
  }
  return map;
}

/**
 * Read a single-channel grayscale mask PNG (multi-region encoded by
 * mask_value) into a Uint8Array. Returns null on failure.
 */
export function loadMaskGray(url: string): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
} | null> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const gray = new Uint8Array(w * h);
        // Mask was authored as grayscale, so any of the RGB channels
        // contains the value. Use red.
        for (let i = 0, p = 0; p < gray.length; p++, i += 4) {
          gray[p] = rgba[i];
        }
        resolve({ data: gray, width: w, height: h });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error(`failed to load mask ${url}`));
    img.src = url;
  });
}

/**
 * Project a multi-region grayscale mask onto mesh vertices using the
 * given orthographic camera. For each labeled mask pixel, look up the
 * front-most vertex and assign that vertex to the region.
 *
 * Tolerance: a pixel is considered part of a region if its gray value
 * is within ±valueTolerance of the region's mask_value (handles JPEG
 * artifacts; for clean PNG masks the default 4 is conservative).
 */
export function reprojectMaskToVertices(
  vertices: Vec3[],
  mask: { data: Uint8Array; width: number; height: number },
  regions: SegmentationRegion[],
  camera: OrthoFrontCamera,
  options: MaskReprojectionOptions = {},
): MaskReprojectionResult {
  if (mask.width !== camera.width || mask.height !== camera.height) {
    throw new Error(
      `mask ${mask.width}x${mask.height} does not match camera ${camera.width}x${camera.height}`,
    );
  }
  const splat = Math.max(0, options.splatRadiusPx ?? 0);

  const frontMap = buildFrontVertexMap(vertices, camera);
  const w = mask.width;
  const h = mask.height;

  const assignments = new Map<number, string>();
  const regionSets = new Map<string, Set<number>>();
  const pixelHits = new Map<string, number>();
  for (const r of regions) {
    regionSets.set(r.label, new Set<number>());
    pixelHits.set(r.label, 0);
  }

  // Build a quick lookup: mask_value → label. If two regions share a
  // value (shouldn't happen in valid SAM3 output) the first wins.
  const valueToLabel = new Map<number, string>();
  for (const r of regions) {
    if (!valueToLabel.has(r.mask_value)) valueToLabel.set(r.mask_value, r.label);
  }
  const valueTolerance = 4;

  let unassigned = 0;

  const tryAssign = (vertexIdx: number, label: string) => {
    if (vertexIdx < 0) return;
    if (!assignments.has(vertexIdx)) {
      assignments.set(vertexIdx, label);
      regionSets.get(label)!.add(vertexIdx);
    }
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask.data[y * w + x];
      if (v === 0) continue;
      // Pick the closest known mask_value within tolerance.
      let bestLabel: string | undefined;
      let bestDelta = valueTolerance + 1;
      for (const [val, lab] of valueToLabel) {
        const d = Math.abs(v - val);
        if (d < bestDelta) {
          bestDelta = d;
          bestLabel = lab;
        }
      }
      if (!bestLabel) continue;
      pixelHits.set(bestLabel, pixelHits.get(bestLabel)! + 1);

      // Direct hit at the labeled pixel.
      const idx = y * w + x;
      const vertex = frontMap[idx];
      if (vertex >= 0) {
        tryAssign(vertex, bestLabel);
        continue;
      }
      // No vertex covers this pixel exactly — splat to a small window.
      if (splat > 0) {
        let foundLocal = false;
        for (let dy = -splat; dy <= splat && !foundLocal; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -splat; dx <= splat; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const v2 = frontMap[yy * w + xx];
            if (v2 >= 0) {
              tryAssign(v2, bestLabel);
              foundLocal = true;
              break;
            }
          }
        }
        if (!foundLocal) unassigned++;
      } else {
        unassigned++;
      }
    }
  }

  return {
    assignments,
    regions: regionSets,
    perRegionPixelHits: pixelHits,
    unassignedPixels: unassigned,
  };
}
