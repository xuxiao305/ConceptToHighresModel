/**
 * Auto-extract the subject bounding box from a reference image.
 *
 * Used by the 2D-localization pipeline so the orthographic Target render
 * can be auto-fitted to a concept image without any manual scale/offset
 * tweaking. The algorithm is intentionally simple and dependency-free:
 *
 *   1. If the image has a real alpha channel (transparent background),
 *      take the bbox of pixels with significant alpha. Most precise.
 *   2. Otherwise estimate the background color from a thin border ring,
 *      threshold every pixel, then keep only the LARGEST connected
 *      component. The connected-component step is critical because
 *      backgrounds like "Blender viewport gray with grid lines" produce
 *      lots of false-positive foreground pixels — without filtering, a
 *      few stray pixels in opposite corners would inflate the bbox.
 */

export interface SubjectBBox {
  /** Pixel-space bbox (top-left origin). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** How many foreground pixels were detected (sanity metric). */
  area: number;
  /** Path used: 'alpha' (transparent bg) or 'color' (border-color thresholding). */
  method: 'alpha' | 'color';
}

export interface ExtractOptions {
  /** Tolerance for color-based detection, 0..255 (Manhattan distance / 3). */
  colorTolerance?: number;
  /** Alpha threshold for the alpha-channel path, 0..255. */
  alphaThreshold?: number;
  /** Width of the border ring sampled for background color, in pixels. */
  borderRing?: number;
  /**
   * Minimum component area (as a fraction of total pixels) to be
   * considered the subject. Components smaller than this are ignored
   * even if they are the largest. Default 0.5%.
   */
  minComponentFraction?: number;
}

/**
 * Extract subject bbox from an image URL. Returns null if no subject
 * could be detected (e.g. completely blank image).
 */
export function extractImageSubjectBBox(
  url: string,
  options: ExtractOptions = {},
): Promise<SubjectBBox | null> {
  const colorTolerance = options.colorTolerance ?? 40;
  const alphaThreshold = options.alphaThreshold ?? 32;
  const borderRing = Math.max(1, options.borderRing ?? 3);
  const minComponentFraction = options.minComponentFraction ?? 0.005;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas 2d context unavailable'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h);
        const px = data.data;

        // Probe the alpha channel — if any pixel is meaningfully
        // transparent we use the alpha path.
        let hasAlpha = false;
        for (let i = 3; i < px.length; i += 4) {
          if (px[i] < 250) { hasAlpha = true; break; }
        }

        // Build a binary foreground mask either from alpha or from
        // border-color thresholding.
        const mask = new Uint8Array(w * h);
        let method: 'alpha' | 'color' = 'color';

        if (hasAlpha) {
          method = 'alpha';
          for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
            mask[p] = px[i + 3] >= alphaThreshold ? 1 : 0;
          }
        } else {
          // Sample a border ring, take the median R/G/B as background.
          const samplesR: number[] = [];
          const samplesG: number[] = [];
          const samplesB: number[] = [];
          const pushPixel = (x: number, y: number) => {
            const i = (y * w + x) * 4;
            samplesR.push(px[i]);
            samplesG.push(px[i + 1]);
            samplesB.push(px[i + 2]);
          };
          for (let r = 0; r < borderRing; r++) {
            if (r >= h || r >= w) break;
            for (let x = 0; x < w; x++) {
              pushPixel(x, r);
              pushPixel(x, h - 1 - r);
            }
            for (let y = r; y < h - r; y++) {
              pushPixel(r, y);
              pushPixel(w - 1 - r, y);
            }
          }
          const median = (arr: number[]) => {
            arr.sort((a, b) => a - b);
            return arr[arr.length >> 1] ?? 0;
          };
          const bgR = median(samplesR);
          const bgG = median(samplesG);
          const bgB = median(samplesB);

          for (let y = 0, p = 0; y < h; y++) {
            for (let x = 0; x < w; x++, p++) {
              const i = p * 4;
              const dr = px[i] - bgR;
              const dg = px[i + 1] - bgG;
              const db = px[i + 2] - bgB;
              const d = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3;
              mask[p] = d > colorTolerance ? 1 : 0;
            }
          }
        }

        // Find the largest connected component (4-connectivity) and
        // return its bbox. Iterative BFS with a typed-array queue keeps
        // memory predictable on large images.
        const labels = new Int32Array(w * h);
        const queueX = new Int32Array(w * h);
        const queueY = new Int32Array(w * h);
        let bestArea = 0;
        let bestMinX = 0, bestMinY = 0, bestMaxX = -1, bestMaxY = -1;

        for (let y0 = 0; y0 < h; y0++) {
          for (let x0 = 0; x0 < w; x0++) {
            const start = y0 * w + x0;
            if (mask[start] === 0 || labels[start] !== 0) continue;
            // BFS this component.
            let qHead = 0, qTail = 0;
            queueX[qTail] = x0;
            queueY[qTail] = y0;
            qTail++;
            labels[start] = 1;
            let area = 0;
            let minX = w, minY = h, maxX = -1, maxY = -1;
            while (qHead < qTail) {
              const cx = queueX[qHead];
              const cy = queueY[qHead];
              qHead++;
              area++;
              if (cx < minX) minX = cx;
              if (cy < minY) minY = cy;
              if (cx > maxX) maxX = cx;
              if (cy > maxY) maxY = cy;
              // 4-neighbors
              if (cx > 0) {
                const ni = cy * w + (cx - 1);
                if (mask[ni] === 1 && labels[ni] === 0) {
                  labels[ni] = 1;
                  queueX[qTail] = cx - 1;
                  queueY[qTail] = cy;
                  qTail++;
                }
              }
              if (cx < w - 1) {
                const ni = cy * w + (cx + 1);
                if (mask[ni] === 1 && labels[ni] === 0) {
                  labels[ni] = 1;
                  queueX[qTail] = cx + 1;
                  queueY[qTail] = cy;
                  qTail++;
                }
              }
              if (cy > 0) {
                const ni = (cy - 1) * w + cx;
                if (mask[ni] === 1 && labels[ni] === 0) {
                  labels[ni] = 1;
                  queueX[qTail] = cx;
                  queueY[qTail] = cy - 1;
                  qTail++;
                }
              }
              if (cy < h - 1) {
                const ni = (cy + 1) * w + cx;
                if (mask[ni] === 1 && labels[ni] === 0) {
                  labels[ni] = 1;
                  queueX[qTail] = cx;
                  queueY[qTail] = cy + 1;
                  qTail++;
                }
              }
            }
            if (area > bestArea) {
              bestArea = area;
              bestMinX = minX;
              bestMinY = minY;
              bestMaxX = maxX;
              bestMaxY = maxY;
            }
          }
        }

        if (bestArea === 0) {
          resolve(null);
          return;
        }
        const totalPx = w * h;
        if (bestArea / totalPx < minComponentFraction) {
          resolve(null);
          return;
        }
        resolve({
          x: bestMinX,
          y: bestMinY,
          w: bestMaxX - bestMinX + 1,
          h: bestMaxY - bestMinY + 1,
          area: bestArea,
          method,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

