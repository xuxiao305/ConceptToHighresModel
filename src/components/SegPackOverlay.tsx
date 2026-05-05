/**
 * SegPackOverlay
 *
 * Page1 SegPack 节点的可视化预览组件。把 SAM3 多区域分割包以三层叠加展示：
 *   1. 源图（T-Pose 或 Remove Jacket）—— 底层
 *   2. mask PNG —— 中层，用 mix-blend-mode:multiply 叠到源图上
 *   3. 每个区域的 bbox + label —— SVG 顶层，按区域索引循环 HSL 色相区分
 *
 * 设计：与 MultiViewOverlay 同构 —— 只渲染图像区，不带按钮；区域信息通过
 * `pack` 受控传入，由调用方负责按需 loadPage1SegPack 解析。SVG 用源图自然
 * 尺寸做 viewBox，preserveAspectRatio:xMidYMid meet 与 <img> objectFit:contain
 * 自动对齐，避免手算容器换算。
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SegmentationPack } from '../services/segmentationPack';

export interface SegPackOverlayProps {
  /** 源图 URL（T-Pose 或 Remove Jacket 整图）。bbox 与该图同坐标系。 */
  sourceUrl: string;
  /** mask PNG URL（grayscale，每个区域对应 mask_value）。可缺省（仅显示 bbox）。 */
  maskUrl?: string | null;
  /** 解析好的 SegmentationPack。null 表示尚未加载。 */
  pack: SegmentationPack | null;
  /** 容器高度，节点 body 默认 160 */
  height?: number | string;
  /** 是否显示 mask 着色叠加层（默认 true） */
  showMask?: boolean;
  /** 是否显示 bbox + label（默认 true） */
  showBoxes?: boolean;
  /** mask 着色不透明度（0..1，默认 0.5） */
  maskOpacity?: number;
}

const containerStyle: CSSProperties = {
  width: '100%',
  position: 'relative',
  background:
    'repeating-linear-gradient(45deg, #242424 0 10px, #1f1f1f 10px 20px)',
  borderRadius: 6,
  overflow: 'hidden',
};

/** 区域色 —— 避开橙/红色相（与 Tripo/Trellis2 默认 mesh 色 #d9734a 冲突）。
 *  顺序：magenta / cyan / lime / blue / purple / amber…循环。与 Page3 viewport 色序完全一致。 */
const REGION_PALETTE_HSL: Array<[number, number, number]> = [
  [320, 80, 60], // magenta
  [180, 75, 50], // cyan
  [130, 70, 50], // lime-green
  [220, 80, 60], // blue
  [270, 65, 60], // purple
  [55, 90, 55],  // amber-yellow
  [200, 70, 55], // sky
  [340, 75, 55], // pink
];

/** 按区域索引返回 [r,g,b] (0..255)。 */
function regionRgb(idx: number): [number, number, number] {
  const [hDeg, sPct, lPct] = REGION_PALETTE_HSL[idx % REGION_PALETTE_HSL.length];
  const hue = hDeg / 360;
  const s = sPct / 100;
  const l = lPct / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  const h6 = hue * 6;
  if (h6 < 1)      [r, g, b] = [c, x, 0];
  else if (h6 < 2) [r, g, b] = [x, c, 0];
  else if (h6 < 3) [r, g, b] = [0, c, x];
  else if (h6 < 4) [r, g, b] = [0, x, c];
  else if (h6 < 5) [r, g, b] = [x, 0, c];
  else             [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function regionColorCss(idx: number): string {
  const [r, g, b] = regionRgb(idx);
  return `rgb(${r},${g},${b})`;
}

/** Page3 需要同样的 HSL 三元组（不走 RGB 折返）以便 three.js 上色。 */
export function regionHslCss(idx: number): string {
  const [h, s, l] = REGION_PALETTE_HSL[idx % REGION_PALETTE_HSL.length];
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/** 同上，但亮度提高 20%（上限 90%），用于 Page3 视口选中 Region 高亮。 */
export function regionHslCssBright(idx: number): string {
  const [h, s, l] = REGION_PALETTE_HSL[idx % REGION_PALETTE_HSL.length];
  const lBright = Math.min(l + 20, 90);
  return `hsl(${h}, ${s}%, ${lBright}%)`;
}

/** 同上，但亮度降低 15%，用于 Page3 视口未选中 Region 暗化。 */
export function regionHslCssDim(idx: number): string {
  const [h, s, l] = REGION_PALETTE_HSL[idx % REGION_PALETTE_HSL.length];
  const lDim = Math.max(l - 15, 8);
  return `hsl(${h}, ${s}%, ${lDim}%)`;
}

/**
 * 把 grayscale mask PNG 按 SegPack 的 mask_value → 颜色映射
 * 着色为 RGBA PNG，每个 region 一种颜色，背景透明。
 * 返回 data URL；调用方可直接喂给 <img>。
 */
async function colorizeMask(
  maskUrl: string,
  pack: SegmentationPack,
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = maskUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, 0, 0);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;

  // mask_value (0..255) → [r, g, b]，未列出的灰度值（含 0=背景）保持透明
  const lut = new Map<number, [number, number, number]>();
  pack.regions.forEach((r, i) => {
    lut.set(r.mask_value, regionRgb(i));
  });

  for (let i = 0; i < px.length; i += 4) {
    const v = px[i]; // 灰度图 R=G=B
    const rgb = lut.get(v);
    if (rgb) {
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = 255; // 不透明，由 <img opacity> 调整整体透明度
    } else {
      px[i + 3] = 0; // 背景透明
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

export function SegPackOverlay({
  sourceUrl,
  maskUrl,
  pack,
  height = 160,
  showMask = true,
  showBoxes = true,
  maskOpacity = 0.5,
}: SegPackOverlayProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  // 把 grayscale mask 着色后的 RGBA data URL；为 null 时回退显示原始 mask
  const [colorizedMaskUrl, setColorizedMaskUrl] = useState<string | null>(null);

  // 源图加载完成后记录自然尺寸（SVG viewBox 用）
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const update = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    if (img.complete) update();
    img.addEventListener('load', update);
    return () => img.removeEventListener('load', update);
  }, [sourceUrl]);

  // mask + pack 都就绪时，离屏 canvas 把 grayscale mask 着色为 RGBA
  useEffect(() => {
    let cancelled = false;
    setColorizedMaskUrl(null);
    if (!showMask || !maskUrl || !pack) return;
    colorizeMask(maskUrl, pack)
      .then((url) => { if (!cancelled) setColorizedMaskUrl(url); })
      .catch((e) => console.warn('[SegPackOverlay] colorizeMask failed:', e));
    return () => { cancelled = true; };
  }, [maskUrl, pack, showMask]);

  return (
    <div style={{ ...containerStyle, height }}>
      {/* 底层：源图 */}
      <img
        ref={imgRef}
        src={sourceUrl}
        alt="SegPack source"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
        }}
      />
      {/* 中层：着色后的 mask（每个 region 一种 HSL 色，背景透明），
          直接以 alpha 叠加到源图上，让用户一眼看清切割范围与颜色对应。 */}
      {showMask && colorizedMaskUrl && (
        <img
          src={colorizedMaskUrl}
          alt="SegPack mask (colorized)"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            opacity: maskOpacity,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* 顶层：bbox + label */}
      {showBoxes && pack && naturalSize && (
        <svg
          viewBox={`0 0 ${naturalSize.w} ${naturalSize.h}`}
          preserveAspectRatio="xMidYMid meet"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        >
          {pack.regions.map((r, i) => {
            const color = regionColorCss(i);
            const fontSize = Math.max(10, Math.min(naturalSize.w, naturalSize.h) * 0.025);
            return (
              <g key={`${r.label}-${i}`}>
                <rect
                  x={r.bbox.x}
                  y={r.bbox.y}
                  width={r.bbox.w}
                  height={r.bbox.h}
                  fill="none"
                  stroke={color}
                  strokeWidth={Math.max(1, naturalSize.w * 0.003)}
                />
                {/* label 背景 + 文字 */}
                <rect
                  x={r.bbox.x}
                  y={Math.max(0, r.bbox.y - fontSize - 2)}
                  width={Math.max(r.label.length * fontSize * 0.55 + 6, 30)}
                  height={fontSize + 2}
                  fill={color}
                  opacity={0.85}
                />
                <text
                  x={r.bbox.x + 3}
                  y={Math.max(fontSize, r.bbox.y - 3)}
                  fontSize={fontSize}
                  fill="#000"
                  fontFamily="system-ui, sans-serif"
                  fontWeight={600}
                >
                  {r.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {/* 右上角：区域数 badge */}
      {pack && (
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'rgba(0,0,0,0.65)',
            color: '#fff',
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 4,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {pack.regions.length} regions
        </div>
      )}
    </div>
  );
}
