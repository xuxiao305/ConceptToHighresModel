/**
 * Page3 V2 — Highres Mesh Gallery panel.
 *
 * Mirrors V1 ModelAssemble.tsx (line 2131-2480 + 3460-3550):
 *   - Lists all Page2 pipelines that currently expose a `modelFile`.
 *   - Renders a textured front-view thumbnail for each via
 *     loadGlb + renderTexturedFrontSnapshot (cached per item).
 *   - Single-click selects (preview); double-click loads into Source.
 *
 * V2 simplifications vs V1:
 *   - No "sourceGalleryBinding" auto-sync on pipeline updates. The user
 *     explicitly picks a version once; the version dropdown / Refresh
 *     button suffices for the V2 flow.
 *   - No `page2:pipelines-updated` event listener. V2 consumers can call
 *     the `refresh` prop after they know Page2 changed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useProject } from '../../contexts/ProjectContext';
import { loadGlb, renderTexturedFrontSnapshot } from '../../three';
import type { AssetVersion, PersistedPipeline } from '../../services/projectStore';

export interface HighresGalleryItem extends AssetVersion {
  id: string;
  pipelineKey: string;
  pipelineIndex: number;
  pipelineName: string;
  pipelineMode: PersistedPipeline['mode'];
}

interface GallerySnapshot {
  status: 'loading' | 'ready' | 'error';
  dataUrl?: string;
}

interface HighresGalleryProps {
  /** Called when the user double-clicks an item — load into Source. */
  onPickSource: (item: HighresGalleryItem) => void;
  /** Filename currently shown as Source mesh, used to mark the active card. */
  currentSrcFile: string | null;
}

export function HighresGallery({ onPickSource, currentSrcFile }: HighresGalleryProps) {
  const { project, listHistory, loadByName, loadPipelines } = useProject();
  const [items, setItems] = useState<HighresGalleryItem[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, GallerySnapshot>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!project) {
      setItems([]);
      setSelectedId(null);
      return;
    }
    setLoading(true);
    try {
      const [pipelinesIndex, history] = await Promise.all([
        loadPipelines(),
        listHistory('page2.highres'),
      ]);
      // 用 history 补充 timestamp/note 元数据，但不要求 modelFile 必须存在于 history。
      // 关键语义：以「pipeline 当前加载的 modelFile」为准（用户当前选择），不是 history 最新条目。
      const historyByFile = new Map(history.map((v) => [v.file, v]));
      const next = (pipelinesIndex?.pipelines ?? [])
        .map((pipeline, pipelineIndex): HighresGalleryItem | null => {
          if (!pipeline.modelFile) return null;
          const version: AssetVersion = historyByFile.get(pipeline.modelFile)
            ?? { file: pipeline.modelFile, timestamp: new Date(0).toISOString() };
          const pipelineKey = pipeline.id ?? `index:${pipelineIndex}`;
          return {
            ...version,
            id: `${pipelineKey}:${version.file}`,
            pipelineKey,
            pipelineIndex,
            pipelineName: pipeline.name,
            pipelineMode: pipeline.mode,
          };
        })
        .filter((v): v is HighresGalleryItem => v !== null);
      setItems(next);
      if (next.length > 0 && (!selectedId || !next.some((v) => v.id === selectedId))) {
        setSelectedId(next[0].id);
      } else if (next.length === 0) {
        setSelectedId(null);
      }
    } finally {
      setLoading(false);
    }
  }, [project, loadPipelines, listHistory, selectedId]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 用 ref 持有最新 refresh，避免事件监听器闭包过期。
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // 仅响应 Page2 显式保存 pipelines 的事件，避免 focus/visibility 变化触发重刷导致卡顿。
  useEffect(() => {
    const handler = () => { void refreshRef.current(); };
    window.addEventListener('page2:pipelines-updated', handler);
    return () => {
      window.removeEventListener('page2:pipelines-updated', handler);
    };
  }, []);

  // Render textured snapshots in series (avoid GPU thrash from N parallel WebGL contexts).
  useEffect(() => {
    let cancelled = false;
    if (!project || items.length === 0) {
      setSnapshots({});
      return () => { cancelled = true; };
    }
    setSnapshots(Object.fromEntries(items.map((it) => [it.id, { status: 'loading' as const }])));
    void (async () => {
      for (const item of items) {
        let urlToRevoke: string | null = null;
        try {
          const loaded = await loadByName('page2.highres', item.file);
          if (!loaded) throw new Error('未找到模型文件');
          urlToRevoke = loaded.url;
          const glb = await loadGlb(loaded.url);
          const dataUrl = renderTexturedFrontSnapshot(glb.scene, glb.bbox, {
            width: 220,
            height: 140,
            padding: 0.08,
            background: '#20242a',
            pixelRatio: 1,
          });
          if (!cancelled) {
            setSnapshots((prev) => ({ ...prev, [item.id]: { status: 'ready', dataUrl } }));
          }
        } catch (err) {
          console.warn('[Page3] gallery snapshot failed:', item.file, err);
          if (!cancelled) {
            setSnapshots((prev) => ({ ...prev, [item.id]: { status: 'error' } }));
          }
        } finally {
          if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [items, project, loadByName]);

  if (!project) {
    return <div style={hintStyle}>未打开工程</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {items.length} 条 · 双击加载到 Source
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => void refresh()} loading={loading}>↻</Button>
      </div>

      {items.length === 0 ? (
        <div style={hintStyle}>
          Page2 暂无 Pipeline 设置 modelFile。请先在 Page2 跑一次 highres。
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            overflowY: 'hidden',
            paddingBottom: 4,
            minHeight: 96,
          }}
        >
          {items.map((v) => {
            const selected = selectedId === v.id;
            const bound = currentSrcFile === v.file;
            const snap = snapshots[v.id];
            return (
              <button
                key={v.id}
                onClick={() => setSelectedId(v.id)}
                onDoubleClick={() => onPickSource(v)}
                title="单击预览，双击加载到 Source"
                style={{
                  flex: '0 0 220px',
                  height: 92,
                  textAlign: 'left',
                  background: selected ? 'var(--bg-elevated)' : 'var(--bg-app)',
                  border: selected ? '1px solid var(--accent-blue)' : '1px solid var(--border-default)',
                  borderRadius: 4,
                  padding: '6px 8px',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  position: 'relative',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'stretch',
                }}
              >
                {bound && (
                  <div style={badgeStyle}>SRC</div>
                )}
                <div style={thumbBoxStyle}>
                  {snap?.status === 'ready' && snap.dataUrl ? (
                    <img src={snap.dataUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : snap?.status === 'error' ? (
                    <span style={{ fontSize: 9, color: '#d9534f' }}>错</span>
                  ) : (
                    <span style={{ fontSize: 9 }}>…</span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {v.pipelineName}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {v.file}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                    mode: {v.pipelineMode}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const hintStyle = {
  fontSize: 11,
  color: 'var(--text-muted)',
  lineHeight: 1.5,
  padding: 8,
} as const;

const badgeStyle = {
  position: 'absolute' as const,
  top: 4,
  right: 6,
  fontSize: 9,
  color: '#7fd97f',
  fontWeight: 700,
};

const thumbBoxStyle = {
  flex: '0 0 80px',
  height: 76,
  alignSelf: 'center' as const,
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  background: '#20242a',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  color: 'var(--text-muted)',
  fontSize: 10,
};
