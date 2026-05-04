/**
 * SAM3Panel — V2-native panel for loading the project SegPack, rendering
 * the Target ortho front view, reprojecting the mask onto Target mesh
 * vertices, and picking a region as the alignment target seed.
 *
 * Compared to V1 (ModelAssemble.tsx SAM3 sidebar):
 *   - No file upload UI: project storage is the only source.
 *   - No SegFormer / subjectFitBBox special case: V2 always fits to
 *     `regionsUnionBBox(segPack.regions)`.
 *   - No manual ortho scale / offset controls: auto-fit only.
 *   - One-click "渲染并反投影" button replaces V1's two-step flow.
 *
 * Outputs flow back to the parent via `onAdoptRegion(region, label, camera)`.
 * The camera is exposed because the pose-proxy strategy needs it to
 * project Target joints into mesh space.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useProject } from '../../contexts/ProjectContext';
import {
  loadMaskGray,
  renderOrthoFrontViewWithCamera,
  reprojectMaskToVertices,
  type Face3,
  type MeshRegion,
  type OrthoFrontCamera,
  type Vec3,
} from '../../three';
import {
  parseSegmentationJson,
  regionsUnionBBox,
  type SegmentationPack,
} from '../../services/segmentationPack';
import { buildMeshRegionFromVertexSet } from '../../services/meshRegion';

// V1's localization-space convention (ModelAssemble L509): ortho render
// resolution is normalized so the long edge = 1024 px. Keeps mask
// reprojection costs bounded regardless of source image size.
const LOCALIZATION_LONG_EDGE = 1024;

interface MeshLike {
  vertices: Vec3[];
  faces: Face3[];
}

interface SAM3PanelProps {
  /**
   * PR-C: which Page1 SegPack slot to bind to.
   *   'clothed'  → page1.segpack.clothed
   *   'nojacket' → page1.segpack.nojacket
   * 由 ModelAssemble 根据 Target 当前的 tarKind 传入，同步展示。
   */
  slot: 'clothed' | 'nojacket';
  tarMesh: MeshLike | null;
  /** Currently-adopted region label (so the picker can highlight it). */
  adoptedLabel: string | null;
  /**
   * Called when the user adopts a region (or clears it). The camera is
   * the ortho front camera used for the reprojection — pose-proxy
   * needs it to project Target joints back into mesh space.
   */
  onAdoptRegion: (
    region: MeshRegion | null,
    label: string | null,
    camera: OrthoFrontCamera | null,
  ) => void;
  /**
   * Emit the per-region vertex sets (after reprojection) so the parent
   * can color the 3D viewport. 与 Page1 SegPack overlay 色彩对齐：
   * 传回原 regions 顺序上的 index，由父组件用同一 regionRgb(idx) 公式查色。
   * null = cleared.
   */
  onReprojRegions?: (
    regions:
      | Array<{ regionIndex: number; label: string; vertices: number[] }>
      | null,
  ) => void;
  onStatus?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface LoadedPack {
  pack: SegmentationPack;
  maskUrl: string;
  source: string;
  dirName: string;
}

export function SAM3Panel(props: SAM3PanelProps) {
  const { slot, tarMesh, adoptedLabel, onAdoptRegion, onReprojRegions, onStatus } = props;
  const { project, loadPage1SegPack, updatePage3Session } = useProject();

  const [loaded, setLoaded] = useState<LoadedPack | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingPack, setLoadingPack] = useState(false);
  const [orthoUrl, setOrthoUrl] = useState<string | null>(null);
  const [camera, setCamera] = useState<OrthoFrontCamera | null>(null);
  const [reprojRegions, setReprojRegions] = useState<Map<string, Set<number>> | null>(null);
  const [running, setRunning] = useState(false);
  const refreshSeqRef = useRef(0);
  // 保证同一个 (slot, dirName, tarMesh) 组合只 auto-render 一次，避免与用户手动动作冲突。
  const autoRenderedKeyRef = useRef<string | null>(null);

  // Auto-load project SegPack when the project changes.
  const refreshPack = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setLoadError(null);
    if (!project) {
      setLoadingPack(false);
      setLoaded((prev) => {
        if (prev) URL.revokeObjectURL(prev.maskUrl);
        return null;
      });
      return;
    }
    setLoadingPack(true);
    try {
      const result = await loadPage1SegPack(slot);
      if (seq !== refreshSeqRef.current) return;
      if (!result) {
        setLoaded((prev) => {
          if (prev) URL.revokeObjectURL(prev.maskUrl);
          return null;
        });
        return;
      }
      const text = await result.jsonBlob.text();
      const pack = parseSegmentationJson(text);
      const maskUrl = URL.createObjectURL(result.maskBlob);
      setLoaded((prev) => {
        if (prev) URL.revokeObjectURL(prev.maskUrl);
        return { pack, maskUrl, source: result.source, dirName: result.dirName };
      });
      onStatus?.(
        `SAM3：已加载 SegPack(${slot === 'clothed' ? 'Clothed' : 'NoJacket'}) · ${pack.regions.length} 个区域`,
        'success',
      );
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === refreshSeqRef.current) setLoadingPack(false);
    }
  }, [project, loadPage1SegPack, slot, onStatus]);

  useEffect(() => {
    void refreshPack();
  }, [refreshPack]);

  // Cleanup ortho object URL on unmount / replacement.
  useEffect(() => () => {
    if (orthoUrl) URL.revokeObjectURL(orthoUrl);
  }, [orthoUrl]);

  // Loaded pack changed → previous ortho/reprojection is stale.
  useEffect(() => {
    setOrthoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setCamera(null);
    setReprojRegions(null);
    onReprojRegions?.(null);
    onAdoptRegion(null, null, null);
    // Reset auto-render guard so the new pack will auto-render once.
    autoRenderedKeyRef.current = null;
    // We deliberately omit `onAdoptRegion` from the dep array: parent
    // callbacks change on every render, and we only want to clear when
    // the loaded pack itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Mask PNG 原始尺寸作为 "reference image" 帧。SegPack 里的 bbox 是在
  // 这个全帧坐标系下。V1 segpack 是从 tight 的 ortho mesh-render 上跑出来
  // 的，区域并集刚好填满画布，所以 union-bbox.far-edge 偶然接近画布尺寸；
  // Page1 segpack 是从 T-Pose 原图上跑，区域不会延伸到边缘，必须读 mask
  // 本身的 naturalWidth/Height。
  const [maskDims, setMaskDims] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!loaded) {
      setMaskDims(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setMaskDims({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (!cancelled) setMaskDims(null);
    };
    img.src = loaded.maskUrl;
    return () => { cancelled = true; };
  }, [loaded]);

  const renderSize = useMemo(() => {
    if (!loaded || !maskDims) return null;
    const bbox = regionsUnionBBox(loaded.pack.regions);
    if (!bbox) return null;
    const refW = maskDims.width;
    const refH = maskDims.height;
    const scale = LOCALIZATION_LONG_EDGE / Math.max(refW, refH);
    const w = Math.max(1, Math.round(refW * scale));
    const h = Math.max(1, Math.round(refH * scale));
    const fitBBox = {
      x: Math.max(0, Math.round(bbox.x * scale)),
      y: Math.max(0, Math.round(bbox.y * scale)),
      w: Math.max(1, Math.round(bbox.w * scale)),
      h: Math.max(1, Math.round(bbox.h * scale)),
    };
    return { w, h, fitBBox };
  }, [loaded, maskDims]);

  // One-click: render Target ortho front view + reproject mask to vertices.
  const handleRenderAndReproject = useCallback(async () => {
    if (!loaded || !tarMesh || !renderSize) {
      onStatus?.('SAM3：缺少 SegPack 或 Target mesh', 'warning');
      return;
    }
    setRunning(true);
    try {
      // 1. Ortho front render with auto-fit to regions union bbox.
      const { dataUrl, camera: cam } = renderOrthoFrontViewWithCamera(
        tarMesh.vertices,
        tarMesh.faces,
        {
          width: renderSize.w,
          height: renderSize.h,
          background: null,
          meshColor: '#dddddd',
          fitToImageBBox: renderSize.fitBBox,
        },
      );
      setOrthoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return dataUrl;
      });
      setCamera(cam);

      // 2. Reproject mask onto Target vertices.
      const mask = await loadMaskGray(loaded.maskUrl, {
        resizeTo: { width: cam.width, height: cam.height },
      });
      if (!mask) {
        onStatus?.('SAM3：mask 解码失败', 'error');
        return;
      }
      const result = reprojectMaskToVertices(
        tarMesh.vertices,
        mask,
        loaded.pack.regions,
        cam,
        { projectionMode: 'through', splatRadiusPx: 1, maskDilatePx: 2 },
      );
      setReprojRegions(result.regions);
      // 按 loaded.pack.regions 原顺序发出，带 regionIndex。这里保证了序号
      // 与 Page1 SegPack 预览里的颜色序号一致，便于诊断反投影结果。
      onReprojRegions?.(
        loaded.pack.regions.map((r, regionIndex) => ({
          regionIndex,
          label: r.label,
          vertices: Array.from(result.regions.get(r.label) ?? []),
        })),
      );

      // Persist completion fact for the V2 readiness panel.
      void updatePage3Session({
        orthoCamera: { width: cam.width, height: cam.height },
        maskReprojection: {
          completedAt: new Date().toISOString(),
          regionCount: result.regions.size,
        },
      });

      const stats = Array.from(result.regions.entries())
        .map(([label, set]) => `${label}=${set.size}`)
        .join(', ');
      onStatus?.(
        `SAM3 反投影完成：${stats} · 未命中像素=${result.unassignedPixels}`,
        'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus?.(`SAM3 渲染/反投影失败：${msg}`, 'error');
    } finally {
      setRunning(false);
    }
  }, [loaded, tarMesh, renderSize, updatePage3Session, onStatus]);

  // Adopt a reprojected region as the current alignment target seed.
  const handleAdopt = useCallback(
    (label: string) => {
      if (!reprojRegions || !tarMesh || !camera) return;
      const set = reprojRegions.get(label);
      if (!set || set.size === 0) {
        onStatus?.(`SAM3：区域 "${label}" 没有顶点`, 'warning');
        return;
      }
      const region = buildMeshRegionFromVertexSet(tarMesh.vertices, set);
      if (!region) return;
      onAdoptRegion(region, label, camera);
      void updatePage3Session({ targetRegionLabel: label });
      onStatus?.(
        `SAM3：已采用区域 "${label}" (${set.size} 顶点) 作为 Target 区域`,
        'success',
      );
    },
    [reprojRegions, tarMesh, camera, onAdoptRegion, updatePage3Session, onStatus],
  );

  const handleClear = useCallback(() => {
    onAdoptRegion(null, null, null);
    void updatePage3Session({ targetRegionLabel: null });
    onStatus?.('SAM3：已清除 Target 区域', 'info');
  }, [onAdoptRegion, updatePage3Session, onStatus]);

  // Auto-render Target ortho + reproject mask once SegPack and tarMesh are
  // both ready. 使用 (slot, dirName, vertex count) 作为唯一 key，避免在
  // 同一组资源上重复触发。手动点击“运行”后不会被覆盖。
  useEffect(() => {
    if (!loaded || !tarMesh || !renderSize) return;
    const key = `${slot}::${loaded.dirName}::${tarMesh.vertices.length}`;
    if (autoRenderedKeyRef.current === key) return;
    autoRenderedKeyRef.current = key;
    void handleRenderAndReproject();
  }, [loaded, tarMesh, renderSize, slot, handleRenderAndReproject]);

  if (!project) {
    return (
      <div style={panelEmpty}>请先在顶栏选择/创建工程</div>
    );
  }
  if (loadError) {
    return <div style={panelError}>SAM3 加载失败：{loadError}</div>;
  }
  if (loadingPack && !loaded) {
    const slotLabel = slot === 'clothed' ? 'Clothed' : 'NoJacket';
    return (
      <div
        style={{
          ...panelEmpty,
          color: 'var(--text-primary)',
          background: 'rgba(127,191,255,0.08)',
          border: '1px solid rgba(127,191,255,0.4)',
        }}
      >
        🔄 正在加载 SegPack({slotLabel})…
      </div>
    );
  }
  if (!loaded) {
    // PR-C: 严格不回退。缺少对应 slot 的 SegPack 时只提示用户去 Page1 重跑。
    const slotLabel = slot === 'clothed' ? 'Clothed' : 'NoJacket';
    return (
      <div
        style={{
          ...panelEmpty,
          color: '#ff7a7a',
          background: 'rgba(255,80,80,0.08)',
          border: '1px solid rgba(255,80,80,0.4)',
        }}
      >
        ⚠️ 当前 Target ({slotLabel}) 缺少 SegPack。
        <br />
        请回 Page1 跑 <strong>SegPack({slotLabel})</strong> 节点生成。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            borderRadius: 3,
            background: 'rgba(127,217,127,0.15)',
            color: '#7fd97f',
            fontWeight: 700,
            fontSize: 10,
          }}
        >
          ✓ 已加载
        </span>
        SegPack ({slot === 'clothed' ? 'Clothed' : 'NoJacket'}): <code>{loaded.dirName}</code> · {loaded.pack.regions.length} 个区域
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Button
          size="sm"
          variant="primary"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => { void handleRenderAndReproject(); }}
          disabled={!tarMesh || running}
          loading={running}
          title={tarMesh ? '渲染 Target 正视图并将 mask 反投影到顶点' : '需要 Target mesh'}
        >
          ▶ 渲染 + 反投影
        </Button>
        <Button
          size="sm"
          onClick={() => { void refreshPack(); }}
          title="重新加载工程内 SegPack"
        >
          ↻
        </Button>
      </div>

      {/* ortho preview img 移除：反投影结果直接提升到中央 DualViewport 的 tarHighlight
          里，不再在侧边重复显示一张黑白预览图。 */}

      {reprojRegions && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            选择对齐目标区域：
          </div>
          {Array.from(reprojRegions.entries())
            .sort((a, b) => b[1].size - a[1].size)
            .map(([label, set]) => {
              const isAdopted = adoptedLabel === label;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => handleAdopt(label)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '4px 8px',
                    fontSize: 11,
                    background: isAdopted
                      ? 'rgba(82,158,255,0.15)'
                      : 'var(--bg-panel)',
                    border: `1px solid ${isAdopted ? 'var(--accent-blue)' : 'var(--border-subtle)'}`,
                    color: 'var(--text-primary)',
                    borderRadius: 4,
                    cursor: set.size > 0 ? 'pointer' : 'not-allowed',
                    textAlign: 'left',
                  }}
                  disabled={set.size === 0}
                >
                  <span>
                    {isAdopted ? '✓ ' : ''}
                    {label}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>{set.size} v</span>
                </button>
              );
            })}
          {adoptedLabel && (
            <Button size="sm" onClick={handleClear} title="清除 Target 区域">
              清除
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const panelEmpty: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  padding: 8,
  background: 'var(--bg-panel)',
  border: '1px dashed var(--border-subtle)',
  borderRadius: 4,
};

const panelError: React.CSSProperties = {
  ...panelEmpty,
  color: '#e08a8a',
  borderColor: '#e08a8a',
  borderStyle: 'solid',
};
