/**
 * LoadedModelList — sidebar list of models currently loaded into the
 * Source Viewport.  Each row shows the model label, file name, and a
 * selected-state highlight.  Click to select / deselect.
 *
 * Phase 1c — multi-model Source Viewport for Page 3.
 */

import type { LoadedModel } from '../../three/types';

interface LoadedModelListProps {
  models: LoadedModel[];
  selectedModelId: string | null;
  onSelect: (modelId: string) => void;
  onRemove?: (modelId: string) => void;
}

export function LoadedModelList({
  models,
  selectedModelId,
  onSelect,
  onRemove,
}: LoadedModelListProps) {
  if (models.length === 0) {
    return (
      <div
        style={{
          width: 200,
          minWidth: 200,
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          padding: 12,
          gap: 4,
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text-default)' }}>
          📦 Loaded Models
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
          Click <b>+</b> in the gallery below to add models to this viewport.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: 200,
        minWidth: 200,
        borderRight: '1px solid var(--border-default)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-default)',
          borderBottom: '1px solid var(--border-default)',
          flexShrink: 0,
        }}
      >
        📦 Loaded Models
        <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>
          ({models.length})
        </span>
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {models.map((model) => {
          const isSelected = model.id === selectedModelId;
          return (
            <div
              key={model.id}
              onClick={() => onSelect(model.id)}
              title={model.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: 12,
                color: isSelected ? 'var(--text-default)' : 'var(--text-muted)',
                background: isSelected
                  ? 'var(--bg-selected, rgba(74,144,217,0.15))'
                  : 'transparent',
                borderLeft: isSelected
                  ? '3px solid var(--accent-default, #4a90d9)'
                  : '3px solid transparent',
                transition: 'background 0.15s, border-color 0.15s',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                if (!isSelected)
                  (e.currentTarget as HTMLElement).style.background =
                    'var(--bg-hover, rgba(255,255,255,0.05))';
              }}
              onMouseLeave={(e) => {
                if (!isSelected)
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              {/* Color swatch */}
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: model.color,
                  flexShrink: 0,
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
              />

              {/* Label + filename */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontWeight: isSelected ? 600 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {model.label}
                </div>
              </div>

              {/* Remove button */}
              {onRemove && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(model.id);
                  }}
                  title="Remove from viewport"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: '0 2px',
                    lineHeight: 1,
                    opacity: 0.5,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = '1';
                    (e.currentTarget as HTMLElement).style.color = '#ff4d4f';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.opacity = '0.5';
                    (e.currentTarget as HTMLElement).style.color = '';
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
