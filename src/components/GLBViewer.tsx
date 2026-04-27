/**
 * GLBViewer — single-viewport wrapper that loads a GLB URL and renders
 * it in either:
 *   - "材质" mode  → original GLTF scene (PBR materials + textures)
 *   - "几何" mode  → flat-color mesh via `MeshViewer` (supports streaming
 *                    vertex updates for future Fast_RNRR integration)
 *
 * The user toggles between modes via a button in the top-right of the
 * viewport. Both modes share the same camera fit / grid / lighting setup.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  MeshViewer,
  TexturedSceneViewer,
  loadGlb,
  type LoadedGlb,
} from '../three';

type RenderMode = 'material' | 'geometry';

export interface GLBViewerProps {
  /** Blob URL or remote URL for a .glb / .gltf file. null → empty state. */
  url: string | null;
  /** Optional title shown top-left. */
  label?: string;
  /** Background color of the canvas. */
  background?: string;
  /** Container height; defaults to filling parent. */
  height?: number | string;
  /** Initial render mode (default 'material'). */
  defaultMode?: RenderMode;
}

export function GLBViewer({
  url,
  label,
  background = '#2a2a2a',
  height = '100%',
  defaultMode = 'material',
}: GLBViewerProps) {
  const [loaded, setLoaded] = useState<LoadedGlb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RenderMode>(defaultMode);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!url) return;

    let cancelled = false;
    loadGlb(url)
      .then((data) => {
        if (cancelled) return;
        setLoaded(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[GLBViewer] failed to load', url, err);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url) {
    return (
      <EmptyState
        height={height}
        background={background}
        label={label}
        message="双击 Pipeline 中的 Rough Model 节点以在此显示"
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        height={height}
        background={background}
        label={label}
        message={`加载失败：${error}`}
        color="var(--accent-red, #d9534f)"
      />
    );
  }

  if (!loaded) {
    return (
      <EmptyState
        height={height}
        background={background}
        label={label}
        message="加载中…"
      />
    );
  }

  const modeToggle = <ModeToggle mode={mode} setMode={setMode} />;

  if (mode === 'material') {
    return (
      <TexturedSceneViewer
        scene={loaded.scene}
        bbox={loaded.bbox}
        height={height}
        background={background}
        label={label}
        topRightExtra={modeToggle}
      />
    );
  }

  return (
    <MeshViewer
      role="result"
      vertices={loaded.vertices}
      faces={loaded.faces}
      color="#bdbdbd"
      label={label}
      height={height}
      background={background}
      topRightExtra={modeToggle}
    />
  );
}

// ---------------------------------------------------------------------------

function ModeToggle({
  mode,
  setMode,
}: {
  mode: RenderMode;
  setMode: (m: RenderMode) => void;
}) {
  const next: RenderMode = mode === 'material' ? 'geometry' : 'material';
  const label = mode === 'material' ? '材质' : '几何';
  const tooltip =
    mode === 'material'
      ? '当前：材质（PBR 贴图）。点击切换到几何模式（实体/线框）'
      : '当前：几何（顶点/面）。点击切换回材质模式';
  return (
    <button
      title={tooltip}
      onClick={() => setMode(next)}
      style={{
        background: 'rgba(0,0,0,0.55)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 4,
        color: '#ddd',
        cursor: 'pointer',
        padding: '2px 7px',
        fontSize: 13,
        lineHeight: 1.4,
        userSelect: 'none',
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({
  height,
  background,
  label,
  message,
  color,
}: {
  height: number | string;
  background: string;
  label?: string;
  message: string;
  color?: string;
}) {
  return (
    <div
      style={{
        height,
        width: '100%',
        position: 'relative',
        background,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: color ?? '#666',
        fontSize: 13,
      }}
    >
      {label && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 12,
            color: '#ddd',
            fontSize: 12,
            fontWeight: 600,
            background: 'rgba(0,0,0,0.5)',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          {label}
        </div>
      )}
      {message}
    </div>
  );
}

// Local helper component to satisfy TS — exported so callers can import if needed
export type { ReactNode };
