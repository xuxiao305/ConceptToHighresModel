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
      // ── DIAG: 反投影前后的 region/mask/camera/命中数据 ──
      // 用于排查"jacket 案例下 region 错位"的问题。
      // 关注：
      //   1. pack.regions 的 mask_value 与 label 是否一一对应（顺序）
      //   2. mask 实际像素值的分布（值直方图）是否匹配 mask_value
      //   3. camera fit 后的画布尺寸 vs mask 原图尺寸
      //   4. 每个 region 的 pixelHits 与 vertex 命中数
      const histo = new Map<number, number>();
      for (let i = 0; i < mask.data.length; i++) {
        const v = mask.data[i];
        histo.set(v, (histo.get(v) ?? 0) + 1);
      }
      const histoTop = Array.from(histo.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      // eslint-disable-next-line no-console
      console.group('[SAM3 reproject diag]');
      // eslint-disable-next-line no-console
      console.log('regions(pack):', loaded.pack.regions.map((r, i) => ({
        idx: i, label: r.label, mask_value: r.mask_value, bbox: r.bbox,
      })));
      // eslint-disable-next-line no-console
      console.log('mask:', { w: mask.width, h: mask.height, refImg: maskDims });
      // eslint-disable-next-line no-console
      console.log('camera:', {
        w: cam.width, h: cam.height,
        camY: cam.camY, camZ: cam.camZ,
        worldPerPx: cam.worldPerPx, meshFrontX: cam.meshFrontX,
      });
      // eslint-disable-next-line no-console
      console.log('mask pixel value top10:', histoTop);
      const result = reprojectMaskToVertices(
        tarMesh.vertices,
        mask,
        loaded.pack.regions,
        cam,
        { projectionMode: 'through', splatRadiusPx: 1, maskDilatePx: 2 },
      );
      // eslint-disable-next-line no-console
      console.log('result:', {
        perRegionPixelHits: Array.from(result.perRegionPixelHits.entries()),
        regionVertexCounts: Array.from(result.regions.entries()).map(([l, s]) => [l, s.size]),
        unassignedPixels: result.unassignedPixels,
      });
      // ── 3D bbox per region：用 World 坐标定位每个 region 顶点的实际位置
      // 如果 leg region 的顶点 worldY 范围不在 mesh 下半部分，那么相机/坐标轴
      // 有问题；如果 worldY 正确但 worldX/Z 散布异常大，说明 through mode 把
      // 背面/内部顶点也吃了。
      // 同时输出 mesh 整体 bbox 作参考。
      let meshMnX=Infinity,meshMnY=Infinity,meshMnZ=Infinity;
      let meshMxX=-Infinity,meshMxY=-Infinity,meshMxZ=-Infinity;
      for (const v of tarMesh.vertices) {
        if (v[0]<meshMnX)meshMnX=v[0]; if (v[0]>meshMxX)meshMxX=v[0];
        if (v[1]<meshMnY)meshMnY=v[1]; if (v[1]>meshMxY)meshMxY=v[1];
        if (v[2]<meshMnZ)meshMnZ=v[2]; if (v[2]>meshMxZ)meshMxZ=v[2];
      }
      const regionBBox3D = Array.from(result.regions.entries()).map(([label, set]) => {
        let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
        let cx=0,cy=0,cz=0,n=0;
        for (const i of set) {
          const v = tarMesh.vertices[i];
          if (v[0]<mnx)mnx=v[0]; if (v[0]>mxx)mxx=v[0];
          if (v[1]<mny)mny=v[1]; if (v[1]>mxy)mxy=v[1];
          if (v[2]<mnz)mnz=v[2]; if (v[2]>mxz)mxz=v[2];
          cx+=v[0]; cy+=v[1]; cz+=v[2]; n++;
        }
        if (n === 0) return { label, count: 0 };
        return {
          label,
          count: n,
          centerY: (cy/n).toFixed(3),
          rangeY: `[${mny.toFixed(3)}, ${mxy.toFixed(3)}]`,
          rangeX: `[${mnx.toFixed(3)}, ${mxx.toFixed(3)}]`,
          rangeZ: `[${mnz.toFixed(3)}, ${mxz.toFixed(3)}]`,
        };
      });
      // eslint-disable-next-line no-console
      console.log('mesh bbox:', {
        x: `[${meshMnX.toFixed(3)}, ${meshMxX.toFixed(3)}]`,
        y: `[${meshMnY.toFixed(3)}, ${meshMxY.toFixed(3)}]  (top→bottom = high→low?)`,
        z: `[${meshMnZ.toFixed(3)}, ${meshMxZ.toFixed(3)}]`,
      });
      // eslint-disable-next-line no-console
      console.log('regionBBox3D:', regionBBox3D);
      // ── 按 worldY 分箱：每箱内统计「总顶点数 / 各 region 命中数 / 未命中数」
      // 用于定位"缺失的小腿顶点"具体去哪了。如果最低的 bin 里 R2(jacket)
      // 命中很多，那是 first-win bug；如果 unassigned 多，那是 mask 在该
      // 像素区无标签（mask 与 mesh 在 Y 方向没对齐）；如果 total=0 即 mesh
      // 那段Y本来就无几何。
      const NUM_BINS = 10;
      const yMin = meshMnY, yMax = meshMxY;
      const binW = (yMax - yMin) / NUM_BINS;
      const bins: Array<{ yLo: number; yHi: number; total: number; perRegion: Record<string, number>; unassigned: number }> = [];
      for (let b = 0; b < NUM_BINS; b++) {
        bins.push({
          yLo: yMin + b * binW,
          yHi: yMin + (b + 1) * binW,
          total: 0,
          perRegion: {},
          unassigned: 0,
        });
      }
      // build vertex→label lookup
      const vertLabel = new Map<number, string>();
      for (const [label, set] of result.regions.entries()) {
        for (const i of set) vertLabel.set(i, label);
      }
      for (let i = 0; i < tarMesh.vertices.length; i++) {
        const wy = tarMesh.vertices[i][1];
        let bIdx = Math.floor((wy - yMin) / binW);
        if (bIdx < 0) bIdx = 0; if (bIdx >= NUM_BINS) bIdx = NUM_BINS - 1;
        bins[bIdx].total++;
        const lab = vertLabel.get(i);
        if (lab) bins[bIdx].perRegion[lab] = (bins[bIdx].perRegion[lab] ?? 0) + 1;
        else bins[bIdx].unassigned++;
      }
      // eslint-disable-next-line no-console
      console.log('vertexY bins (low→high):', bins.map((b, k) => ({
        bin: k,
        yRange: `[${b.yLo.toFixed(3)}, ${b.yHi.toFixed(3)}]`,
        total: b.total,
        ...b.perRegion,
        unassigned: b.unassigned,
      })));
      // ── Unassigned 顶点投影分析:
      // 把所有 unassigned 顶点按当前相机投到像素,记录:
      //   - 落在画布内/外的比例
      //   - 落在画布内时,mask 值直方图(以确认是 mask=0 还是命中了某 region 但被代码丢弃)
      //   - pixelX/pixelY 范围
      // 同时单独跑底部 3 个 bin (legs 区域),报它们的 pixel 范围 — 与 R3 mask
      // bbox 比对就能定位 X 轴是否错位。
      const unassignedSet = new Set<number>();
      for (let i = 0; i < tarMesh.vertices.length; i++) {
        if (!vertLabel.has(i)) unassignedSet.add(i);
      }
      const W = cam.width, H = cam.height;
      const projectVert = (v: [number, number, number]) => {
        const px = Math.round(W / 2 + (cam.camZ - v[2]) / cam.worldPerPx);
        const py = Math.round(H / 2 - (v[1] - cam.camY) / cam.worldPerPx);
        return { px, py };
      };
      let inFrame = 0, outFrame = 0;
      const maskHisto = new Map<number, number>();
      let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity;
      // legs subset: Y < -0.2 (≈ bin 0..2)
      let legsPxMin = Infinity, legsPxMax = -Infinity, legsPyMin = Infinity, legsPyMax = -Infinity;
      let legsCount = 0, legsInFrame = 0;
      const legsMaskHisto = new Map<number, number>();
      for (const i of unassignedSet) {
        const v = tarMesh.vertices[i];
        const { px, py } = projectVert(v);
        const isLegs = v[1] < -0.2;
        if (isLegs) legsCount++;
        if (px < 0 || px >= W || py < 0 || py >= H) {
          outFrame++;
          continue;
        }
        inFrame++;
        if (px < pxMin) pxMin = px; if (px > pxMax) pxMax = px;
        if (py < pyMin) pyMin = py; if (py > pyMax) pyMax = py;
        const mv = mask.data[py * W + px];
        maskHisto.set(mv, (maskHisto.get(mv) ?? 0) + 1);
        if (isLegs) {
          legsInFrame++;
          if (px < legsPxMin) legsPxMin = px; if (px > legsPxMax) legsPxMax = px;
          if (py < legsPyMin) legsPyMin = py; if (py > legsPyMax) legsPyMax = py;
          legsMaskHisto.set(mv, (legsMaskHisto.get(mv) ?? 0) + 1);
        }
      }
      // eslint-disable-next-line no-console
      console.log('unassigned vertices projection:', {
        total: unassignedSet.size,
        inFrame, outFrame,
        pixelXRange: `[${pxMin}, ${pxMax}]`,
        pixelYRange: `[${pyMin}, ${pyMax}]`,
        maskValueHisto: Array.from(maskHisto.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8),
      });
      // eslint-disable-next-line no-console
      console.log('LEGS (Y<-0.2) unassigned projection:', {
        total: legsCount,
        inFrame: legsInFrame,
        outFrame: legsCount - legsInFrame,
        pixelXRange: `[${legsPxMin}, ${legsPxMax}]`,
        pixelYRange: `[${legsPyMin}, ${legsPyMax}]`,
        maskValueHisto: Array.from(legsMaskHisto.entries()).sort((a, b) => b[1] - a[1]),
      });
      // eslint-disable-next-line no-console
      console.groupEnd();
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
