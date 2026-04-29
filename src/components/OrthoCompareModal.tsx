import { useEffect, useMemo, useState } from 'react';

interface Layer {
  url: string;
  label: string;
  /** Initial opacity 0..1. */
  defaultOpacity?: number;
  /** Optional CSS blend mode applied to this layer. */
  blendMode?: React.CSSProperties['mixBlendMode'];
  /** Optional tint to color-key this layer (e.g. mask = red). */
  tintColor?: string;
}

interface OrthoCompareModalProps {
  layers: Layer[];
  width: number;
  height: number;
  title?: string;
  /** Optional pixel-space bbox to overlay (yellow rectangle) for debug. */
  highlightBBox?: { x: number; y: number; w: number; h: number } | null;
  onClose: () => void;
}

/**
 * Convert a grayscale/binary mask image into an RGBA data URL where
 * pixel brightness becomes alpha and color becomes the requested tint.
 * We cannot rely on CSS `mask-image` because the SAM3 mask is a pure
 * RGB PNG — browser support for `mask-mode: luminance` is inconsistent
 * and tends to fall back to alpha (which is fully opaque), painting
 * the whole tint color across the layer.
 */
function tintMaskUrl(url: string, tint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
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
      let tr = 255, tg = 0, tb = 0;
      const m = /^#?([0-9a-fA-F]{6})$/.exec(tint);
      if (m) {
        const v = parseInt(m[1], 16);
        tr = (v >> 16) & 0xff;
        tg = (v >> 8) & 0xff;
        tb = v & 0xff;
      }
      for (let i = 0; i < px.length; i += 4) {
        const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
        px[i] = tr;
        px[i + 1] = tg;
        px[i + 2] = tb;
        px[i + 3] = lum;
      }
      ctx.putImageData(data, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Three-layer overlay used to verify SAM3 mask alignment with an
 * orthographic mesh render. Layers are stacked at exact pixel size
 * with independent opacity sliders.
 */
export function OrthoCompareModal({
  layers,
  width,
  height,
  title,
  highlightBBox,
  onClose,
}: OrthoCompareModalProps) {
  const [opacities, setOpacities] = useState<number[]>(() =>
    layers.map((l) => l.defaultOpacity ?? 1),
  );

  const layerKey = useMemo(
    () => layers.map((l) => `${l.url}|${l.tintColor ?? ''}`).join('§'),
    [layers],
  );
  const [renderUrls, setRenderUrls] = useState<(string | null)[]>(() =>
    layers.map((l) => (l.tintColor ? null : l.url)),
  );

  useEffect(() => {
    let alive = true;
    setOpacities(layers.map((l) => l.defaultOpacity ?? 1));
    setRenderUrls(layers.map((l) => (l.tintColor ? null : l.url)));
    layers.forEach((l, i) => {
      if (!l.tintColor) return;
      tintMaskUrl(l.url, l.tintColor)
        .then((dataUrl) => {
          if (!alive) return;
          setRenderUrls((prev) => {
            const next = [...prev];
            next[i] = dataUrl;
            return next;
          });
        })
        .catch(() => {
          /* leave null — that layer just won't render */
        });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scale to fit viewport while preserving aspect ratio.
  const maxW = Math.min(window.innerWidth - 320, 1200);
  const maxH = window.innerHeight - 220;
  const scale = Math.min(maxW / width, maxH / height, 1);
  const dispW = Math.round(width * scale);
  const dispH = Math.round(height * scale);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        cursor: 'zoom-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'flex-start',
          cursor: 'default',
        }}
      >
        {/* Stacked layers */}
        <div
          style={{
            position: 'relative',
            width: dispW,
            height: dispH,
            background: '#0a0a0a',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-elevated)',
          }}
        >
          {title && (
            <div
              style={{
                position: 'absolute',
                top: -28,
                left: 0,
                color: 'var(--text-primary)',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {title} — {width}×{height}
            </div>
          )}
          {layers.map((l, i) => {
            const url = renderUrls[i];
            if (!url) return null;
            return (
              <img
                key={i}
                src={url}
                alt={l.label}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  opacity: opacities[i],
                  mixBlendMode: l.blendMode,
                  pointerEvents: 'none',
                }}
              />
            );
          })}
          {highlightBBox && (
            <div
              style={{
                position: 'absolute',
                left: `${(highlightBBox.x / width) * 100}%`,
                top: `${(highlightBBox.y / height) * 100}%`,
                width: `${(highlightBBox.w / width) * 100}%`,
                height: `${(highlightBBox.h / height) * 100}%`,
                border: '1px dashed #ffd84a',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.45) inset',
                pointerEvents: 'none',
              }}
              title={`检测到主体 bbox: ${highlightBBox.w}×${highlightBBox.h} @ (${highlightBBox.x}, ${highlightBBox.y})`}
            />
          )}
        </div>

        {/* Controls */}
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 4,
            padding: 12,
            minWidth: 220,
            color: 'var(--text-primary)',
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>图层不透明度</div>
          {layers.map((l, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 2,
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>{l.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {Math.round(opacities[i] * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacities[i]}
                onChange={(e) =>
                  setOpacities((prev) => {
                    const next = [...prev];
                    next[i] = Number(e.target.value);
                    return next;
                  })
                }
                style={{ width: '100%' }}
              />
            </div>
          ))}
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            按 Esc 或点击空白处关闭
          </div>
        </div>
      </div>
    </div>
  );
}
