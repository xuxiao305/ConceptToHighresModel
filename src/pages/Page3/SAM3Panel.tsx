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
  onStatus?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface LoadedPack {
  pack: SegmentationPack;
  maskUrl: string;
  source: string;
  dirName: string;
}

export function SAM3Panel(props: SAM3PanelProps) {
  const { tarMesh, adoptedLabel, onAdoptRegion, onStatus } = props;
  const { project, loadPage3SegPack, updatePage3Session } = useProject();

  const [loaded, setLoaded] = useState<LoadedPack | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orthoUrl, setOrthoUrl] = useState<string | null>(null);
  const [camera, setCamera] = useState<OrthoFrontCamera | null>(null);
  const [reprojRegions, setReprojRegions] = useState<Map<string, Set<number>> | null>(null);
  const [running, setRunning] = useState(false);
  const refreshSeqRef = useRef(0);

  // Auto-load project SegPack when the project changes.
  const refreshPack = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setLoadError(null);
    if (!project) {
      setLoaded((prev) => {
        if (prev) URL.revokeObjectURL(prev.maskUrl);
        return null;
      });
      return;
    }
    try {
      const result = await loadPage3SegPack();
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
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [project, loadPage3SegPack]);

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
    onAdoptRegion(null, null, null);
    // We deliberately omit `onAdoptRegion` from the dep array: parent
    // callbacks change on every render, and we only want to clear when
    // the loaded pack itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const renderSize = useMemo(() => {
    if (!loaded) return null;
    const bbox = regionsUnionBBox(loaded.pack.regions);
    if (!bbox) return null;
    // Use the union bbox as the source "image" size for normalization.
    // V1 used the original ref image size; we don't have a ref image in
    // V2 (no upload UI), so the bbox itself is our reference frame.
    const refW = Math.max(1, Math.round(bbox.x + bbox.w));
    const refH = Math.max(1, Math.round(bbox.y + bbox.h));
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
  }, [loaded]);

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

  if (!project) {
    return (
      <div style={panelEmpty}>请先在顶栏选择/创建工程</div>
    );
  }
  if (loadError) {
    return <div style={panelError}>SAM3 加载失败：{loadError}</div>;
  }
  if (!loaded) {
    return (
      <div style={panelEmpty}>
        工程内未发现 SegPack（page3_assemble/01_segpack）。
        请先在 Page3 V1 流程导出，或将 SegPack 拷贝至工程目录。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        SegPack: <code>{loaded.dirName}</code> · {loaded.pack.regions.length} 个区域
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

      {orthoUrl && (
        <img
          src={orthoUrl}
          alt="Target ortho front"
          style={{
            width: '100%',
            background: '#222',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            imageRendering: 'pixelated',
          }}
        />
      )}

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
