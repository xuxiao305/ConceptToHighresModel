/**
 * Page3 V2 — Target Mesh Gallery panel.
 *
 * 与 HighresGallery 对称（Source 一侧），但数据源是 Page1 的两个 3D 节点：
 *   - page1.rough           → Clothed（带外套）
 *   - page1.rough.nojacket  → NoJacket（去外套）
 *
 * 职责：
 *   - 列出工程里所有 page1.rough / page1.rough.nojacket 历史 GLB；
 *   - 单击预览（标记选中）；
 *   - 双击触发 onPickTarget(item, kind) — kind 用来在 ModelAssemble 里：
 *       1. 选对的 NODE_KEY 重新 loadGlbAsMesh
 *       2. 自动 loadPage1SegPack(kind) 联动切割包
 *
 * 缩略图：复用 loadGlb + renderTexturedFrontSnapshot。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useProject } from '../../contexts/ProjectContext';
import { loadGlb, renderTexturedFrontSnapshot } from '../../three';
import type { AssetVersion } from '../../services/projectStore';

export type TargetKind = 'clothed' | 'nojacket';

export interface TargetGalleryItem extends AssetVersion {
  /** 唯一 ID（kind:file），React key + 选中态用 */
  id: string;
  kind: TargetKind;
  /** 对应 NODE_KEY，便于父组件直接调 loadByName */
  nodeKey: 'page1.rough' | 'page1.rough.nojacket';
}

interface GallerySnapshot {
  status: 'loading' | 'ready' | 'error';
  dataUrl?: string;
}

interface TargetGalleryProps {
  /** 双击后由父组件加载到 Target，并按 kind 自动联动 SegPack */
  onPickTarget: (item: TargetGalleryItem) => void;
  /**
   * 当前 Target 显示的 (kind, file)，用来在卡片上挂 TGT 角标。
   * 只用 file 比较会出歧义（clothed/nojacket 可能同名），所以两个都比。
   */
  currentTargetKind: TargetKind | null;
  currentTargetFile: string | null;
}

const KIND_LABEL: Record<TargetKind, string> = {
  clothed: 'Clothed',
  nojacket: 'NoJacket',
};
const KIND_COLOR: Record<TargetKind, string> = {
  clothed: '#7fbfff',
  nojacket: '#ffb87f',
};

export function TargetGallery({
  onPickTarget,
  currentTargetKind,
  currentTargetFile,
}: TargetGalleryProps) {
  const { project, listHistory, loadByName } = useProject();
  const [items, setItems] = useState<TargetGalleryItem[]>([]);
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
      const [clothed, nojacket] = await Promise.all([
        listHistory('page1.rough'),
        listHistory('page1.rough.nojacket'),
      ]);
      // 只取每个 kind 最新一条（= Page1 当前选中的版本），避免把历史全部铺出来。
      // listHistory 已经按时间倒序，索引 0 即最新。
      const latestClothed = clothed[0];
      const latestNojacket = nojacket[0];
      const next: TargetGalleryItem[] = [];
      if (latestClothed) {
        next.push({
          ...latestClothed,
          id: `clothed:${latestClothed.file}`,
          kind: 'clothed',
          nodeKey: 'page1.rough',
        });
      }
      if (latestNojacket) {
        next.push({
          ...latestNojacket,
          id: `nojacket:${latestNojacket.file}`,
          kind: 'nojacket',
          nodeKey: 'page1.rough.nojacket',
        });
      }
      setItems(next);
      if (next.length > 0 && (!selectedId || !next.some((v) => v.id === selectedId))) {
        setSelectedId(next[0].id);
      } else if (next.length === 0) {
        setSelectedId(null);
      }
    } finally {
      setLoading(false);
    }
  }, [project, listHistory, selectedId]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 用 ref 持有最新 refresh，避免事件监听器闭包过期。
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // 缩略图渲染（串行，避免多 WebGL context 同时跑）
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
          const loaded = await loadByName(item.nodeKey, item.file);
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
          console.warn('[Page3 TargetGallery] snapshot failed:', item.file, err);
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
          {items.length} 条（每 kind 最新）· 双击加载到 Target
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => void refresh()} loading={loading}>↻</Button>
      </div>

      {items.length === 0 ? (
        <div style={hintStyle}>
          Page1 暂无 3D Model（Clothed / NoJacket）。请先在 Page1 跑一次 3D Model 节点。
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
            const bound = currentTargetKind === v.kind && currentTargetFile === v.file;
            const snap = snapshots[v.id];
            return (
              <button
                key={v.id}
                onClick={() => setSelectedId(v.id)}
                onDoubleClick={() => onPickTarget(v)}
                title={`单击预览，双击加载到 Target（${KIND_LABEL[v.kind]}）`}
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
                {bound && <div style={badgeStyle}>TGT</div>}
                <div style={thumbBoxStyle}>
                  {snap?.status === 'ready' && snap.dataUrl ? (
                    <img
                      src={snap.dataUrl}
                      alt={v.file}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : snap?.status === 'error' ? (
                    <span style={{ fontSize: 9, color: '#d9534f' }}>错</span>
                  ) : (
                    <span style={{ fontSize: 9 }}>…</span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: KIND_COLOR[v.kind],
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {KIND_LABEL[v.kind]}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {v.file}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                    {new Date(v.timestamp).toLocaleString()}
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
  color: '#ffd57f',
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
