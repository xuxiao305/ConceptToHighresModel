import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { OrthoCompareModal } from '../../components/OrthoCompareModal';
import { useProject } from '../../contexts/ProjectContext';
import {
  parseSegmentationJson,
  regionsUnionBBox,
  type SegmentationPack,
} from '../../services/segmentationPack';
import { parseGarmentsSegFormer } from '../../services/garmentParsing';
import {
  DualViewport,
  MeshViewer,
  useLandmarkStore,
  loadGlbAsMesh,
  loadGlb,
  buildMeshAdjacency,
  matchGlobalCandidates,
  ransacFilterCandidates,
  matchPartialToWhole,
  matchLimbStructureToWhole,
  detectJacketStructure,
  splitGarmentByBBox,
  matchStructureGraphs,
  computePartialDebug,
  bboxDiagonal,
  renderOrthoFrontViewWithCamera,
  renderTexturedFrontSnapshot,
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
  type PartialMatchTimingReport,
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
import type { AssetVersion, PersistedPipeline } from '../../services/projectStore';

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
type TargetRegionSelectionMode = 'auto' | 'manual';
type PartialMatchMode = 'surface' | 'limb-structure' | 'jacket-structure';

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

interface AutoAlignSummary {
  mode: PartialMatchMode;
  regionLabel: string | null;
  pairs: number;
  rmse: number;
  scale: number;
  method: 'SVD' | 'ICP';
  elapsedMs: number;
}

interface PartialMatchSummary {
  mode: PartialMatchMode;
  status: 'success' | 'failed';
  pairs: number;
  bestInlierCount: number;
  rawSrcSamples: number;
  rawTarSamples: number;
  topK: number;
  iterationsRun: number;
  thresholdUsed: number;
  rmse: number;
  elapsedMs: number;
  timings?: PartialMatchTimingReport;
  diagnostics?: Record<string, unknown>;
  warnings?: string[];
}

interface AlignTraceEntry {
  time: string;
  stage: string;
  data: Record<string, unknown>;
}

type ManualAlignmentPairSource = 'landmarks' | 'accepted-candidates' | 'partial-candidates';

interface ManualAlignmentPairs {
  source: ManualAlignmentPairSource;
  sourcePoints: Vec3[];
  targetPoints: Vec3[];
  count: number;
}

interface HighresGalleryItem extends AssetVersion {
  id: string;
  pipelineKey: string;
  pipelineIndex: number;
  pipelineName: string;
  pipelineMode: PersistedPipeline['mode'];
}

interface SourceGalleryBinding {
  pipelineKey: string;
  pipelineIndex: number;
  pipelineName: string;
  pipelineMode: PersistedPipeline['mode'];
  file: string;
}

interface GallerySnapshot {
  status: 'loading' | 'ready' | 'error';
  dataUrl?: string;
}

const TRACE_LIMIT = 200;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function roundVec(v: Vec3 | undefined): Vec3 | null {
  return v ? [round3(v[0]), round3(v[1]), round3(v[2])] : null;
}

function summarizePartialTimings(timings?: PartialMatchTimingReport) {
  if (!timings) return undefined;
  return {
    totalMs: round3(timings.totalMs),
    saliencyMs: round3(timings.saliencyMs),
    samplingMs: round3(timings.samplingMs),
    axialFrameMs: round3(timings.axialFrameMs),
    descriptorBuildMs: round3(timings.descriptorBuildMs),
    spatialHashMs: round3(timings.spatialHashMs),
    fpfhSpfhMs: round3(timings.fpfhSpfhMs),
    topKMs: round3(timings.topKMs),
    ransacMs: round3(timings.ransacMs),
    refitAndFinalizeMs: round3(timings.refitAndFinalizeMs),
    axialTrials: timings.axialTrials.map((trial) => ({
      flipTarAxial: trial.flipTarAxial,
      flipTarAxis2: trial.flipTarAxis2,
      flipTarAxis3: trial.flipTarAxis3,
      totalMs: round3(trial.totalMs),
      descriptorBuildMs: round3(trial.descriptorBuildMs),
      spatialHashMs: round3(trial.spatialHashMs),
      fpfhSpfhMs: round3(trial.fpfhSpfhMs),
      topKMs: round3(trial.topKMs),
      ransacMs: round3(trial.ransacMs),
      refitAndFinalizeMs: round3(trial.refitAndFinalizeMs),
      bestInlierCount: trial.bestInlierCount,
      pairs: trial.pairs,
    })),
    fpfhEvents: timings.fpfhEvents.map((event) => ({
      label: event.label,
      scaleIndex: event.scaleIndex,
      radius: round3(event.radius),
      seedCount: event.seedCount,
      vertexCount: event.vertexCount,
      subdivisions: event.subdivisions,
      spatialHashMs: round3(event.spatialHashMs),
      fpfhSpfhMs: round3(event.fpfhSpfhMs),
    })),
  };
}

function summarizeCamera(camera: OrthoFrontCamera | null): Record<string, unknown> | null {
  if (!camera) return null;
  return {
    width: camera.width,
    height: camera.height,
    camY: round3(camera.camY),
    camZ: round3(camera.camZ),
    worldPerPx: round3(camera.worldPerPx),
    meshFrontX: round3(camera.meshFrontX),
  };
}

function summarizeRegion(region: MeshRegion | null): Record<string, unknown> | null {
  if (!region) return null;
  return {
    seedVertex: region.seedVertex,
    vertices: region.vertices.size,
    centroid: roundVec(region.centroid),
    boundingRadius: round3(region.boundingRadius),
  };
}

function summarizeMaskReprojection(result: MaskReprojectionResult | null): Record<string, unknown> | null {
  if (!result) return null;
  return {
    regions: Array.from(result.regions.entries()).map(([label, set]) => ({
      label,
      vertices: set.size,
      pixelHits: result.perRegionPixelHits.get(label) ?? 0,
    })),
    unassignedPixels: result.unassignedPixels,
  };
}

function summarizePairs(pairs: LandmarkCandidate[], max = 12): Array<Record<string, unknown>> {
  return pairs.slice(0, max).map((p, i) => ({
    i: i + 1,
    srcVertex: p.srcVertex,
    tarVertex: p.tarVertex,
    confidence: round3(p.confidence),
    descriptorDist: round3(p.descriptorDist),
  }));
}

function regionSignature(region: MeshRegion | null, label: string | null = null): string {
  if (!region) return 'none';
  let checksum = 0;
  for (const idx of region.vertices) {
    checksum = (checksum + ((idx + 1) * 2654435761)) >>> 0;
  }
  return [
    label ?? '',
    region.vertices.size,
    region.seedVertex,
    checksum,
    round3(region.centroid[0]),
    round3(region.centroid[1]),
    round3(region.centroid[2]),
    round3(region.boundingRadius),
  ].join(':');
}

function summarizeMatrix(m: number[][]): number[][] {
  return m.map((row) => row.map(round3));
}

function qualityLabel(summary: AutoAlignSummary): { label: string; color: string } {
  if (summary.rmse < 1.0 && summary.pairs >= 20) return { label: '良好', color: '#7fd97f' };
  if (summary.rmse < 1.8 && summary.pairs >= 15) return { label: '可用', color: '#e9d36c' };
  return { label: '需要检查', color: '#e08a8a' };
}

const ALIGNMENT_MODE: AlignmentMode = 'similarity';
const PARTIAL_SAMPLE_POOL_MODE = 'robust' as const;
const PARTIAL_RADIUS_FRACTIONS = [0.08, 0.16, 0.32];

function matrixSimilarityScale(matrix4x4: number[][]): number {
  const sx = Math.sqrt(matrix4x4[0][0] ** 2 + matrix4x4[1][0] ** 2 + matrix4x4[2][0] ** 2);
  const sy = Math.sqrt(matrix4x4[0][1] ** 2 + matrix4x4[1][1] ** 2 + matrix4x4[2][1] ** 2);
  const sz = Math.sqrt(matrix4x4[0][2] ** 2 + matrix4x4[1][2] ** 2 + matrix4x4[2][2] ** 2);
  return (sx + sy + sz) / 3;
}

function buildAlignmentResultFromMatrix(
  srcMesh: MeshData,
  srcLandmarks: Vec3[],
  tarLandmarks: Vec3[],
  matrix4x4: number[][],
): AlignmentResult {
  const transformedVertices = srcMesh.vertices.map((v) => applyTransform(v, matrix4x4));
  const alignedSrcLandmarks = srcLandmarks.map((v) => applyTransform(v, matrix4x4));
  const errors = alignedSrcLandmarks.map((a, i) => {
    const b = tarLandmarks[i];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  });
  const meanError = errors.length > 0 ? errors.reduce((s, v) => s + v, 0) / errors.length : 0;
  const rmse = errors.length > 0 ? Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length) : 0;
  const maxError = errors.length > 0 ? Math.max(...errors) : 0;

  return {
    mode: ALIGNMENT_MODE,
    matrix4x4,
    transformedVertices,
    alignedSrcLandmarks,
    targetLandmarks: tarLandmarks,
    rmse,
    meanError,
    maxError,
    scale: matrixSimilarityScale(matrix4x4),
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()?.toLowerCase() ?? path.toLowerCase();
}

function recommendRegionLabel(sourceName: string, labels: string[]): string | null {
  if (labels.length === 0) return null;
  const normalized = sourceName.toLowerCase().replace(/[\s_-]+/g, '');
  const findLabel = (needles: string[]) =>
    labels.find((label) => needles.some((needle) => label.toLowerCase().replace(/[\s_-]+/g, '').includes(needle))) ?? null;

  const hasArm = normalized.includes('arm') || normalized.includes('rarm') || normalized.includes('larm');
  const hasRight = normalized.includes('right') || normalized.includes('rarm') || normalized.includes('armhires');
  const hasLeft = normalized.includes('left') || normalized.includes('larm');
  if (hasArm && hasLeft) return findLabel(['leftarm']) ?? findLabel(['arm']);
  if (hasArm && hasRight) return findLabel(['rightarm']) ?? findLabel(['arm']);
  if (hasArm) return findLabel(['rightarm']) ?? findLabel(['leftarm']) ?? findLabel(['arm']);
  if (normalized.includes('body') || normalized.includes('torso') || normalized.includes('jacket') || normalized.includes('coat')) {
    return findLabel(['body', 'torso', 'jacket', 'coat']);
  }
  return labels[0] ?? null;
}

function normalizedLabel(label: string): string {
  return label.toLowerCase().replace(/[\s_-]+/g, '');
}

function findMaskRegion(
  regions: Map<string, Set<number>> | undefined,
  needles: string[],
): Set<number> | undefined {
  if (!regions) return undefined;
  const normalizedNeedles = needles.map(normalizedLabel);
  for (const [label, vertices] of regions) {
    const normalized = normalizedLabel(label);
    if (normalizedNeedles.some((needle) => normalized.includes(needle))) return vertices;
  }
  return undefined;
}

function diagnosticNumber(diagnostics: Record<string, unknown> | undefined, key: string): number | null {
  const value = diagnostics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnosticString(diagnostics: Record<string, unknown> | undefined, key: string): string | null {
  const value = diagnostics?.[key];
  return typeof value === 'string' ? value : null;
}

function buildPartialWarnings(
  mode: PartialMatchMode,
  diagnostics: Record<string, unknown> | undefined,
  tarRegion: MeshRegion | null,
  targetVertexCount: number,
): string[] {
  if (mode !== 'limb-structure' && mode !== 'jacket-structure') return [];
  const warnings: string[] = [];
  if (mode === 'jacket-structure') {
    if (diagnostics?.matchedCount !== undefined && (diagnostics.matchedCount as number) < 4) {
      warnings.push('外套结构图匹配锚点不足（< 4），对齐可能不稳定。');
    }
    if (diagnostics?.warning) {
      warnings.push(diagnostics.warning as string);
    }
    return warnings;
  }
  if (!tarRegion) {
    warnings.push('结构模式建议先用 mask / seed 限定目标肢体区域，否则 root/end 可能取到身体整体端点。');
  } else if (targetVertexCount > 0) {
    const ratio = tarRegion.vertices.size / targetVertexCount;
    if (ratio > 0.45) warnings.push('目标区域占整模比例偏大，可能不是单独肢体区域。');
    if (ratio < 0.002) warnings.push('目标区域顶点很少，结构锚点可能不稳定。');
  }
  const srcBendStrength = diagnosticNumber(diagnostics, 'srcBendStrength');
  const tarBendStrength = diagnosticNumber(diagnostics, 'tarBendStrength');
  if (srcBendStrength !== null && srcBendStrength < 0.025) warnings.push('Source 弯折强度较低：肘/膝方向可能不明显。');
  if (tarBendStrength !== null && tarBendStrength < 0.025) warnings.push('Target 弯折强度较低：肘/膝方向可能不明显。');
  if (diagnosticString(diagnostics, 'targetRootBy') === 'target-centroid') {
    warnings.push('未找到 Body/Torso 区域，root 判断退化为 target centroid。');
  }
  return warnings;
}

function chooseRegionLabel(sourceName: string, labels: string[], previous = ''): string {
  if (labels.length === 0) return '';
  if (previous && labels.includes(previous)) return previous;
  return recommendRegionLabel(sourceName, labels) ?? labels[0];
}

function dataUrlFromBase64Png(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

function chooseGarmentRegionLabel(labels: string[]): string {
  const normalized = labels.map((label) => ({ label, key: normalizedLabel(label) }));
  const preferred = ['upperclothes', 'coat', 'jacket', 'dress', 'skirt', 'pants', 'scarf'];
  for (const key of preferred) {
    const hit = normalized.find((entry) => entry.key.includes(key));
    if (hit) return hit.label;
  }
  return labels[0] ?? '';
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

function makeRandomAlignSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function allIndices(n: number, limit?: number): number[] {
  const end = limit != null ? Math.min(limit, n) : n;
  const arr = new Array<number>(end);
  for (let i = 0; i < end; i++) arr[i] = i;
  return arr;
}

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
  const { project, listHistory, loadByName, loadLatest, loadPipelines } = useProject();
  const demoTarget = useMemo(() => makeDemoTarget(DEMO_SOURCE), []);

  const [srcMesh, setSrcMesh] = useState<MeshData>(DEMO_SOURCE);
  const [tarMesh, setTarMesh] = useState<MeshData>(demoTarget);
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const [landmarkSize, setLandmarkSize] = useState(0.01);
  const [aligning, setAligning] = useState(false);
  const [alignResult, setAlignResult] = useState<AlignmentResult | null>(null);
  const [centerViewMode, setCenterViewMode] = useState<CenterViewMode>('landmark');
  const [resultViewMode, setResultViewMode] = useState<ResultViewMode>('overlay');
  const [resultPreview, setResultPreview] = useState<ResultPreview | null>(null);
  const [selectedSrcIndex, setSelectedSrcIndex] = useState<number | null>(null);
  const [selectedTarIndex, setSelectedTarIndex] = useState<number | null>(null);
  const [highresHistory, setHighresHistory] = useState<HighresGalleryItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [selectedGalleryId, setSelectedGalleryId] = useState<string | null>(null);
  const [gallerySnapshots, setGallerySnapshots] = useState<Record<string, GallerySnapshot>>({});
  const [sourceGalleryBinding, setSourceGalleryBinding] = useState<SourceGalleryBinding | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoAlignSummary, setAutoAlignSummary] = useState<AutoAlignSummary | null>(null);
  const [partialMatchSummary, setPartialMatchSummary] = useState<PartialMatchSummary | null>(null);
  const [alignmentTrace, setAlignmentTrace] = useState<AlignTraceEntry[]>([]);

  const appendAlignmentTrace = useCallback((stage: string, data: Record<string, unknown> = {}) => {
    const entry: AlignTraceEntry = {
      time: new Date().toISOString().slice(11, 23),
      stage,
      data,
    };
    console.info('[Page3Align]', stage, data);
    setAlignmentTrace((prev) => {
      const next = [...prev, entry].slice(-TRACE_LIMIT);
      (window as unknown as { __PAGE3_ALIGN_TRACE__?: AlignTraceEntry[] }).__PAGE3_ALIGN_TRACE__ = next;
      return next;
    });
  }, []);

  const clearAlignmentTrace = useCallback(() => {
    setAlignmentTrace([]);
    (window as unknown as { __PAGE3_ALIGN_TRACE__?: AlignTraceEntry[] }).__PAGE3_ALIGN_TRACE__ = [];
  }, []);

  // ── Phase 1 region-grow state ─────────────────────────────────────────
  // NOTE: the manual seed-mode UI was removed in favour of SAM3 mask
  // reprojection. `tarRegion` is still set programmatically by the
  // "设为 seed" button on a SAM3 region; partial-match reads it for
  // hard constraint + soft seed. `srcRegion` is currently unused but
  // kept for future symmetry (source-side SAM3 region).
  const [srcRegion, setSrcRegion] = useState<MeshRegion | null>(null);
  const [tarRegion, setTarRegion] = useState<MeshRegion | null>(null);
  const [tarRegionLabel, setTarRegionLabel] = useState<string | null>(null);

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
  const [partialSrcSamples, setPartialSrcSamples] = useState(25);
  const [partialTarSamples, setPartialTarSamples] = useState(80);
  const [partialTopK, setPartialTopK] = useState(8);
  const [partialThresholdPct, setPartialThresholdPct] = useState(5);
  const [partialIterations, setPartialIterations] = useState(600);
  const [partialDescriptor, setPartialDescriptor] = useState<'curvature' | 'fpfh'>('fpfh');
  const [partialMatchMode, setPartialMatchMode] = useState<PartialMatchMode>('surface');
  const [partialSeedWeight, setPartialSeedWeight] = useState(5.0);
  // PCA axial+radial feature weight. Critical for cylindrical parts
  // like arms / legs where pure FPFH collapses to a single feature.
  const [partialAxialWeight, setPartialAxialWeight] = useState(5.0);
  const [partialMacroSaliencyRings, setPartialMacroSaliencyRings] = useState(6);
  const [partialLoading, setPartialLoading] = useState(false);

  // ── ICP manual/refine parameters ─────────────────────────────────────
  const [icpMaxIterations, setIcpMaxIterations] = useState(30);
  const [icpSampleCount, setIcpSampleCount] = useState(400);
  const [icpRejectMultiplier, setIcpRejectMultiplier] = useState(2.5);
  const [icpConvergenceImprovement, setIcpConvergenceImprovement] = useState(0.005);

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
  const [selectedTargetRegionLabel, setSelectedTargetRegionLabel] = useState<string>('');
  const [targetRegionSelectionMode, setTargetRegionSelectionMode] = useState<TargetRegionSelectionMode>('auto');
  const [segformerParsing, setSegformerParsing] = useState(false);
  const [segformerClasses, setSegformerClasses] = useState<Array<{ id: number; label: string; pixels: number }>>([]);
  const [orthoRenderUrl, setOrthoRenderUrl] = useState<string | null>(null);
  // Camera that was actually used for the most recent render. Required
  // for mask reprojection so the projection used to interpret a mask
  // matches the one used to render it.
  const [orthoCamera, setOrthoCamera] = useState<OrthoFrontCamera | null>(null);
  const [maskReproj, setMaskReproj] = useState<MaskReprojectionResult | null>(null);
  const [autoLocalizing, setAutoLocalizing] = useState(false);
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
  const segPackDirInputRef = useRef<HTMLInputElement | null>(null);

  // The bbox actually used for fitting: JSON union > image auto-extract.
  const fitBBox = useMemo(() => {
    if (segPack) return regionsUnionBBox(segPack.regions);
    return refSubjectBBox
      ? { x: refSubjectBBox.x, y: refSubjectBBox.y, w: refSubjectBBox.w, h: refSubjectBBox.h }
      : null;
  }, [segPack, refSubjectBBox]);

  const regionLabels = useMemo(() => segPack?.regions.map((r) => r.label) ?? [], [segPack]);
  const recommendedRegionLabel = useMemo(
    () => recommendRegionLabel(srcMesh.name, regionLabels),
    [srcMesh.name, regionLabels],
  );
  const activeTargetRegionLabel = useMemo(() => {
    if (regionLabels.length === 0) return '';
    if (
      targetRegionSelectionMode === 'manual' &&
      selectedTargetRegionLabel &&
      regionLabels.includes(selectedTargetRegionLabel)
    ) {
      return selectedTargetRegionLabel;
    }
    return recommendedRegionLabel ?? regionLabels[0];
  }, [recommendedRegionLabel, regionLabels, selectedTargetRegionLabel, targetRegionSelectionMode]);

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
  const activeSeedSignatureRef = useRef<string>('none|none');

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

  const srcRegionSignature = useMemo(() => regionSignature(srcRegion), [srcRegion]);
  const tarRegionSignature = useMemo(
    () => regionSignature(tarRegion, tarRegionLabel),
    [tarRegion, tarRegionLabel],
  );
  const activeSeedSignature = `${srcRegionSignature}|${tarRegionSignature}`;

  useEffect(() => {
    activeSeedSignatureRef.current = activeSeedSignature;
  }, [activeSeedSignature]);

  const clearCandidates = useCallback(() => {
    setCandidates([]);
    setAcceptedCandidateIds(new Set());
    setPartialMatchSummary(null);
  }, []);

  const handleSetPartialMatchMode = useCallback((mode: PartialMatchMode) => {
    setPartialMatchMode(mode);
    setPartialMatchSummary(null);
    setPartialDebug(null);
    setAcceptedCandidateIds(new Set());
    onStatusChange(
      mode === 'limb-structure'
        ? 'Step 1 已切换到实验模式：肢体大结构（root / bend / end 三锚点）'
        : mode === 'jacket-structure'
          ? 'Step 1 已切换到实验模式：外套结构（collar / shoulder / cuff / hem 锚点图）'
          : 'Step 1 已切换到旧模式：表面 RANSAC（FPFH/曲率 + RANSAC）',
      'info',
    );
  }, [onStatusChange]);

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
    const runSeedSignature = activeSeedSignatureRef.current;
    setPartialMatchSummary(null);
    setPartialLoading(true);
    // Defer to next frame so React can render the loading state first
    setTimeout(() => {
    const t0 = performance.now();
    const runSeed = makeRandomAlignSeed();
    appendAlignmentTrace('manual-partial-start', {
      source: { name: srcMesh.name, vertices: srcMesh.vertices.length, faces: srcMesh.faces.length },
      target: { name: tarMesh.name, vertices: tarMesh.vertices.length, faces: tarMesh.faces.length },
      params: {
        mode: partialMatchMode,
        numSrcSamples: partialSrcSamples,
        numTarSamples: partialTarSamples,
        topK: partialTopK,
        iterations: partialIterations,
        inlierThreshold: partialThresholdPct / 100,
        descriptor: partialDescriptor,
        samplePoolMode: PARTIAL_SAMPLE_POOL_MODE,
        radiusFractions: PARTIAL_RADIUS_FRACTIONS,
        macroSaliencyRings: partialMacroSaliencyRings,
        tarSeedWeight: tarRegion ? partialSeedWeight : 0,
        axialWeight: partialAxialWeight,
        seed: runSeed,
      },
      targetRegion: summarizeRegion(tarRegion),
    });
    const tarBodyVertices = findMaskRegion(maskReproj?.regions, ['body', 'torso']);
    const r = partialMatchMode === 'limb-structure'
      ? matchLimbStructureToWhole(
          { vertices: srcMesh.vertices },
          { vertices: tarMesh.vertices },
          {
            tarConstraintVertices: tarRegion?.vertices,
            tarBodyVertices,
            mode: ALIGNMENT_MODE,
          },
        )
      : partialMatchMode === 'jacket-structure'
        ? (() => {
            const srcGarment = new Set(allIndices(srcMesh.vertices.length));
            const tarGarment = tarRegion?.vertices ?? new Set(allIndices(tarMesh.vertices.length));
            const srcSplit = splitGarmentByBBox(srcMesh.vertices, srcGarment);
            const tarSplit = splitGarmentByBBox(tarMesh.vertices, tarGarment);
            const srcStructure = detectJacketStructure(srcMesh.vertices, srcSplit);
            const tarStructure = detectJacketStructure(tarMesh.vertices, tarSplit);
            const result = matchStructureGraphs(srcStructure.graph, tarStructure.graph);
            return {
              pairs: result.pairs,
              matrix4x4: result.matrix4x4,
              rmse: result.rmse,
              thresholdUsed: 0,
              iterationsRun: 1,
              rawSrcSamples: result.totalAnchors,
              rawTarSamples: result.totalAnchors,
              bestInlierCount: result.matchedCount,
              diagnostics: {
                mode: 'jacket-structure' as const,
                srcAnchors: srcStructure.graph.anchors.length,
                tarAnchors: tarStructure.graph.anchors.length,
                matchedCount: result.matchedCount,
                warning: result.warning ?? null,
              },
            };
          })()
      : matchPartialToWhole(
          { vertices: srcMesh.vertices, adjacency: srcAdjacency },
          { vertices: tarMesh.vertices, adjacency: tarAdjacency },
          {
            numSrcSamples: partialSrcSamples,
            numTarSamples: partialTarSamples,
            topK: partialTopK,
            iterations: partialIterations,
            inlierThreshold: partialThresholdPct / 100,
            descriptor: partialDescriptor,
            samplePoolMode: PARTIAL_SAMPLE_POOL_MODE,
            radiusFractions: PARTIAL_RADIUS_FRACTIONS,
            macroSaliencyRings: partialMacroSaliencyRings,
            tarSeedCentroid: tarRegion?.centroid,
            tarSeedRadius: tarRegion?.boundingRadius,
            tarSeedWeight: tarRegion ? partialSeedWeight : 0,
            tarConstraintVertices: tarRegion?.vertices,
            tarConstraintUseSaliency: Boolean(tarRegion?.vertices?.size),
            axialWeight: partialAxialWeight,
            seed: runSeed,
          },
        );
    const partialTimings = 'timings' in r ? r.timings : undefined;
    const partialDiagnostics = 'diagnostics' in r ? r.diagnostics : undefined;
    const partialWarnings = buildPartialWarnings(partialMatchMode, partialDiagnostics, tarRegion, tarMesh.vertices.length);
    const dt = performance.now() - t0;
    if (activeSeedSignatureRef.current !== runSeedSignature) {
      appendAlignmentTrace('manual-partial-stale-discarded', {
        runSeedSignature,
        currentSeedSignature: activeSeedSignatureRef.current,
        elapsedMs: round3(dt),
      });
      onStatusChange('Step 1 结果已丢弃：Target seed 在计算期间发生变化，请重新运行 Step 1', 'warning');
      setPartialLoading(false);
      return;
    }
    if (!r.matrix4x4 || r.pairs.length < 3) {
      setCandidates([]);
      setAcceptedCandidateIds(new Set());
      setPartialMatchSummary({
        mode: partialMatchMode,
        status: 'failed',
        pairs: r.pairs.length,
        bestInlierCount: r.bestInlierCount,
        rawSrcSamples: r.rawSrcSamples,
        rawTarSamples: r.rawTarSamples,
        topK: partialTopK,
        iterationsRun: r.iterationsRun,
        thresholdUsed: r.thresholdUsed,
        rmse: r.rmse,
        elapsedMs: dt,
        timings: partialTimings,
        diagnostics: partialDiagnostics,
        warnings: partialWarnings,
      });
      appendAlignmentTrace('manual-partial-failed', {
        mode: partialMatchMode,
        pairs: r.pairs.length,
        bestInlierCount: r.bestInlierCount,
        rawSrcSamples: r.rawSrcSamples,
        rawTarSamples: r.rawTarSamples,
        elapsedMs: round3(dt),
        timings: summarizePartialTimings(partialTimings),
        warnings: partialWarnings,
        diagnostics: partialDiagnostics,
      });
      onStatusChange(
        partialMatchMode === 'limb-structure'
          ? `Step 1 失败：结构锚点不足或退化（pairs=${r.pairs.length}）。请检查目标肢体区域 / Body 区域。`
          : partialMatchMode === 'jacket-structure'
            ? `Step 1 失败：外套结构锚点匹配不足（matched=${(r as any).diagnostics?.matchedCount ?? r.pairs.length}）。请检查 source/target 外套区域 BBox 分割是否合理。`
            : `Step 1 失败：RANSAC inliers=${r.bestInlierCount}（threshold=${(partialThresholdPct).toFixed(1)}% src bbox）` +
              ` — 试着加大 topK / 迭代数 / threshold`,
        'error',
      );
      setPartialLoading(false);
      return;
    }
    setCandidates(r.pairs);
    setAcceptedCandidateIds(new Set());
    setPartialMatchSummary({
      mode: partialMatchMode,
      status: 'success',
      pairs: r.pairs.length,
      bestInlierCount: r.bestInlierCount,
      rawSrcSamples: r.rawSrcSamples,
      rawTarSamples: r.rawTarSamples,
      topK: partialTopK,
      iterationsRun: r.iterationsRun,
      thresholdUsed: r.thresholdUsed,
      rmse: r.rmse,
      elapsedMs: dt,
      timings: partialTimings,
      diagnostics: partialDiagnostics,
      warnings: partialWarnings,
    });
    appendAlignmentTrace('manual-partial-result', {
      mode: partialMatchMode,
      pairs: r.pairs.length,
      rmse: round3(r.rmse),
      bestInlierCount: r.bestInlierCount,
      rawSrcSamples: r.rawSrcSamples,
      rawTarSamples: r.rawTarSamples,
      thresholdUsed: round3(r.thresholdUsed),
      firstPairs: summarizePairs(r.pairs),
      elapsedMs: round3(dt),
      timings: summarizePartialTimings(partialTimings),
      warnings: partialWarnings,
      diagnostics: partialDiagnostics,
    });
    appendAlignmentTrace('manual-partial-timing', summarizePartialTimings(partialTimings) ?? {});
    onStatusChange(
      partialMatchMode === 'limb-structure'
        ? `Step 1 完成：结构锚点 ${r.pairs.length} 对（root/bend/end），RMSE=${r.rmse.toFixed(4)} — ${dt.toFixed(1)}ms${partialWarnings.length ? ' · 有诊断警告' : ''}`
        : partialMatchMode === 'jacket-structure'
          ? `Step 1 完成：外套结构锚点 ${r.pairs.length} 对（collar/hem/shoulder/cuff/armpit），RMSE=${r.rmse.toFixed(4)} — ${dt.toFixed(1)}ms${partialWarnings.length ? ' · 有诊断警告' : ''}`
          : `Step 1 完成：RANSAC inliers=${r.bestInlierCount}，输出 ${r.pairs.length} 对候选，RMSE=${r.rmse.toFixed(4)}，threshold=${r.thresholdUsed.toFixed(4)} — ${dt.toFixed(1)}ms`,
      partialWarnings.length ? 'warning' : 'success',
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
    partialMatchMode,
    partialSeedWeight,
    partialAxialWeight,
    partialMacroSaliencyRings,
    tarRegion,
    maskReproj,
    appendAlignmentTrace,
    onStatusChange,
  ]);

  const handleRunPartialDebug = useCallback(() => {
    if (srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0) {
      onStatusChange('Source/Target 尚未加载', 'warning');
      return;
    }
    setPartialLoading(true);
    setTimeout(async () => {
    const t0 = performance.now();
    const dbg = computePartialDebug(
      { vertices: srcMesh.vertices, adjacency: srcAdjacency },
      { vertices: tarMesh.vertices, adjacency: tarAdjacency },
      {
        numSrcSamples: partialSrcSamples,
        numTarSamples: partialTarSamples,
        topK: partialTopK,
        descriptor: partialDescriptor,
        samplePoolMode: PARTIAL_SAMPLE_POOL_MODE,
        radiusFractions: PARTIAL_RADIUS_FRACTIONS,
        macroSaliencyRings: partialMacroSaliencyRings,
        tarSeedCentroid: tarRegion?.centroid,
        tarSeedRadius: tarRegion?.boundingRadius,
        tarSeedWeight: tarRegion ? partialSeedWeight : 0,
        tarConstraintVertices: tarRegion?.vertices,
        tarConstraintUseSaliency: Boolean(tarRegion?.vertices?.size),
        axialWeight: partialAxialWeight,
      },
    );
    const dt = performance.now() - t0;
    setPartialDebug(dbg);
    onStatusChange(
      `采样诊断完成：Saliency src=${dbg.srcSaliencyTop.length} tar=${dbg.tarSaliencyTop.length}` +
        ` | FPS src=${dbg.srcFPS.length} tar=${dbg.tarFPS.length}` +
        ` | Top-K=${partialTopK} | 平均最佳 top-1 距离=${dbg.avgBestDist.toFixed(4)} — ${dt.toFixed(1)}ms。该结果仅用于可视化，不会进入 Step 2。`,
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
    partialMacroSaliencyRings,
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

  const handleLoadRefImage = useCallback(async (file: File): Promise<{ w: number; h: number } | null> => {
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
      setOrthoCamera(null);
      setMaskReproj(null);
      setTarRegion(null);
      setTarRegionLabel(null);
      appendAlignmentTrace('load-ref-image', {
        file: file.name,
        size,
      });
      // Auto-extract subject bbox so the renderer can fit the target
      // mesh to the same image-space framing as the reference image.
      try {
        const bbox = await extractImageSubjectBBox(url);
        setRefSubjectBBox(bbox);
        if (bbox) {
          appendAlignmentTrace('ref-image-bbox', {
            file: file.name,
            bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h, method: bbox.method },
          });
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
      return size;
    } catch (err) {
      URL.revokeObjectURL(url);
      onStatusChange(
        `参考图加载失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
      return null;
    }
  }, [onStatusChange]);

  const handleLoadMaskImage = useCallback(async (file: File, expectedSize = refImageSize): Promise<boolean> => {
    const url = URL.createObjectURL(file);
    try {
      const size = await loadImageDimensions(url);
      if (expectedSize && (size.w !== expectedSize.w || size.h !== expectedSize.h)) {
        URL.revokeObjectURL(url);
        onStatusChange(
          `Mask 尺寸 ${size.w}×${size.h} 与参考图 ${expectedSize.w}×${expectedSize.h} 不一致`,
          'error',
        );
        return false;
      }
      setMaskImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setMaskImageName(file.name);
      setMaskReproj(null);
      setTarRegion(null);
      setTarRegionLabel(null);
      appendAlignmentTrace('load-mask-image', {
        file: file.name,
        size,
        expectedSize,
      });
      onStatusChange(`已加载 SAM3 mask：${file.name}`, 'success');
      return true;
    } catch (err) {
      URL.revokeObjectURL(url);
      onStatusChange(
        `Mask 加载失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
      return false;
    }
  }, [refImageSize, onStatusChange]);

  const handleRunSegFormerGarmentParse = useCallback(async () => {
    if (!refImageUrl || !refImageSize) {
      onStatusChange('请先加载参考图，再运行 SegFormer 服装分割', 'warning');
      return;
    }
    setSegformerParsing(true);
    setSegformerClasses([]);
    onStatusChange('SegFormer 服装语义分割中…', 'info');
    try {
      const result = await parseGarmentsSegFormer({
        source: refImageUrl,
        classes: ['Upper-clothes', 'Dress', 'Skirt', 'Pants', 'Scarf'],
      });
      const pack = parseSegmentationJson(JSON.stringify(result.json));
      const labels = pack.regions.map((r) => r.label);
      const selectedLabel = chooseGarmentRegionLabel(labels);
      const maskUrl = dataUrlFromBase64Png(result.labelMaskBase64);

      setSegPack(pack);
      setSegPackName('segformer_segmentation.json');
      setMaskImageUrl((prev) => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
        return maskUrl;
      });
      setMaskImageName('segformer_label_mask.png');
      setSelectedTargetRegionLabel(selectedLabel);
      setTargetRegionSelectionMode('manual');
      setSegformerClasses(result.classesPresent);
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setOrthoCamera(null);
      setMaskReproj(null);
      setTarRegion(null);
      setTarRegionLabel(null);

      appendAlignmentTrace('segformer-garment-parse', {
        image: refImageName,
        size: refImageSize,
        selectedLabel,
        regions: pack.regions.map((r) => ({ label: r.label, mask: r.mask_value, bbox: r.bbox })),
        classesPresent: result.classesPresent,
      });
      const union = regionsUnionBBox(pack.regions);
      onStatusChange(
        `SegFormer 服装分割完成：${labels.join(', ')}` +
          (selectedLabel ? ` · 当前目标区域 ${selectedLabel}` : '') +
          (union ? ` · bbox ${union.w}×${union.h}@(${union.x},${union.y})` : ''),
        'success',
      );
    } catch (err) {
      onStatusChange(
        `SegFormer 服装分割失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    } finally {
      setSegformerParsing(false);
    }
  }, [refImageUrl, refImageSize, refImageName, appendAlignmentTrace, onStatusChange]);

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
      setTarRegion(null);
      setTarRegionLabel(null);
      appendAlignmentTrace('render-ortho', {
        useAuto,
        refImageSize,
        fitBBox,
        manualFit: { scale: orthoScale, offsetX: orthoOffsetX, offsetY: orthoOffsetY },
        camera: summarizeCamera(camera),
        targetMesh: { vertices: tarMesh.vertices.length, faces: tarMesh.faces.length },
      });
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
        { projectionMode: 'through', splatRadiusPx: 1, maskDilatePx: 2 },
      );
      setMaskReproj(result);
      setTarRegion(null);
      setTarRegionLabel(null);
      appendAlignmentTrace('manual-reproject-mask', {
        camera: summarizeCamera(orthoCamera),
        mask: maskImageName,
        segmentation: segPackName,
        result: summarizeMaskReprojection(result),
      });
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
  const buildTarRegionFromSet = useCallback(
    (set: Set<number>): MeshRegion | null => {
      if (set.size === 0) return null;
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
      return region;
    },
    [tarMesh.vertices],
  );

  const handleAdoptRegionAsTarSeed = useCallback(
    (label: string) => {
      if (!maskReproj) return;
      const set = maskReproj.regions.get(label);
      if (!set || set.size === 0) {
        onStatusChange(`区域 "${label}" 没有顶点可用作 seed`, 'warning');
        return;
      }
      const region = buildTarRegionFromSet(set);
      if (!region) return;
      setTarRegion(region);
      setTarRegionLabel(label);
      setSelectedTargetRegionLabel(label);
      setTargetRegionSelectionMode('manual');
      appendAlignmentTrace('adopt-target-region', {
        label,
        region: summarizeRegion(region),
      });
      onStatusChange(
        `已将 SAM3 区域 "${label}" (${set.size} 顶点) 设为 Target seed · 中心=(${region.centroid[0].toFixed(3)}, ${region.centroid[1].toFixed(3)}, ${region.centroid[2].toFixed(3)}) · 半径=${region.boundingRadius.toFixed(3)}`,
        'success',
      );
    },
    [maskReproj, buildTarRegionFromSet, onStatusChange],
  );

  // Keep the semantic Target seed derived from the active SAM3 region,
  // instead of relying on whichever async loader/effect happened to run
  // last. This makes region changes, source-driven auto recommendations,
  // and already-computed reprojections converge through one canonical path.
  useEffect(() => {
    if (!maskReproj || !activeTargetRegionLabel) return;
    if (tarRegion && tarRegionLabel === activeTargetRegionLabel) return;

    const set = maskReproj.regions.get(activeTargetRegionLabel);
    if (!set || set.size === 0) {
      setTarRegion(null);
      setTarRegionLabel(null);
      appendAlignmentTrace('sync-target-region-empty', {
        label: activeTargetRegionLabel,
        availableLabels: Array.from(maskReproj.regions.keys()),
      });
      return;
    }

    const region = buildTarRegionFromSet(set);
    if (!region) return;
    setTarRegion(region);
    setTarRegionLabel(activeTargetRegionLabel);
    appendAlignmentTrace('sync-target-region', {
      label: activeTargetRegionLabel,
      selectionMode: targetRegionSelectionMode,
      region: summarizeRegion(region),
    });
  }, [
    maskReproj,
    activeTargetRegionLabel,
    tarRegion,
    tarRegionLabel,
    targetRegionSelectionMode,
    buildTarRegionFromSet,
    appendAlignmentTrace,
  ]);

  // Once the SAM3 three-piece pack is loaded, immediately perform the
  // target localization that used to be delayed until the manual buttons or
  // the one-click auto-align button: render Target front view, reproject mask
  // to target vertices, then adopt the selected region as the Target seed.
  useEffect(() => {
    const targetRegionLabel = activeTargetRegionLabel;
    if (!segPack || !maskImageUrl || !refImageSize) return;
    if (maskReproj) return;
    if (tarMesh.vertices.length === 0 || tarMesh.faces.length === 0) return;

    let cancelled = false;
    const run = async () => {
      setAutoLocalizing(true);
      const t0 = performance.now();
      try {
        const useAuto = autoFit && !!fitBBox;
        const rendered = renderOrthoFrontViewWithCamera(
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
        if (cancelled) return;
        setOrthoRenderUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return rendered.dataUrl;
        });
        setOrthoCamera(rendered.camera);
        appendAlignmentTrace('auto-localize-render-ortho', {
          useAuto,
          refImageSize,
          fitBBox,
          manualFit: { scale: orthoScale, offsetX: orthoOffsetX, offsetY: orthoOffsetY },
          camera: summarizeCamera(rendered.camera),
        });

        const mask = await loadMaskGray(maskImageUrl);
        if (cancelled) return;
        if (!mask) {
          onStatusChange('分割包已加载，但 mask 解码失败，无法自动反投影', 'error');
          return;
        }
        const reproj = reprojectMaskToVertices(
          tarMesh.vertices,
          mask,
          segPack.regions,
          rendered.camera,
          { projectionMode: 'through', splatRadiusPx: 1, maskDilatePx: 2 },
        );
        if (cancelled) return;
        setMaskReproj(reproj);
        appendAlignmentTrace('auto-localize-reproject-mask', {
          targetRegionLabel,
          selectionMode: targetRegionSelectionMode,
          camera: summarizeCamera(rendered.camera),
          mask: maskImageName,
          segmentation: segPackName,
          result: summarizeMaskReprojection(reproj),
        });

        const set = reproj.regions.get(targetRegionLabel);
        if (set && set.size > 0) {
          const region = buildTarRegionFromSet(set);
          if (region) {
            setTarRegion(region);
            setTarRegionLabel(targetRegionLabel);
          }
        } else {
          setTarRegion(null);
          setTarRegionLabel(null);
        }

        const stats = Array.from(reproj.regions.entries())
          .map(([label, regionSet]) => `${label}=${regionSet.size}`)
          .join(', ');
        onStatusChange(
          `分割包 3D 定位完成：已渲染 Target 正视图并反投影 mask · ${stats} · ${(performance.now() - t0).toFixed(1)}ms`,
          'success',
        );
      } catch (err) {
        if (!cancelled) {
          onStatusChange(
            `分割包 3D 定位失败：${err instanceof Error ? err.message : '未知错误'}`,
            'error',
          );
        }
      } finally {
        if (!cancelled) setAutoLocalizing(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    segPack,
    maskImageUrl,
    refImageSize,
    activeTargetRegionLabel,
    targetRegionSelectionMode,
    maskReproj,
    tarMesh,
    autoFit,
    fitBBox,
    orthoScale,
    orthoOffsetX,
    orthoOffsetY,
    maskImageName,
    segPackName,
    buildTarRegionFromSet,
    appendAlignmentTrace,
    onStatusChange,
  ]);

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
      const labels = pack.regions.map((r) => r.label);
      const selectedLabel = chooseRegionLabel(srcMesh.name, labels);
      setSegPack(pack);
      setSegPackName(file.name);
      setSelectedTargetRegionLabel(selectedLabel);
      setTargetRegionSelectionMode('auto');
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setOrthoCamera(null);
      setMaskReproj(null);
      setTarRegion(null);
      setTarRegionLabel(null);
      appendAlignmentTrace('load-seg-json', {
        file: file.name,
        imageName: pack.imageName,
        maskName: pack.maskName,
        sourceName: srcMesh.name,
        selectedLabel,
        selectionMode: 'auto',
        recommendedLabel: recommendRegionLabel(srcMesh.name, labels),
        regions: pack.regions.map((r) => ({ label: r.label, mask: r.mask_value, bbox: r.bbox })),
      });
      const union = regionsUnionBBox(pack.regions);
      onStatusChange(
        `已加载 ${file.name} · ${pack.regions.length} 个区域：${pack.regions.map((r) => r.label).join(', ')}` +
          (selectedLabel ? ` · 当前目标区域 ${selectedLabel}` : '') +
          (union ? ` · 并集 bbox ${union.w}×${union.h}@(${union.x},${union.y})` : ''),
        'success',
      );
    } catch (err) {
      onStatusChange(
        `segmentation.json 解析失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [onStatusChange, srcMesh.name]);

  const handleLoadSegPackFiles = useCallback(async (files: FileList | File[]) => {
    const all = Array.from(files);
    const jsonFile = all.find((f) => baseName((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name) === 'segmentation.json')
      ?? all.find((f) => f.name.toLowerCase().endsWith('.json'));
    if (!jsonFile) {
      onStatusChange('分割包目录中未找到 segmentation.json', 'error');
      return;
    }

    try {
      const text = await jsonFile.text();
      const pack = parseSegmentationJson(text);
      const findReferencedFile = (name: string) => {
        const wanted = baseName(name);
        return all.find((f) => baseName((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name) === wanted)
          ?? all.find((f) => baseName(f.name) === wanted);
      };
      const imageFile = findReferencedFile(pack.imageName);
      const maskFile = findReferencedFile(pack.maskName);

      // Use the exact same state path as manual JSON loading, then reuse
      // the same reference-image and mask loaders. This keeps one-click
      // bundle loading behavior identical to loading the three files one by
      // one before continuing the manual alignment flow.
      await handleLoadSegJson(jsonFile);
      appendAlignmentTrace('load-seg-pack', {
        jsonFile: jsonFile.name,
        imageFile: imageFile?.name ?? null,
        maskFile: maskFile?.name ?? null,
        imageName: pack.imageName,
        maskName: pack.maskName,
        regions: pack.regions.map((r) => ({ label: r.label, mask: r.mask_value, bbox: r.bbox })),
      });

      let imageSize: { w: number; h: number } | null = null;
      if (imageFile) {
        imageSize = await handleLoadRefImage(imageFile);
      }
      if (maskFile) {
        await handleLoadMaskImage(maskFile, imageSize ?? refImageSize);
      }

      const union = regionsUnionBBox(pack.regions);
      onStatusChange(
        `已加载 SAM3 分割包：${pack.regions.map((r) => r.label).join(' / ')}` +
          (imageFile ? ` · 参考图 ${pack.imageName}` : ` · 未找到参考图 ${pack.imageName}`) +
          (maskFile ? ` · Mask ${pack.maskName}` : ` · 未找到 Mask ${pack.maskName}`) +
          (union ? ` · bbox ${union.w}×${union.h}@(${union.x},${union.y})` : ''),
        imageFile && maskFile ? 'success' : 'warning',
      );
    } catch (err) {
      onStatusChange(
        `SAM3 分割包加载失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [handleLoadMaskImage, handleLoadRefImage, handleLoadSegJson, onStatusChange, refImageSize]);

  const onSegJsonFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await handleLoadSegJson(file);
      e.currentTarget.value = '';
    },
    [handleLoadSegJson],
  );

  const onSegPackDirChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      await handleLoadSegPackFiles(files);
      e.currentTarget.value = '';
    },
    [handleLoadSegPackFiles],
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

  // Stale-candidate guard: invalidate suggestions when seed regions really
  // change.  Do not key this on the MeshRegion object itself: auto-localize
  // and region-sync can rebuild an equivalent object asynchronously, which
  // previously made freshly-rendered Step 1 candidate dots disappear a moment
  // later even though the semantic seed had not changed.
  useEffect(() => {
    setCandidates([]);
    setAcceptedCandidateIds(new Set());
    setPartialMatchSummary(null);
  }, [srcRegionSignature, tarRegionSignature]);

  const pairCount = Math.min(srcLandmarks.length, tarLandmarks.length);
  const isBalanced = srcLandmarks.length === tarLandmarks.length && srcLandmarks.length > 0;
  const manualAlignmentPairs = useMemo<ManualAlignmentPairs | null>(() => {
    if (isBalanced && srcLandmarks.length >= 3) {
      return {
        source: 'landmarks',
        sourcePoints: srcLandmarks.map((p) => p.position),
        targetPoints: tarLandmarks.map((p) => p.position),
        count: srcLandmarks.length,
      };
    }

    const accepted = candidates.filter((_, i) => acceptedCandidateIds.has(i));
    const pairSource = accepted.length >= 3 ? accepted : candidates;
    if (pairSource.length >= 3) {
      return {
        source: accepted.length >= 3 ? 'accepted-candidates' : 'partial-candidates',
        sourcePoints: pairSource.map((p) => p.srcPosition),
        targetPoints: pairSource.map((p) => p.tarPosition),
        count: pairSource.length,
      };
    }

    return null;
  }, [acceptedCandidateIds, candidates, isBalanced, srcLandmarks, tarLandmarks]);
  const manualPairSourceLabel = manualAlignmentPairs?.source === 'landmarks'
    ? 'Landmark Pairs'
    : manualAlignmentPairs?.source === 'accepted-candidates'
      ? '已接受候选'
      : manualAlignmentPairs?.source === 'partial-candidates'
        ? 'Partial 候选'
        : '无可用输入';
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
    if (autoAlignSummary) setAutoAlignSummary(null);
    if (centerViewMode === 'result') setCenterViewMode('landmark');
  }, [alignResult, autoAlignSummary, centerViewMode, resultPreview]);

  const loadGalleryItemToSource = useCallback(async (
    item: HighresGalleryItem,
    options: { autoSync?: boolean } = {},
  ) => {
    let loadedUrlToRevoke: string | null = null;
    try {
      onStatusChange(
        options.autoSync
          ? `正在同步 Source：${item.pipelineName} → ${item.file}`
          : `正在从 Mesh Gallery 打开：${item.file}`,
        'info',
      );
      const loaded = await loadByName('page2.highres', item.file);
      if (!loaded) {
        onStatusChange('加载失败：未找到该 highres 模型版本', 'error');
        return;
      }
      loadedUrlToRevoke = loaded.url;

      const mesh = await loadGlbAsMesh(loaded.url);
      setSrcMesh({
        name: item.file,
        vertices: mesh.vertices,
        faces: mesh.faces,
      });
      setSourceGalleryBinding({
        pipelineKey: item.pipelineKey,
        pipelineIndex: item.pipelineIndex,
        pipelineName: item.pipelineName,
        pipelineMode: item.pipelineMode,
        file: item.file,
      });
      setTargetRegionSelectionMode('auto');
      setSelectedSrcIndex(null);
      setSrcRegion(null);
      clearAllLandmarks();
      resetPreview();
      onStatusChange(
        options.autoSync
          ? `Source 已跟随 ${item.pipelineName} 更新为：${item.file}`
          : `已将 ${item.file} 加载到 Source，并绑定到 ${item.pipelineName}`,
        'success',
      );
    } catch (err) {
      onStatusChange(`打开失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      if (loadedUrlToRevoke) URL.revokeObjectURL(loadedUrlToRevoke);
    }
  }, [clearAllLandmarks, loadByName, onStatusChange, resetPreview]);

  const refreshHighresGallery = useCallback(async () => {
    if (!project) {
      setHighresHistory([]);
      setSelectedGalleryId(null);
      setSourceGalleryBinding(null);
      return;
    }

    setGalleryLoading(true);
    try {
      const [pipelinesIndex, history] = await Promise.all([
        loadPipelines(),
        listHistory('page2.highres'),
      ]);
      const historyByFile = new Map(history.map((v) => [v.file, v]));
      const currentModels = (pipelinesIndex?.pipelines ?? [])
        .map((pipeline, pipelineIndex): HighresGalleryItem | null => {
          if (!pipeline.modelFile) return null;
          const version = historyByFile.get(pipeline.modelFile);
          if (!version) return null;
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
      setHighresHistory(currentModels);

      if (currentModels.length === 0) {
        setSelectedGalleryId(null);
        return;
      }

      if (sourceGalleryBinding) {
        const boundCurrent = currentModels.find((v) => v.pipelineKey === sourceGalleryBinding.pipelineKey);
        if (!boundCurrent) {
          setSourceGalleryBinding(null);
        } else if (boundCurrent.file !== sourceGalleryBinding.file) {
          await loadGalleryItemToSource(boundCurrent, { autoSync: true });
        } else if (
          boundCurrent.pipelineName !== sourceGalleryBinding.pipelineName ||
          boundCurrent.pipelineIndex !== sourceGalleryBinding.pipelineIndex ||
          boundCurrent.pipelineMode !== sourceGalleryBinding.pipelineMode
        ) {
          setSourceGalleryBinding({
            pipelineKey: boundCurrent.pipelineKey,
            pipelineIndex: boundCurrent.pipelineIndex,
            pipelineName: boundCurrent.pipelineName,
            pipelineMode: boundCurrent.pipelineMode,
            file: boundCurrent.file,
          });
        }
      }

      const nextItem = selectedGalleryId
        ? currentModels.find((v) => v.id === selectedGalleryId) ?? currentModels[0]
        : currentModels[0];

      setSelectedGalleryId(nextItem.id);
    } catch {
      setHighresHistory([]);
      setSelectedGalleryId(null);
    } finally {
      setGalleryLoading(false);
    }
  }, [listHistory, loadByName, loadGalleryItemToSource, loadPipelines, project, selectedGalleryId, sourceGalleryBinding]);

  useEffect(() => {
    void refreshHighresGallery();
  }, [refreshHighresGallery]);

  useEffect(() => {
    const handlePipelinesUpdated = () => {
      void refreshHighresGallery();
    };
    window.addEventListener('page2:pipelines-updated', handlePipelinesUpdated);
    return () => window.removeEventListener('page2:pipelines-updated', handlePipelinesUpdated);
  }, [refreshHighresGallery]);

  useEffect(() => {
    let cancelled = false;
    if (!project || highresHistory.length === 0) {
      setGallerySnapshots({});
      return () => { cancelled = true; };
    }

    setGallerySnapshots(Object.fromEntries(
      highresHistory.map((item) => [item.id, { status: 'loading' as const }]),
    ));

    (async () => {
      for (const item of highresHistory) {
        let loadedUrlToRevoke: string | null = null;
        try {
          const loaded = await loadByName('page2.highres', item.file);
          if (!loaded) throw new Error('未找到模型文件');
          loadedUrlToRevoke = loaded.url;
          const glb = await loadGlb(loaded.url);
          const dataUrl = renderTexturedFrontSnapshot(glb.scene, glb.bbox, {
            width: 220,
            height: 140,
            padding: 0.08,
            background: '#20242a',
            pixelRatio: 1,
          });
          if (!cancelled) {
            setGallerySnapshots((prev) => ({
              ...prev,
              [item.id]: { status: 'ready', dataUrl },
            }));
          }
        } catch (err) {
          console.warn('[Page3] render gallery snapshot failed:', item.file, err);
          if (!cancelled) {
            setGallerySnapshots((prev) => ({
              ...prev,
              [item.id]: { status: 'error' },
            }));
          }
        } finally {
          if (loadedUrlToRevoke) URL.revokeObjectURL(loadedUrlToRevoke);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [highresHistory, loadByName, project]);

  const handleSelectGalleryItem = useCallback(async (item: HighresGalleryItem) => {
    setSelectedGalleryId(item.id);
  }, []);

  const handleOpenGalleryToSource = useCallback(async (item: HighresGalleryItem) => {
    await loadGalleryItemToSource(item);
  }, [loadGalleryItemToSource]);

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
        setSourceGalleryBinding(null);
        setTargetRegionSelectionMode('auto');
        setSelectedSrcIndex(null);
        setSrcRegion(null);
      } else {
        setTarMesh(mesh);
        setSelectedTarIndex(null);
        setTarRegion(null);
        setTarRegionLabel(null);
        // Camera & reprojection are bound to the previous mesh — drop them.
        setOrthoRenderUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
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
    if (srcLandmarks.length !== tarLandmarks.length && (srcLandmarks.length > 0 || tarLandmarks.length > 0)) {
      onStatusChange('Source/Target landmark 数量不一致，请修正或清空后使用候选对齐', 'error');
      return;
    }
    if (!manualAlignmentPairs || manualAlignmentPairs.count < 3) {
      onStatusChange('至少需要 3 对 landmark 或 partial-match 候选才能执行 Similarity SVD 对齐', 'error');
      return;
    }

    setAligning(true);
    try {
      const result = alignSourceMeshByLandmarks(
        srcMesh.vertices,
        manualAlignmentPairs.sourcePoints,
        manualAlignmentPairs.targetPoints,
        ALIGNMENT_MODE,
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
      appendAlignmentTrace('manual-landmark-svd-result', {
        input: manualAlignmentPairs.source,
        pairs: manualAlignmentPairs.count,
        rmse: round3(result.rmse),
        meanError: round3(result.meanError),
        maxError: round3(result.maxError),
        scale: round3(result.scale),
        matrix: summarizeMatrix(result.matrix4x4),
      });
      onStatusChange(
        `Similarity SVD 对齐完成：${manualPairSourceLabel} ${manualAlignmentPairs.count} 对，RMSE=${result.rmse.toFixed(4)}`,
        'success',
      );
    } catch (err) {
      onStatusChange(`对齐失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      setAligning(false);
    }
  };

  const handleRunIcpAlign = () => {
    if (!alignResult) {
      onStatusChange('请先执行 Landmark SVD，对 ICP 提供初始姿态', 'warning');
      return;
    }
    if (!manualAlignmentPairs || manualAlignmentPairs.count < 3) {
      onStatusChange('至少需要 3 对 landmark 或 partial-match 候选用于评估 ICP 结果', 'error');
      return;
    }

    setAligning(true);
    setTimeout(() => {
      try {
        const t0 = performance.now();
        const runSeed = makeRandomAlignSeed();
        appendAlignmentTrace('manual-icp-start', {
          input: manualAlignmentPairs.source,
          pairs: manualAlignmentPairs.count,
          initialRmse: round3(alignResult.rmse),
          tarRestrictVertices: tarRegion ? tarRegion.vertices.size : null,
          seed: runSeed,
          params: {
            maxIterations: icpMaxIterations,
            sampleCount: icpSampleCount,
            rejectMultiplier: icpRejectMultiplier,
            convergenceImprovement: icpConvergenceImprovement,
            firstIterMode: ALIGNMENT_MODE,
            subsequentMode: ALIGNMENT_MODE,
          },
        });
        const icp = icpRefine(srcMesh.vertices, tarMesh.vertices, alignResult.matrix4x4, {
          maxIterations: icpMaxIterations,
          sampleCount: icpSampleCount,
          rejectMultiplier: icpRejectMultiplier,
          convergenceImprovement: icpConvergenceImprovement,
          firstIterMode: ALIGNMENT_MODE,
          subsequentMode: ALIGNMENT_MODE,
          seed: runSeed,
          tarRestrictVertices: tarRegion?.vertices,
        });
        const result = buildAlignmentResultFromMatrix(
          srcMesh,
          manualAlignmentPairs.sourcePoints,
          manualAlignmentPairs.targetPoints,
          icp.matrix4x4,
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
        const dt = performance.now() - t0;
        appendAlignmentTrace('manual-icp-result', {
          input: manualAlignmentPairs.source,
          pairs: manualAlignmentPairs.count,
          icpRmse: round3(icp.rmse),
          landmarkRmse: round3(result.rmse),
          scale: round3(result.scale),
          bestIteration: icp.bestIteration,
          stopReason: icp.stopReason,
          iterations: icp.iterations.map((it, index) => ({
            index,
            rmse: round3(it.rmse),
            pairsKept: it.pairsKept,
            improvement: Number.isFinite(it.improvement) ? round3(it.improvement) : it.improvement,
          })),
          matrix: summarizeMatrix(result.matrix4x4),
          elapsedMs: round3(dt),
        });
        onStatusChange(
          `ICP refine 完成：${icp.iterations.length} 轮，landmark RMSE=${result.rmse.toFixed(4)}，ICP RMSE=${icp.rmse.toFixed(4)}`,
          'success',
        );
      } catch (err) {
        onStatusChange(`ICP refine 失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
      } finally {
        setAligning(false);
      }
    }, 16);
  };

  // Auto pipeline: structural/RANSAC match → SVD landmark fit → ICP refine.
  // Explicit mode buttons avoid relying on hidden Step 1 mode state.
  const handleAutoAlign = useCallback((modeOverride?: PartialMatchMode) => {
    const runMode = modeOverride ?? partialMatchMode;
    if (srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0) {
      onStatusChange('Source/Target 尚未加载', 'warning');
      return;
    }
    const targetRegionLabel = activeTargetRegionLabel;
    if (!targetRegionLabel) {
      onStatusChange(
        '请先加载 SAM3 分割包并选择目标区域，避免无约束匹配误对到身体。',
        'error',
      );
      return;
    }
    if (!maskReproj && (!segPack || !maskImageUrl || !refImageSize)) {
      onStatusChange(
        '目标区域尚未定位：请加载完整 SAM3 分割包（segmentation.json + 参考图 + mask）。',
        'error',
      );
      return;
    }
    setPartialMatchMode(runMode);
    clearAlignmentTrace();
    const runSeed = makeRandomAlignSeed();
    appendAlignmentTrace('auto-align-click', {
      mode: runMode,
      seed: runSeed,
      targetRegionLabel,
      selectionMode: targetRegionSelectionMode,
      selectedTargetRegionLabel,
      tarRegionLabel,
      hasTarRegion: Boolean(tarRegion),
      hasMaskReproj: Boolean(maskReproj),
      hasOrthoCamera: Boolean(orthoCamera),
      segPackName,
      refImageName,
      maskImageName,
      refImageSize,
      fitBBox,
      source: { name: srcMesh.name, vertices: srcMesh.vertices.length, faces: srcMesh.faces.length },
      target: { name: tarMesh.name, vertices: tarMesh.vertices.length, faces: tarMesh.faces.length },
    });
    setPartialLoading(true);
    setAligning(true);
    setTimeout(async () => {
      try {
        const t0 = performance.now();

        let workingTarRegion =
          tarRegion && tarRegionLabel === targetRegionLabel ? tarRegion : null;
        let workingMaskReproj = maskReproj;
        appendAlignmentTrace('auto-region-initial', {
          targetRegionLabel,
          selectionMode: targetRegionSelectionMode,
          selectedTargetRegionLabel,
          tarRegionLabel,
          usingCachedRegion: Boolean(workingTarRegion),
          cachedRegion: summarizeRegion(workingTarRegion),
          maskReproj: summarizeMaskReprojection(workingMaskReproj),
          camera: summarizeCamera(orthoCamera),
        });

        if (!workingTarRegion && targetRegionLabel) {
          if (workingMaskReproj) {
            const set = workingMaskReproj.regions.get(targetRegionLabel);
            if (set && set.size > 0) {
              workingTarRegion = buildTarRegionFromSet(set);
              if (workingTarRegion) {
                setTarRegion(workingTarRegion);
                setTarRegionLabel(targetRegionLabel);
              }
              appendAlignmentTrace('auto-region-from-existing-reprojection', {
                label: targetRegionLabel,
                region: summarizeRegion(workingTarRegion),
              });
            }
          } else if (segPack && maskImageUrl && refImageSize) {
            let camera = orthoCamera;
            if (!camera) {
              const useAuto = autoFit && !!fitBBox;
              const rendered = renderOrthoFrontViewWithCamera(
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
                return rendered.dataUrl;
              });
              setOrthoCamera(rendered.camera);
              camera = rendered.camera;
              appendAlignmentTrace('auto-render-ortho', {
                useAuto,
                refImageSize,
                fitBBox,
                manualFit: { scale: orthoScale, offsetX: orthoOffsetX, offsetY: orthoOffsetY },
                camera: summarizeCamera(camera),
              });
            }

            const mask = await loadMaskGray(maskImageUrl);
            if (mask) {
              const reproj = reprojectMaskToVertices(
                tarMesh.vertices,
                mask,
                segPack.regions,
                camera,
                { projectionMode: 'through', splatRadiusPx: 1, maskDilatePx: 2 },
              );
              setMaskReproj(reproj);
              workingMaskReproj = reproj;
              appendAlignmentTrace('auto-reproject-mask', {
                label: targetRegionLabel,
                camera: summarizeCamera(camera),
                mask: maskImageName,
                segmentation: segPackName,
                result: summarizeMaskReprojection(reproj),
              });
              const set = reproj.regions.get(targetRegionLabel);
              if (set && set.size > 0) {
                workingTarRegion = buildTarRegionFromSet(set);
                if (workingTarRegion) {
                  setTarRegion(workingTarRegion);
                  setTarRegionLabel(targetRegionLabel);
                }
                appendAlignmentTrace('auto-region-from-new-reprojection', {
                  label: targetRegionLabel,
                  region: summarizeRegion(workingTarRegion),
                });
              }
            }
          }
        }

        if (!workingTarRegion) {
          onStatusChange(
            `目标区域 "${targetRegionLabel}" 没有可用顶点，已停止自动对齐以避免误匹配到身体。请检查 mask / 反投影结果。`,
            'error',
          );
          setPartialLoading(false);
          setAligning(false);
          return;
        }

        // 1. Partial match
        appendAlignmentTrace('auto-partial-start', {
          params: {
            mode: runMode,
            numSrcSamples: partialSrcSamples,
            numTarSamples: partialTarSamples,
            topK: partialTopK,
            iterations: partialIterations,
            inlierThreshold: partialThresholdPct / 100,
            descriptor: partialDescriptor,
            samplePoolMode: PARTIAL_SAMPLE_POOL_MODE,
            radiusFractions: PARTIAL_RADIUS_FRACTIONS,
            macroSaliencyRings: partialMacroSaliencyRings,
            tarSeedWeight: workingTarRegion ? partialSeedWeight : 0,
            axialWeight: partialAxialWeight,
            seed: runSeed,
          },
          targetRegionLabel,
          targetRegion: summarizeRegion(workingTarRegion),
        });
        const workingTarBodyVertices = findMaskRegion(workingMaskReproj?.regions, ['body', 'torso']);
        const pm = runMode === 'limb-structure'
          ? matchLimbStructureToWhole(
              { vertices: srcMesh.vertices },
              { vertices: tarMesh.vertices },
              {
                tarConstraintVertices: workingTarRegion?.vertices,
                tarBodyVertices: workingTarBodyVertices,
                mode: ALIGNMENT_MODE,
              },
            )
          : runMode === 'jacket-structure'
            ? (() => {
                // Phase 0: split garment into torso / left_sleeve / right_sleeve
                // using bounding-box heuristic. Phase 2 will replace with AI.
                const srcGarment = new Set(allIndices(srcMesh.vertices.length));
                const tarGarment = workingTarRegion?.vertices ?? new Set(allIndices(tarMesh.vertices.length));
                const srcSplit = splitGarmentByBBox(srcMesh.vertices, srcGarment);
                const tarSplit = splitGarmentByBBox(tarMesh.vertices, tarGarment);
                const srcStructure = detectJacketStructure(srcMesh.vertices, srcSplit);
                const tarStructure = detectJacketStructure(tarMesh.vertices, tarSplit);
                appendAlignmentTrace('auto-jacket-structure', {
                  srcAnchors: srcStructure.graph.anchors.length,
                  tarAnchors: tarStructure.graph.anchors.length,
                  srcRegions: { torso: srcSplit.torso.size, left: srcSplit.left_sleeve.size, right: srcSplit.right_sleeve.size },
                  tarRegions: { torso: tarSplit.torso.size, left: tarSplit.left_sleeve.size, right: tarSplit.right_sleeve.size },
                  srcDiag: srcStructure.diagnostics,
                  tarDiag: tarStructure.diagnostics,
                });
                const result = matchStructureGraphs(srcStructure.graph, tarStructure.graph);
                return {
                  pairs: result.pairs,
                  matrix4x4: result.matrix4x4,
                  rmse: result.rmse,
                  thresholdUsed: 0,
                  iterationsRun: 1,
                  rawSrcSamples: result.totalAnchors,
                  rawTarSamples: result.totalAnchors,
                  bestInlierCount: result.matchedCount,
                  diagnostics: {
                    mode: 'jacket-structure' as const,
                    srcAnchors: srcStructure.graph.anchors.length,
                    tarAnchors: tarStructure.graph.anchors.length,
                    matchedCount: result.matchedCount,
                    warning: result.warning ?? null,
                  },
                };
              })()
          : matchPartialToWhole(
              { vertices: srcMesh.vertices, adjacency: srcAdjacency },
              { vertices: tarMesh.vertices, adjacency: tarAdjacency },
              {
                numSrcSamples: partialSrcSamples,
                numTarSamples: partialTarSamples,
                topK: partialTopK,
                iterations: partialIterations,
                inlierThreshold: partialThresholdPct / 100,
                descriptor: partialDescriptor,
                samplePoolMode: PARTIAL_SAMPLE_POOL_MODE,
                radiusFractions: PARTIAL_RADIUS_FRACTIONS,
                macroSaliencyRings: partialMacroSaliencyRings,
                tarSeedCentroid: workingTarRegion?.centroid,
                tarSeedRadius: workingTarRegion?.boundingRadius,
                tarSeedWeight: workingTarRegion ? partialSeedWeight : 0,
                tarConstraintVertices: workingTarRegion?.vertices,
                tarConstraintUseSaliency: Boolean(workingTarRegion?.vertices?.size),
                axialWeight: partialAxialWeight,
                seed: runSeed,
              },
            );
        const partialTimings = 'timings' in pm ? pm.timings : undefined;
        const partialDiagnostics = 'diagnostics' in pm ? pm.diagnostics : undefined;
        const partialWarnings = buildPartialWarnings(runMode, partialDiagnostics, workingTarRegion, tarMesh.vertices.length);
        if (!pm.matrix4x4 || pm.pairs.length < 3) {
          appendAlignmentTrace('auto-partial-failed', {
            mode: runMode,
            bestInlierCount: pm.bestInlierCount,
            rawSrcSamples: pm.rawSrcSamples,
            rawTarSamples: pm.rawTarSamples,
            timings: summarizePartialTimings(partialTimings),
            warnings: partialWarnings,
            diagnostics: partialDiagnostics,
          });
          onStatusChange(
            runMode === 'limb-structure'
              ? `自动对齐：结构锚点匹配失败（pairs=${pm.pairs.length}）`
              : runMode === 'jacket-structure'
                ? `自动对齐：外套结构锚点匹配失败（matched=${(pm as any).diagnostics?.matchedCount ?? pm.pairs.length}）`
                : `自动对齐：partial-match 失败 (inliers=${pm.bestInlierCount})`,
            'error',
          );
          setPartialLoading(false);
          setAligning(false);
          return;
        }
        appendAlignmentTrace('auto-partial-result', {
          mode: runMode,
          pairs: pm.pairs.length,
          rmse: round3(pm.rmse),
          bestInlierCount: pm.bestInlierCount,
          rawSrcSamples: pm.rawSrcSamples,
          rawTarSamples: pm.rawTarSamples,
          thresholdUsed: round3(pm.thresholdUsed),
          firstPairs: summarizePairs(pm.pairs),
          matrix: pm.matrix4x4 ? summarizeMatrix(pm.matrix4x4) : null,
          timings: summarizePartialTimings(partialTimings),
          warnings: partialWarnings,
          diagnostics: partialDiagnostics,
        });

        // 2. SVD landmark fit on accepted pairs (similarity).
        const lmFit = alignSourceMeshByLandmarks(
          srcMesh.vertices,
          pm.pairs.map((p) => p.srcPosition),
          pm.pairs.map((p) => p.tarPosition),
          'similarity',
        );

        // 3. ICP refine starting from the SVD initial transform.
        //    Mirror the manual Step 3 path: once SAM3 has localized the
        //    target part, nearest-neighbor search should stay inside that
        //    region. Otherwise a partial source can be pulled toward the
        //    closest unrelated body surface.
        const icp = icpRefine(srcMesh.vertices, tarMesh.vertices, lmFit.matrix4x4, {
          maxIterations: icpMaxIterations,
          sampleCount: icpSampleCount,
          rejectMultiplier: icpRejectMultiplier,
          convergenceImprovement: icpConvergenceImprovement,
          firstIterMode: ALIGNMENT_MODE,
          subsequentMode: ALIGNMENT_MODE,
          seed: runSeed,
          tarRestrictVertices: workingTarRegion?.vertices,
        });

        // Landmark RMSE and ICP RMSE measure different goals.  SVD
        // optimizes the sparse RANSAC landmark pairs; ICP optimizes dense
        // surface fit inside the target region.  Manual testing shows ICP
        // can visibly improve alignment while increasing landmark RMSE, so
        // do not reject ICP just because sparse landmark RMSE is higher.
        const evalRmseOnLandmarks = (m: number[][]): number => {
          let s = 0;
          for (const p of pm.pairs) {
            const t = applyTransform(p.srcPosition, m);
            const dx = t[0] - p.tarPosition[0];
            const dy = t[1] - p.tarPosition[1];
            const dz = t[2] - p.tarPosition[2];
            s += dx * dx + dy * dy + dz * dz;
          }
          return Math.sqrt(s / pm.pairs.length);
        };
        const lmFitLandmarkRmse = evalRmseOnLandmarks(lmFit.matrix4x4);
        const icpLandmarkRmse = evalRmseOnLandmarks(icp.matrix4x4);
        const bestIcpIter = icp.iterations[icp.bestIteration];
        const minIcpPairsKept = Math.min(30, Math.max(6, Math.floor(icpSampleCount * 0.1)));
        const useIcp = Number.isFinite(icp.rmse)
          && icp.iterations.length > 0
          && !!bestIcpIter
          && bestIcpIter.pairsKept >= minIcpPairsKept;
        const finalMatrix = useIcp ? icp.matrix4x4 : lmFit.matrix4x4;
        const finalRmse = useIcp ? icp.rmse : lmFitLandmarkRmse;
        appendAlignmentTrace('auto-fit-compare', {
          lmFit: {
            rmse: round3(lmFit.rmse),
            landmarkRmse: round3(lmFitLandmarkRmse),
            scale: round3(lmFit.scale),
            matrix: summarizeMatrix(lmFit.matrix4x4),
          },
          icp: {
            rmse: round3(icp.rmse),
            landmarkRmse: round3(icpLandmarkRmse),
            params: {
              maxIterations: icpMaxIterations,
              sampleCount: icpSampleCount,
              rejectMultiplier: icpRejectMultiplier,
              convergenceImprovement: icpConvergenceImprovement,
              firstIterMode: ALIGNMENT_MODE,
              subsequentMode: ALIGNMENT_MODE,
              tarRestrictVertices: workingTarRegion?.vertices.size ?? 0,
              minPairsKept: minIcpPairsKept,
            },
            iterations: icp.iterations.length,
            bestIteration: icp.bestIteration + 1,
            bestPairsKept: bestIcpIter?.pairsKept ?? 0,
            stopReason: icp.stopReason,
            matrix: summarizeMatrix(icp.matrix4x4),
          },
          finalMethod: useIcp ? 'ICP' : 'SVD',
          finalRmse: round3(finalRmse),
        });

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
        const sx = matrixSimilarityScale(finalMatrix);

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
        appendAlignmentTrace('auto-final-preview', {
          mode: runMode,
          method: useIcp ? 'ICP' : 'SVD',
          pairs: pm.pairs.length,
          rmse: round3(finalRmse),
          meanError: round3(meanError),
          maxError: round3(maxError),
          scale: round3(sx),
          elapsedMs: round3(dt),
        });
        setAutoAlignSummary({
          mode: runMode,
          regionLabel: workingTarRegion ? targetRegionLabel : null,
          pairs: pm.pairs.length,
          rmse: finalRmse,
          scale: sx,
          method: useIcp ? 'ICP' : 'SVD',
          elapsedMs: dt,
        });
        const icpSummary = useIcp
          ? `ICP 已采用：surface RMSE=${icp.rmse.toFixed(4)}，kept=${bestIcpIter?.pairsKept ?? 0}，${icp.iterations.length} 轮 (${icp.stopReason}, best#${icp.bestIteration + 1})`
          : `ICP 未采用：kept=${bestIcpIter?.pairsKept ?? 0} < ${minIcpPairsKept} 或 RMSE 无效`;
        const modeLabel = runMode === 'limb-structure' ? '四肢大结构' : runMode === 'jacket-structure' ? '外套结构' : 'RANSAC';
        onStatusChange(
          `自动对齐完成 · ${modeLabel} · partial=${pm.pairs.length} 对 · ${icpSummary} · 最终 RMSE=${finalRmse.toFixed(4)} · ${dt.toFixed(0)}ms`,
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
    partialMacroSaliencyRings,
    partialMatchMode,
    tarRegion,
    tarRegionLabel,
    activeTargetRegionLabel,
    targetRegionSelectionMode,
    selectedTargetRegionLabel,
    maskReproj,
    segPack,
    maskImageUrl,
    refImageSize,
    orthoCamera,
    autoFit,
    fitBBox,
    orthoScale,
    orthoOffsetX,
    orthoOffsetY,
    icpMaxIterations,
    icpSampleCount,
    icpRejectMultiplier,
    icpConvergenceImprovement,
    buildTarRegionFromSet,
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
    setAutoAlignSummary(null);
    setSourceGalleryBinding(null);
    setSelectedSrcIndex(null);
    setCenterViewMode('landmark');
    onStatusChange('已将对齐结果应用到 Source 模型与 Source landmarks', 'success');
  };

  const restoreDemo = useCallback(async () => {
    const srcUrl = '/demo/alignmenttest_arm_hires_Deformed.glb';
    const tarUrl = '/demo/alignmenttest_bot.glb';
    try {
      onStatusChange('正在加载 Demo: arm_hires_Deformed (源) + bot (目标整身)…', 'info');
      const [srcLoaded, tarLoaded] = await Promise.all([
        loadGlbAsMesh(srcUrl),
        loadGlbAsMesh(tarUrl),
      ]);
      setSrcMesh({
        name: 'alignmenttest_arm_hires_Deformed.glb',
        vertices: srcLoaded.vertices,
        faces: srcLoaded.faces,
      });
      setSourceGalleryBinding(null);
      setTargetRegionSelectionMode('auto');
      setTarMesh({
        name: 'alignmenttest_bot.glb',
        vertices: tarLoaded.vertices,
        faces: tarLoaded.faces,
      });
      clearAllLandmarks();
      setAlignResult(null);
      setResultPreview(null);
      setAutoAlignSummary(null);
      setSelectedSrcIndex(null);
      setSelectedTarIndex(null);
      setSrcRegion(null);
      setTarRegion(null);
      setTarRegionLabel(null);
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setOrthoCamera(null);
      setMaskReproj(null);
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
      setSourceGalleryBinding(null);
      setTargetRegionSelectionMode('auto');
      setTarMesh(demoTarget);
      clearAllLandmarks();
      setAlignResult(null);
      setResultPreview(null);
      setAutoAlignSummary(null);
      setSelectedSrcIndex(null);
      setSelectedTarIndex(null);
      setSrcRegion(null);
      setTarRegion(null);
      setTarRegionLabel(null);
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setOrthoCamera(null);
      setMaskReproj(null);
      setCandidates([]);
      setAcceptedCandidateIds(new Set());
      onStatusChange(
        `Demo GLB 加载失败（${err instanceof Error ? err.message : '未知错误'}），已回退到内置盒子 Demo`,
        'warning',
      );
    }
  }, [clearAllLandmarks, demoTarget, onStatusChange]);

  const loadRoughModel = useCallback(async () => {
    if (!project) {
      onStatusChange('请先打开工程', 'warning');
      return;
    }
    try {
      onStatusChange('正在加载 Page1 粗模 (3D Model) 到 Target…', 'info');
      const rough = await loadLatest('page1.rough');
      if (!rough) {
        onStatusChange('Page1 尚未生成 3D Model（粗模），请先在 Page1 完成生成', 'warning');
        return;
      }
      const mesh = await loadGlbAsMesh(rough.url);
      setTarMesh({
        name: rough.version.file,
        vertices: mesh.vertices,
        faces: mesh.faces,
      });
      clearAllLandmarks();
      setAlignResult(null);
      setResultPreview(null);
      setAutoAlignSummary(null);
      setSelectedTarIndex(null);
      setTarRegion(null);
      setTarRegionLabel(null);
      setOrthoRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setOrthoCamera(null);
      setMaskReproj(null);
      setCandidates([]);
      setAcceptedCandidateIds(new Set());
      setCenterViewMode('landmark');
      onStatusChange(
        `已加载 Page1 粗模到 Target：${rough.version.file} · V/F=${mesh.vertices.length}/${mesh.faces.length}`,
        'success',
      );
    } catch (err) {
      onStatusChange(
        `加载 Page1 粗模失败：${err instanceof Error ? err.message : '未知错误'}`,
        'error',
      );
    }
  }, [project, loadLatest, clearAllLandmarks, onStatusChange]);

  // 页面挂载时自动加载 Demo (arm hires Deformed)，作为初始模型
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

  const meshGalleryPanel = (
    <div
      style={{
        borderTop: '1px solid var(--border-default)',
        background: 'var(--bg-surface)',
        padding: '8px 10px',
        height: 172,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
          Mesh Gallery
        </div>
        <Button
          size="sm"
          onClick={() => {
            void refreshHighresGallery();
          }}
          loading={galleryLoading}
        >
          刷新
        </Button>
      </div>

      {!project && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          未打开工程，无法读取 Page2 的 highres 输出。
        </div>
      )}

      {project && highresHistory.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Page2 暂无 Pipeline 当前使用的 3D Model。
        </div>
      )}

      {project && highresHistory.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
              overflowY: 'hidden',
              paddingBottom: 4,
              minHeight: 104,
            }}
          >
            {highresHistory.map((v) => {
              const selected = selectedGalleryId === v.id;
              const bound = sourceGalleryBinding?.pipelineKey === v.pipelineKey;
              const snapshot = gallerySnapshots[v.id];
              return (
                <button
                  key={v.id}
                  onClick={() => {
                    void handleSelectGalleryItem(v);
                  }}
                  onDoubleClick={() => {
                    void handleOpenGalleryToSource(v);
                  }}
                  title="单击预览，双击加载到 Source。列表只显示 Page2 每条 Pipeline 当前选中的模型。"
                  style={{
                    flex: '0 0 320px',
                    height: 104,
                    textAlign: 'left',
                    background: selected ? 'var(--bg-elevated)' : 'var(--bg-app)',
                    border: selected ? '1px solid var(--accent-blue)' : '1px solid var(--border-default)',
                    borderRadius: 4,
                    padding: '8px 10px',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    position: 'relative',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'stretch',
                  }}
                >
                  {bound && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 6,
                        right: 8,
                        fontSize: 10,
                        color: '#7fd97f',
                        fontWeight: 700,
                      }}
                    >
                      Source
                    </div>
                  )}
                  <div
                    style={{
                      flex: '0 0 96px',
                      height: 76,
                      alignSelf: 'center',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 3,
                      background: '#20242a',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      color: 'var(--text-muted)',
                      fontSize: 10,
                    }}
                  >
                    {snapshot?.status === 'ready' && snapshot.dataUrl ? (
                      <img
                        src={snapshot.dataUrl}
                        alt={`${v.pipelineName} front preview`}
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    ) : snapshot?.status === 'error' ? (
                      '预览失败'
                    ) : (
                      '生成中…'
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1, paddingRight: 42 }}>
                    <div style={{ fontSize: 10, color: 'var(--accent-blue)', fontWeight: 600, marginBottom: 4 }}>
                      #{v.pipelineIndex + 1} · {v.pipelineName} · {v.pipelineMode === 'multiview' ? 'Jacket Extract' : 'General Extract'}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.file}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      {new Date(v.timestamp).toLocaleString()}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                      静态正视图 · 双击载入 Source
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
    </div>
  );

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
              title="加载 alignmenttest_arm_hires_Deformed.glb (源手臂) + alignmenttest_bot.glb (整身角色)"
            >
              加载 Demo (arm deformed)
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void loadRoughModel();
              }}
              title="加载 Page1 的 3D Model（粗模）到 Target 视口"
            >
              加载粗模
            </Button>
          </div>
          <input ref={srcInputRef} type="file" accept=".glb" style={{ display: 'none' }} onChange={onSrcFileChange} />
          <input ref={tarInputRef} type="file" accept=".glb" style={{ display: 'none' }} onChange={onTarFileChange} />
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Source: {srcMesh.name}
            <br />
            V/F: {srcMesh.vertices.length} / {srcMesh.faces.length}
            {sourceGalleryBinding && (
              <>
                <br />
                Source 同步：#{sourceGalleryBinding.pipelineIndex + 1} · {sourceGalleryBinding.pipelineName}
              </>
            )}
            <br />
            Target: {tarMesh.name}
            <br />
            V/F: {tarMesh.vertices.length} / {tarMesh.faces.length}
          </div>
        </PanelSection>

        <PanelSection title="自动对齐流程">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
            <div>Source 部件：<b>{srcMesh.name}</b></div>
            <div>Target 模型：<b>{tarMesh.name}</b></div>
          </div>

          <div
            style={{
              padding: 8,
              border: '1px solid var(--border-default)',
              borderRadius: 3,
              background: 'var(--bg-app)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              marginBottom: 8,
            }}
          >
            <div style={{ color: segPack ? '#7fd97f' : 'var(--text-muted)', fontWeight: 600 }}>
              SAM3 分割包：{segPack ? '已加载' : '未加载'}
            </div>
            {segPack ? (
              <>
                <div>参考图：{refImageName ?? segPack.imageName}</div>
                <div>Mask：{maskImageName ?? segPack.maskName}</div>
                <div>检测到区域：{regionLabels.join(' / ')}</div>
                <div>
                  当前目标区域：{activeTargetRegionLabel || '未确定'} · {targetRegionSelectionMode === 'manual' ? '手动选择' : '自动推荐'}
                </div>
                <div>
                  Target 正视图：{orthoRenderUrl ? '已自动渲染' : autoLocalizing ? '自动渲染中…' : '待渲染'}
                </div>
                <div>
                  Mask 反投影：{maskReproj ? '已完成' : autoLocalizing ? '自动反投影中…' : '待执行'}
                </div>
                {tarRegion && tarRegionLabel && (
                  <div style={{ color: '#7fd97f' }}>
                    已定位目标区域：{tarRegionLabel} · {tarRegion.vertices.size} 顶点
                  </div>
                )}
              </>
            ) : (
              <div>请选择包含 segmentation.json、参考图和 mask 的目录。</div>
            )}
          </div>

          <Button
            size="sm"
            onClick={() => segPackDirInputRef.current?.click()}
            style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
            title="选择 SAM3 分割包目录，自动读取 segmentation.json、参考图和 mask"
          >
            加载 SAM3 分割包目录
          </Button>

          <input
            ref={segPackDirInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={onSegPackDirChange}
            {...{ webkitdirectory: '', directory: '' }}
          />

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>目标区域</div>
          <select
            value={activeTargetRegionLabel}
            onChange={(e) => {
              const label = e.target.value;
              setSelectedTargetRegionLabel(label);
              setTargetRegionSelectionMode('manual');
              setTarRegion(null);
              setTarRegionLabel(null);
              if (maskReproj && label) handleAdoptRegionAsTarSeed(label);
            }}
            disabled={regionLabels.length === 0}
            style={{
              width: '100%',
              marginBottom: 6,
              background: 'var(--bg-app)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
              borderRadius: 3,
              padding: '4px 6px',
              fontSize: 11,
            }}
          >
            {regionLabels.length === 0 && <option value="">未检测到区域</option>}
            {regionLabels.map((label) => (
              <option key={label} value={label}>{label}</option>
            ))}
          </select>
          {recommendedRegionLabel && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
              系统推荐：{recommendedRegionLabel}，当前模式：{targetRegionSelectionMode === 'manual' ? '手动' : '自动'}（可修改）
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
            <Button
              size="md"
              variant="primary"
              onClick={() => handleAutoAlign('limb-structure')}
              loading={partialLoading || aligning}
              disabled={partialLoading || aligning || srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0}
              style={{ justifyContent: 'center' }}
              title="推荐用于手臂/腿：先用根部、弯折、末端三点做大结构对齐，再用 ICP 内点细化"
            >
              {(partialLoading || aligning) ? '自动对齐中…' : '一键 · 四肢大结构对齐'}
            </Button>
            <Button
              size="md"
              variant="primary"
              onClick={() => handleAutoAlign('jacket-structure')}
              loading={partialLoading || aligning}
              disabled={partialLoading || aligning || srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0}
              style={{ justifyContent: 'center' }}
              title="推荐用于外套/上衣：用 collar / shoulder / cuff / hem 结构图做语义锚点对齐"
            >
              {(partialLoading || aligning) ? '自动对齐中…' : '一键 · 外套结构对齐'}
            </Button>
            <Button
              size="md"
              variant="secondary"
              onClick={() => handleAutoAlign('surface')}
              loading={partialLoading || aligning}
              disabled={partialLoading || aligning || srcMesh.vertices.length === 0 || tarMesh.vertices.length === 0}
              style={{ justifyContent: 'center' }}
              title="保留旧流程：使用表面描述子 + RANSAC 生成候选对，再用 SVD/ICP 对齐"
            >
              {(partialLoading || aligning) ? '自动对齐中…' : '一键 · RANSAC 对齐'}
            </Button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <Button
              size="sm"
              onClick={handleApplyAlignedTransform}
              disabled={!alignResult}
              style={{ justifyContent: 'center' }}
            >
              接受对齐
            </Button>
            <Button
              size="sm"
              onClick={resetPreview}
              disabled={!alignResult && !resultPreview}
              style={{ justifyContent: 'center' }}
            >
              撤销预览
            </Button>
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
          >
            {showAdvanced ? '隐藏高级参数' : '显示高级参数'}
          </Button>
        </PanelSection>

        {showAdvanced && <PanelSection title="2D 定位 (SAM3 验证)" defaultCollapsed>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            用一张参考图（概念图 / Bot.png）+ SAM3/SegFormer mask，对照 Target 的正交正视渲染图，
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
              onClick={() => { void handleRunSegFormerGarmentParse(); }}
              loading={segformerParsing}
              disabled={!refImageUrl || segformerParsing}
              title={refImageUrl
                ? '用 SegFormer 从参考图自动生成服装 segmentation.json + class-id mask，并触发 Target 自动定位'
                : '请先加载参考图'}
            >
              {segformerParsing ? 'SegFormer 分割中…' : 'SegFormer 服装分割'}
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
            {segformerClasses.length > 0 && (
              <>
                <br />
                SegFormer: {segformerClasses.map((c) => `${c.label}=${c.pixels}`).join(', ')}
              </>
            )}
            <br />
            正视渲染: {orthoRenderUrl ? '已就绪' : '(未渲染)'}
          </div>

          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            约定：相机沿 +X 看向 -X，up=+Y，画面右映射到世界 -Z（角色左侧）。
          </div>
        </PanelSection>}

        {showAdvanced && <PanelSection title="部分匹配 (Partial → Whole)" defaultCollapsed>
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

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            Step 1 匹配模式
          </div>
          <div
            style={{
              marginBottom: 6,
              padding: '4px 6px',
              borderRadius: 3,
              background: partialMatchMode === 'limb-structure'
                ? 'rgba(127,217,127,0.12)'
                : partialMatchMode === 'jacket-structure'
                  ? 'rgba(255,187,51,0.12)'
                  : 'var(--bg-app)',
              border: partialMatchMode === 'limb-structure'
                ? '1px solid rgba(127,217,127,0.45)'
                : partialMatchMode === 'jacket-structure'
                  ? '1px solid rgba(255,187,51,0.45)'
                  : '1px solid var(--border-default)',
              color: partialMatchMode === 'limb-structure'
                ? '#7fd97f'
                : partialMatchMode === 'jacket-structure'
                  ? '#ffbb33'
                  : 'var(--text-secondary)',
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            当前模式：{partialMatchMode === 'limb-structure'
              ? '实验 · 肢体大结构'
              : partialMatchMode === 'jacket-structure'
                ? '实验 · 外套结构对齐'
                : '旧模式 · 表面 RANSAC'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
            <Button
              size="sm"
              variant={partialMatchMode === 'limb-structure' ? 'primary' : 'secondary'}
              onClick={() => handleSetPartialMatchMode('limb-structure')}
              style={{ justifyContent: 'center' }}
              title="用 PCA 主轴、根端、弯折面、末端做大结构对齐；适合手臂/腿"
            >
              {partialMatchMode === 'limb-structure' ? '✓ ' : ''}肢体大结构
            </Button>
            <Button
              size="sm"
              variant={partialMatchMode === 'jacket-structure' ? 'primary' : 'secondary'}
              onClick={() => handleSetPartialMatchMode('jacket-structure')}
              style={{ justifyContent: 'center' }}
              title="检测外套 torso / 左右袖的 collar/hem/shoulder/cuff/armpit 结构锚点，SVD 相似变换匹配"
            >
              {partialMatchMode === 'jacket-structure' ? '✓ ' : ''}外套结构
            </Button>
            <Button
              size="sm"
              variant={partialMatchMode === 'surface' ? 'primary' : 'secondary'}
              onClick={() => handleSetPartialMatchMode('surface')}
              style={{ justifyContent: 'center' }}
              title="旧模式：局部表面描述子 + RANSAC，适合形态基本一致的部件"
            >
              {partialMatchMode === 'surface' ? '✓ ' : ''}表面 RANSAC
            </Button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
            当前：{partialMatchMode === 'limb-structure'
              ? '只输出肩/肘/手（或髋/膝/脚）3 个大结构锚点，优先对齐 PCA 方向与弯折朝向。'
              : partialMatchMode === 'jacket-structure'
                ? '分割外套为 torso / 左右袖，检测 collar/hem/shoulder/cuff/armpit 结构锚点，SVD 相似变换匹配。'
                : '输出多组局部表面候选点，仍受局部细节影响。'}
          </div>

          {partialMatchMode === 'limb-structure' && (
            <div
              style={{
                marginBottom: 8,
                padding: 8,
                border: '1px solid rgba(127,217,127,0.35)',
                borderRadius: 3,
                background: 'rgba(127,217,127,0.06)',
                fontSize: 10,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              实验模式：Step 1 会直接检测 root / bend / end 三个结构锚点；下方采样数、Top-K、RANSAC、描述子参数只影响“表面 RANSAC”模式。
            </div>
          )}
          {partialMatchMode === 'jacket-structure' && (
            <div
              style={{
                marginBottom: 8,
                padding: 8,
                border: '1px solid rgba(255,187,51,0.35)',
                borderRadius: 3,
                background: 'rgba(255,187,51,0.06)',
                fontSize: 10,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              实验模式（Phase 0）：用 BBox 启发式分割 torso/左右袖，PCA 检测外套结构锚点，SVD 相似变换匹配。下方采样数、Top-K、RANSAC、描述子参数只影响“表面 RANSAC”模式。
            </div>
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
            Macro saliency rings（抗小突起；越大越看大形）
          </div>
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={partialMacroSaliencyRings}
            onChange={(e) => setPartialMacroSaliencyRings(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            {partialMacroSaliencyRings} rings · 当前描述半径：{PARTIAL_RADIUS_FRACTIONS.join(' / ')} × src bbox
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
            onClick={handleFindPartial}
            loading={partialLoading}
            disabled={partialLoading}
            style={{ width: '100%', justifyContent: 'center' }}
            title={partialMatchMode === 'limb-structure'
              ? '执行结构匹配：检测 root / bend / end 三个大结构锚点，并生成供 Step 2 使用的对应点'
              : partialMatchMode === 'jacket-structure'
                ? '执行外套结构匹配：BBox 分割 torso/左右袖，检测 collar/hem/shoulder/cuff/armpit 锚点，SVD 相似变换匹配'
                : '执行完整 partial-match：采样、descriptor top-K、RANSAC 筛选，并生成供 Step 2 使用的候选对应点'}
          >
            {partialLoading ? '计算中…' : partialMatchMode === 'limb-structure'
              ? 'Step 1 · 结构锚点生成候选对'
              : partialMatchMode === 'jacket-structure'
                ? 'Step 1 · 外套结构锚点生成候选对'
                : 'Step 1 · RANSAC 生成候选对'}
          </Button>
          <Button
            size="sm"
            onClick={handleRunPartialDebug}
            loading={partialLoading}
            disabled={partialLoading}
            style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
            title="仅用于调参诊断：预览 Saliency、FPS 和 Top-K 候选，不生成候选对，不进入 Step 2"
          >
            {partialLoading ? '计算中…' : '诊断：预览采样点 / Top-K'}
          </Button>

          {partialMatchSummary && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                background: 'var(--bg-app)',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                fontSize: 10,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  color: partialMatchSummary.status === 'success' ? '#7fd97f' : '#e08a8a',
                  marginBottom: 4,
                }}
              >
                {partialMatchSummary.mode === 'limb-structure' ? '结构锚点结果' : 'RANSAC 结果'}：{partialMatchSummary.status === 'success' ? '成功' : '失败'}
              </div>
              {partialMatchSummary.mode === 'limb-structure' ? (
                <>
                  <div>Anchors：root / bend / end</div>
                  <div>Source bend strength：{diagnosticNumber(partialMatchSummary.diagnostics, 'srcBendStrength')?.toFixed(4) ?? '-'}</div>
                  <div>Target bend strength：{diagnosticNumber(partialMatchSummary.diagnostics, 'tarBendStrength')?.toFixed(4) ?? '-'}</div>
                  <div>Target root by：{diagnosticString(partialMatchSummary.diagnostics, 'targetRootBy') ?? '-'}</div>
                  <div>Final pairs：{partialMatchSummary.pairs}</div>
                </>
              ) : (
                <>
                  <div>Source samples：{partialMatchSummary.rawSrcSamples}</div>
                  <div>Target samples：{partialMatchSummary.rawTarSamples}</div>
                  <div>Top-K：{partialMatchSummary.topK}</div>
                  <div>Iterations：{partialMatchSummary.iterationsRun}</div>
                  <div>Best inliers：{partialMatchSummary.bestInlierCount}</div>
                  <div>Final pairs：{partialMatchSummary.pairs}</div>
                  <div>Threshold：{partialMatchSummary.thresholdUsed.toFixed(4)}</div>
                </>
              )}
              <div>
                RMSE：{Number.isFinite(partialMatchSummary.rmse) ? partialMatchSummary.rmse.toFixed(4) : '∞'}
              </div>
              <div>耗时：{partialMatchSummary.elapsedMs.toFixed(1)}ms</div>
              {partialMatchSummary.warnings && partialMatchSummary.warnings.length > 0 && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-default)', color: '#e9d36c' }}>
                  {partialMatchSummary.warnings.map((warning, i) => (
                    <div key={i}>⚠ {warning}</div>
                  ))}
                </div>
              )}
              {partialMatchSummary.timings && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-default)' }}>
                  <div>计时 total：{partialMatchSummary.timings.totalMs.toFixed(1)}ms</div>
                  <div>saliency：{partialMatchSummary.timings.saliencyMs.toFixed(1)}ms</div>
                  <div>sampling：{partialMatchSummary.timings.samplingMs.toFixed(1)}ms</div>
                  <div>spatial hash：{partialMatchSummary.timings.spatialHashMs.toFixed(1)}ms</div>
                  <div>FPFH/SPFH：{partialMatchSummary.timings.fpfhSpfhMs.toFixed(1)}ms</div>
                  <div>topK：{partialMatchSummary.timings.topKMs.toFixed(1)}ms</div>
                  <div>RANSAC：{partialMatchSummary.timings.ransacMs.toFixed(1)}ms</div>
                  <div>axial trials：{partialMatchSummary.timings.axialTrials.length}</div>
                </div>
              )}
            </div>
          )}
        </PanelSection>}

        {showAdvanced && partialDebug && (
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

        {showAdvanced && <PanelSection title="Step 1 候选对 / 结构锚点" defaultCollapsed>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
            这里显示 Step 1 输出的 source ↔ target 对应点：结构模式通常是 root / bend / end 3 对，表面模式是 RANSAC 筛选后的候选点。
            可以单独审阅、接受或拒绝；接受后用于 Step 2 Landmark SVD。
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
                运行“一键 · 四肢大结构对齐 / RANSAC 对齐”或 Step 1 后，候选对会出现在这里。
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
        </PanelSection>}

        {showAdvanced && <PanelSection title="全网格查找 (Global)" defaultCollapsed>
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
        </PanelSection>}
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

        {meshGalleryPanel}
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
        <PanelSection title="结果质量">
          {autoAlignSummary ? (() => {
            const q = qualityLabel(autoAlignSummary);
            return (
              <div
                style={{
                  padding: 8,
                  borderRadius: 3,
                  border: `1px solid ${q.color}`,
                  background: 'var(--bg-app)',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                  lineHeight: 1.7,
                }}
              >
                <div style={{ color: q.color, fontWeight: 700 }}>对齐质量：{q.label}</div>
                <div>目标区域：{autoAlignSummary.regionLabel ?? '(未指定)'}</div>
                <div>一键模式：{autoAlignSummary.mode === 'limb-structure' ? '四肢大结构' : autoAlignSummary.mode === 'jacket-structure' ? '外套结构' : 'RANSAC'}</div>
                <div>匹配点：{autoAlignSummary.pairs}</div>
                <div>RMSE：{autoAlignSummary.rmse.toFixed(3)}</div>
                <div>Scale：{autoAlignSummary.scale.toFixed(3)}</div>
                <div>最终方法：{autoAlignSummary.method}</div>
                <div>耗时：{(autoAlignSummary.elapsedMs / 1000).toFixed(1)}s</div>
              </div>
            );
          })() : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              点击“一键 · 四肢大结构对齐”或“一键 · RANSAC 对齐”后，这里会显示匹配点、RMSE、scale 和质量评级。
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
            <Button size="sm" variant="primary" onClick={handleApplyAlignedTransform} disabled={!alignResult} style={{ justifyContent: 'center' }}>
              接受对齐
            </Button>
            <Button size="sm" onClick={resetPreview} disabled={!alignResult && !resultPreview} style={{ justifyContent: 'center' }}>
              撤销
            </Button>
            <Button size="sm" onClick={() => handleAutoAlign('limb-structure')} loading={partialLoading || aligning} disabled={partialLoading || aligning} style={{ justifyContent: 'center' }}>
              重跑大结构
            </Button>
            <Button size="sm" onClick={() => handleAutoAlign('jacket-structure')} loading={partialLoading || aligning} disabled={partialLoading || aligning} style={{ justifyContent: 'center' }}>
              重跑外套结构
            </Button>
            <Button size="sm" onClick={() => handleAutoAlign('surface')} loading={partialLoading || aligning} disabled={partialLoading || aligning} style={{ justifyContent: 'center' }}>
              重跑 RANSAC
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setCenterViewMode('result');
                setResultViewMode('overlay');
              }}
              disabled={!resultPreview}
              style={{ justifyContent: 'center' }}
            >
              查看结果
            </Button>
          </div>
        </PanelSection>

        {(showAdvanced || alignmentTrace.length > 0) && (
          <PanelSection title="对齐诊断日志" defaultCollapsed={alignmentTrace.length === 0}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(JSON.stringify(alignmentTrace, null, 2));
                  onStatusChange('已复制对齐诊断日志', 'success');
                }}
                disabled={alignmentTrace.length === 0}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                复制日志
              </Button>
              <Button
                size="sm"
                onClick={clearAlignmentTrace}
                disabled={alignmentTrace.length === 0}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                清空
              </Button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
              同时会输出到浏览器控制台：<b>[Page3Align]</b>。
            </div>
            <pre
              style={{
                maxHeight: 360,
                overflow: 'auto',
                margin: 0,
                padding: 8,
                background: 'var(--bg-app)',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                color: 'var(--text-secondary)',
                fontSize: 10,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {alignmentTrace.length === 0
                ? '暂无日志。运行自动对齐或手动反投影后会显示。'
                : alignmentTrace.map((e) => `${e.time} ${e.stage}\n${JSON.stringify(e.data, null, 2)}`).join('\n\n')}
            </pre>
          </PanelSection>
        )}

        {showAdvanced && <PanelSection title="Landmark 显示">
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
        </PanelSection>}

        {showAdvanced && <PanelSection title="Landmark Pairs" defaultCollapsed>
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
        </PanelSection>}

        {showAdvanced && <PanelSection title="Step 2/3 · Landmark SVD / ICP 手动对齐">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            模式固定为 Similarity（旋转 + 平移 + 统一缩放）。
            <br />
            当前输入：{manualPairSourceLabel}
            {manualAlignmentPairs ? ` · ${manualAlignmentPairs.count} 对` : ' · 至少需要 3 对'}
          </div>

          <Button
            variant="primary"
            size="sm"
            loading={aligning}
            onClick={handleRunAlign}
            disabled={aligning || !manualAlignmentPairs}
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            title="Step 2：使用当前 Landmark Pairs / 已接受候选 / Partial 候选执行 Similarity SVD 对齐"
          >
            Step 2 · Landmark SVD 对齐
          </Button>

          <div
            style={{
              marginTop: 10,
              padding: 8,
              border: '1px solid var(--border-default)',
              borderRadius: 3,
              background: 'var(--bg-app)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 6 }}>
              Step 3 · ICP 参数
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>最大迭代数</div>
            <input
              type="range"
              min={5}
              max={80}
              step={5}
              value={icpMaxIterations}
              onChange={(e) => setIcpMaxIterations(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              {icpMaxIterations}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Source 采样点数</div>
            <input
              type="range"
              min={100}
              max={1200}
              step={50}
              value={icpSampleCount}
              onChange={(e) => setIcpSampleCount(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              {icpSampleCount}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>离群点拒绝倍数</div>
            <input
              type="range"
              min={1}
              max={5}
              step={0.1}
              value={icpRejectMultiplier}
              onChange={(e) => setIcpRejectMultiplier(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              {icpRejectMultiplier.toFixed(1)} × median distance
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>收敛阈值</div>
            <input
              type="range"
              min={0.001}
              max={0.02}
              step={0.001}
              value={icpConvergenceImprovement}
              onChange={(e) => setIcpConvergenceImprovement(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
              {(icpConvergenceImprovement * 100).toFixed(1)}% improvement
            </div>

            <Button
              size="sm"
              variant="primary"
              loading={aligning}
              onClick={handleRunIcpAlign}
              disabled={aligning || !alignResult || !manualAlignmentPairs}
              style={{ width: '100%', justifyContent: 'center' }}
              title="Step 3：从当前 SVD 结果出发执行逐顶点 ICP refine"
            >
              Step 3 · ICP refine
            </Button>
          </div>

          <Button
            size="sm"
            onClick={handleApplyAlignedTransform}
            disabled={!alignResult}
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            title="将当前对齐结果真正写回 Source 网格与 Source landmarks"
          >
            应用变换
          </Button>

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
                ✓ Similarity Alignment Ready
              </div>
              <div>RMSE: {alignResult.rmse.toFixed(5)}</div>
              <div>Mean: {alignResult.meanError.toFixed(5)}</div>
              <div>Max: {alignResult.maxError.toFixed(5)}</div>
              <div>Scale: {alignResult.scale.toFixed(5)}</div>
            </div>
          )}
        </PanelSection>}

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
