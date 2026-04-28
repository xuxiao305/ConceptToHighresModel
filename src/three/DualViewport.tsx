/**
 * DualViewport — side-by-side source / target MeshViewer pair with
 * camera-sync toggle.
 *
 * Adapted from D:/AI/Prototypes/WrapDeformation/frontend/src/components/DualViewport.tsx
 * (antd controls replaced by plain DOM buttons.)
 */

import type { Vec3, Face3, ViewMode } from './types';
import type { LandmarkPoint } from './landmarkStore';
import { MeshViewer } from './MeshViewer';
import { useCameraSyncStore } from './cameraSyncStore';

interface DualViewportProps {
  srcVertices: Vec3[];
  srcFaces: Face3[];
  tarVertices: Vec3[];
  tarFaces: Face3[];
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  srcLandmarks?: LandmarkPoint[];
  tarLandmarks?: LandmarkPoint[];
  onSrcClick?: (
    idx: number,
    pos: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => void;
  onTarClick?: (
    idx: number,
    pos: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => void;
  pickingEnabled?: boolean;
  srcPickingEnabled?: boolean;
  tarPickingEnabled?: boolean;
  selectedSrcLandmarkIndex?: number | null;
  selectedTarLandmarkIndex?: number | null;
  onSelectSrcLandmark?: (index: number) => void;
  onSelectTarLandmark?: (index: number) => void;
  onDeleteSrcLandmark?: (index: number) => void;
  onDeleteTarLandmark?: (index: number) => void;
  onMoveSrcLandmark?: (index: number, position: Vec3) => void;
  onMoveTarLandmark?: (index: number, position: Vec3) => void;
  height?: number | string;
  /** Show camera-sync toggle at the top */
  showCameraSync?: boolean;
  landmarkScreenFraction?: number;
  /** Streaming vertex updates for the source (Fast_RNRR per-step) */
  srcUpdatedVertices?: Vec3[];
  /** Labels override */
  srcLabel?: string;
  tarLabel?: string;
}

export function DualViewport({
  srcVertices,
  srcFaces,
  tarVertices,
  tarFaces,
  viewMode,
  onViewModeChange,
  srcLandmarks = [],
  tarLandmarks = [],
  onSrcClick,
  onTarClick,
  pickingEnabled = false,
  srcPickingEnabled,
  tarPickingEnabled,
  selectedSrcLandmarkIndex = null,
  selectedTarLandmarkIndex = null,
  onSelectSrcLandmark,
  onSelectTarLandmark,
  onDeleteSrcLandmark,
  onDeleteTarLandmark,
  onMoveSrcLandmark,
  onMoveTarLandmark,
  height = '100%',
  showCameraSync = true,
  landmarkScreenFraction,
  srcUpdatedVertices,
  srcLabel = 'Source',
  tarLabel = 'Target',
}: DualViewportProps) {
  const cameraSyncEnabled = useCameraSyncStore((s) => s.syncEnabled);
  const setCameraSyncEnabled = useCameraSyncStore((s) => s.setSyncEnabled);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height, width: '100%' }}>
      <div
        style={{
          flexShrink: 0,
          padding: '6px 8px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 16,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <ModeSegment value={viewMode} onChange={onViewModeChange} />
        {showCameraSync && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={cameraSyncEnabled}
              onChange={(e) => setCameraSyncEnabled(e.target.checked)}
            />
            Camera Sync
          </label>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid var(--border-default)' }}>
          <MeshViewer
            role="source"
            vertices={srcVertices}
            faces={srcFaces}
            color="#4a90d9"
            viewMode={viewMode}
            updatedVertices={srcUpdatedVertices}
            landmarks={srcLandmarks}
            landmarkColor="#ff4d4f"
            selectedLandmarkIndex={selectedSrcLandmarkIndex}
            onLandmarkSelect={onSelectSrcLandmark}
            onLandmarkDelete={onDeleteSrcLandmark}
            onLandmarkMove={onMoveSrcLandmark}
            onMeshClick={onSrcClick}
            pickingEnabled={srcPickingEnabled ?? pickingEnabled}
            height="100%"
            label={srcLabel}
            cameraSyncId={cameraSyncEnabled ? 'source' : undefined}
            landmarkScreenFraction={landmarkScreenFraction}
            showViewModeToggle={false}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MeshViewer
            role="target"
            vertices={tarVertices}
            faces={tarFaces}
            color="#d9734a"
            viewMode={viewMode}
            landmarks={tarLandmarks}
            landmarkColor="#1890ff"
            selectedLandmarkIndex={selectedTarLandmarkIndex}
            onLandmarkSelect={onSelectTarLandmark}
            onLandmarkDelete={onDeleteTarLandmark}
            onLandmarkMove={onMoveTarLandmark}
            onMeshClick={onTarClick}
            pickingEnabled={tarPickingEnabled ?? pickingEnabled}
            height="100%"
            label={tarLabel}
            cameraSyncId={cameraSyncEnabled ? 'target' : undefined}
            landmarkScreenFraction={landmarkScreenFraction}
            showViewModeToggle={false}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local segmented control (replaces antd <Segmented>)
// ---------------------------------------------------------------------------

function ModeSegment({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  const options: { label: string; value: ViewMode }[] = [
    { label: 'Solid', value: 'solid' },
    { label: 'Wireframe', value: 'wireframe' },
    { label: 'Solid + Wire', value: 'solid+wireframe' },
  ];
  return (
    <div
      style={{
        display: 'inline-flex',
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid var(--border-default)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              background: active ? 'var(--accent-blue, #1890ff)' : 'transparent',
              border: 'none',
              padding: '3px 10px',
              fontSize: 12,
              color: active ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
