/**
 * Loader for SAM3 multi-region segmentation packs.
 *
 * Schema (current, see Data/SAM3_SegInfo/segmentation.json):
 *
 *   {
 *     "image": "Bot.png",
 *     "mask_png": "segmentation_mask.png",
 *     "objects": [
 *       {
 *         "label": "RightArm",
 *         "mask_value": 85,
 *         "bbox": {
 *           "xyxy": [x1, y1, x2, y2],   // inclusive both ends
 *           "xywh": [x, y, w, h]
 *         }
 *       },
 *       ...
 *     ]
 *   }
 *
 * Notes
 * - `xyxy` uses INCLUSIVE bounds, so width = x2 - x1 + 1.
 * - Labels are observer-side ("Left/Right" = picture left/right). What
 *   SAM3 calls `LeftArm` is the character's RIGHT arm, and vice versa.
 *   We do not auto-rename here; downstream code that needs the
 *   anatomical side should remap explicitly.
 * - `mask_value` is the gray level (0..255) used in the multi-region
 *   single-channel PNG; pixels equal to that value belong to the
 *   region.
 */

export interface SegmentationRegion {
  label: string;
  /** Gray level in mask_png that identifies this region. */
  mask_value: number;
  /** Pixel-space bbox, top-left origin, INCLUSIVE bounds. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface SegmentationPack {
  /** Reference image filename (relative to the JSON, used for diagnostics). */
  imageName: string;
  /** Multi-region mask PNG filename (relative to the JSON). */
  maskName: string;
  regions: SegmentationRegion[];
}

interface RawObject {
  label?: string;
  mask_value?: number;
  bbox?: {
    xyxy?: [number, number, number, number];
    xywh?: [number, number, number, number];
  };
}

interface RawPack {
  image?: string;
  mask_png?: string;
  objects?: RawObject[];
}

/**
 * Parse a segmentation.json blob/file/text. Throws on malformed input.
 */
export function parseSegmentationJson(text: string): SegmentationPack {
  let raw: RawPack;
  try {
    raw = JSON.parse(text) as RawPack;
  } catch (err) {
    throw new Error(`segmentation.json is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('segmentation.json must be an object');
  }
  if (typeof raw.image !== 'string' || raw.image.length === 0) {
    throw new Error('segmentation.json: missing "image"');
  }
  if (typeof raw.mask_png !== 'string' || raw.mask_png.length === 0) {
    throw new Error('segmentation.json: missing "mask_png"');
  }
  if (!Array.isArray(raw.objects) || raw.objects.length === 0) {
    throw new Error('segmentation.json: "objects" must be a non-empty array');
  }

  const regions: SegmentationRegion[] = [];
  raw.objects.forEach((obj, i) => {
    if (!obj || typeof obj !== 'object') {
      throw new Error(`segmentation.json: objects[${i}] is not an object`);
    }
    const label = typeof obj.label === 'string' ? obj.label : `Region_${i + 1}`;
    if (typeof obj.mask_value !== 'number') {
      throw new Error(`segmentation.json: objects[${i}].mask_value missing`);
    }
    const bbox = obj.bbox;
    if (!bbox || typeof bbox !== 'object') {
      throw new Error(`segmentation.json: objects[${i}].bbox missing`);
    }
    let x: number, y: number, w: number, h: number;
    if (bbox.xywh && Array.isArray(bbox.xywh) && bbox.xywh.length === 4) {
      [x, y, w, h] = bbox.xywh;
    } else if (bbox.xyxy && Array.isArray(bbox.xyxy) && bbox.xyxy.length === 4) {
      const [x1, y1, x2, y2] = bbox.xyxy;
      x = x1;
      y = y1;
      w = x2 - x1 + 1;
      h = y2 - y1 + 1;
    } else {
      throw new Error(`segmentation.json: objects[${i}].bbox needs xywh or xyxy`);
    }
    regions.push({
      label,
      mask_value: obj.mask_value,
      bbox: { x, y, w, h },
    });
  });

  return {
    imageName: raw.image,
    maskName: raw.mask_png,
    regions,
  };
}

/**
 * Compute the union of all region bboxes, in pixel space. Useful as the
 * "subject bbox" for fitting the orthographic render to the reference
 * image when multiple regions cover different parts of the character.
 */
export function regionsUnionBBox(
  regions: SegmentationRegion[],
): { x: number; y: number; w: number; h: number } | null {
  if (regions.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    const b = r.bbox;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
