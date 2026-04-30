import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { GLBThumbnail } from '../../components/GLBThumbnail';
import { OrthoCompareModal } from '../../components/OrthoCompareModal';
import { useProject } from '../../contexts/ProjectContext';
import {
  parseSegmentationJson,
  regionsUnionBBox,
  type SegmentationPack,
} from '../../services/segmentationPack';
import {
  DualViewport,
  MeshViewer,
  useLandmarkStore,
  loadGlbAsMesh,
  buildMeshAdjacency,
  matchGlobalCandidates,
  ransacFilterCandidates,
  matchPartialToWhole,
  computePartialDebug,
  bboxDiagonal,
  renderOrthoFrontViewWithCamera,
  loadMaskGray,
  reprojectMaskToVertices,
  extractImageSubjectBBox,
  icpRefine,
  type Vec3,
  type Face3,
  type ViewMode,
  type MeshAdjacency,
  type MeshRegion,
  type LandmarkCandidate,
  type PartialDebugResult,
  type SubjectBBox,
  type OrthoFrontCamera,
  type MaskReprojectionResult,
} from '../../three';
import {
  alignSourceMeshByLandmarks,
  type AlignmentMode,
  type AlignmentResult,
  applyTransform,
} from '../../three/alignment';
import type { AssetVersion } from '../../services/projectStore';

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface MeshData {
  name: string;
  vertices: Vec3[];
  faces: Face3[];
}

type CenterViewMode = 'landmark' | 'result';
type ResultViewMode = 'overlay' | 'aligned' | 'target' | 'original';

interface ResultPreview {
  mode: AlignmentMode;
  originalVertices: Vec3[];
  alignedVertices: Vec3[];
  alignedSrcLandmarks: Vec3[];
  targetLandmarks: Vec3[];
  faces: Face3[];
  rmse: number;
  meanError: number;
  maxError: number;
  scale: number;
}

const DEMO_SOURCE: MeshData = {
  name: 'Demo Source',
  vertices: [
    [-0.6, 0.0, -0.3],
    [0.7, 0.0, -0.2],
    [0.6, 0.0, 0.5],
    [-0.5, 0.0, 0.4],
    [-0.4, 1.0, -0.25],
    [0.5, 1.1, -0.1],
    [0.45, 1.05, 0.45],
    [-0.35, 0.95, 0.35],
    [-0.1, 1.55, 0.0],
    [0.15, 1.75, 0.08],
  ],
  faces: [
    [0, 1, 2], [0, 2, 3],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
    [4, 8, 9], [5, 9, 8],
    [6, 9, 5], [7, 8, 4],
  ],
};

function makeDemoTarget(source: MeshData): MeshData {
  const angleY = Math.PI * 0.28;
  const c = Math.cos(angleY);
  const s = Math.sin(angleY);
  const scale = 1.1;
  const tx = 0.85;
  const ty = -0.05;
  const tz = 0.55;
  const matrix4x4 = [
    [scale * c, 0, scale * s, tx],
    [0, scale, 0, ty],
    [-scale * s, 0, scale * c, tz],
    [0, 0, 0, 1],
  ];

  return {
    name: 'Demo Target',
    vertices: source.vertices.map((v) => applyTransform(v, matrix4x4)),
    faces: source.faces,
  };
}

export function ModelAssemble({ onStatusChange }: Props) {
  const { project, listHistory, loadByName } = useProject();
  const demoTarget = useMemo(() => makeDemoTarget(DEMO_SOURCE), []);

  const [srcMesh, setSrcMesh] = useState<MeshData>(DEMO_SOURCE);
  const [tarMesh, setTarMesh] = useState<MeshData>(demoTarget);
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const [landmarkSize, setLandmarkSize] = useState(0.01);
  const [alignmentMode, setAlignmentMode] = useState<AlignmentMode>('similarity');
  const [aligning, setAligning] = useState(false);
  const [alignResult, setAlignResult] = useState<AlignmentResult | null>(null);
  const [centerViewMode, setCenterViewMode] = useState<CenterViewMode>('landmark');
  const [resultViewMode, setResultViewMode] = useState<ResultViewMode>('overlay');
  const [resultPreview, setResultPreview] = useState<ResultPreview | null>(null);
  const [selectedSrcIndex, setSelectedSrcIndex] = useState<number | null>(null);
  const [selectedTarIndex, setSelectedTarIndex] = useState<number | null>(null);
  const [highresHistory, setHighresHistory] = useState<AssetVersion[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [selectedGalleryFile, setSelectedGalleryFile] = useState<string | null>(null);
  const [selectedGalleryPreviewUrl, setSelectedGalleryPreviewUrl] = useState<string | null>(null);

  // ── Phase 1 region-grow state ─────────────────────────────────────────
  // NOTE: the manual seed-mode UI was removed in favour of SAM3 mask
  // reprojection. `tarRegion` is still set programmatically by the
  // "设为 seed" button on a SAM3 region; partial-match reads it for
  // hard constraint + soft seed. `srcRegion` is currently unused but
  // kept for future symmetry (source-side SAM3 region).
  const [srcRegion, setSrcRegion] = useState<MeshRegion | null>(null);
  const [tarRegion, setTarRegion] = useState<MeshRegion | null>(null);

  // ── Phase 2 candidate list state ────────────────────────────────────────────
  // The "查找候选" UI for region-based local matching was removed; the
  // candidate list itself is reused by partial-match results.
  const [candidates, setCandidates] = useState<LandmarkCandidate[]>([]);
  const [acceptedCandidateIds, setAcceptedCandidateIds] = useState<Set<number>>(
    () => new Set(),
  );

  // ── Whole-mesh global candidates (Phase 2.5) ──────────────────────────
  const [globalSamples, setGlobalSamples] = useState(60);
  const [globalRings, setGlobalRings] = useState(3);
  const [globalRequireMutual, setGlobalRequireMutual] = useState(true);
  const [ransacAutoApply, setRansacAutoApply] = useState(true);
  const [ransacThresholdPct, setRansacThresholdPct] = useState(5);
  const [ransacIterations, setRansacIterations] = useState(300);

  // ── Partial-to-whole (Phase 2.6) ──────────────────────────────────────
  const [partialSrcSamples, setPartialSrcSamples] = useState(20);
  const [partialTarSamples, setPartialTarSamples] = useState(80);
  const [partialTopK, setPartialTopK] = useState(5);
  const [partialThresholdPct, setPartialThresholdPct] = useState(5);
  const [partialIterations, setPartialIterations] = useState(600);
  const [partialDescriptor, setPartialDescriptor] = useState<'curvature' | 'fpfh'>('fpfh');
  const [partialSeedWeight, setPartialSeedWeight] = useState(2.0);
  // PCA axial+radial feature weight. Critical for cylindrical parts
  // like arms / legs where pure FPFH collapses to a single feature.
  const [partialAxialWeight, setPartialAxialWeight] = useState(5.0);
  const [partialLoading, setPartialLoading] = useState(false);

  // ── Phase 1 debug visualization ───────────────────────────────────────
  const [partialDebug, setPartialDebug] = useState<PartialDebugResult | null>(null);
  const [showSaliency, setShowSaliency] = useState(true);
  const [showFPS, setShowFPS] = useState(true);
  const [showTopK, setShowTopK] = useState(true);

  // ── 2D localization (SAM3) state ──────────────────────────────────────
  // Used to verify that an external 2D image (e.g. concept art / Bot.png)
  // aligns with an orthographic front render of the target mesh, before
  // we wire mask → vertex reprojection.
  const [refImageUrl, setRefImageUrl] = useState<string | null>(null);
  const [refImageName, setRefImageName] = useState<string | null>(null);
  const [refImageSize, setRefImageSize] = useState<{ w: number; h: number } | null>(null);
  const [refSubjectBBox, setRefSubjectBBox] = useState<SubjectBBox | null>(null);
  const [maskImageUrl, setMaskImageUrl] = useState<string | null>(null);
  const [maskImageName, setMaskImageName] = useState<string | null>(null);
  // Optional segmentation.json sidecar (SAM3 export). When present its
  // union of region bboxes is the most reliable framing source.
  const [segPack, setSegPack] = useState<SegmentationPack | null>(null);
  const [segPackName, setSegPackName] = useState<string | null>(null);
  const [orthoRenderUrl, setOrthoRenderUrl] = useState<string | null>(null);
  // Camera that was actually used for the most recent render. Required
  // for mask reprojection so the projection used to interpret a mask
  // matches the one used to render it.
  const [orthoCamera, setOrthoCamera] = useState<OrthoFrontCamera | null>(null);
  const [maskReproj, setMaskReproj] = useState<MaskReprojectionResult | null>(null);
  const [showOrthoCompare, setShowOrthoCompare] = useState(false);
  // Auto-fit is the default; users only override these manually if the
  // automatic subject-bbox extraction misjudges the image.
  const [autoFit, setAutoFit] = useState(true);
  const [orthoScale, setOrthoScale] = useState(1.0);
  const [orthoOffsetX, setOrthoOffsetX] = useState(0);
  const [orthoOffsetY, setOrthoOffsetY] = useState(0);
  const refImageInputRef = useRef<HTMLInputElement | null>(null);
  const maskImageInputRef = useRef<HTMLInputElement | null>(null);
  const segJsonInputRef = useRef<HTMLInputElement | null>(null);

  // The bbox actually used for fitting: JSON union > image auto-extract.
  const fitBBox = useMemo(() => {
    if (segPack) return regionsUnionBBox(segPack.regions);
    return refSubjectBBox
      ? { x: refSubjectBBox.x, y: refSubjectBBox.y, w: refSubjectBBox.w, h: refSubjectBBox.h }
      : null;
  }, [segPack, refSubjectBBox]);

  const srcAdjacency: MeshAdjacency = useMemo(
    () => buildMeshAdjacency(srcMesh.vertices, srcMesh.faces),
    [srcMesh],
  );
  const tarAdjacency: MeshAdjacency = useMemo(
    () => buildMeshAdjacency(tarMesh.vertices, tarMesh.faces),
    [tarMesh],
  );

  const srcInputRef = useRef<HTMLInputElement | null>(null);
  const tarInputRef = useRef<HTMLInputElement | null>(null);

  const srcLandmarks = useLandmarkStore((s) => s.srcLandmarks);
  const tarLandmarks = useLandmarkStore((s) => s.tarLandmarks);
  const addSrcLandmark = useLandmarkStore((s) => s.addSrcLandmark);
  const addTarLandmark = useLandmarkStore((s) => s.addTarLandmark);
  const updateSrcLandmark = useLandmarkStore((s) => s.updateSrcLandmark);
  const updateTarLandmark = useLandmarkStore((s) => s.updateTarLandmark);
  const removeSrcLandmark = useLandmarkStore((s) => s.removeSrcLandmark);
  const removeTarLandmark = useLandmarkStore((s) => s.removeTarLandmark);
  const clearSrcLandmarks = useLandmarkStore((s) => s.clearSrcLandmarks);
  const clearTarLandmarks = useLandmarkStore((s) => s.clearTarLandmarks);
  const clearAllLandmarks = useLandmarkStore((s) => s.clearAll);

  const clearCandidates = useCallback(() => {
    setCandidates([]);
    setAcceptedCandidateIds(new Set());
  }, []);

  const handleAcceptCandidate = useCallback(
    (i: number) => {
      const c = candidates[i];
      if (!c) return;
      addSrcLandmark(c.srcVertex, c.srcPosition);
      addTarLandmark(c.tarVertex, c.tarPosition);
      setAcceptedCandidateIds((prev) => {
        const next = new Set(prev);
        next.add(i);
        return next;
      });
      onStatusChange(
        `已接受候选 #${i + 1}（confidence=${c.confidence.toFixed(2)}）→ landmark pair`,
        'success',
      );
    },
    [candidates, addSrcLandmark, addTarLandmark, onStatusChange],
  );

  const handleRejectCandidate = useCallback(
    (i: number) => {
      setCandidates((prev) => prev.filter((_, idx) => idx !== i));
      setAcceptedCandidateIds((prev) => {
        const next = new Set<number>();
        for (const idx of prev) {
          if (idx === i) continue;
          next.add(idx > i ? idx - 1 : idx);
        }
        return next;
      });
    },
    [],
  );

  const handleAcceptAllCandidates = useCallback(() => {
    let accepted = 0;
    candidates.forEach((c, i) => {
      if (acceptedCandidateIds.has(i)) return;
      addSrcLandmark(c.srcVertex, c.srcPosition);
      addTarLandmark(c.tarVertex, c.tarPosition);
      accepted++;
    });
    setAcceptedCandidateIds(new Set(candidates.map((_, i) => i)));
    if (accepted > 0) {
      onStatusChange(`已接受 ${accepted} 对候选 → landmark pairs`, 'success');
    }
  }, [candidates, acceptedCandidateIds, addSrcLandmark, addTarLandmark, onStatusChange]);

  const handleFindGlobalCandidates = useCallback(() => {
    if (srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0) {
      onStatusChange('Source/Target 尚未加载', 'warning');
      return;
    }
    const t0 = performance.now();
    let result = matchGlobalCandidates(
      { vertices: srcMesh.vertices, adjacency: srcAdjacency },
      { vertices: tarMesh.vertices, adjacency: tarAdjacency },
      {
        numSamples: globalSamples,
        rings: globalRings,
        requireMutual: globalRequireMutual,
      },
    );
    const rawCount = result.length;
    let ransacInfo = '';
    if (ransacAutoApply && result.length >= 4) {
      const r = ransacFilterCandidates(result, tarMesh.vertices, {
        iterations: ransacIterations,
        inlierThreshold: bboxDiagonal(tarMesh.vertices) * (ransacThresholdPct / 100),
      });
      if (r.matrix4x4 && r.inliers.length >= 3) {
        result = r.inliers;
        ransacInfo = ` · RANSAC 留下 ${r.inliers.length}/${rawCount} (RMSE=${r.rmse.toFixed(4)})`;
      } else {
        ransacInfo = ` · RANSAC 失败（保留全部 ${rawCount}）`;
      }
    }
    const dt = performance.now() - t0;
    setCandidates(result);
    setAcceptedCandidateIds(new Set());
    const accepted = result.filter((c) => c.suggestAccept).length;
    onStatusChange(
      `全网格匹配：${result.length} 对（${accepted} 推荐接受）${ransacInfo} — ${dt.toFixed(1)}ms`,
      result.length > 0 ? 'success' : 'warning',
    );
  }, [
    srcMesh,
    tarMesh,
    srcAdjacency,
    tarAdjacency,
    globalSamples,
    globalRings,
    globalRequireMutual,
    ransacAutoApply,
    ransacIterations,
    ransacThresholdPct,
    onStatusChange,
  ]);

  const handleRansacRefine = useCallback(() => {
    if (candidates.length < 4) {
      onStatusChange('候选少于 4，RANSAC 无法精修', 'warning');
      return;
    }
    const t0 = performance.now();
    const r = ransacFilterCandidates(candidates, tarMesh.vertices, {
      iterations: ransacIterations,
      inlierThreshold: bboxDiagonal(tarMesh.vertices) * (ransacThresholdPct / 100),
    });
    const dt = performance.now() - t0;
    if (!r.matrix4x4 || r.inliers.length < 3) {
      onStatusChange(
        `RANSAC 失败：未找到一致的 inlier 集合（threshold=${(ransacThresholdPct).toFixed(1)}%）`,
        'error',
      );
      return;
    }
    setCandidates(r.inliers);
    setAcceptedCandidateIds(new Set());
    onStatusChange(
      `RANSAC 精修：保留 ${r.inliers.length}/${candidates.length}（RMSE=${r.rmse.toFixed(4)}） — ${dt.toFixed(1)}ms`,
      'success',
    );
  }, [candidates, tarMesh, ransacIterations, ransacThresholdPct, onStatusChange]);

  const handleFindPartial = useCallback(() => {
    if (srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0) {
      onStatusChange('Source/Target 尚未加载', 'warning');
      return;
    }
    setPartialLoading(true);
    // Defer to next frame so React can render the loading state first
    setTimeout(() => {
    const t0 = performance.now();
    const r = matchPartialToWhole(
      { vertices: srcMesh.vertices, adjacency: srcAdjacency },
      { vertices: tarMesh.vertices, adjacency: tarAdjacency },
      {
        numSrcSamples: partialSrcSamples,
        numTarSamples: partialTarSamples,
        topK: partialTopK,
        iterations: partialIterations,
        inlierThreshold: partialThresholdPct / 100,
        descriptor: partialDescriptor,
        tarSeedCentroid: tarRegion?.centroid,
        tarSeedRadius: tarRegion?.boundingRadius,
        tarSeedWeight: tarRegion ? partialSeedWeight : 0,
        tarConstraintVertices: tarRegion?.vertices,
        axialWeight: partialAxialWeight,
      },
    );
    const dt = performance.now() - t0;
    if (!r.matrix4x4 || r.pairs.length < 3) {
      setCandidates([]);
      setAcceptedCandidateIds(new Set());
      onStatusChange(
        `部分匹配失败：inliers=${r.bestInlierCount}（threshold=${(partialThresholdPct).toFixed(1)}% src bbox）` +
          ` — 试着加大 topK / 迭代数 / threshold`,
        'error',
      );
      setPartialLoading(false);
      return;
    }
    setCandidates(r.pairs);
    setAcceptedCandidateIds(new Set());
    onStatusChange(
      `部分匹配：${r.pairs.length} 对（RMSE=${r.rmse.toFixed(4)} src 单位） — ${dt.toFixed(1)}ms`,
      'success',
    );
    setPartialLoading(false);
    }, 16);
  }, [
    srcMesh,
    tarMesh,
    srcAdjacency,
    tarAdjacency,
    partialSrcSamples,
    partialTarSamples,
    partialTopK,
    partialIterations,
    partialThresholdPct,
    partialDescriptor,
    partialSeedWeight,
    partialAxialWeight,
    tarRegion,
    onStatusChange,
  ]);

  const handleRunPartialDebug = useCallback(() => {
    if (srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0) {
      onStatusChange('Source/Target 尚未加载', 'warning');
      return;
    }
    setPartialLoading(true);
    setTimeout(() => {
    const t0 = performance.now();
    const dbg = computePartialDebug(
      { vertices: srcMesh.vertices, adjacency: srcAdjacency },
      { vertices: tarMesh.vertices, adjacency: tarAdjacency },
      {
        numSrcSamples: partialSrcSamples,
        numTarSamples: partialTarSamples,
        topK: partialTopK,
        descriptor: partialDescriptor,
        tarSeedCentroid: tarRegion?.centroid,
        tarSeedRadius: tarRegion?.boundingRadius,
        tarSeedWeight: tarRegion ? partialSeedWeight : 0,
        tarConstraintVertices: tarRegion?.vertices,
        axialWeight: partialAxialWeight,
      },
    );
    const dt = performance.now() - t0;
    setPartialDebug(dbg);
    onStatusChange(
      `调试快照: 显著池 src=${dbg.srcSaliencyTop.length} tar=${dbg.tarSaliencyTop.length}` +
        ` | FPS src=${dbg.srcFPS.length} tar=${dbg.tarFPS.length}` +
        ` | 平均最佳 top-1 距离=${dbg.avgBestDist.toFixed(4)} — ${dt.toFixed(1)}ms`,
      'info',
    );
    setPartialLoading(false);
    }, 16);
  }, [
    srcMesh,
    tarMesh,
    srcAdjacency,
    tarAdjacency,
    partialSrcSamples,
    partialTarSamples,
    partialTopK,
    partialDescriptor,
    partialSeedWeight,
    partialAxialWeight,
    tarRegion,
    onStatusChange,
  ]);

  const handleClearPartialDebug = useCallback(() => {
    setPartialDebug(null);
  }, []);

  // ── 2D localization handlers ──────────────────────────────────────────

  const loadImageDimensions = (url: string): Promise<{ w: number; h: number }> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });

  const handleLoadRefImage = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const size = await loadImageDimensions(url);
      setRefImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setRefImageName(file.name);
      setRefImageSize(size);
      // Invalidate any stale ortho render — its size may not match.
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      // Auto-extract subject bbox so the renderer can fit the target
      // mesh to the same image-space framing as the reference image.
      try {
        const bbox = await extractImageSubjectBBox(url);
        setRefSubjectBBox(bbox);
        if (bbox) {
          onStatusChange(
            `已加载参考图：${file.name} (${size.w}×${size.h}) · 主体 bbox=${bbox.w}×${bbox.h}@(${bbox.x},${bbox.y}) [${bbox.method}]`,
            'success',
          );
        } else {
          onStatusChange(
            `已加载参考图：${file.name} (${size.w}×${size.h}) · 主体检测失败，将退化为铺满拟合`,
            'warning',
          );
        }
      } catch {
        setRefSubjectBBox(null);
        onStatusChange(
          `已加载参考图：${file.name} (${size.w}×${size.h}) · 主体提取异常`,
          'warning',
        );
      }
    } catch (err) {
      URL.revokeObjectURL(url);
      onStatusChange(
        `参考图加载失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [onStatusChange]);

  const handleLoadMaskImage = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const size = await loadImageDimensions(url);
      if (refImageSize && (size.w !== refImageSize.w || size.h !== refImageSize.h)) {
        URL.revokeObjectURL(url);
        onStatusChange(
          `Mask 尺寸 ${size.w}×${size.h} 与参考图 ${refImageSize.w}×${refImageSize.h} 不一致`,
          'error',
        );
        return;
      }
      setMaskImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setMaskImageName(file.name);
      onStatusChange(`已加载 SAM3 mask：${file.name}`, 'success');
    } catch (err) {
      URL.revokeObjectURL(url);
      onStatusChange(
        `Mask 加载失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [refImageSize, onStatusChange]);

  const handleRenderOrtho = useCallback(() => {
    if (!refImageSize) {
      onStatusChange('请先加载参考图（用于决定渲染尺寸）', 'warning');
      return;
    }
    if (tarMesh.vertices.length === 0 || tarMesh.faces.length === 0) {
      onStatusChange('Target mesh 为空，无法渲染正视图', 'warning');
      return;
    }
    try {
      const useAuto = autoFit && !!fitBBox;
      const { dataUrl, camera } = renderOrthoFrontViewWithCamera(
        tarMesh.vertices,
        tarMesh.faces,
        {
          width: refImageSize.w,
          height: refImageSize.h,
          background: null,
          meshColor: '#dddddd',
          ...(useAuto
            ? { fitToImageBBox: fitBBox! }
            : {
                scale: orthoScale,
                offsetX: orthoOffsetX,
                offsetY: orthoOffsetY,
              }),
        },
      );
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return dataUrl;
      });
      setOrthoCamera(camera);
      // Render geometry/camera changed → previous reprojection is stale.
      setMaskReproj(null);
      if (useAuto) {
        const b = fitBBox!;
        const src = segPack ? `${segPack.regions.length}-region 并集` : '图像主体';
        onStatusChange(
          `已渲染 Target 正视图 ${refImageSize.w}×${refImageSize.h} · 自动拟合到 ${src} ${b.w}×${b.h}@(${b.x},${b.y})`,
          'success',
        );
      } else {
        onStatusChange(
          `已渲染 Target 正交正视图 ${refImageSize.w}×${refImageSize.h}` +
            ` · scale=${orthoScale.toFixed(2)} offset=(${orthoOffsetX.toFixed(2)}, ${orthoOffsetY.toFixed(2)})`,
          'success',
        );
      }
    } catch (err) {
      onStatusChange(
        `渲染失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [refImageSize, tarMesh, autoFit, fitBBox, segPack, orthoScale, orthoOffsetX, orthoOffsetY, onStatusChange]);

  // Reproject the SAM3 mask onto Target mesh vertices using the camera
  // captured from the most recent ortho render. Output: per-region
  // vertex sets that downstream code can use as semantic priors.
  const handleReprojectMask = useCallback(async () => {
    if (!orthoCamera) {
      onStatusChange('请先点 “渲染 Target 正视图” 锁定虚拟相机', 'warning');
      return;
    }
    if (!segPack) {
      onStatusChange('请先加载 segmentation.json', 'warning');
      return;
    }
    if (!maskImageUrl) {
      onStatusChange('请先加载 mask 图（segmentation_mask.png）', 'warning');
      return;
    }
    try {
      const t0 = performance.now();
      const mask = await loadMaskGray(maskImageUrl);
      if (!mask) {
        onStatusChange('mask 解码失败', 'error');
        return;
      }
      const result = reprojectMaskToVertices(
        tarMesh.vertices,
        mask,
        segPack.regions,
        orthoCamera,
        { splatRadiusPx: 1 },
      );
      setMaskReproj(result);
      const stats = Array.from(result.regions.entries())
        .map(([label, set]) => `${label}=${set.size}`)
        .join(', ');
      const dt = performance.now() - t0;
      onStatusChange(
        `反投影完成：${stats} · 未命中像素=${result.unassignedPixels} · ${dt.toFixed(1)}ms`,
        'success',
      );
    } catch (err) {
      onStatusChange(
        `反投影失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [orthoCamera, segPack, maskImageUrl, tarMesh, onStatusChange]);

  // Adopt a reprojected SAM3 region as the partial-match Target seed.
  // Builds a synthetic MeshRegion (centroid + bounding radius) so the
  // existing soft-seed pipeline picks it up without code changes.
  const handleAdoptRegionAsTarSeed = useCallback(
    (label: string) => {
      if (!maskReproj) return;
      const set = maskReproj.regions.get(label);
      if (!set || set.size === 0) {
        onStatusChange(`区域 "${label}" 没有顶点可用作 seed`, 'warning');
        return;
      }
      let cx = 0, cy = 0, cz = 0;
      for (const idx of set) {
        const v = tarMesh.vertices[idx];
        cx += v[0]; cy += v[1]; cz += v[2];
      }
      const inv = 1 / set.size;
      const centroid: Vec3 = [cx * inv, cy * inv, cz * inv];
      let r2max = 0;
      for (const idx of set) {
        const v = tarMesh.vertices[idx];
        const dx = v[0] - centroid[0];
        const dy = v[1] - centroid[1];
        const dz = v[2] - centroid[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2max) r2max = d2;
      }
      const boundingRadius = Math.sqrt(r2max);
      // Synthetic MeshRegion. seedVertex is just any member; vertexLayer
      // is empty because BFS layer info isn't applicable to a reprojected
      // set. Downstream consumers (partial-match) only read centroid +
      // boundingRadius + vertices, so the rest is cosmetic.
      const seedVertex = set.values().next().value as number;
      const region: MeshRegion = {
        seedVertex,
        vertices: new Set(set),
        vertexLayer: new Map(),
        centroid,
        boundingRadius,
        finalSteps: 0,
        stopReason: 'frontier-empty',
      };
      setTarRegion(region);
      onStatusChange(
        `已将 SAM3 区域 "${label}" (${set.size} 顶点) 设为 Target seed · 中心=(${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}, ${centroid[2].toFixed(3)}) · 半径=${boundingRadius.toFixed(3)}`,
        'success',
      );
    },
    [maskReproj, tarMesh, onStatusChange],
  );

  const onRefImageFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await handleLoadRefImage(file);
      e.currentTarget.value = '';
    },
    [handleLoadRefImage],
  );

  const onMaskImageFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await handleLoadMaskImage(file);
      e.currentTarget.value = '';
    },
    [handleLoadMaskImage],
  );

  // segmentation.json sidecar (multi-region SAM3 export). When loaded
  // we adopt its region bboxes as the most reliable framing source and
  // ignore image-based subject extraction.
  const handleLoadSegJson = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const pack = parseSegmentationJson(text);
      setSegPack(pack);
      setSegPackName(file.name);
      const union = regionsUnionBBox(pack.regions);
      onStatusChange(
        `已加载 ${file.name} · ${pack.regions.length} 个区域：${pack.regions.map((r) => r.label).join(', ')}` +
          (union ? ` · 并集 bbox ${union.w}×${union.h}@(${union.x},${union.y})` : ''),
        'success',
      );
    } catch (err) {
      onStatusChange(
        `segmentation.json 解析失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [onStatusChange]);

  const onSegJsonFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await handleLoadSegJson(file);
      e.currentTarget.value = '';
    },
    [handleLoadSegJson],
  );

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    return () => {
      if (refImageUrl) URL.revokeObjectURL(refImageUrl);
      if (maskImageUrl) URL.revokeObjectURL(maskImageUrl);
      if (orthoRenderUrl) URL.revokeObjectURL(orthoRenderUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stale-candidate guard: invalidate suggestions when seed regions change.
  useEffect(() => {
    setCandidates([]);
    setAcceptedCandidateIds(new Set());
  }, [srcRegion, tarRegion]);

  const pairCount = Math.min(srcLandmarks.length, tarLandmarks.length);
  const isBalanced = srcLandmarks.length === tarLandmarks.length && srcLandmarks.length > 0;
  const hasResultPreview = resultPreview !== null;

  const srcHighlightArr = useMemo(
    () => (srcRegion ? Array.from(srcRegion.vertices) : undefined),
    [srcRegion],
  );
  const tarHighlightArr = useMemo(
    () => (tarRegion ? Array.from(tarRegion.vertices) : undefined),
    [tarRegion],
  );

  const srcCandidateArr = useMemo(() => {
    if (candidates.length === 0) return undefined;
    const out: number[] = [];
    candidates.forEach((c, i) => {
      if (acceptedCandidateIds.has(i)) return;
      out.push(c.srcVertex);
    });
    return out.length > 0 ? out : undefined;
  }, [candidates, acceptedCandidateIds]);

  const tarCandidateArr = useMemo(() => {
    if (candidates.length === 0) return undefined;
    const out: number[] = [];
    candidates.forEach((c, i) => {
      if (acceptedCandidateIds.has(i)) return;
      out.push(c.tarVertex);
    });
    return out.length > 0 ? out : undefined;
  }, [candidates, acceptedCandidateIds]);

  // Phase 1 debug visualization layers (saliency + FPS + topK)
  const srcDebugLayers = useMemo(() => {
    if (!partialDebug) return undefined;
    const layers: Array<{ indices: number[]; color: string; size?: number; opacity?: number }> = [];
    if (showSaliency) {
      layers.push({ indices: partialDebug.srcSaliencyTop, color: '#39e87a', size: 4, opacity: 0.5 });
    }
    if (showFPS) {
      layers.push({ indices: partialDebug.srcFPS, color: '#7df0ff', size: 12, opacity: 1 });
    }
    return layers.length > 0 ? layers : undefined;
  }, [partialDebug, showSaliency, showFPS]);

  const tarDebugLayers = useMemo(() => {
    const layers: Array<{ indices: number[]; color: string; size?: number; opacity?: number }> = [];
    // SAM3 reprojection layer (always visible when present, sits below
    // the partial-match debug layers so the user can compare).
    if (maskReproj) {
      // Stable per-label color palette.
      const palette = ['#ff5e6c', '#7bd57f', '#5fb3ff', '#ffd84a', '#c69cff', '#ffa05c'];
      let i = 0;
      for (const [, set] of maskReproj.regions) {
        layers.push({
          indices: Array.from(set),
          color: palette[i % palette.length],
          size: 6,
          opacity: 0.85,
        });
        i++;
      }
    }
    if (partialDebug) {
      if (showSaliency) {
        layers.push({ indices: partialDebug.tarSaliencyTop, color: '#996b3a', size: 4, opacity: 0.5 });
      }
      if (showFPS) {
        layers.push({ indices: partialDebug.tarFPS, color: '#ffb066', size: 10, opacity: 1 });
      }
      if (showTopK) {
        const set = new Set<number>();
        for (const m of partialDebug.topKMatches) {
          for (const t of m.matches) set.add(t.tarVertex);
        }
        layers.push({ indices: Array.from(set), color: '#ff66ff', size: 14, opacity: 1 });
      }
    }
    return layers.length > 0 ? layers : undefined;
  }, [maskReproj, partialDebug, showSaliency, showFPS, showTopK]);

  const resetPreview = useCallback(() => {
    if (alignResult) setAlignResult(null);
    if (resultPreview) setResultPreview(null);
    if (centerViewMode === 'result') setCenterViewMode('landmark');
  }, [alignResult, centerViewMode, resultPreview]);

  const refreshHighresGallery = useCallback(async () => {
    if (!project) {
      setHighresHistory([]);
      setSelectedGalleryFile(null);
      setSelectedGalleryPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    setGalleryLoading(true);
    try {
      const history = await listHistory('page2.highres');
      setHighresHistory(history);

      if (history.length === 0) {
        setSelectedGalleryFile(null);
        setSelectedGalleryPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        return;
      }

      const nextFile = selectedGalleryFile && history.some((v) => v.file === selectedGalleryFile)
        ? selectedGalleryFile
        : history[0].file;

      setSelectedGalleryFile(nextFile);
      const preview = await loadByName('page2.highres', nextFile);
      setSelectedGalleryPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return preview?.url ?? null;
      });
    } catch {
      setHighresHistory([]);
      setSelectedGalleryFile(null);
      setSelectedGalleryPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    } finally {
      setGalleryLoading(false);
    }
  }, [listHistory, loadByName, project, selectedGalleryFile]);

  useEffect(() => {
    void refreshHighresGallery();
  }, [refreshHighresGallery]);

  useEffect(() => {
    return () => {
      if (selectedGalleryPreviewUrl) URL.revokeObjectURL(selectedGalleryPreviewUrl);
    };
  }, [selectedGalleryPreviewUrl]);

  const handleSelectGalleryItem = useCallback(async (fileName: string) => {
    setSelectedGalleryFile(fileName);
    const preview = await loadByName('page2.highres', fileName);
    setSelectedGalleryPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return preview?.url ?? null;
    });
  }, [loadByName]);

  const handleOpenGalleryToSource = useCallback(async (fileName: string) => {
    let loadedUrlToRevoke: string | null = null;
    try {
      onStatusChange(`正在从 Mesh Gallery 打开：${fileName}`, 'info');
      const loaded = await loadByName('page2.highres', fileName);
      if (!loaded) {
        onStatusChange('加载失败：未找到该 highres 模型版本', 'error');
        return;
      }
      loadedUrlToRevoke = loaded.url;

      const mesh = await loadGlbAsMesh(loaded.url);
      setSrcMesh({
        name: fileName,
        vertices: mesh.vertices,
        faces: mesh.faces,
      });
      setSelectedSrcIndex(null);
      setSrcRegion(null);
      clearAllLandmarks();
      resetPreview();
      onStatusChange(`已将 ${fileName} 加载到 Source`, 'success');
    } catch (err) {
      onStatusChange(`打开失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      if (loadedUrlToRevoke) URL.revokeObjectURL(loadedUrlToRevoke);
    }
  }, [clearAllLandmarks, loadByName, onStatusChange, resetPreview]);

  const selectSourceLandmark = (index: number) => {
    setSelectedSrcIndex(index);
    setSelectedTarIndex(null);
  };

  const selectTargetLandmark = (index: number) => {
    setSelectedTarIndex(index);
    setSelectedSrcIndex(null);
  };

  const loadMeshFromFile = async (file: File, side: 'source' | 'target') => {
    const url = URL.createObjectURL(file);
    try {
      onStatusChange(`正在加载 ${side === 'source' ? 'Source' : 'Target'} GLB：${file.name}`, 'info');
      const loaded = await loadGlbAsMesh(url);
      const mesh: MeshData = {
        name: file.name,
        vertices: loaded.vertices,
        faces: loaded.faces,
      };
      if (side === 'source') {
        setSrcMesh(mesh);
        setSelectedSrcIndex(null);
        setSrcRegion(null);
      } else {
        setTarMesh(mesh);
        setSelectedTarIndex(null);
        setTarRegion(null);
        // Camera & reprojection are bound to the previous mesh — drop them.
        setOrthoCamera(null);
        setMaskReproj(null);
      }
      clearAllLandmarks();
      resetPreview();
      onStatusChange(`${side === 'source' ? 'Source' : 'Target'} 已加载，landmark 已清空`, 'success');
    } catch (err) {
      onStatusChange(`加载失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const onSrcFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadMeshFromFile(file, 'source');
    e.currentTarget.value = '';
  };

  const onTarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadMeshFromFile(file, 'target');
    e.currentTarget.value = '';
  };

  const handleSrcClick = (
    idx: number,
    pos: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => {
    if (!modifiers.ctrlKey) return;
    const nextIndex = (srcLandmarks[srcLandmarks.length - 1]?.index ?? 0) + 1;
    addSrcLandmark(idx, pos);
    selectSourceLandmark(nextIndex);
    resetPreview();
    onStatusChange(`Source Landmark #${nextIndex} 已添加 (Ctrl+Click)`, 'info');
  };

  const handleTarClick = (
    idx: number,
    pos: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => {
    if (!modifiers.ctrlKey) return;
    const nextIndex = (tarLandmarks[tarLandmarks.length - 1]?.index ?? 0) + 1;
    addTarLandmark(idx, pos);
    selectTargetLandmark(nextIndex);
    resetPreview();
    onStatusChange(`Target Landmark #${nextIndex} 已添加 (Ctrl+Click)`, 'info');
  };

  const handleDeleteSrcLandmark = (index: number) => {
    removeSrcLandmark(index);
    if (selectedSrcIndex === index) setSelectedSrcIndex(null);
    resetPreview();
    onStatusChange(`已删除 Source Landmark #${index}`, 'warning');
  };

  const handleDeleteTarLandmark = (index: number) => {
    removeTarLandmark(index);
    if (selectedTarIndex === index) setSelectedTarIndex(null);
    resetPreview();
    onStatusChange(`已删除 Target Landmark #${index}`, 'warning');
  };

  const handleMoveSrcLandmark = (index: number, position: Vec3) => {
    updateSrcLandmark(index, position, -1);
    selectSourceLandmark(index);
    resetPreview();
  };

  const handleMoveTarLandmark = (index: number, position: Vec3) => {
    updateTarLandmark(index, position, -1);
    selectTargetLandmark(index);
    resetPreview();
  };

  const handleRunAlign = () => {
    if (!isBalanced) {
      onStatusChange('Source/Target landmark 数量不一致，无法对齐', 'error');
      return;
    }
    if (pairCount < 3) {
      onStatusChange('至少需要 3 对 landmark 才能执行刚体/相似对齐', 'error');
      return;
    }

    setAligning(true);
    try {
      const result = alignSourceMeshByLandmarks(
        srcMesh.vertices,
        srcLandmarks.map((p) => p.position),
        tarLandmarks.map((p) => p.position),
        alignmentMode,
      );
      setAlignResult(result);
      setResultPreview({
        mode: result.mode,
        originalVertices: srcMesh.vertices,
        alignedVertices: result.transformedVertices,
        alignedSrcLandmarks: result.alignedSrcLandmarks,
        targetLandmarks: result.targetLandmarks,
        faces: srcMesh.faces,
        rmse: result.rmse,
        meanError: result.meanError,
        maxError: result.maxError,
        scale: result.scale,
      });
      setCenterViewMode('result');
      setResultViewMode('overlay');
      onStatusChange(
        `${alignmentMode === 'rigid' ? 'Rigid' : 'Similarity'} 对齐完成，RMSE=${result.rmse.toFixed(4)}`,
        'success',
      );
    } catch (err) {
      onStatusChange(`对齐失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      setAligning(false);
    }
  };

  // Auto pipeline: partial-match → SVD landmark fit → ICP refine.
  // One button does everything; result lands in resultPreview so the
  // "重叠预览" button lights up immediately.
  const handleAutoAlign = useCallback(() => {
    if (srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0) {
      onStatusChange('Source/Target 尚未加载', 'warning');
      return;
    }
    setPartialLoading(true);
    setAligning(true);
    setTimeout(() => {
      try {
        const t0 = performance.now();

        // 1. Partial match
        const pm = matchPartialToWhole(
          { vertices: srcMesh.vertices, adjacency: srcAdjacency },
          { vertices: tarMesh.vertices, adjacency: tarAdjacency },
          {
            numSrcSamples: partialSrcSamples,
            numTarSamples: partialTarSamples,
            topK: partialTopK,
            iterations: partialIterations,
            inlierThreshold: partialThresholdPct / 100,
            descriptor: partialDescriptor,
            tarSeedCentroid: tarRegion?.centroid,
            tarSeedRadius: tarRegion?.boundingRadius,
            tarSeedWeight: tarRegion ? partialSeedWeight : 0,
            tarConstraintVertices: tarRegion?.vertices,
            axialWeight: partialAxialWeight,
          },
        );
        if (!pm.matrix4x4 || pm.pairs.length < 3) {
          onStatusChange(
            `自动对齐：partial-match 失败 (inliers=${pm.bestInlierCount})`,
            'error',
          );
          setPartialLoading(false);
          setAligning(false);
          return;
        }

        // 2. SVD landmark fit on accepted pairs (similarity).
        const lmFit = alignSourceMeshByLandmarks(
          srcMesh.vertices,
          pm.pairs.map((p) => p.srcPosition),
          pm.pairs.map((p) => p.tarPosition),
          'similarity',
        );

        // 3. ICP refine starting from the SVD initial transform.
        const icp = icpRefine(srcMesh.vertices, tarMesh.vertices, lmFit.matrix4x4);

        // Pick the best of {SVD-only, ICP-best}. ICP can occasionally
        // diverge on tricky overlaps; this comparison guards that.
        const useIcp = icp.rmse < lmFit.rmse;
        const finalMatrix = useIcp ? icp.matrix4x4 : lmFit.matrix4x4;
        const finalRmse = useIcp ? icp.rmse : lmFit.rmse;

        const transformedVertices = srcMesh.vertices.map((v) =>
          applyTransform(v, finalMatrix),
        );
        const alignedSrcLandmarks = pm.pairs.map((p) =>
          applyTransform(p.srcPosition, finalMatrix),
        );
        const targetLandmarks = pm.pairs.map((p) => p.tarPosition);

        const errs: number[] = [];
        for (let i = 0; i < pm.pairs.length; i++) {
          const a = alignedSrcLandmarks[i];
          const b = targetLandmarks[i];
          const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
          errs.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const meanError = errs.reduce((s, v) => s + v, 0) / errs.length;
        const maxError = Math.max(...errs);
        const sx = Math.sqrt(
          finalMatrix[0][0] ** 2 + finalMatrix[1][0] ** 2 + finalMatrix[2][0] ** 2,
        );

        setCandidates(pm.pairs);
        setAcceptedCandidateIds(new Set(pm.pairs.map((_, i) => i)));
        setAlignResult({
          mode: 'similarity',
          matrix4x4: finalMatrix,
          transformedVertices,
          alignedSrcLandmarks,
          targetLandmarks,
          rmse: finalRmse,
          meanError,
          maxError,
          scale: sx,
        });
        setResultPreview({
          mode: 'similarity',
          originalVertices: srcMesh.vertices,
          alignedVertices: transformedVertices,
          alignedSrcLandmarks,
          targetLandmarks,
          faces: srcMesh.faces,
          rmse: finalRmse,
          meanError,
          maxError,
          scale: sx,
        });
        setCenterViewMode('result');
        setResultViewMode('overlay');

        const dt = performance.now() - t0;
        const icpSummary = useIcp
          ? `ICP 收敛于 ${icp.iterations.length} 轮 (${icp.stopReason}, best#${icp.bestIteration + 1})`
          : `ICP 未改善 (lmFit RMSE=${lmFit.rmse.toFixed(4)} ≤ ICP=${icp.rmse.toFixed(4)})`;
        onStatusChange(
          `自动对齐完成 · partial=${pm.pairs.length} 对 · ${icpSummary} · 最终 RMSE=${finalRmse.toFixed(4)} · ${dt.toFixed(0)}ms`,
          'success',
        );
      } catch (err) {
        onStatusChange(
          `自动对齐失败：${err instanceof Error ? err.message : '未知错误'}`,
          'error',
        );
      } finally {
        setPartialLoading(false);
        setAligning(false);
      }
    }, 16);
  }, [
    srcMesh,
    tarMesh,
    srcAdjacency,
    tarAdjacency,
    partialSrcSamples,
    partialTarSamples,
    partialTopK,
    partialIterations,
    partialThresholdPct,
    partialDescriptor,
    partialSeedWeight,
    partialAxialWeight,
    tarRegion,
    onStatusChange,
  ]);

  const handleApplyAlignedTransform = () => {
    if (!alignResult) return;
    
    const newVertices = srcMesh.vertices.map((v) => applyTransform(v, alignResult.matrix4x4));
    setSrcMesh((prev) => ({
      ...prev,
      vertices: newVertices,
    }));
    
    // 手动变换每一个 landmark
    srcLandmarks.forEach((landmark) => {
      const newPos = applyTransform(landmark.position, alignResult.matrix4x4);
      updateSrcLandmark(landmark.index, newPos);
    });
    
    setAlignResult(null);
    setSelectedSrcIndex(null);
    setCenterViewMode('landmark');
    onStatusChange('已将对齐结果应用到 Source 模型与 Source landmarks', 'success');
  };

  const restoreDemo = useCallback(async () => {
    const srcUrl = '/demo/alignmenttest_arm_hires.glb';
    const tarUrl = '/demo/alignmenttest_bot.glb';
    try {
      onStatusChange('正在加载 Demo: alignmenttest_arm_hires (源 + 形变)…', 'info');
      const [srcLoaded, tarLoaded] = await Promise.all([
        loadGlbAsMesh(srcUrl),
        loadGlbAsMesh(tarUrl),
      ]);
      setSrcMesh({
        name: 'alignmenttest_arm_hires.glb',
        vertices: srcLoaded.vertices,
        faces: srcLoaded.faces,
      });
      setTarMesh({
        name: 'alignmenttest_arm_hires_Deformed.glb',
        vertices: tarLoaded.vertices,
        faces: tarLoaded.faces,
      });
      clearAllLandmarks();
      setAlignResult(null);
      setResultPreview(null);
      setSelectedSrcIndex(null);
      setSelectedTarIndex(null);
      setSrcRegion(null);
      setTarRegion(null);
      setCandidates([]);
      setAcceptedCandidateIds(new Set());
      setCenterViewMode('landmark');
      onStatusChange(
        `Demo 已加载：Src V/F=${srcLoaded.vertices.length}/${srcLoaded.faces.length}, ` +
          `Tar V/F=${tarLoaded.vertices.length}/${tarLoaded.faces.length}`,
        'success',
      );
    } catch (err) {
      // Fallback: tiny inline demo so the page is still usable
      setSrcMesh(DEMO_SOURCE);
      setTarMesh(demoTarget);
      clearAllLandmarks();
      setAlignResult(null);
      setResultPreview(null);
      setSelectedSrcIndex(null);
      setSelectedTarIndex(null);
      setSrcRegion(null);
      setTarRegion(null);
      setCandidates([]);
      setAcceptedCandidateIds(new Set());
      onStatusChange(
        `Demo GLB 加载失败（${err instanceof Error ? err.message : '未知错误'}），已回退到内置盒子 Demo`,
        'warning',
      );
    }
  }, [clearAllLandmarks, demoTarget, onStatusChange]);

  // 页面挂载时自动加载 Demo (arm hires)，作为初始模型
  const initialDemoLoadedRef = useRef(false);
  useEffect(() => {
    if (initialDemoLoadedRef.current) return;
    initialDemoLoadedRef.current = true;
    void restoreDemo();
    // 仅首次挂载执行，避免 restoreDemo 引用变化导致重复加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debugLabelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'var(--text-muted)',
    marginBottom: 6,
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '230px 1fr 320px',
        overflow: 'hidden',
        background: 'var(--bg-app)',
      }}
    >
      <aside
        style={{
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          padding: 10,
          gap: 10,
        }}
      >
        <PanelSection title="模型输入">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Button size="sm" onClick={() => srcInputRef.current?.click()}>导入 Source GLB</Button>
            <Button size="sm" onClick={() => tarInputRef.current?.click()}>导入 Target GLB</Button>
            <Button
              size="sm"
              onClick={() => {
                void restoreDemo();
              }}
              title="加载 alignmenttest_arm_hires.glb (源手臂) + alignmenttest_bot.glb (整身角色)"
            >
              加载 Demo (arm hires)
            </Button>
          </div>
          <input ref={srcInputRef} type="file" accept=".glb" style={{ display: 'none' }} onChange={onSrcFileChange} />
          <input ref={tarInputRef} type="file" accept=".glb" style={{ display: 'none' }} onChange={onTarFileChange} />
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Source: {srcMesh.name}
            <br />
            V/F: {srcMesh.vertices.length} / {srcMesh.faces.length}
            <br />
            Target: {tarMesh.name}
            <br />
            V/F: {tarMesh.vertices.length} / {tarMesh.faces.length}
          </div>
        </PanelSection>

        <PanelSection title="2D 定位 (SAM3 验证)">
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            用一张参考图（概念图 / Bot.png）+ SAM3 mask，对照 Target 的正交正视渲染图，
            肉眼判断标准虚拟相机是否对齐。三层叠加：参考图 / mask / 正视渲染。
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Button size="sm" onClick={() => refImageInputRef.current?.click()}>
              加载参考图
            </Button>
            <Button
              size="sm"
              onClick={() => maskImageInputRef.current?.click()}
              disabled={!refImageUrl}
              title={refImageUrl ? '加载 SAM3 mask（需与参考图同分辨率）' : '请先加载参考图'}
            >
              加载 Mask
            </Button>
            <Button
              size="sm"
              onClick={() => segJsonInputRef.current?.click()}
              title="加载 SAM3 多区域 segmentation.json（提供最可靠的拟合 bbox）"
            >
              加载 segmentation.json
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleRenderOrtho}
              disabled={!refImageSize || tarMesh.vertices.length === 0}
              title={
                !refImageSize
                  ? '请先加载参考图以确定渲染尺寸'
                  : '按参考图分辨率渲染 Target 的正交正视图'
              }
            >
              渲染 Target 正视图
            </Button>
            <Button
              size="sm"
              onClick={() => setShowOrthoCompare(true)}
              disabled={!refImageUrl && !maskImageUrl && !orthoRenderUrl}
            >
              三图叠加对照
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => { void handleReprojectMask(); }}
              disabled={!orthoCamera || !segPack || !maskImageUrl}
              title={
                !orthoCamera
                  ? '请先点 “渲染 Target 正视图” 锁定相机'
                  : !segPack
                    ? '请先加载 segmentation.json'
                    : !maskImageUrl
                      ? '请先加载 mask 图'
                      : '把 mask 各区域反投影到 Target 顶点'
              }
            >
              反投影 mask 到 Target 顶点
            </Button>
            {maskReproj && (
              <Button
                size="sm"
                onClick={() => setMaskReproj(null)}
                title="清除 Target 视口里的反投影高亮"
              >
                清除反投影高亮
              </Button>
            )}
          </div>

          {maskReproj && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                background: 'var(--bg-app)',
                fontSize: 11,
                color: 'var(--text-secondary)',
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
                反投影结果
              </div>
              {Array.from(maskReproj.regions.entries()).map(([label, set], i) => {
                const palette = ['#ff5e6c', '#7bd57f', '#5fb3ff', '#ffd84a', '#c69cff', '#ffa05c'];
                const color = palette[i % palette.length];
                const hits = maskReproj.perRegionPixelHits.get(label) ?? 0;
                const isCurrentSeed =
                  tarRegion !== null && tarRegion.vertices.size === set.size && set.size > 0 &&
                  // cheap identity check: first vertex matches
                  tarRegion.vertices.has(set.values().next().value as number);
                return (
                  <div
                    key={label}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      <span style={{ color }}>●</span> {label}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {set.size} 顶点 / {hits} 像素
                    </span>
                    <button
                      onClick={() => handleAdoptRegionAsTarSeed(label)}
                      title="把该区域作为 partial-match 的 Target 软 seed"
                      disabled={set.size === 0}
                      style={{
                        background: isCurrentSeed ? 'var(--accent-blue)' : 'transparent',
                        border: `1px solid ${isCurrentSeed ? 'var(--accent-blue)' : 'var(--border-default)'}`,
                        color: isCurrentSeed ? '#fff' : 'var(--text-secondary)',
                        padding: '0 6px',
                        cursor: set.size === 0 ? 'not-allowed' : 'pointer',
                        borderRadius: 2,
                        fontSize: 10,
                        height: 18,
                      }}
                    >
                      {isCurrentSeed ? '✓ seed' : '设为 seed'}
                    </button>
                  </div>
                );
              })}
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  color: 'var(--text-muted)',
                }}
              >
                未命中像素：{maskReproj.unassignedPixels}
              </div>
            </div>
          )}

          <div style={{ display: 'none' }}>
            {/* anchor to keep below blocks aligned */}
          </div>

          <div
            style={{
              marginTop: 10,
              padding: 8,
              border: '1px solid var(--border-default)',
              borderRadius: 3,
              background: 'var(--bg-app)',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: 'var(--text-secondary)',
                marginBottom: 6,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoFit}
                onChange={(e) => setAutoFit(e.target.checked)}
              />
              自动拟合参考图主体（推荐）
            </label>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
              {segPack && fitBBox
                ? `使用 segmentation.json 区域并集：${fitBBox.w}×${fitBBox.h}@(${fitBBox.x},${fitBBox.y}) · ${segPack.regions.length} 区域`
                : refSubjectBBox
                  ? `已检测主体 bbox：${refSubjectBBox.w}×${refSubjectBBox.h}@(${refSubjectBBox.x},${refSubjectBBox.y}) [${refSubjectBBox.method}]`
                  : refImageUrl
                    ? '未检测到清晰主体，将退化为铺满拟合或手动模式'
                    : '加载参考图后会自动提取主体 bbox'}
            </div>

            <div
              style={{
                fontSize: 11,
                color: 'var(--text-secondary)',
                marginTop: 4,
                marginBottom: 6,
                opacity: autoFit ? 0.4 : 1,
              }}
            >
              手动微调（autoFit 关闭时生效）
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              缩放 (scale)
            </div>
            <input
              type="range"
              min={0.4}
              max={1.5}
              step={0.01}
              value={orthoScale}
              onChange={(e) => setOrthoScale(Number(e.target.value))}
              disabled={autoFit}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              {orthoScale.toFixed(2)}× {orthoScale < 1 ? '(渲染会变小)' : orthoScale > 1 ? '(渲染会变大)' : ''}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>水平偏移 X</div>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.005}
              value={orthoOffsetX}
              onChange={(e) => setOrthoOffsetX(Number(e.target.value))}
              disabled={autoFit}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              {orthoOffsetX.toFixed(3)}（正值=右移）
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>垂直偏移 Y</div>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.005}
              value={orthoOffsetY}
              onChange={(e) => setOrthoOffsetY(Number(e.target.value))}
              disabled={autoFit}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              {orthoOffsetY.toFixed(3)}（正值=上移）
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                onClick={() => {
                  setOrthoScale(1);
                  setOrthoOffsetX(0);
                  setOrthoOffsetY(0);
                }}
                disabled={autoFit}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                重置
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={handleRenderOrtho}
                disabled={!refImageSize || tarMesh.vertices.length === 0}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                重新渲染
              </Button>
            </div>
          </div>

          <input
            ref={refImageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onRefImageFileChange}
          />
          <input
            ref={maskImageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onMaskImageFileChange}
          />
          <input
            ref={segJsonInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onSegJsonFileChange}
          />

          <div
            style={{
              marginTop: 10,
              padding: 6,
              background: 'var(--bg-app)',
              border: '1px solid var(--border-default)',
              borderRadius: 3,
              fontSize: 10,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
            }}
          >
            参考图: {refImageName ?? '(未加载)'}
            {refImageSize && (
              <> · {refImageSize.w}×{refImageSize.h}</>
            )}
            <br />
            Mask: {maskImageName ?? '(未加载)'}
            <br />
            JSON: {segPackName ?? '(未加载)'}
            {segPack && (
              <> · {segPack.regions.length} 区域：{segPack.regions.map((r) => r.label).join(', ')}</>
            )}
            <br />
            正视渲染: {orthoRenderUrl ? '已就绪' : '(未渲染)'}
          </div>

          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            约定：相机沿 +X 看向 -X，up=+Y，画面右映射到世界 -Z（角色左侧）。
          </div>
        </PanelSection>

        <PanelSection title="Mesh Gallery (Page2 Highres)" defaultCollapsed>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                void refreshHighresGallery();
              }}
              loading={galleryLoading}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              刷新列表
            </Button>
          </div>

          {!project && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              未打开工程，无法读取 Page2 的 highres 输出。
            </div>
          )}

          {project && highresHistory.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              暂无 highres 模型历史。
            </div>
          )}

          {project && selectedGalleryPreviewUrl && (
            <div style={{ marginBottom: 8 }}>
              <GLBThumbnail url={selectedGalleryPreviewUrl} height={110} autoRotateSpeed={0.35} />
            </div>
          )}

          {project && highresHistory.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 190, overflow: 'auto' }}>
              {highresHistory.map((v) => {
                const selected = selectedGalleryFile === v.file;
                return (
                  <button
                    key={v.file}
                    onClick={() => {
                      void handleSelectGalleryItem(v.file);
                    }}
                    onDoubleClick={() => {
                      void handleOpenGalleryToSource(v.file);
                    }}
                    title="单击预览，双击加载到 Source"
                    style={{
                      textAlign: 'left',
                      background: selected ? 'var(--bg-elevated)' : 'var(--bg-app)',
                      border: selected ? '1px solid var(--accent-blue)' : '1px solid var(--border-default)',
                      borderRadius: 3,
                      padding: '6px 8px',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {v.file}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {new Date(v.timestamp).toLocaleString()}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            双击任意条目可直接替换 Source 模型。
          </div>
        </PanelSection>

        <PanelSection title="对齐模式" defaultCollapsed>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant={alignmentMode === 'similarity' ? 'primary' : 'secondary'}
              onClick={() => setAlignmentMode('similarity')}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              Similarity
            </Button>
            <Button
              size="sm"
              variant={alignmentMode === 'rigid' ? 'primary' : 'secondary'}
              onClick={() => setAlignmentMode('rigid')}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              Rigid
            </Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {alignmentMode === 'similarity'
              ? 'Similarity: 旋转 + 平移 + 统一缩放'
              : 'Rigid: 仅旋转 + 平移'}
          </div>
        </PanelSection>

        <PanelSection title="部分匹配 (Partial → Whole)">
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            适用于 Source 是部件、Target 是包含该部件的整体（如：手臂 → 完整角色）。
            <br />
            <span style={{ color: tarRegion ? '#7fd97f' : '#e08a8a', fontWeight: 600 }}>
              {tarRegion
                ? `✓ Target seed 中心已设置（半径=${tarRegion.boundingRadius.toFixed(3)}），软约束权重=${partialSeedWeight.toFixed(1)}`
                : '⚠ 建议先在 Target 上 Seed 一个大概位置（手臂附近），作为软约束提示'}
            </span>
          </div>

          {tarRegion && (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Seed 软约束权重（0=禁用，越大越偏向 seed）
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={0.5}
                value={partialSeedWeight}
                onChange={(e) => setPartialSeedWeight(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
                {partialSeedWeight.toFixed(1)}
              </div>
            </>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            主轴 (axial) 特征权重（圆柱形部件必备，0=关闭）
          </div>
          <input
            type="range"
            min={0}
            max={15}
            step={0.5}
            value={partialAxialWeight}
            onChange={(e) => setPartialAxialWeight(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialAxialWeight.toFixed(1)} {partialAxialWeight === 0 ? '(关闭)' : ''}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Src 采样数（部件，少而精）
          </div>
          <input
            type="range"
            min={10}
            max={80}
            step={2}
            value={partialSrcSamples}
            onChange={(e) => setPartialSrcSamples(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialSrcSamples}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Tar 采样数（整体，要密）
          </div>
          <input
            type="range"
            min={50}
            max={500}
            step={10}
            value={partialTarSamples}
            onChange={(e) => setPartialTarSamples(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialTarSamples}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            每个 src 保留候选数 (top-K)
          </div>
          <input
            type="range"
            min={1}
            max={15}
            step={1}
            value={partialTopK}
            onChange={(e) => setPartialTopK(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialTopK}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            inlier 阈值（% of <b>src</b> bbox 对角线）
          </div>
          <input
            type="range"
            min={1}
            max={20}
            step={0.5}
            value={partialThresholdPct}
            onChange={(e) => setPartialThresholdPct(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialThresholdPct.toFixed(1)}%
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            RANSAC 迭代数（大些更稳）
          </div>
          <input
            type="range"
            min={100}
            max={3000}
            step={100}
            value={partialIterations}
            onChange={(e) => setPartialIterations(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialIterations}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>描述子</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <Button
              size="sm"
              variant={partialDescriptor === 'fpfh' ? 'primary' : 'secondary'}
              onClick={() => setPartialDescriptor('fpfh')}
              style={{ flex: 1, justifyContent: 'center' }}
              title="33-dim 方向直方图，区分度最高，稍慢"
            >
              FPFH
            </Button>
            <Button
              size="sm"
              variant={partialDescriptor === 'curvature' ? 'primary' : 'secondary'}
              onClick={() => setPartialDescriptor('curvature')}
              style={{ flex: 1, justifyContent: 'center' }}
              title="12-dim 尺度感知曲率，快"
            >
              曲率
            </Button>
          </div>

          <Button
            size="sm"
            variant="primary"
            onClick={handleAutoAlign}
            loading={partialLoading || aligning}
            disabled={partialLoading || aligning}
            style={{ width: '100%', justifyContent: 'center', marginBottom: 6 }}
            title="一键：partial-match → SVD 对齐 → ICP refine。结果直接进入“重叠预览”。"
          >
            {(partialLoading || aligning) ? '计算中…' : '一键自动对齐 (partial + ICP)'}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={handleFindPartial}
            loading={partialLoading}
            disabled={partialLoading}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {partialLoading ? '计算中…' : '部分匹配查找'}
          </Button>
          <Button
            size="sm"
            onClick={handleRunPartialDebug}
            loading={partialLoading}
            disabled={partialLoading}
            style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
            title="只跑前几步（saliency + FPS + top-K），不跑 RANSAC，方便看选点情况"
          >
            {partialLoading ? '计算中…' : '调试快照（看选点）'}
          </Button>
        </PanelSection>

        {partialDebug && (
          <PanelSection title="调试可视化">
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
              暗色 = saliency 池；亮色 = FPS 采样；品红 = top-K 候选集合（target 端）。
              <br />
              <span style={{ color: '#39e87a' }}>● Src Saliency</span>{' '}
              <span style={{ color: '#7df0ff' }}>● Src FPS</span>{' '}
              <span style={{ color: '#ffb066' }}>● Tar FPS</span>{' '}
              <span style={{ color: '#ff66ff' }}>● Top-K</span>
            </div>

            <label style={debugLabelStyle}>
              <input
                type="checkbox"
                checked={showSaliency}
                onChange={(e) => setShowSaliency(e.target.checked)}
              />
              显示 Saliency 池（{partialDebug.srcSaliencyTop.length} / {partialDebug.tarSaliencyTop.length}）
            </label>
            <label style={debugLabelStyle}>
              <input
                type="checkbox"
                checked={showFPS}
                onChange={(e) => setShowFPS(e.target.checked)}
              />
              显示 FPS 采样（{partialDebug.srcFPS.length} / {partialDebug.tarFPS.length}）
            </label>
            <label style={debugLabelStyle}>
              <input
                type="checkbox"
                checked={showTopK}
                onChange={(e) => setShowTopK(e.target.checked)}
              />
              显示 Top-K 候选合集
            </label>

            <div
              style={{
                marginTop: 8,
                padding: 6,
                background: 'var(--bg-app)',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                fontSize: 10,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              平均最佳 top-1 距离：{partialDebug.avgBestDist.toFixed(4)}
            </div>

            <Button
              size="sm"
              onClick={handleClearPartialDebug}
              style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
            >
              清除调试可视化
            </Button>
          </PanelSection>
        )}

        <PanelSection title="候选匹配 (Phase 2)">
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
            partial-match 找到的 source ↔ target 顶点对都会出现在这里，
            可以单独审阅、接受或拒绝；接受后会写入 Landmark Pairs。
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              onClick={clearCandidates}
              disabled={candidates.length === 0}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              清空候选
            </Button>
            {candidates.length > 0 && (
              <Button
                size="sm"
                variant="primary"
                onClick={handleAcceptAllCandidates}
                disabled={acceptedCandidateIds.size === candidates.length}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                全部接受 ({candidates.length - acceptedCandidateIds.size})
              </Button>
            )}
          </div>

          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {candidates.length === 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                运行 “一键自动对齐” 或 “部分匹配查找” 后，候选对会出现在这里。
              </div>
            )}
            {candidates.map((c, i) => {
              const accepted = acceptedCandidateIds.has(i);
              const conf = c.confidence;
              const confColor = conf >= 0.7 ? '#7fd97f' : conf >= 0.5 ? '#e9d36c' : '#e08a8a';
              return (
                <div
                  key={`${c.srcVertex}-${c.tarVertex}-${i}`}
                  style={{
                    border: '1px solid var(--border-default)',
                    borderRadius: 3,
                    padding: '4px 6px',
                    background: accepted ? 'var(--bg-elevated)' : 'var(--bg-app)',
                    fontSize: 10,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span style={{ width: 14, color: 'var(--text-muted)' }}>#{i + 1}</span>
                  <span style={{ color: confColor, fontWeight: 600, width: 32 }}>
                    {(conf * 100).toFixed(0)}%
                  </span>
                  <span style={{ flex: 1, color: 'var(--text-muted)' }}>
                    {c.srcVertex}↔{c.tarVertex}
                  </span>
                  {accepted ? (
                    <span style={{ color: 'var(--accent-green, #7fd97f)' }}>✓</span>
                  ) : (
                    <>
                      <button
                        onClick={() => handleAcceptCandidate(i)}
                        title="接受为 landmark pair"
                        style={{
                          background: 'transparent',
                          border: '1px solid var(--border-default)',
                          color: '#7fd97f',
                          padding: '0 6px',
                          cursor: 'pointer',
                          borderRadius: 2,
                        }}
                      >
                        ✓
                      </button>
                      <button
                        onClick={() => handleRejectCandidate(i)}
                        title="拒绝该候选"
                        style={{
                          background: 'transparent',
                          border: '1px solid var(--border-default)',
                          color: '#e08a8a',
                          padding: '0 6px',
                          cursor: 'pointer',
                          borderRadius: 2,
                        }}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </PanelSection>

        <PanelSection title="全网格查找 (Global)" defaultCollapsed>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            适用于 Source 与 Target 形态相近、但拓扑/transform 不同的情况。
            从整个网格上挑显著点 → 空间 FPS 散开 → 多尺度曲率配对。
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            采样数 (numSamples)
          </div>
          <input
            type="range"
            min={10}
            max={200}
            step={5}
            value={globalSamples}
            onChange={(e) => setGlobalSamples(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {globalSamples}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            描述子尺度 (rings)
          </div>
          <input
            type="range"
            min={1}
            max={6}
            step={1}
            value={globalRings}
            onChange={(e) => setGlobalRings(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {globalRings} 圈
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 6,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={globalRequireMutual}
              onChange={(e) => setGlobalRequireMutual(e.target.checked)}
            />
            互最近邻过滤（更稳，更少）
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 6,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={ransacAutoApply}
              onChange={(e) => setRansacAutoApply(e.target.checked)}
            />
            自动 RANSAC 几何一致性过滤（强烈推荐）
          </label>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            RANSAC 阈値（% of bbox 对角线）
          </div>
          <input
            type="range"
            min={1}
            max={20}
            step={0.5}
            value={ransacThresholdPct}
            onChange={(e) => setRansacThresholdPct(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {ransacThresholdPct.toFixed(1)}%
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            RANSAC 迭代数
          </div>
          <input
            type="range"
            min={50}
            max={2000}
            step={50}
            value={ransacIterations}
            onChange={(e) => setRansacIterations(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {ransacIterations}
          </div>

          <Button
            size="sm"
            variant="primary"
            onClick={handleFindGlobalCandidates}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            全网格查找候选
          </Button>
          <Button
            size="sm"
            onClick={handleRansacRefine}
            disabled={candidates.length < 4}
            style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
            title="用 RANSAC 在当前候选集合中筛出几何一致的子集"
          >
            RANSAC 精修当前候选
          </Button>
        </PanelSection>
      </aside>

      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          <Button
            size="sm"
            variant={centerViewMode === 'landmark' ? 'primary' : 'secondary'}
            onClick={() => setCenterViewMode('landmark')}
          >
            对点视图
          </Button>
          <Button
            size="sm"
            variant={centerViewMode === 'result' ? 'primary' : 'secondary'}
            onClick={() => hasResultPreview && setCenterViewMode('result')}
            disabled={!hasResultPreview}
            title="显示对齐后的重叠预览"
          >
            重叠预览
          </Button>
          <Button size="sm" variant={viewMode === 'solid' ? 'primary' : 'secondary'} onClick={() => setViewMode('solid')}>实体</Button>
          <Button size="sm" variant={viewMode === 'wireframe' ? 'primary' : 'secondary'} onClick={() => setViewMode('wireframe')}>线框</Button>
          <Button size="sm" variant={viewMode === 'solid+wireframe' ? 'primary' : 'secondary'} onClick={() => setViewMode('solid+wireframe')}>实体+线框</Button>
          <span style={{ flex: 1 }} />
          <span>Pairs: {pairCount}</span>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {centerViewMode === 'landmark' && (
            <DualViewport
              srcVertices={srcMesh.vertices}
              srcFaces={srcMesh.faces}
              tarVertices={tarMesh.vertices}
              tarFaces={tarMesh.faces}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              srcLandmarks={srcLandmarks}
              tarLandmarks={tarLandmarks}
              onSrcClick={handleSrcClick}
              onTarClick={handleTarClick}
              selectedSrcLandmarkIndex={selectedSrcIndex}
              selectedTarLandmarkIndex={selectedTarIndex}
              onSelectSrcLandmark={selectSourceLandmark}
              onSelectTarLandmark={selectTargetLandmark}
              onDeleteSrcLandmark={handleDeleteSrcLandmark}
              onDeleteTarLandmark={handleDeleteTarLandmark}
              onMoveSrcLandmark={handleMoveSrcLandmark}
              onMoveTarLandmark={handleMoveTarLandmark}
              height="100%"
              landmarkScreenFraction={landmarkSize}
              srcUpdatedVertices={alignResult?.transformedVertices}
              srcLabel="Source"
              tarLabel="Target"
              showCameraSync
              srcHighlightVertices={srcHighlightArr}
              tarHighlightVertices={tarHighlightArr}
              srcHighlightColor="#7df0ff"
              tarHighlightColor="#ffb066"
              srcCandidateVertices={srcCandidateArr}
              tarCandidateVertices={tarCandidateArr}
              srcCandidateColor="#ffffff"
              tarCandidateColor="#fffacd"
              srcPointLayers={srcDebugLayers}
              tarPointLayers={tarDebugLayers}
            />
          )}
          {centerViewMode === 'result' && resultPreview && (
            <ResultPreviewPanel
              resultViewMode={resultViewMode}
              onResultViewModeChange={setResultViewMode}
              resultPreview={resultPreview}
              targetMesh={tarMesh}
            />
          )}
        </div>
      </main>

      <aside
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}
      >
        <PanelSection title="Landmark 显示">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
            <span style={{ whiteSpace: 'nowrap' }}>大小</span>
            <input
              type="range"
              min={0.002}
              max={0.05}
              step={0.001}
              value={landmarkSize}
              onChange={(e) => setLandmarkSize(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ width: 36, textAlign: 'right' }}>{landmarkSize.toFixed(3)}</span>
          </div>
        </PanelSection>

        <PanelSection title="Landmark Pairs">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Source 与 Target 按添加顺序一一配对。按住 Ctrl 在对应网格上左键点击可新增。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <LandmarkList
              title={`Source (${srcLandmarks.length})`}
              items={srcLandmarks}
              color="var(--state-busy)"
              selectedIndex={selectedSrcIndex}
              onSelect={selectSourceLandmark}
              onRemove={handleDeleteSrcLandmark}
            />
            <LandmarkList
              title={`Target (${tarLandmarks.length})`}
              items={tarLandmarks}
              color="var(--accent-blue)"
              selectedIndex={selectedTarIndex}
              onSelect={selectTargetLandmark}
              onRemove={handleDeleteTarLandmark}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                clearSrcLandmarks();
                setSelectedSrcIndex(null);
                resetPreview();
                onStatusChange('已清空 Source landmarks', 'warning');
              }}
              style={{ justifyContent: 'center' }}
            >
              清空 Source
            </Button>
            <Button
              size="sm"
              onClick={() => {
                clearTarLandmarks();
                setSelectedTarIndex(null);
                resetPreview();
                onStatusChange('已清空 Target landmarks', 'warning');
              }}
              style={{ justifyContent: 'center' }}
            >
              清空 Target
            </Button>
          </div>
        </PanelSection>

        <PanelSection title="Align Tools">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            模式: {alignmentMode === 'similarity' ? 'Similarity' : 'Rigid'}
            <br />
            规则: 3 对以上 landmarks，按顺序配对
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <Button
              variant="primary"
              size="sm"
              loading={aligning}
              onClick={handleRunAlign}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              执行对齐
            </Button>
            <Button
              size="sm"
              onClick={handleApplyAlignedTransform}
              disabled={!alignResult}
              style={{ flex: 1, justifyContent: 'center' }}
              title="将当前对齐结果真正写回 Source 网格与 Source landmarks"
            >
              应用变换
            </Button>
          </div>

          {alignResult && (
            <div
              style={{
                marginTop: 10,
                padding: 8,
                borderRadius: 3,
                border: '1px solid var(--state-complete)',
                background: 'var(--bg-app)',
                fontSize: 11,
                color: 'var(--text-primary)',
                lineHeight: 1.6,
              }}
            >
              <div style={{ color: 'var(--accent-green)' }}>
                ✓ {alignResult.mode === 'rigid' ? 'Rigid' : 'Similarity'} Alignment Ready
              </div>
              <div>RMSE: {alignResult.rmse.toFixed(5)}</div>
              <div>Mean: {alignResult.meanError.toFixed(5)}</div>
              <div>Max: {alignResult.maxError.toFixed(5)}</div>
              {alignResult.mode === 'similarity' && <div>Scale: {alignResult.scale.toFixed(5)}</div>}
            </div>
          )}
        </PanelSection>

        {resultPreview && (
          <PanelSection title="Result View">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>              <Button
                size="sm"
                variant={resultViewMode === 'overlay' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('overlay');
                }}
                style={{ justifyContent: 'center' }}
              >
                Overlay
              </Button>
              <Button
                size="sm"
                variant={resultViewMode === 'aligned' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('aligned');
                }}
                style={{ justifyContent: 'center' }}
              >
                Aligned
              </Button>
              <Button
                size="sm"
                variant={resultViewMode === 'target' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('target');
                }}
                style={{ justifyContent: 'center' }}
              >
                Target
              </Button>
              <Button
                size="sm"
                variant={resultViewMode === 'original' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('original');
                }}
                style={{ justifyContent: 'center' }}
              >
                Original
              </Button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Overlay 会把对齐后的 Source 与 Target 放进同一个坐标系和同一个 grid 里，适合检查复杂模型是否真的重合。
            </div>
          </PanelSection>
        )}
      </aside>

      {showOrthoCompare && refImageSize && (
        <OrthoCompareModal
          width={refImageSize.w}
          height={refImageSize.h}
          title="2D 定位对照"
          highlightBBox={fitBBox ?? refSubjectBBox ?? null}
          onClose={() => setShowOrthoCompare(false)}
          layers={[
            ...(refImageUrl
              ? [{ url: refImageUrl, label: '参考图', defaultOpacity: 1 }]
              : []),
            ...(orthoRenderUrl
              ? [{ url: orthoRenderUrl, label: 'Target 正视渲染', defaultOpacity: 0.6 }]
              : []),
            ...(maskImageUrl
              ? [
                  {
                    url: maskImageUrl,
                    label: 'SAM3 Mask（红色）',
                    defaultOpacity: 0.5,
                    tintColor: '#ff3355',
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}

function ResultPreviewPanel({
  resultViewMode,
  onResultViewModeChange,
  resultPreview,
  targetMesh,
}: {
  resultViewMode: ResultViewMode;
  onResultViewModeChange: (mode: ResultViewMode) => void;
  resultPreview: ResultPreview;
  targetMesh: MeshData;
}) {
  // Convert Vec3[] to LandmarkPoint[] for display
  const srcLandmarkPoints = resultPreview.alignedSrcLandmarks.map((pos, i) => ({
    index: i + 1,
    vertexIdx: -1,
    position: pos,
  }));

  const tarLandmarkPoints = resultPreview.targetLandmarks.map((pos, i) => ({
    index: i + 1,
    vertexIdx: -1,
    position: pos,
  }));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
          Alignment Result
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={resultViewMode === 'overlay' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('overlay')}>Overlay</Button>
          <Button size="sm" variant={resultViewMode === 'aligned' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('aligned')}>Aligned</Button>
          <Button size="sm" variant={resultViewMode === 'target' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('target')}>Target</Button>
          <Button size="sm" variant={resultViewMode === 'original' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('original')}>Original</Button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {resultViewMode === 'overlay' && (
          <MeshViewer
            role="result"
            vertices={resultPreview.alignedVertices}
            faces={resultPreview.faces}
            color="#4a90d9"
            viewMode="solid"
            height="100%"
            label="Overlay: Aligned Source (蓝色点) + Target (橙色点)"
            landmarks={srcLandmarkPoints}
            landmarkColor="#ff6b6b"
            overlayVertices={targetMesh.vertices}
            overlayFaces={targetMesh.faces}
            overlayColor="#d9734a"
            overlayLandmarks={tarLandmarkPoints}
            showViewModeToggle={false}
          />
        )}
        {resultViewMode === 'aligned' && (
          <MeshViewer
            role="result"
            vertices={resultPreview.alignedVertices}
            faces={resultPreview.faces}
            color="#4a90d9"
            viewMode="solid"
            height="100%"
            label="Aligned Source (with src landmarks)"
            landmarks={srcLandmarkPoints}
            landmarkColor="#ff6b6b"
            showViewModeToggle={false}
          />
        )}
        {resultViewMode === 'target' && (
          <MeshViewer
            role="target"
            vertices={targetMesh.vertices}
            faces={targetMesh.faces}
            color="#d9734a"
            viewMode="solid"
            height="100%"
            label="Target (with tar landmarks)"
            landmarks={tarLandmarkPoints}
            landmarkColor="#a0d995"
            showViewModeToggle={false}
          />
        )}
        {resultViewMode === 'original' && (
          <MeshViewer
            role="source"
            vertices={resultPreview.originalVertices}
            faces={resultPreview.faces}
            color="#4a90d9"
            viewMode="solid"
            height="100%"
            label="Original Source"
            showViewModeToggle={false}
          />
        )}
      </div>
    </div>
  );
}

function PanelSection({
  title,
  children,
  defaultCollapsed = false,
}: {
  title: string;
  children: React.ReactNode;
  /** When true the section starts collapsed; click the header to toggle. */
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div style={{ borderBottom: '1px solid var(--border-default)', padding: 10 }}>
      <div
        onClick={() => setCollapsed((v) => !v)}
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: collapsed ? 0 : 8,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 8 }}>
          {collapsed ? '▶' : '▼'}
        </span>
        {title}
      </div>
      {!collapsed && children}
    </div>
  );
}

function LandmarkList({
  title,
  items,
  color,
  selectedIndex,
  onSelect,
  onRemove,
}: {
  title: string;
  items: { index: number }[];
  color: string;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 4 }}>{title}</div>
      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 3,
          background: 'var(--bg-app)',
          maxHeight: 220,
          overflow: 'auto',
        }}
      >
        {items.length === 0 && (
          <div style={{ padding: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>—</div>
        )}
        {items.map((p) => (
          <div
            key={p.index}
            onClick={() => onSelect(p.index)}
            style={{
              display: 'flex',
              alignItems: 'center',
              borderBottom: '1px solid var(--border-subtle)',
              padding: '4px 6px',
              fontSize: 11,
              cursor: 'pointer',
              background: selectedIndex === p.index ? 'var(--bg-surface-2)' : 'transparent',
              boxShadow: selectedIndex === p.index ? `inset 2px 0 0 ${color}` : 'none',
            }}
          >
            <span style={{ flex: 1, color: selectedIndex === p.index ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              #{p.index}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.index);
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: 2,
              }}
              title="删除"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
