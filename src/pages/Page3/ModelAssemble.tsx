/**
 * Stage 6 (refactor master plan) — Page3 V2 GUI scaffold.
 *
 * 设计意图：
 *   - 落地 ModelAssembleMockup.tsx 的视觉布局（3 列：360 / 1fr / 360）。
 *   - 策略卡 + 步骤面板的数据来源切换成 Stage 5 的 services/alignStrategies 注册表，
 *     不再是 mockup 里硬编码的 STRATEGIES / STEPS_BY_STRATEGY。
 *   - 中央视口区与左侧数据面板沿用 mockup 的占位形态，待后续切片把
 *     生产 ModelAssemble 中的 DualViewport / ResultPreview / SAM3 装载器
 *     拆成可复用组件再嵌入（计划中的 "2-3 commits by component slice"）。
 *   - 通过 ?v2 query param 切换，与生产 ModelAssemble 并存（Stage 7 才考虑做默认）。
 *
 * Stage 7/1 切片（2026-05-04）：
 *   - useProject() 接通：hasPoseProxyJoints 现在来自 project.meta.page1.joints。
 *
 * Stage 7/2 切片（2026-05-04）：
 *   - 接通 hasSource / hasTarget：通过 listHistory('page2.highres') 和
 *     listHistory('page1.rough') 检测工程内是否已有可加载的 GLB 文件。
 *
 * Stage 7/3c 切片（2026-05-04）：
 *   - 接通 hasSegPack：通过 loadPage3SegPack() 读取工程内上次在 V1
 *     保存的 SegPack（page3.segpack node）。
 *
 * Stage 7/4 切片（2026-05-04）：
 *   - srcLandmarkCount / tarLandmarkCount：订阅全局 useLandmarkStore（V1/V2 共享）。
 *   - hasAdjacency：逻辑上等价于 hasSource && hasTarget。
 *
 * Stage 7/5 切片（2026-05-04）：
 *   - hasBodyTorsoRegion：加载 SegPack 后解析 segmentation.json，
 *     检测 regions 里是否含 body/torso/jacket/coat 标签。
 *   - 进度：8/9。剩下 1/9 （3 字段为组）是 2D 定位交互产生的
 *     transient state：hasTargetRegion / hasMaskReprojection / hasOrthoCamera。
 *   - 这里只判存在性，不实际 load blob（避免 URL.createObjectURL 泄漏，且接
 *     通 mesh 视口是更后面的切片）。
 *   - 进度：3/9。
 *
 * Stage 7/6 切片（2026-05-04）：达成 9/9。
 *   - 会话快照 page3_session.json（V1 在 setOrthoCamera/setMaskReproj/
 *     setTarRegion 成功点写入）。V2 只读快照推导进度状态条，
 *     不重复运行 2D 定位管线。
 *   - hasOrthoCamera = !!session.orthoCamera
 *   - hasMaskReprojection = !!session.maskReprojection
 *   - hasTargetRegion = !!session.targetRegionLabel
 *   - 不存购重 payload（per-vertex map）—— V2 进度条只需事实。
 *
 * Stage 8/1 切片（2026-05-04）：中央视口接通。
 *   - refreshAssets 在确认 page2.highres / page1.rough 存在后，立刻 loadLatest()
 *     + loadGlbAsMesh() 把 GLB 解析成 vertices/faces（解析后立刻 revoke URL，
 *     不持有 ObjectURL，避免内存泄漏）。
 *   - 中央占位 div 替换为 <DualViewport>，订阅 useLandmarkStore 显示 V1 已添加
 *     的 landmark。
 *   - 仍保持只读：picking/click/move/delete 全 disabled；landmark 编辑入口
 *     仍在 V1。后续切片会逐步把交互搬过来。
 *
 * Stage 8/2 切片（2026-05-04）：V2 入口可编辑 landmark。
 *   - Ctrl+Click 添加、点击选中、Drag 移动、Delete 删除 —— 全部直接 dispatch 到
 *     useLandmarkStore。V1 仍能同时读到同一份 state（全局 zustand）。
 *   - resetPreview 还未接入（V1 里是清 alignResult+resultPreview），等 Stage 8/3
 *     run 接通后一起处理。
 *   - status callback 走 _props.onStatusChange（V2 先前必须响应以便调试）。
 *
 * Stage 8/3 切片（2026-05-04）：Manual 策略 Run 接通。
 *   - 仅 manual 策略在 V2 可运行（它是纯函数 alignSourceMeshByLandmarks，
 *     不依赖 V1 那些 500 行闭包）。其他 3 套 auto 策略的 run 仍在 V1
 *     handleAutoAlign 里，本切片不动，只在 V2 上显示提示。
 *   - Run 入口为右侧面板顶部的 [▶ 运行对齐] 按钮（与选中策略联动）。
 *   - 运行后展示 RMSE / scale；接受。应用 transform 到实际 srcMesh + landmarks
 *     使用与 V1 同名的 store action transformSrcLandmarks。
 *   - QualityDrawer 接入真实 RMSE / meanError / maxError / scale。
 *
 * Stage 8/4 切片（2026-05-04）：Result Preview overlay。
 *   - 中央区增加 centerView 切换：landmark / result。Run 成功后自动跳到 result。
 *   - result 子模式 overlay/aligned/target/original 完全复制 V1 ResultPreviewPanel
 *     的语义（line 5310-5419）。overlay 同时显示对齐后的 src + target。
 *   - Reset/Accept 同时切回 landmark 视图。
 *   - 依然只在 manual 策略下可运行；auto 策略提示不变。
 *
 * 边界：
 *   - 不重新实现任何对齐算法；auto 策略仍由现存 ModelAssemble 持有。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { useProject } from '../../contexts/ProjectContext';
import type { Page3Session, AssetVersion } from '../../services/projectStore';
import { parseSegmentationJson } from '../../services/segmentationPack';
import { parseGarmentsSegFormer } from '../../services/garmentParsing';
import {
  DualViewport,
  MeshViewer,
  loadGlbAsMesh,
  exportMeshAsGlb,
  useLandmarkStore,
  buildMeshAdjacency,
  renderOrthoFrontViewWithCamera,
  icpRefine,
  type Face3,
  type Vec3,
  type ViewMode,
  type MeshRegion,
  type OrthoFrontCamera,
  type LoadedModel,
} from '../../three';
import { alignSourceMeshByLandmarks, type AlignmentResult } from '../../three/alignment';
import { runLimbStructure, runSurface, runPoseProxy } from '../../services/alignStrategies/runners';
import { SAM3Panel } from './SAM3Panel';
import { TargetGallery, type TargetGalleryItem, type TargetKind } from './TargetGallery';
import { HighresGallery, type HighresGalleryItem } from './HighresGallery';
import { LoadedModelList } from './LoadedModelList';
import { regionHslCss, regionHslCssBright, regionHslCssDim } from '../../components/SegPackOverlay';
import type { Joint2D } from '../../types/joints';
import { transformJointsBySmartCrop } from '../../services/dwpose';
import {
  ALIGN_STRATEGIES,
  summarizeReadiness,
  type AlignStrategy,
  type AlignStrategyContext,
  type AlignStrategyId,
  type RequirementCheck,
  type StrategyReadiness,
  type StrategyStep,
} from '../../services/alignStrategies';
import {
  collectJoints,
  renderSrcOrtho,
  buildProxies,
  solveSvd,
  solveIcp,
  type CollectJointsOutput,
  type RenderSrcOrthoOutput,
  type BuildProxiesOutput,
  type SolveSvdOutput,
  type SolveIcpOutput,
} from '../../services/alignStrategies/poseProxySteps';

interface ModelAssembleProps {
  onStatusChange?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

/** 与生产 ModelAssemble.findMaskRegion 同一组词汇（line 431-432）。 */
const BODY_TORSO_LABELS = ['body', 'torso', 'jacket', 'coat'];
function segPackHasBodyTorso(regionLabels: string[]): boolean {
  return regionLabels.some((label) => {
    const lower = label.toLowerCase();
    return BODY_TORSO_LABELS.some((kw) => lower.includes(kw));
  });
}


const READINESS_COLOR: Record<StrategyReadiness, string> = {
  ready: '#5cb85c',
  partial: '#e8b740',
  blocked: '#888',
};
const READINESS_ICON: Record<StrategyReadiness, string> = {
  ready: '🟢',
  partial: '🟡',
  blocked: '⚪',
};
const READINESS_LABEL: Record<StrategyReadiness, string> = {
  ready: '全部就绪',
  partial: '部分就绪',
  blocked: '依赖缺失',
};

interface MeshData {
  vertices: Vec3[];
  faces: Face3[];
}

export function ModelAssemble(props: ModelAssembleProps) {
  const { onStatusChange } = props;
  const { project, listHistory, loadLatest, loadByName, loadPage1SegPack, loadPage3Session, saveAsset, savePage3SegPack, loadPipelines } = useProject();
  // Stage 7/4: 订阅全局 landmark store（V1/V2 共享）。
  const srcLandmarks = useLandmarkStore((s) => s.srcLandmarks);
  const tarLandmarks = useLandmarkStore((s) => s.tarLandmarks);
  const addSrcLandmark = useLandmarkStore((s) => s.addSrcLandmark);
  const addTarLandmark = useLandmarkStore((s) => s.addTarLandmark);
  const updateSrcLandmark = useLandmarkStore((s) => s.updateSrcLandmark);
  const updateTarLandmark = useLandmarkStore((s) => s.updateTarLandmark);
  const removeSrcLandmark = useLandmarkStore((s) => s.removeSrcLandmark);
  const removeTarLandmark = useLandmarkStore((s) => s.removeTarLandmark);
  const transformSrcLandmarks = useLandmarkStore((s) => s.transformSrcLandmarks);
  const srcLandmarkCount = srcLandmarks.length;
  const tarLandmarkCount = tarLandmarks.length;
  // Stage 8/2: V2 内部选中状态（V1 有同名 state，不共享 — 两个面板独立选中可接受）。
  const [selectedSrcIndex, setSelectedSrcIndex] = useState<number | null>(null);
  const [selectedTarIndex, setSelectedTarIndex] = useState<number | null>(null);
  // Stage 8/3: Run 状态 + 对齐结果。
  const [aligning, setAligning] = useState(false);
  const [alignResult, setAlignResult] = useState<AlignmentResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Phase A2: pose-proxy 真分步状态 — 每步缓存结果，null = 未跑 / 待跑。
  type PoseProxyStepState = {
    joints: CollectJointsOutput | null;
    srcRender: RenderSrcOrthoOutput | null;
    proxies: BuildProxiesOutput | null;
    svd: SolveSvdOutput | null;
    icp: SolveIcpOutput | null;
  };
  const [poseProxyState, setPoseProxyState] = useState<PoseProxyStepState>({
    joints: null,
    srcRender: null,
    proxies: null,
    svd: null,
    icp: null,
  });
  // Marker visibility toggles for pose-proxy debug overlay.
  const [showJointSeeds, setShowJointSeeds] = useState(true);
  const [showCapsuleAnchors, setShowCapsuleAnchors] = useState(true);
  const [showSpecialAnchors, setShowSpecialAnchors] = useState(true);
  /** Show pipeline joints (SmartCrop affine-mapped 2D→3D unprojected) on src side. */
  const [showPipelineJointsOverlay, setShowPipelineJointsOverlay] = useState(false);
  /** Show SAM3 semantic segmentation reprojection overlay on target mesh. */
  const [showTarSegOverlay, setShowTarSegOverlay] = useState(true);
  /** World-X offset of the 2D→3D marker plane from meshFrontX (units). */
  const [pipelineJointOffset, setPipelineJointOffset] = useState(2);

  // Stage 8/4: 中央视图模式 与 结果预览子模式。
  type CenterView = 'landmark' | 'result';
  type ResultView = 'overlay' | 'aligned' | 'target' | 'original';
  const [centerView, setCenterView] = useState<CenterView>('landmark');
  const [resultView, setResultView] = useState<ResultView>('overlay');
  // Stage 9 + Phase C: SAM3 目标分割状态汇总为单个状态对象，
  // 避免多个独立 useState 不同步。下游代码依然通过解构别名访问。
  type TarSegmentationState = {
    region: MeshRegion | null;
    label: string | null;
    orthoCamera: OrthoFrontCamera | null;
    /** 反投影后的每区域顶点集（可选）——用于在中央 3D 视口高亮全部 SegPack 区域。 */
    reprojRegions: Array<{ regionIndex: number; label: string; vertices: number[] }> | null;
  };
  const [tarSegmentationState, setTarSegmentationState] = useState<TarSegmentationState>({
    region: null, label: null, orthoCamera: null, reprojRegions: null,
  });
  const tarRegion = tarSegmentationState.region;
  const tarRegionLabel = tarSegmentationState.label;
  const tarOrthoCamera = tarSegmentationState.orthoCamera;
  const tarReprojRegions = tarSegmentationState.reprojRegions;
  const handleAdoptRegion = useCallback(
    (region: MeshRegion | null, label: string | null, camera: OrthoFrontCamera | null) => {
      setTarSegmentationState((prev) => ({ ...prev, region, label, orthoCamera: camera }));
    },
    [],
  );
  const setTarReprojRegions = useCallback(
    (r: Array<{ regionIndex: number; label: string; vertices: number[] }> | null) => {
      setTarSegmentationState((prev) => ({ ...prev, reprojRegions: r }));
    },
    [],
  );
  // Stage 8/1: 中央视口需要的 mesh 数据。null = 尚未加载/工程内无文件。
  const [srcMesh, setSrcMesh] = useState<MeshData | null>(null);
  const [tarMesh, setTarMesh] = useState<MeshData | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const [meshLoadError, setMeshLoadError] = useState<string | null>(null);
  // Phase 1e: multi-model source viewport state
  const [srcModels, setSrcModels] = useState<LoadedModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const loadedModelIds = useMemo(() => new Set(srcModels.map((m) => m.id)), [srcModels]);
  /** Per-view jacket-only joints (SmartCrop-mapped from Page1 global joints).
   *  null = not yet resolved / no pipeline info / fallback to full-body. */
  const [pipelineJoints, setPipelineJoints] = useState<Record<string, Joint2D[]> | null>(null);
  /** Image size of the Page2 split view that pipelineJoints are in.
   *  Used to scale joints to match the srcCamera resolution. */
  const [pipelineJointImageSize, setPipelineJointImageSize] = useState<{ width: number; height: number } | null>(null);
  // 跟踪当前活跃的 refresh 序号，防止 race condition（旧请求晚于新请求返回）。
  const refreshSeqRef = useRef(0);
  const [selectedId, setSelectedId] = useState<AlignStrategyId>('pose-proxy');
  const [expandedReqs, setExpandedReqs] = useState<Set<AlignStrategyId>>(new Set());
  const [showLogs, setShowLogs] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  // Stage 10: ICP refine params (manual + auto post-refine).
  const [icpMaxIter, setIcpMaxIter] = useState(30);
  const [icpRejectMul, setIcpRejectMul] = useState(2.5);
  const [icpSampleCount, setIcpSampleCount] = useState(400);
  // Stage 10: trace log of align runs.
  type TraceEntry = {
    id: number;
    ts: string;
    method: string;
    rmse: number;
    meanError: number;
    pairsKept?: number;
    iterations?: number;
    ok: boolean;
    note?: string;
  };
  const [traceLog, setTraceLog] = useState<TraceEntry[]>([]);
  const traceIdRef = useRef(0);
  const pushTrace = useCallback((e: Omit<TraceEntry, 'id' | 'ts'>) => {
    setTraceLog((prev) => [
      { id: ++traceIdRef.current, ts: new Date().toLocaleTimeString(), ...e },
      ...prev,
    ].slice(0, 20));
  }, []);

  // Stage 7/2: 检测工程内是否已存在 source/target GLB（不实际 load blob）。
  //   source = page2.highres（高模，对齐起点）
  //   target = page1.rough（粗模，对齐目标姿态）
  // 命名沿用生产 ModelAssemble 的语义（src→tar 表示对齐方向）。
  const [sourceFileCount, setSourceFileCount] = useState(0);
  const [targetFileCount, setTargetFileCount] = useState(0);
  // Stage 11: full version history per side + currently chosen file name.
  const [srcHistory, setSrcHistory] = useState<AssetVersion[]>([]);
  const [tarHistory, setTarHistory] = useState<AssetVersion[]>([]);
  const [srcChosenName, setSrcChosenName] = useState<string | null>(null);
  const [tarChosenName, setTarChosenName] = useState<string | null>(null);
  // PR-B/C: which Page1 3D output is currently bound to Target.
  //   'clothed'  → page1.rough           + page1.segpack.clothed
  //   'nojacket' → page1.rough.nojacket  + page1.segpack.nojacket
  // SegPack 数据源完全跟随 tarKind，不再回退到 page3.segpack。
  const [tarKind, setTarKind] = useState<TargetKind>('clothed');
  // Stage 7/3c: SegPack 检测。
  const [segPackDirName, setSegPackDirName] = useState<string | null>(null);
  // Stage 7/5: SegPack 里是否有 body/torso 标签。
  const [segPackRegionLabels, setSegPackRegionLabels] = useState<string[]>([]);
  // Stage 7/6: 会话快照。
  const [session, setSession] = useState<Page3Session | null>(null);
  const refreshAssets = useCallback(() => {
    if (!project) {
      setSourceFileCount(0);
      setTargetFileCount(0);
      setSegPackDirName(null);
      setSegPackRegionLabels([]);
      setSession(null);
      setSrcMesh(null);
      setTarMesh(null);
      setMeshLoadError(null);
      setPipelineJoints(null);
      setPipelineJointImageSize(null);
      return;
    }
    const seq = ++refreshSeqRef.current;
    // PR-C: target 侧 NODE_KEY 由 tarKind 决定；SegPack 同步取对应 slot。
    const tarNodeKey: 'page1.rough' | 'page1.rough.nojacket' =
      tarKind === 'nojacket' ? 'page1.rough.nojacket' : 'page1.rough';
    void Promise.all([
      listHistory('page2.highres'),
      listHistory(tarNodeKey),
      loadPage1SegPack(tarKind),
      loadPage3Session(),
    ]).then(async ([src, tar, segpack, sess]) => {
      if (seq !== refreshSeqRef.current) return;
      setSourceFileCount(src.length);
      setTargetFileCount(tar.length);
      setSrcHistory(src);
      setTarHistory(tar);
      setSegPackDirName(segpack?.dirName ?? null);
      setSession(sess);
      // Stage 7/5: 只解析 json（快），不加载 mask。
      if (segpack?.jsonBlob) {
        try {
          const text = await segpack.jsonBlob.text();
          const pack = parseSegmentationJson(text);
          setSegPackRegionLabels(pack.regions.map((r) => r.label));
        } catch (err) {
          console.warn('[V2] SegPack json 解析失败:', err);
          setSegPackRegionLabels([]);
        }
      } else {
        setSegPackRegionLabels([]);
      }
      // Stage 8/1: 加载实际 mesh 数据。失败不阻塞 readiness 面板。
      setMeshLoadError(null);
      const loadSide = async (
        nodeKey: string,
        chosenName: string | null,
        history: AssetVersion[],
      ): Promise<MeshData | null> => {
        try {
          // Stage 11: prefer the explicitly-chosen version when present in
          // history; otherwise fall through to loadLatest.
          const useChosen = chosenName && history.some((v) => v.file === chosenName);
          const latest = useChosen
            ? await loadByName(nodeKey, chosenName!)
            : await loadLatest(nodeKey);
          if (!latest) return null;
          const loaded = await loadGlbAsMesh(latest.url);
          // 解析完成立刻 revoke，避免 ObjectURL 泄漏（与 V1 line 2366 同模式）。
          URL.revokeObjectURL(latest.url);
          return { vertices: loaded.vertices, faces: loaded.faces };
        } catch (err) {
          console.warn(`[V2] mesh 加载失败 (${nodeKey}):`, err);
          throw err;
        }
      };
      try {
        const [s, t] = await Promise.all([
          src.length > 0 ? loadSide('page2.highres', srcChosenName, src) : Promise.resolve(null),
          tar.length > 0 ? loadSide(tarNodeKey, tarChosenName, tar) : Promise.resolve(null),
        ]);
        if (seq !== refreshSeqRef.current) return;
        setSrcMesh(s);
        setTarMesh(t);

        // SmartCrop bone cropping: resolve pipeline joints for src mesh
        if (s && project?.meta?.page1?.joints?.global) {
          try {
            const srcModelFile = srcChosenName ?? src[0]?.file;
            if (srcModelFile) {
              const pipelinesIdx = await loadPipelines();
              const pipeline = pipelinesIdx?.pipelines.find(
                (p) => p.modelFile === srcModelFile && p.smartCropMeta && p.splitMeta,
              );
              if (pipeline?.smartCropMeta && pipeline?.splitMeta) {
                const cropped = transformJointsBySmartCrop(
                  project.meta.page1.joints.global,
                  pipeline.smartCropMeta,
                  pipeline.splitMeta,
                );
                setPipelineJoints(cropped);
                // Store Page2 split view size for coordinate-space alignment.
                const frontView = pipeline.splitMeta.views.find((v) => v.view === 'front');
                setPipelineJointImageSize(frontView ? { width: frontView.sliceSize.w, height: frontView.sliceSize.h } : null);
              } else {
                setPipelineJoints(null);
                setPipelineJointImageSize(null);
              }
            } else {
              setPipelineJoints(null);
              setPipelineJointImageSize(null);
            }
          } catch (e) {
            console.warn('[V2] pipeline joints 解析失败:', e);
            setPipelineJoints(null);
            setPipelineJointImageSize(null);
          }
        } else {
          setPipelineJoints(null);
          setPipelineJointImageSize(null);
        }
      } catch (err) {
        if (seq !== refreshSeqRef.current) return;
        setMeshLoadError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [project, listHistory, loadLatest, loadByName, loadPage1SegPack, loadPage3Session, loadPipelines, srcChosenName, tarChosenName, tarKind]);
  // Effect 只在 project 变化时跑；在其他页面落盘后的新资产需手动 ↻ 按钮。
  useEffect(() => {
    refreshAssets();
  }, [refreshAssets]);

  // Stage 7/1+7/2+7/3c+7/4+7/5+7/6: 9/9 全部接通。
  const ctx: AlignStrategyContext = useMemo(() => {
    const front = project?.meta.page1?.joints?.views.front?.joints;
    const hasSource = sourceFileCount > 0;
    const hasTarget = targetFileCount > 0;
    return {
      hasPoseProxyJoints: !!(front && front.length > 0),
      hasPipelineJoints: !!(pipelineJoints?.front?.length),
      hasSource,
      hasTarget,
      hasSegPack: !!segPackDirName,
      hasBodyTorsoRegion: segPackHasBodyTorso(segPackRegionLabels),
      // hasAdjacency 逻辑等价于 两份 mesh 都能 load。
      hasAdjacency: hasSource && hasTarget,
      srcLandmarkCount,
      tarLandmarkCount,
      // Stage 7/6: 从 V1 会话快照推导。
      hasOrthoCamera: !!session?.orthoCamera,
      hasMaskReprojection: !!session?.maskReprojection,
      hasTargetRegion: !!session?.targetRegionLabel,
    };
  }, [
    project?.meta.page1?.joints,
    pipelineJoints,
    sourceFileCount,
    targetFileCount,
    segPackDirName,
    segPackRegionLabels,
    srcLandmarkCount,
    tarLandmarkCount,
    session,
  ]);

  const selectedStrategy = useMemo(
    () => ALIGN_STRATEGIES.find((s) => s.id === selectedId) ?? ALIGN_STRATEGIES[0],
    [selectedId],
  );

  const toggleReqs = (id: AlignStrategyId) => {
    setExpandedReqs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Stage 8/2: 看 V1 line 2384-2434。Ctrl+Click 添加、Drag 移动、Delete 删除。
  // 与 V1 语义一致：index 以 原最后一个 + 1 生成 —— 但这里同一 store，
  // V1/V2 同时点击也不会冲突（store 内部是自增 counter，addSrcLandmark 返回后
  // 获得的 index 需从 next state 读）。此处只需负责调用 add，选中交给下次 effect。
  const handleSrcClick = useCallback(
    (idx: number, pos: Vec3, modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => {
      if (!modifiers.ctrlKey) return;
      addSrcLandmark(idx, pos);
      onStatusChange?.('Source Landmark 已添加 (Ctrl+Click)', 'info');
    },
    [addSrcLandmark, onStatusChange],
  );
  const handleTarClick = useCallback(
    (idx: number, pos: Vec3, modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => {
      if (!modifiers.ctrlKey) return;
      addTarLandmark(idx, pos);
      onStatusChange?.('Target Landmark 已添加 (Ctrl+Click)', 'info');
    },
    [addTarLandmark, onStatusChange],
  );
  const handleDeleteSrc = useCallback(
    (index: number) => {
      removeSrcLandmark(index);
      if (selectedSrcIndex === index) setSelectedSrcIndex(null);
      onStatusChange?.(`已删除 Source Landmark #${index}`, 'warning');
    },
    [removeSrcLandmark, selectedSrcIndex, onStatusChange],
  );
  const handleDeleteTar = useCallback(
    (index: number) => {
      removeTarLandmark(index);
      if (selectedTarIndex === index) setSelectedTarIndex(null);
      onStatusChange?.(`已删除 Target Landmark #${index}`, 'warning');
    },
    [removeTarLandmark, selectedTarIndex, onStatusChange],
  );
  const handleMoveSrc = useCallback(
    (index: number, position: Vec3) => {
      updateSrcLandmark(index, position, -1);
      setSelectedSrcIndex(index);
    },
    [updateSrcLandmark],
  );
  const handleMoveTar = useCallback(
    (index: number, position: Vec3) => {
      updateTarLandmark(index, position, -1);
      setSelectedTarIndex(index);
    },
    [updateTarLandmark],
  );

  // Stage 10: hidden file inputs for Source/Target GLB import.
  const srcFileInputRef = useRef<HTMLInputElement | null>(null);
  const tarFileInputRef = useRef<HTMLInputElement | null>(null);
  const importGlb = useCallback(
    async (side: 'src' | 'tar', file: File) => {
      if (!project) {
        onStatusChange?.('未打开工程，无法保存到项目', 'error');
        return;
      }
      try {
        const nodeKey = side === 'src' ? 'page2.highres' : 'page1.rough';
        await saveAsset(nodeKey, file, 'glb', `imported via Page3 V2 (${file.name})`, 'import');
        onStatusChange?.(`${side === 'src' ? 'Source' : 'Target'} GLB 已导入：${file.name}`, 'success');
        refreshAssets();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStatusChange?.(`GLB 导入失败：${msg}`, 'error');
      }
    },
    [project, saveAsset, onStatusChange, refreshAssets],
  );

  // Phase 1e: multi-model load/unload/select handlers
  const MODEL_COLORS = ['#4a90d9', '#d9734a', '#5cb85c', '#e8b740', '#b37feb', '#eb7f9a', '#36cfc9', '#ff85c0'];
  const handleLoadModel = useCallback(
    async (item: HighresGalleryItem) => {
      if (!project) return;
      try {
        const loaded = await loadByName('page2.highres', item.file);
        if (!loaded) { onStatusChange?.(`未找到模型文件: ${item.file}`, 'error'); return; }
        const { vertices, faces } = await loadGlbAsMesh(loaded.url);
        URL.revokeObjectURL(loaded.url);
        const colorIdx = srcModels.length % MODEL_COLORS.length;
        const newModel: LoadedModel = {
          id: item.id,
          label: `${item.pipelineName}`,
          vertices,
          faces,
          color: MODEL_COLORS[colorIdx],
          userTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          selected: true,
        };
        setSrcModels((prev) => {
          // Deselect all existing, select the new one
          const deselected = prev.map((m) => ({ ...m, selected: false }));
          return [...deselected, newModel];
        });
        setSelectedModelId(newModel.id);
        onStatusChange?.(`已加载到 Viewport: ${item.pipelineName}`, 'success');
      } catch (err) {
        onStatusChange?.(`加载失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    [project, loadByName, srcModels.length, onStatusChange],
  );
  const handleUnloadModel = useCallback(
    (modelId: string) => {
      setSrcModels((prev) => {
        const next = prev.filter((m) => m.id !== modelId);
        if (selectedModelId === modelId) {
          setSelectedModelId(next.length > 0 ? next[0].id : null);
        }
        return next;
      });
    },
    [selectedModelId],
  );
  const handleSelectModel = useCallback(
    (modelId: string) => {
      setSelectedModelId((prev) => (prev === modelId ? null : modelId));
      // Update selected state on the models
      setSrcModels((prev) =>
        prev.map((m) => ({ ...m, selected: m.id === modelId && m.id !== selectedModelId })),
      );
    },
    [selectedModelId],
  );

  // Stage 11: manual SegPack file upload (json + mask + optional ref). Mirrors
  // V1 handleLoadSegPackFiles. Writes through savePage3SegPack so V2 reads it
  // identically to a SegFormer-produced pack.
  const segPackInputRef = useRef<HTMLInputElement | null>(null);
  const [segPackBusy, setSegPackBusy] = useState(false);
  const importSegPack = useCallback(
    async (files: FileList | File[]) => {
      if (!project) {
        onStatusChange?.('未打开工程', 'error');
        return;
      }
      const arr = Array.from(files);
      const json = arr.find((f) => f.name.toLowerCase().endsWith('.json'));
      const mask = arr.find((f) => /mask.*\.(png|jpg|jpeg|webp)$/i.test(f.name))
        ?? arr.find((f) => /\.(png|jpg|jpeg|webp)$/i.test(f.name) && f !== json);
      if (!json || !mask) {
        onStatusChange?.('SegPack 需至少 1 个 .json + 1 个 mask 图片', 'error');
        return;
      }
      setSegPackBusy(true);
      try {
        // Validate JSON shape early (throws if malformed).
        parseSegmentationJson(await json.text());
        await savePage3SegPack(json, mask, mask.name, `manual upload: ${json.name}+${mask.name}`);
        onStatusChange?.(`SegPack 已导入：${json.name} + ${mask.name}`, 'success');
        refreshAssets();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStatusChange?.(`SegPack 导入失败：${msg}`, 'error');
      } finally {
        setSegPackBusy(false);
      }
    },
    [project, savePage3SegPack, onStatusChange, refreshAssets],
  );

  // Stage 11: SegFormer garment parse trigger. Takes a reference image,
  // runs the dev bridge, persists json+mask via savePage3SegPack so the
  // pack appears in the SAM3 region picker on next refresh.
  const refImageInputRef = useRef<HTMLInputElement | null>(null);
  const [segformerBusy, setSegformerBusy] = useState(false);
  const runSegFormer = useCallback(
    async (refImage: File) => {
      if (!project) {
        onStatusChange?.('未打开工程', 'error');
        return;
      }
      setSegformerBusy(true);
      onStatusChange?.('SegFormer 服装语义分割中…', 'info');
      try {
        const result = await parseGarmentsSegFormer({
          source: refImage,
          classes: ['Upper-clothes', 'Dress', 'Skirt', 'Pants', 'Scarf'],
        });
        const jsonBlob = new Blob([JSON.stringify(result.json, null, 2)], { type: 'application/json' });
        // base64 → Blob (reuse atob).
        const bin = atob(result.labelMaskBase64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const maskBlob = new Blob([buf], { type: 'image/png' });
        const maskName = 'segformer_label_mask.png';
        await savePage3SegPack(
          jsonBlob,
          maskBlob,
          maskName,
          `segformer (${result.classesPresent.map((c) => c.label).join(',')}) ref=${refImage.name}`,
        );
        onStatusChange?.(
          `SegFormer 完成 · ${result.classesPresent.length} 类 · 已写入 page3.segpack`,
          'success',
        );
        refreshAssets();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStatusChange?.(`SegFormer 失败：${msg}`, 'error');
      } finally {
        setSegformerBusy(false);
      }
    },
    [project, savePage3SegPack, onStatusChange, refreshAssets],
  );

  // Phase A3: 上游状态变化 → 清空 poseProxyState。
  // joints / SAM3 region / mesh 变化 → 清空全部（所有步骤依赖这些输入）。
  useEffect(() => {
    setPoseProxyState({ joints: null, srcRender: null, proxies: null, svd: null, icp: null });
  }, [project?.meta.page1?.joints, tarRegion, srcMesh, tarMesh]);

  // ICP 参数变化 → 只清 icp 槽（下游可以重跑 ICP 而无需重算 SVD/proxies）。
  useEffect(() => {
    setPoseProxyState((prev) => (prev.icp ? { ...prev, icp: null } : prev));
  }, [icpMaxIter, icpRejectMul, icpSampleCount]);

  // Stage 8/3: Manual 策略 Run。其余 3 套 auto 策略运行仍在 V1。
  // 语义与 V1 handleRunAlign (line 2436-2484) 一致：
  //   - srcLandmark.length === tarLandmark.length
  //   - 至少 3 对才能 SVD
  //   - 使用 similarity 模式（V1 ALIGNMENT_MODE 常量）
  const canRunManual = srcMesh !== null
    && srcLandmarkCount === tarLandmarkCount
    && srcLandmarkCount >= 3;
  const handleRunManual = useCallback(() => {
    if (!srcMesh) {
      setRunError('Source mesh 未加载');
      return;
    }
    if (srcLandmarkCount !== tarLandmarkCount) {
      setRunError(`Landmark 数量不一致：src=${srcLandmarkCount} tar=${tarLandmarkCount}`);
      return;
    }
    if (srcLandmarkCount < 3) {
      setRunError('至少需 3 对 landmark');
      return;
    }
    setRunError(null);
    setAligning(true);
    try {
      const result = alignSourceMeshByLandmarks(
        srcMesh.vertices,
        srcLandmarks.map((l) => l.position),
        tarLandmarks.map((l) => l.position),
        'similarity',
      );
      setAlignResult(result);
      setCenterView('result');
      setResultView('overlay');
      pushTrace({ method: 'manual-svd', rmse: result.rmse, meanError: result.meanError, ok: true });
      onStatusChange?.(`Manual SVD 对齐完成 RMSE=${result.rmse.toFixed(4)}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunError(msg);
      pushTrace({ method: 'manual-svd', rmse: 0, meanError: 0, ok: false, note: msg });
      onStatusChange?.(`Manual 对齐失败：${msg}`, 'error');
    } finally {
      setAligning(false);
    }
  }, [srcMesh, srcLandmarks, tarLandmarks, srcLandmarkCount, tarLandmarkCount, onStatusChange, pushTrace]);

  // 接受对齐：把 alignResult.matrix4x4 应用到 srcMesh + srcLandmarks。
  // 与 V1 handleApplyAlignedTransform (line 3273-3296) 同语义。
  const handleAcceptAlign = useCallback(() => {
    if (!alignResult || !srcMesh) return;
    setSrcMesh({
      vertices: alignResult.transformedVertices,
      faces: srcMesh.faces,
    });
    transformSrcLandmarks(alignResult.matrix4x4);
    setAlignResult(null);
    setCenterView('landmark');
    onStatusChange?.('已应用对齐变换到 Source mesh + landmarks', 'success');
  }, [alignResult, srcMesh, transformSrcLandmarks, onStatusChange]);

  const handleResetAlign = useCallback(() => {
    setAlignResult(null);
    setRunError(null);
    setCenterView('landmark');
  }, []);

  // Stage 10: ICP refinement on top of an existing alignResult. Restricts
  // NN search to tarRegion when adopted (prevents partial-to-whole drift).
  const handleRefineIcp = useCallback(() => {
    if (!alignResult || !srcMesh || !tarMesh) {
      setRunError('需先运行一次初步对齐');
      return;
    }
    setRunError(null);
    setAligning(true);
    try {
      const icp = icpRefine(srcMesh.vertices, tarMesh.vertices, alignResult.matrix4x4, {
        maxIterations: icpMaxIter,
        rejectMultiplier: icpRejectMul,
        sampleCount: icpSampleCount,
        tarRestrictVertices: tarRegion?.vertices,
      });
      // Apply refined matrix to source vertices for preview parity with AlignmentResult shape.
      const transformed: Vec3[] = srcMesh.vertices.map((v) => {
        const m = icp.matrix4x4;
        return [
          m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2] + m[0][3],
          m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2] + m[1][3],
          m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2] + m[2][3],
        ];
      });
      const alignedSrcLm: Vec3[] = srcLandmarks.map((l) => {
        const v = l.position;
        const m = icp.matrix4x4;
        return [
          m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2] + m[0][3],
          m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2] + m[1][3],
          m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2] + m[2][3],
        ];
      });
      // Phase C: 真实计算 ICP 后的 landmark mean/max error（不再 alias rmse）。
      let lmSum = 0;
      let lmMax = 0;
      const n = Math.min(alignedSrcLm.length, tarLandmarks.length);
      for (let i = 0; i < n; i++) {
        const a = alignedSrcLm[i];
        const b = tarLandmarks[i].position;
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        const e = Math.sqrt(dx * dx + dy * dy + dz * dz);
        lmSum += e;
        if (e > lmMax) lmMax = e;
      }
      const lmMean = n > 0 ? lmSum / n : 0;

      const refined: AlignmentResult = {
        ...alignResult,
        matrix4x4: icp.matrix4x4,
        transformedVertices: transformed,
        alignedSrcLandmarks: alignedSrcLm,
        rmse: icp.rmse,
        meanError: lmMean,
        maxError: lmMax,
      };
      setAlignResult(refined);
      const lastIter = icp.iterations[icp.iterations.length - 1];
      pushTrace({
        method: 'icp-refine',
        rmse: icp.rmse,
        meanError: lmMean,
        pairsKept: lastIter?.pairsKept,
        iterations: icp.iterations.length,
        ok: true,
        note: icp.stopReason,
      });
      onStatusChange?.(`ICP 精化完成 RMSE=${icp.rmse.toFixed(4)} (${icp.iterations.length} iter, ${icp.stopReason})`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunError(msg);
      pushTrace({ method: 'icp-refine', rmse: 0, meanError: 0, ok: false, note: msg });
      onStatusChange?.(`ICP 精化失败：${msg}`, 'error');
    } finally {
      setAligning(false);
    }
  }, [alignResult, srcMesh, tarMesh, tarRegion, srcLandmarks, tarLandmarks, icpMaxIter, icpRejectMul, icpSampleCount, onStatusChange, pushTrace]);

  // Stage 10: export aligned source mesh as GLB into project (page3.aligned).
  const handleExportAligned = useCallback(async () => {
    if (!project) {
      onStatusChange?.('未打开工程', 'error');
      return;
    }
    if (!srcMesh) {
      onStatusChange?.('Source mesh 未加载', 'error');
      return;
    }
    // Prefer alignResult.transformedVertices if a result is pending; else
    // export srcMesh as-is (caller may have already “Accepted” a transform
    // which means srcMesh is already aligned).
    const verts = alignResult?.transformedVertices ?? srcMesh.vertices;
    try {
      const blob = await exportMeshAsGlb(verts, srcMesh.faces);
      const note = alignResult
        ? `aligned (RMSE=${alignResult.rmse.toFixed(4)} mode=${alignResult.mode})`
        : 'aligned (accepted)';
      await saveAsset('page3.aligned', blob, 'glb', note, 'aligned');
      onStatusChange?.(`对齐后的 Source GLB 已写入 page3.aligned`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatusChange?.(`导出失败：${msg}`, 'error');
    }
  }, [project, srcMesh, alignResult, saveAsset, onStatusChange]);

  // Stage 8/8: lazy adjacency for surface strategy. Only computed when
  // both meshes are loaded; result is memoised on identity.
  const srcAdjacency = useMemo(() => {
    if (!srcMesh) return null;
    return buildMeshAdjacency(srcMesh.vertices, srcMesh.faces);
  }, [srcMesh]);
  const tarAdjacency = useMemo(() => {
    if (!tarMesh) return null;
    return buildMeshAdjacency(tarMesh.vertices, tarMesh.faces);
  }, [tarMesh]);

  // SegPack 反投影区域 → DualViewport tar 分层点云，调用 Page1 SegPackOverlay 同一个
  // 调色板函数 regionHslCss，保证与 Page1 预览颜色逐个对应。
  // 当 tarRegionLabel 选中某个区域时：该区域亮色高亮，其他区域亮度下调 50%。
  const tarSegpackLayers = useMemo(() => {
    if (!tarReprojRegions || tarReprojRegions.length === 0) return undefined;
    const hasSelection = tarRegionLabel != null;
    const layers = tarReprojRegions
      .filter((r) => r.vertices.length > 0)
      .map((r) => {
        const isSelected = hasSelection && r.label === tarRegionLabel;
        return {
          indices: r.vertices,
          color: isSelected
            ? regionHslCssBright(r.regionIndex)
            : hasSelection
              ? regionHslCssDim(r.regionIndex)
              : regionHslCss(r.regionIndex),
          size: 9,
          opacity: isSelected ? 1.0 : hasSelection ? 0.7 : 0.85,
        };
      });
    return layers.length > 0 ? layers : undefined;
  }, [tarReprojRegions, tarRegionLabel]);

  // ── Pose-proxy step 3 可视化：anchor / shoulder_line / torso_axis ─────
  // 把 PCA 算出的代理 anchor 作为彩色小球叠加在 src/tar mesh 上，方便
  // 直观验证骨架代理是否落在合理位置。颜色按 kind 分组（torso=青，
  // 上臂=绿，前臂=黄，shoulder_line=红，torso_axis=紫），sphere
  // 直径 ≈ mesh 对角线 × 0.012。
  const anchorMarkers = useMemo(() => {
    const proxies = poseProxyState.proxies;
    if (!proxies || !srcMesh || !tarMesh) return { src: undefined, tar: undefined };

    const colorForKind = (kind: string): string => {
      if (kind.includes('shoulder_line')) return '#ff4d4f';
      if (kind.includes('torso_axis')) return '#b37feb';
      if (kind.includes('torso')) return '#13c2c2';
      if (kind.includes('forearm')) return '#fadb14';
      if (kind.includes('upper_arm') || kind.includes('arm')) return '#52c41a';
      return '#ffffff';
    };

    const meshDiag = (mesh: { vertices: Vec3[] }): number => {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const v of mesh.vertices) {
        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
        if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
      }
      const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    };

    const buildSide = (proxy: typeof proxies.srcProxy, mesh: { vertices: Vec3[] }) => {
      const radius = meshDiag(mesh) * 0.012;
      const list: Array<{ position: Vec3; color: string; size: number; label?: string; opacity?: number }> = [];

      // 灰色小球：jointSeeds（2D joint → 最近 mesh 顶点平均位置）
      // 显示原始反投影位置，便于判断"塌缩"是发生在 seeds 阶段还是 PCA 阶段。
      // 不带 label 避免 13 个标签遮挡。
      // Joint seeds: 带标签的彩色小球，方便诊断 DWPose 检测位置。
      // 颜色按部位分组：头颈=白，肩=红，肘腕=橙，髋=青，膝踝=蓝。
      const jointSeedColor = (name: string): string => {
        if (name.includes('neck')) return '#ffffff';
        if (name.includes('shoulder')) return '#ff7875';
        if (name.includes('elbow') || name.includes('wrist')) return '#ffa940';
        if (name.includes('hip')) return '#36cfc9';
        if (name.includes('knee') || name.includes('ankle')) return '#597ef7';
        return '#888888';
      };
      if (showJointSeeds) {
        for (const [name, pos] of proxy.jointSeeds) {
          list.push({
            position: pos,
            color: jointSeedColor(name),
            size: radius * 0.6,
            label: name,
            opacity: 0.9,
          });
        }
      }

      // 主层：PCA capsule anchors（彩色 + 标签）
      if (showCapsuleAnchors) {
        for (const a of proxy.anchors) {
          list.push({
            position: a.position,
            color: colorForKind(a.kind),
            size: radius,
            label: a.kind,
          });
        }
      }
      if (showSpecialAnchors) {
        if (proxy.shoulderLine) {
          list.push({
            position: proxy.shoulderLine.position,
            color: colorForKind('shoulder_line'),
            size: radius * 1.2,
            label: 'shoulder_line',
          });
        }
        if (proxy.torsoAxis) {
          list.push({
            position: proxy.torsoAxis.position,
            color: colorForKind('torso_axis'),
            size: radius * 1.2,
            label: 'torso_axis',
          });
        }
      }
      return list;
    };

    return {
      src: buildSide(proxies.srcProxy, srcMesh),
      tar: buildSide(proxies.tarProxy, tarMesh),
    };
  }, [poseProxyState.proxies, srcMesh, tarMesh, showJointSeeds, showCapsuleAnchors, showSpecialAnchors]);

  // ── Pipeline Joints 2D→3D 可视化 ────────────────────────────────────
  // 将 SmartCrop 仿射变换后的 pipeline joints 通过 srcCamera 反向投影
  // 到 3D，画在 src mesh 前方的一个平面上。Joints 和 camera 现在使用
  // 相同的 image size（pipelineJointImageSize），无需 XY 缩放。
  const pipelineJoint3DMarkers = useMemo(() => {
    if (!showPipelineJointsOverlay) return undefined;
    const cam = poseProxyState.srcRender?.srcCamera;
    if (!cam || !pipelineJoints?.front || !srcMesh) return undefined;

    // Joints and camera now share the same image size, so no XY scaling needed.
    const joints = pipelineJoints.front;

    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const wpp = cam.worldPerPx;
    const worldX = cam.meshFrontX - pipelineJointOffset;

    // Same color scheme as joint seeds for consistency
    const color = (name: string): string => {
      if (name.includes('neck')) return '#ffffff';
      if (name.includes('shoulder')) return '#ff7875';
      if (name.includes('elbow') || name.includes('wrist')) return '#ffa940';
      if (name.includes('hip')) return '#36cfc9';
      if (name.includes('knee') || name.includes('ankle')) return '#597ef7';
      return '#888888';
    };

    const markers: Array<{ position: Vec3; color: string; size: number; label: string; opacity: number }> = [];
    for (const j of joints) {
      // Inverse of projectVerticesToImage:
      //   u = cx + (camZ - wz) / wpp  →  wz = camZ - (u - cx) * wpp
      //   v = cy - (wy - camY) / wpp  →  wy = camY + (cy - v) * wpp
      const wz = cam.camZ - (j.x - cx) * wpp;
      const wy = cam.camY + (cy - j.y) * wpp;
      markers.push({
        position: [worldX, wy, wz],
        color: color(j.name),
        size: 0.02,  // fixed world size for 2D-projected joints
        label: `2D:${j.name}`,
        opacity: 0.85,
      });
    }
    return markers;
  }, [showPipelineJointsOverlay, poseProxyState.srcRender, pipelineJoints, srcMesh, pipelineJointOffset]);

  // ── Pipeline Joints 2D→3D on tar side ────────────────────────────────
  // Same unprojection logic as pipelineJoint3DMarkers, but through the
  // SAM3 ortho camera and using the already-scaled tarJoints from step1.
  const tarPipelineJoint3DMarkers = useMemo(() => {
    if (!showPipelineJointsOverlay) return undefined;
    const cam = tarOrthoCamera;
    const joints = poseProxyState.joints?.tarJoints;
    if (!cam || !joints || !tarMesh) return undefined;

    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const wpp = cam.worldPerPx;
    const worldX = cam.meshFrontX + pipelineJointOffset;

    const color = (name: string): string => {
      if (name.includes('neck')) return '#ffffff';
      if (name.includes('shoulder')) return '#ff7875';
      if (name.includes('elbow') || name.includes('wrist')) return '#ffa940';
      if (name.includes('hip')) return '#36cfc9';
      if (name.includes('knee') || name.includes('ankle')) return '#597ef7';
      return '#888888';
    };

    const markers: Array<{ position: Vec3; color: string; size: number; label: string; opacity: number }> = [];
    for (const j of joints) {
      if (j.confidence <= 0) continue;
      const wz = cam.camZ - (j.x - cx) * wpp;
      const wy = cam.camY + (cy - j.y) * wpp;
      markers.push({
        position: [worldX, wy, wz],
        color: color(j.name),
        size: 0.02,
        label: `2D:${j.name}`,
        opacity: 0.85,
      });
    }
    return markers;
  }, [showPipelineJointsOverlay, tarOrthoCamera, poseProxyState.joints, tarMesh, pipelineJointOffset]);

  // Stage 8/8 + 9: limb-structure + surface + pose-proxy auto runners.
  // tarConstraintVertices comes from SAM3Panel (Stage 9). When the user
  // hasn’t adopted a region, runners execute unconstrained (whole mesh).
  const canRunAuto = srcMesh !== null && tarMesh !== null;
  const handleRunAuto = useCallback(async (id: 'limb-structure' | 'surface' | 'pose-proxy') => {
    if (!srcMesh || !tarMesh) {
      setRunError('Source / target mesh 未加载');
      return;
    }
    setRunError(null);
    setAligning(true);
    try {
      let outcome;
      if (id === 'limb-structure') {
        outcome = runLimbStructure({
          src: srcMesh,
          tar: tarMesh,
          tarConstraintVertices: tarRegion?.vertices,
        });
      } else if (id === 'surface') {
        if (!srcAdjacency || !tarAdjacency) {
          throw new Error('mesh adjacency 尚未就绪');
        }
        outcome = runSurface({
          src: { vertices: srcMesh.vertices, adjacency: srcAdjacency },
          tar: { vertices: tarMesh.vertices, adjacency: tarAdjacency },
          tarConstraintVertices: tarRegion?.vertices,
          tarSeedCentroid: tarRegion?.centroid,
          tarSeedRadius: tarRegion?.boundingRadius,
        });
      } else {
        // pose-proxy: needs Page1 joints + src ortho camera (rendered on the
        // fly to match the page1 front view size) + tarOrthoCamera (from SAM3).
        const front = project?.meta.page1?.joints?.views.front;
        if (!front || front.joints.length === 0) {
          throw new Error('pose-proxy 需 Page1 joints：请先在 Page1 完成 DWPose 检测');
        }
        if (!tarOrthoCamera) {
          throw new Error('pose-proxy 需 Target SAM3 正交相机：请先在 SAM3 面板点 “渲染 + 反投影”');
        }
        const srcRender = renderOrthoFrontViewWithCamera(
          srcMesh.vertices,
          srcMesh.faces,
          {
            width: front.imageSize.width,
            height: front.imageSize.height,
            background: null,
            meshColor: '#dddddd',
          },
        );
        // Tar joints live in page1 split-local space; rescale them to the
        // SAM3 ortho camera resolution (V1 scaleJointsToImageSize).
        const sx = tarOrthoCamera.width / Math.max(1, front.imageSize.width);
        const sy = tarOrthoCamera.height / Math.max(1, front.imageSize.height);
        const tarJoints: Joint2D[] = front.joints.map((j) => ({
          ...j,
          x: Math.round(j.x * sx),
          y: Math.round(j.y * sy),
        }));
        outcome = runPoseProxy({
          src: srcMesh,
          tar: tarMesh,
          srcJoints: front.joints,
          tarJoints,
          srcCamera: srcRender.camera,
          tarCamera: tarOrthoCamera,
          tarConstraintVertices: tarRegion?.vertices,
        });
      }
      setAlignResult(outcome.result);
      setCenterView('result');
      setResultView('overlay');
      pushTrace({ method: outcome.method, rmse: outcome.result.rmse, meanError: outcome.result.meanError, ok: true });
      onStatusChange?.(
        `${id} 对齐完成 RMSE=${outcome.result.rmse.toFixed(4)} (${outcome.method})`,
        'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunError(msg);
      pushTrace({ method: id, rmse: 0, meanError: 0, ok: false, note: msg });
      onStatusChange?.(`${id} 对齐失败：${msg}`, 'error');
    } finally {
      setAligning(false);
    }
  }, [srcMesh, tarMesh, srcAdjacency, tarAdjacency, tarRegion, tarOrthoCamera, project, onStatusChange, pushTrace]);

  // Phase A5: pose-proxy 真分步一键运行 — 顺序跑 5 步，每步结果写入 poseProxyState。
  // 仅当 selectedId === 'pose-proxy' 时被调用。
  // ── Step 自检（结果都进诊断日志）──────────────────────────────────
  // 失败只警告（pushTrace ok=false），不抛异常 — 是诊断不是阻塞。
  const validateCollectJoints = useCallback((
    joints: CollectJointsOutput,
    front: { joints: Joint2D[]; imageSize: { width: number; height: number } },
    tarCamera: OrthoFrontCamera,
  ) => {
    const issues: string[] = [];
    const expected = front.joints.length;
    // 1. 数量一致
    if (joints.srcJoints.length !== expected || joints.tarJoints.length !== expected) {
      issues.push(`数量不一致: src=${joints.srcJoints.length} tar=${joints.tarJoints.length} expected=${expected}`);
    }
    // 2. 坐标在画布内（只检查 confidence>0 的关节，DWPose 没检出的 joint 可能为 0/0）
    let outOfBounds = 0;
    for (const j of joints.tarJoints) {
      if (j.confidence <= 0) continue;
      if (j.x < 0 || j.x >= tarCamera.width || j.y < 0 || j.y >= tarCamera.height) {
        outOfBounds++;
      }
    }
    if (outOfBounds > 0) {
      issues.push(`${outOfBounds} 个 tar joint 越界 (画布 ${tarCamera.width}×${tarCamera.height})`);
    }
    // 3. 缩放比例：挑第一个 confidence>0 的 joint 验证
    const sx = tarCamera.width / Math.max(1, front.imageSize.width);
    const sy = tarCamera.height / Math.max(1, front.imageSize.height);
    let sampleNote = '';
    for (let i = 0; i < joints.srcJoints.length; i++) {
      const s = joints.srcJoints[i];
      const t = joints.tarJoints[i];
      if (s.confidence <= 0) continue;
      const expectX = Math.round(s.x * sx);
      const expectY = Math.round(s.y * sy);
      const dx = Math.abs(t.x - expectX);
      const dy = Math.abs(t.y - expectY);
      sampleNote = `sample[${i}=${s.name}] src=(${s.x},${s.y}) tar=(${t.x},${t.y}) expect=(${expectX},${expectY})`;
      if (dx > 1 || dy > 1) {
        issues.push(`缩放偏差: ${sampleNote} dx=${dx} dy=${dy}`);
      }
      break;
    }
    const ok = issues.length === 0;
    const summary = ok
      ? `step1 自检通过 · ${expected} joints · 缩放(${sx.toFixed(3)},${sy.toFixed(3)}) · ${sampleNote}`
      : `step1 自检失败 · ${issues.join(' | ')}`;
    pushTrace({
      method: 'pose-proxy/step1-check',
      rmse: 0,
      meanError: 0,
      ok,
      note: summary,
    });
    onStatusChange?.(summary, ok ? 'info' : 'warning');
    return ok;
  }, [pushTrace, onStatusChange]);

  // ── Step 2 (renderSrcOrtho) 自检 ────────────────────────────────
  const validateRenderSrcOrtho = useCallback((
    srcRender: RenderSrcOrthoOutput,
    page1Size: { width: number; height: number },
  ) => {
    const issues: string[] = [];
    const cam = srcRender.srcCamera;
    // 1. 画布尺寸 = page1Size
    if (cam.width !== page1Size.width || cam.height !== page1Size.height) {
      issues.push(`画布尺寸不匹配: cam=${cam.width}×${cam.height} expect=${page1Size.width}×${page1Size.height}`);
    }
    // 2. 数值有限性
    const finiteFields: Array<[string, number]> = [
      ['camY', cam.camY], ['camZ', cam.camZ],
      ['worldPerPx', cam.worldPerPx], ['meshFrontX', cam.meshFrontX],
    ];
    for (const [name, v] of finiteFields) {
      if (!Number.isFinite(v)) issues.push(`${name} 非有限值 (=${v})`);
    }
    // 3. worldPerPx 必须为正
    if (cam.worldPerPx <= 0) {
      issues.push(`worldPerPx 非正 (=${cam.worldPerPx}) — mesh 退化或 fit 失败`);
    }
    // 4. dataUrl 健康度
    let dataUrlNote = '';
    if (srcRender.srcOrthoDataUrl == null) {
      dataUrlNote = 'dataUrl=null (调试用，不影响下游)';
    } else if (!srcRender.srcOrthoDataUrl.startsWith('data:image/')) {
      issues.push(`dataUrl 非 image (前缀=${srcRender.srcOrthoDataUrl.slice(0, 24)})`);
    } else {
      const bytes = srcRender.srcOrthoDataUrl.length;
      dataUrlNote = `dataUrl ${bytes}B`;
      // 极小 dataUrl 通常是空白图（base64 PNG 至少几百字节）
      if (bytes < 200) issues.push(`dataUrl 过短 (=${bytes}B) — 可能是空白图`);
    }
    const ok = issues.length === 0;
    const summary = ok
      ? `step2 自检通过 · ${cam.width}×${cam.height} · worldPerPx=${cam.worldPerPx.toFixed(4)} · camY=${cam.camY.toFixed(2)} camZ=${cam.camZ.toFixed(2)} meshFrontX=${cam.meshFrontX.toFixed(2)} · ${dataUrlNote}`
      : `step2 自检失败 · ${issues.join(' | ')}`;
    pushTrace({
      method: 'pose-proxy/step2-check',
      rmse: 0,
      meanError: 0,
      ok,
      note: summary,
    });
    onStatusChange?.(summary, ok ? 'info' : 'warning');
    return ok;
  }, [pushTrace, onStatusChange]);

  // ── Step 3 (buildProxies) 自检 ──────────────────────────────────
  // 关注：
  //   1. anchor 数量（src/tar 各应有 6-8 个 capsule anchors）
  //   2. 空间散布 = 最远两 anchor 距离 / mesh 对角线
  //      若 < 0.15 → 所有 anchor 几乎重叠，高度可疑（mesh 缺失肢体或
  //      tarConstraintVertices 限制过严，导致 jointsToSeeds3D 全部塌缩）
  //   3. shoulderLine / torsoAxis 是否生成
  //   4. pairs 数量 + 平均 confidence
  const validateBuildProxies = useCallback((
    out: BuildProxiesOutput,
    srcVerts: Vec3[],
    tarVerts: Vec3[],
  ) => {
    const issues: string[] = [];

    const meshDiag = (verts: Vec3[]): number => {
      let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
      for (const v of verts) {
        if (v[0]<mnx)mnx=v[0]; if (v[0]>mxx)mxx=v[0];
        if (v[1]<mny)mny=v[1]; if (v[1]>mxy)mxy=v[1];
        if (v[2]<mnz)mnz=v[2]; if (v[2]>mxz)mxz=v[2];
      }
      const dx=mxx-mnx,dy=mxy-mny,dz=mxz-mnz;
      return Math.sqrt(dx*dx+dy*dy+dz*dz) || 1;
    };
    const maxPairwise = (pts: Vec3[]): number => {
      let m = 0;
      for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++) {
        const a=pts[i],b=pts[j];
        const d=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
        if (d>m) m=d;
      }
      return m;
    };

    const sideStats = (label: string, proxy: typeof out.srcProxy, verts: Vec3[]) => {
      const diag = meshDiag(verts);
      const positions = proxy.anchors.map((a) => a.position);
      const spread = maxPairwise(positions);
      const ratio = spread / diag;
      const lowConf = proxy.anchors.filter((a) => a.confidence < 0.3).length;
      // ── Y 分布诊断:每个 anchor 在 mesh Y 范围内的相对位置(0=底,1=顶)
      // 用于诊断"anchor 全挤在上半部分,没下到肘部/腕部"。
      let mnY = Infinity, mxY = -Infinity;
      for (const v of verts) { if (v[1] < mnY) mnY = v[1]; if (v[1] > mxY) mxY = v[1]; }
      const yRange = mxY - mnY || 1;
      const yPctList = proxy.anchors.map((a) => ({
        kind: a.kind,
        yPct: ((a.position[1] - mnY) / yRange * 100).toFixed(0) + '%',
      }));
      // eslint-disable-next-line no-console
      console.log(`[buildProxies][${label}] meshY=[${mnY.toFixed(3)},${mxY.toFixed(3)}] anchors:`, yPctList);
      // eslint-disable-next-line no-console
      console.log(`[buildProxies][${label}] jointSeeds:`, Array.from(proxy.jointSeeds.entries()).map(([k, v]) => ({
        joint: k,
        yPct: ((v[1] - mnY) / yRange * 100).toFixed(0) + '%',
        pos: v.map((c) => c.toFixed(3)),
      })));
      const note = `${label}:${proxy.anchors.length}个anchor 散布${spread.toFixed(3)}/${diag.toFixed(3)}=${(ratio*100).toFixed(1)}% lowConf=${lowConf} shoulderLine=${proxy.shoulderLine?'✓':'✗'} torsoAxis=${proxy.torsoAxis?'✓':'✗'}`;
      if (proxy.anchors.length < 4) {
        issues.push(`${label}: anchor 数量过少 (${proxy.anchors.length})`);
      }
      if (ratio < 0.15 && proxy.anchors.length >= 2) {
        issues.push(`${label}: anchor 空间塌缩 (散布${(ratio*100).toFixed(1)}% < 15%) — 可能是 mesh 缺失肢体几何或约束区域过窄`);
      }
      if (proxy.warnings.length > 0) {
        issues.push(`${label} warnings: ${proxy.warnings.slice(0,2).join('; ')}`);
      }
      return note;
    };

    const srcNote = sideStats('src', out.srcProxy, srcVerts);
    const tarNote = sideStats('tar', out.tarProxy, tarVerts);

    const avgConf = out.pairs.length > 0
      ? out.pairs.reduce((s, p) => s + p.confidence, 0) / out.pairs.length
      : 0;
    const pairsNote = `pairs=${out.pairs.length} avgConf=${avgConf.toFixed(2)}`;
    if (out.pairs.length < 3) {
      issues.push(`pairs 数量过少 (${out.pairs.length}) — SVD 可能不稳定`);
    }

    const ok = issues.length === 0;
    const summary = ok
      ? `step3 自检通过 · ${srcNote} · ${tarNote} · ${pairsNote}`
      : `step3 自检告警 · ${srcNote} · ${tarNote} · ${pairsNote} · ${issues.join(' | ')}`;
    pushTrace({
      method: 'pose-proxy/step3-check',
      rmse: 0,
      meanError: 0,
      ok,
      note: summary,
    });
    onStatusChange?.(summary, ok ? 'info' : 'warning');
    return ok;
  }, [pushTrace, onStatusChange]);


  const handleRunPoseProxyStepwise = useCallback(async () => {
    if (!srcMesh || !tarMesh) {
      setRunError('Source / target mesh 未加载');
      return;
    }
    const front = project?.meta.page1?.joints?.views.front;
    if (!front || front.joints.length === 0) {
      setRunError('pose-proxy 需 Page1 joints：请先在 Page1 完成 DWPose 检测');
      return;
    }
    if (!tarOrthoCamera) {
      setRunError('pose-proxy 需 Target SAM3 正交相机：请先在 SAM3 面板点 "渲染 + 反投影"');
      return;
    }
    setRunError(null);
    setAligning(true);
    try {
      // SmartCrop coordinate mapping: use jacket-space joints for src.
      // When pipelineJoints are available, use their native split size as
      // srcCamera resolution — joints and camera then share the same
      // coordinate space without XY scaling, avoiding stretch artifacts.
      const srcImageSize = (pipelineJointImageSize && pipelineJoints?.front)
        ? pipelineJointImageSize
        : front.imageSize;
      const srcFrontJoints = pipelineJoints?.front ?? front.joints;
      // Step 1: collectJoints
      // page1Size must be front.imageSize because tarJointsRaw always
      // lives in Page1 full-image coordinates (not pipeline split space).
      const joints = collectJoints({
        srcJointsRaw: srcFrontJoints,
        tarJointsRaw: front.joints,
        tarCamera: tarOrthoCamera,
        page1Size: front.imageSize,
      });
      setPoseProxyState((prev) => ({ ...prev, joints }));
      validateCollectJoints(joints, front, tarOrthoCamera);

      // Step 2: renderSrcOrtho
      const srcRender = renderSrcOrtho({
        srcVertices: srcMesh.vertices,
        srcFaces: srcMesh.faces,
        page1Size: srcImageSize,
      });
      setPoseProxyState((prev) => ({ ...prev, srcRender }));
      validateRenderSrcOrtho(srcRender, srcImageSize);

      // Step 3: buildProxies
      const proxies = buildProxies({
        srcVertices: srcMesh.vertices,
        tarVertices: tarMesh.vertices,
        srcJoints: joints.srcJoints,
        tarJoints: joints.tarJoints,
        srcCamera: srcRender.srcCamera,
        tarCamera: tarOrthoCamera,
        tarConstraintVertices: tarRegion?.vertices,
      });
      setPoseProxyState((prev) => ({ ...prev, proxies }));
      validateBuildProxies(proxies, srcMesh.vertices, tarMesh.vertices);

      // Step 4: solveSvd
      const svd = solveSvd({
        srcVertices: srcMesh.vertices,
        tarVertices: tarMesh.vertices,
        pairs: proxies.pairs,
      });
      setPoseProxyState((prev) => ({ ...prev, svd }));
      // 立即预览 SVD 结果，方便诊断 SVD vs ICP 各自行为
      setAlignResult(svd.result);
      setCenterView('result');
      setResultView('overlay');
      pushTrace({ method: 'SVD', rmse: svd.lmFitRmse, meanError: svd.result.meanError, ok: true });

      // Step 5: solveIcp
      const icp = solveIcp({
        srcVertices: srcMesh.vertices,
        tarVertices: tarMesh.vertices,
        lmFitMatrix: svd.lmFitMatrix,
        pairs: proxies.pairs,
        icpCfg: { maxIterations: icpMaxIter, sampleCount: icpSampleCount, rejectMultiplier: icpRejectMul, convergenceImprovement: 0.005 },
        tarConstraintVertices: tarRegion?.vertices,
      });
      setPoseProxyState((prev) => ({ ...prev, icp }));

      // 最终结果 → alignResult（与旧 handleRunAuto 行为一致）
      setAlignResult(icp.result);
      setCenterView('result');
      setResultView('overlay');
      pushTrace({ method: icp.method, rmse: icp.result.rmse, meanError: icp.result.meanError, ok: true });
      onStatusChange?.(
        `pose-proxy 对齐完成 RMSE=${icp.result.rmse.toFixed(4)} (${icp.method})`,
        'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunError(msg);
      pushTrace({ method: 'pose-proxy', rmse: 0, meanError: 0, ok: false, note: msg });
      onStatusChange?.(`pose-proxy 对齐失败：${msg}`, 'error');
    } finally {
      setAligning(false);
    }
  }, [srcMesh, tarMesh, tarOrthoCamera, tarRegion, project, pipelineJoints, pipelineJointImageSize, icpMaxIter, icpRejectMul, icpSampleCount, onStatusChange, pushTrace, validateCollectJoints, validateRenderSrcOrtho, validateBuildProxies]);

  // Phase A4: pose-proxy 单步重跑 — **只跑这一步**，清空下游槽位。
  // 重要：除非 stepIndex === 4 (ICP)，否则不会触碰 alignResult。
  // 这样点 step1（collectJoints）只会刷新 joints 槽，绝不会让 source 贴到 target。
  const handleRerunPoseProxyStep = useCallback(async (stepIndex: number) => {
    if (!srcMesh || !tarMesh) {
      setRunError('Source / target mesh 未加载');
      return;
    }
    const front = project?.meta.page1?.joints?.views.front;
    if (!front || front.joints.length === 0) {
      setRunError('pose-proxy 需 Page1 joints');
      return;
    }
    if (!tarOrthoCamera) {
      setRunError('pose-proxy 需 Target SAM3 正交相机');
      return;
    }
    // 上游槽位检查：第 i 步必须有 0..i-1 的所有上游结果。
    const slotMap = ['joints', 'srcRender', 'proxies', 'svd', 'icp'] as const;
    for (let k = 0; k < stepIndex; k++) {
      if (poseProxyState[slotMap[k]] === null) {
        setRunError(`step${stepIndex + 1} 重跑需先完成 step${k + 1}（${slotMap[k]}）`);
        return;
      }
    }
    setRunError(null);
    setAligning(true);
    // 立即清空当前步及所有下游槽位（让 UI 显示 running / pending）。
    setPoseProxyState((prev) => {
      const next = { ...prev };
      for (let k = stepIndex; k < slotMap.length; k++) next[slotMap[k]] = null as never;
      return next;
    });
    // 同时清掉旧的 alignResult（旧结果跟当前步链已经不一致了）。
    setAlignResult(null);
    try {
      // SmartCrop coordinate mapping: use jacket-space joints for src.
      // Same as handleRunPoseProxyStepwise — native split size avoids scaling.
      const srcImageSize = (pipelineJointImageSize && pipelineJoints?.front)
        ? pipelineJointImageSize
        : front.imageSize;
      const srcFrontJoints = pipelineJoints?.front ?? front.joints;
      switch (stepIndex) {
        case 0: {
          const joints = collectJoints({
            srcJointsRaw: srcFrontJoints,
            tarJointsRaw: front.joints,
            tarCamera: tarOrthoCamera,
            page1Size: front.imageSize,
          });
          setPoseProxyState((prev) => ({ ...prev, joints }));
          validateCollectJoints(joints, front, tarOrthoCamera);
          onStatusChange?.(`pose-proxy step1 重跑完成 · ${joints.srcJoints.length} joints`, 'success');
          break;
        }
        case 1: {
          const srcRender = renderSrcOrtho({
            srcVertices: srcMesh.vertices,
            srcFaces: srcMesh.faces,
            page1Size: srcImageSize,
          });
          setPoseProxyState((prev) => ({ ...prev, srcRender }));
          validateRenderSrcOrtho(srcRender, srcImageSize);
          onStatusChange?.(`pose-proxy step2 重跑完成 · srcCamera ${srcRender.srcCamera.width}×${srcRender.srcCamera.height}`, 'success');
          break;
        }
        case 2: {
          const joints = poseProxyState.joints!;
          const srcRender = poseProxyState.srcRender!;
          const proxies = buildProxies({
            srcVertices: srcMesh.vertices,
            tarVertices: tarMesh.vertices,
            srcJoints: joints.srcJoints,
            tarJoints: joints.tarJoints,
            srcCamera: srcRender.srcCamera,
            tarCamera: tarOrthoCamera,
            tarConstraintVertices: tarRegion?.vertices,
          });
          setPoseProxyState((prev) => ({ ...prev, proxies }));
          validateBuildProxies(proxies, srcMesh.vertices, tarMesh.vertices);
          onStatusChange?.(`pose-proxy step3 重跑完成 · ${proxies.pairs.length} pairs`, 'success');
          break;
        }
        case 3: {
          const proxies = poseProxyState.proxies!;
          const svd = solveSvd({
            srcVertices: srcMesh.vertices,
            tarVertices: tarMesh.vertices,
            pairs: proxies.pairs,
          });
          setPoseProxyState((prev) => ({ ...prev, svd }));
          // 立即预览 SVD 结果
          setAlignResult(svd.result);
          setCenterView('result');
          setResultView('overlay');
          onStatusChange?.(`pose-proxy step4 重跑完成 · landmark RMSE=${svd.lmFitRmse.toFixed(4)}`, 'success');
          break;
        }
        case 4: {
          const proxies = poseProxyState.proxies!;
          const svd = poseProxyState.svd!;
          const icp = solveIcp({
            srcVertices: srcMesh.vertices,
            tarVertices: tarMesh.vertices,
            lmFitMatrix: svd.lmFitMatrix,
            pairs: proxies.pairs,
            icpCfg: { maxIterations: icpMaxIter, sampleCount: icpSampleCount, rejectMultiplier: icpRejectMul, convergenceImprovement: 0.005 },
            tarConstraintVertices: tarRegion?.vertices,
          });
          setPoseProxyState((prev) => ({ ...prev, icp }));
          // 仅 ICP 步会写 alignResult，因为它是产出最终对齐矩阵的那一步。
          setAlignResult(icp.result);
          setCenterView('result');
          setResultView('overlay');
          pushTrace({ method: icp.method, rmse: icp.result.rmse, meanError: icp.result.meanError, ok: true });
          onStatusChange?.(
            `pose-proxy step5 重跑完成 RMSE=${icp.result.rmse.toFixed(4)} (${icp.method})`,
            'success',
          );
          break;
        }
        default:
          throw new Error(`unknown stepIndex=${stepIndex}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunError(msg);
      pushTrace({ method: 'pose-proxy', rmse: 0, meanError: 0, ok: false, note: msg });
      onStatusChange?.(`pose-proxy step${stepIndex + 1} 重跑失败：${msg}`, 'error');
    } finally {
      setAligning(false);
    }
  }, [srcMesh, tarMesh, tarOrthoCamera, tarRegion, project, poseProxyState, icpMaxIter, icpRejectMul, icpSampleCount, onStatusChange, pushTrace, validateCollectJoints, validateRenderSrcOrtho, validateBuildProxies, pipelineJoints, pipelineJointImageSize]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Stage 7/Final-α: Beta 标识，V1 仍是默认路由 */}
      <div
        style={{
          padding: '6px 12px',
          background: 'linear-gradient(90deg, rgba(232,183,64,0.15), rgba(232,183,64,0.05))',
          borderBottom: '1px solid rgba(232,183,64,0.4)',
          fontSize: 11,
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            background: '#e8b740',
            color: '#000',
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 3,
            letterSpacing: 0.5,
          }}
        >
          BETA
        </span>
        <span>
          Page3 V2（Stage 9）：Manual + Limb-Structure + Surface + Pose-Proxy 均可运行。SAM3 区域供 pose-proxy / surface。
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '360px 1fr 360px',
          overflow: 'hidden',
          background: 'var(--bg-app)',
        }}
      >
      {/* 左侧：数据 / 区域 / 日志 */}
      <aside style={asideStyle('left')}>
        <PanelSection title="📦 模型输入">
          <input
            ref={srcFileInputRef}
            type="file"
            accept=".glb,model/gltf-binary"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importGlb('src', f);
              e.target.value = '';
            }}
          />
          <input
            ref={tarFileInputRef}
            type="file"
            accept=".glb,model/gltf-binary"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importGlb('tar', f);
              e.target.value = '';
            }}
          />
          <Row>
            <Button size="sm" onClick={() => srcFileInputRef.current?.click()} disabled={!project}>Source GLB</Button>
            <Button size="sm" onClick={() => tarFileInputRef.current?.click()} disabled={!project}>Target GLB</Button>
            <Button size="sm" onClick={refreshAssets} title="重新扫描工程内 GLB">↻</Button>
          </Row>
          <Hint>
            page2.highres: {sourceFileCount} 个 · page1.rough: {targetFileCount} 个
            {sourceFileCount === 0 && targetFileCount === 0 && '（工程内尚无 GLB）'}
          </Hint>
          <Hint>导入后会以新版本写入对应 node，不覆盖历史</Hint>
          {srcHistory.length > 1 && (
            <VersionPicker
              label="src 版本"
              versions={srcHistory}
              chosen={srcChosenName}
              onChoose={(name) => { setSrcChosenName(name); refreshAssets(); }}
            />
          )}
          {tarHistory.length > 1 && (
            <VersionPicker
              label="tar 版本"
              versions={tarHistory}
              chosen={tarChosenName}
              onChoose={(name) => { setTarChosenName(name); refreshAssets(); }}
            />
          )}
        </PanelSection>

        <PanelSection title="🎯 目标区域 (必填)">
          <Hint>
            SegPack: {segPackDirName ?? '未保存'}
            {segPackDirName && '（加载后自动持久化）'}
          </Hint>
          {segPackRegionLabels.length > 0 && (
            <Hint>区域: {segPackRegionLabels.join(', ')}</Hint>
          )}
          <input
            ref={segPackInputRef}
            type="file"
            multiple
            accept=".json,image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void importSegPack(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={refImageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void runSegFormer(f);
              e.target.value = '';
            }}
          />
          <Row>
            <Button
              size="sm"
              onClick={() => segPackInputRef.current?.click()}
              disabled={!project || segPackBusy}
              loading={segPackBusy}
              title="选中 JSON + mask 图片（可一起选）"
            >
              手动上传 SegPack
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => refImageInputRef.current?.click()}
              disabled={!project || segformerBusy}
              loading={segformerBusy}
              title="选中一张参考图 → 运行 SegFormer 服装分割并写入 SegPack"
            >
              🧑 SegFormer
            </Button>
          </Row>
          <Hint>SegFormer 需 dev 服务已启动（/api/segformer-garment）</Hint>
        </PanelSection>

        <PanelSection
          title="📊 诊断日志"
          collapsed={!showLogs}
          onToggle={() => setShowLogs((v) => !v)}
        >
          {session ? (
            <>
              <Hint>page3_session.updatedAt: {session.updatedAt}</Hint>
              {session.orthoCamera && (
                <Hint>orthoCamera: {session.orthoCamera.width}×{session.orthoCamera.height}</Hint>
              )}
              {session.maskReprojection && (
                <Hint>maskReprojection: {session.maskReprojection.regionCount} regions @ {session.maskReprojection.completedAt}</Hint>
              )}
              {session.targetRegionLabel && (
                <Hint>targetRegion: {session.targetRegionLabel}</Hint>
              )}
            </>
          ) : (
            <Hint>page3_session.json 未生成</Hint>
          )}
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>对齐运行记录</div>
            {traceLog.length > 0 && (
              <button
                onClick={() => setTraceLog([])}
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
                title="清空诊断日志"
              >
                清空
              </button>
            )}
          </div>
          {traceLog.length === 0 ? (
            <Hint>还未运行任何对齐</Hint>
          ) : (
            <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 4 }}>
              {traceLog.map((t) => (
                <div
                  key={t.id}
                  style={{
                    fontSize: 10,
                    padding: '4px 6px',
                    marginBottom: 3,
                    borderLeft: `3px solid ${t.ok ? '#5cb85c' : '#d9534f'}`,
                    background: 'var(--bg-app)',
                    color: 'var(--text-primary)',
                    fontFamily: 'monospace',
                  }}
                >
                  <div>{t.ts} · <strong>{t.method}</strong> · {t.ok ? `RMSE=${t.rmse.toFixed(4)}` : 'FAIL'}</div>
                  {t.iterations !== undefined && (
                    <div style={{ color: 'var(--text-muted)' }}>iter={t.iterations} pairs={t.pairsKept ?? '–'}</div>
                  )}
                  {t.note && <div style={{ color: 'var(--text-muted)' }}>{t.note}</div>}
                </div>
              ))}
            </div>
          )}
        </PanelSection>
      </aside>

      {/* 中间：视口占位 */}
      <main style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            background: 'var(--bg-surface)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600 }}>中央视图</span>
          <Button
            size="sm"
            variant={centerView === 'landmark' ? 'primary' : 'secondary'}
            onClick={() => setCenterView('landmark')}
          >
            Landmark
          </Button>
          <Button
            size="sm"
            variant={centerView === 'result' ? 'primary' : 'secondary'}
            onClick={() => alignResult && setCenterView('result')}
            disabled={!alignResult}
            title={alignResult ? '' : '运行对齐后可查看'}
          >
            Result
          </Button>
          {centerView === 'result' && (
            <>
              <span style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />
              <Button size="sm" variant={resultView === 'overlay' ? 'primary' : 'secondary'} onClick={() => setResultView('overlay')}>Overlay</Button>
              <Button size="sm" variant={resultView === 'aligned' ? 'primary' : 'secondary'} onClick={() => setResultView('aligned')}>Aligned</Button>
              <Button size="sm" variant={resultView === 'target' ? 'primary' : 'secondary'} onClick={() => setResultView('target')}>Target</Button>
              <Button size="sm" variant={resultView === 'original' ? 'primary' : 'secondary'} onClick={() => setResultView('original')}>Original</Button>
            </>
          )}
          {poseProxyState.proxies && (
            <>
              <span style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>骨骼叠加:</span>
              <Button
                size="sm"
                variant={showJointSeeds ? 'primary' : 'secondary'}
                onClick={() => setShowJointSeeds((v) => !v)}
                title="Joint Seeds — DWPose 检测到的各关节位置"
              >Seeds</Button>
              <Button
                size="sm"
                variant={showCapsuleAnchors ? 'primary' : 'secondary'}
                onClick={() => setShowCapsuleAnchors((v) => !v)}
                title="Capsule Anchors — PCA 算出的肢体代理锚点"
              >Anchors</Button>
              <Button
                size="sm"
                variant={showSpecialAnchors ? 'primary' : 'secondary'}
                onClick={() => setShowSpecialAnchors((v) => !v)}
                title="特殊锚点 — shoulder_line / torso_axis"
              >Special</Button>
            </>
          )}
          {pipelineJoints?.front && (
            <>
              <span style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />
              <Button
                size="sm"
                variant={showPipelineJointsOverlay ? 'primary' : 'secondary'}
                onClick={() => setShowPipelineJointsOverlay((v) => !v)}
                title="Pipeline Joints — SmartCrop 仿射变换后的 2D joints 反向投影到 3D 前方平面"
              >2D→3D</Button>
              <input
                type="range"
                min={-5}
                max={5}
                step={0.2}
                value={pipelineJointOffset}
                onChange={(e) => setPipelineJointOffset(Number(e.target.value))}
                style={{ width: 64, height: 12, cursor: 'pointer' }}
                title={`2D→3D 偏移: ${pipelineJointOffset} 单位`}
              />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 24 }}>{pipelineJointOffset}</span>
            </>
          )}
          {tarReprojRegions && tarReprojRegions.length > 0 && (
            <>
              <span style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />
              <Button
                size="sm"
                variant={showTarSegOverlay ? 'primary' : 'secondary'}
                onClick={() => setShowTarSegOverlay((v) => !v)}
                title="Target 语义分割投影 — SAM3 各区域顶点着色"
              >Seg</Button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            策略: {selectedStrategy.label}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {srcModels.length > 0 && (
            <LoadedModelList
              models={srcModels}
              selectedModelId={selectedModelId}
              onSelect={handleSelectModel}
              onRemove={handleUnloadModel}
            />
          )}
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {(srcMesh || srcModels.length > 0) && tarMesh && centerView === 'landmark' && (
            <DualViewport
              srcVertices={srcMesh?.vertices ?? []}
              srcFaces={srcMesh?.faces ?? []}
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
              onSelectSrcLandmark={setSelectedSrcIndex}
              onSelectTarLandmark={setSelectedTarIndex}
              onDeleteSrcLandmark={handleDeleteSrc}
              onDeleteTarLandmark={handleDeleteTar}
              onMoveSrcLandmark={handleMoveSrc}
              onMoveTarLandmark={handleMoveTar}
              tarPointLayers={showTarSegOverlay ? tarSegpackLayers : undefined}
              srcMarkers={[...(anchorMarkers.src ?? []), ...(pipelineJoint3DMarkers ?? [])]}
              tarMarkers={[...(anchorMarkers.tar ?? []), ...(tarPipelineJoint3DMarkers ?? [])]}
              srcLabel="Source (page2.highres)"
              tarLabel="Target (page1.rough)"
              showCameraSync
              height="100%"
              srcModels={srcModels.length > 0 ? srcModels : undefined}
            />
          )}
          {srcMesh && tarMesh && centerView === 'result' && alignResult && (
            <ResultPreviewV2
              alignResult={alignResult}
              srcFaces={srcMesh.faces}
              originalSrcVertices={srcMesh.vertices}
              targetMesh={tarMesh}
              resultView={resultView}
            />
          )}
          {((!srcMesh && srcModels.length === 0) || !tarMesh) && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: 14,
              }}
            >
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🎬</div>
                <div>
                  {!project
                    ? '未打开工程'
                    : meshLoadError
                      ? `Mesh 加载失败：${meshLoadError}`
                      : sourceFileCount === 0 || targetFileCount === 0
                        ? `工程内 mesh 不全（src=${sourceFileCount}, tar=${targetFileCount}）`
                        : '正在加载 mesh…'}
                </div>
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  Stage 8/1 · DualViewport 已接通（只读，picking 仍在 V1）
                </div>
              </div>
            </div>
          )}
          </div>
        </div>
      </main>

      {/* 右侧：策略 / 步骤 */}
      <aside style={{ ...asideStyle('right'), position: 'relative' }}>
        <QualityDrawer open={showQuality} onToggle={() => setShowQuality((v) => !v)} result={alignResult} />

        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--border-default)',
            background: 'linear-gradient(180deg, rgba(92,184,92,0.10), transparent)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
            <span style={{ color: alignResult ? '#5cb85c' : 'var(--text-muted)' }}>
              {alignResult
                ? `RMSE=${alignResult.rmse.toFixed(4)} · scale=${alignResult.scale.toFixed(3)}`
                : runError
                  ? `⚠ ${runError}`
                  : 'RMSE 未运行'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setShowQuality((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent-blue)',
                fontSize: 10,
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              详情 ◀
            </button>
          </div>
          {selectedId === 'manual' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                variant="primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleAcceptAlign}
                disabled={!alignResult}
                title={alignResult ? '接受并应用变换到 src mesh' : '先运行对齐后可接受'}
              >
                ✓ 接受对齐
              </Button>
              <Button
                size="sm"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleResetAlign}
                disabled={!alignResult && !runError}
              >
                ↶ 撤销
              </Button>
            </div>
          ) : selectedId === 'limb-structure' || selectedId === 'surface' || selectedId === 'pose-proxy' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                variant="primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleAcceptAlign}
                disabled={!alignResult}
                title={alignResult ? '接受并应用变换到 src mesh' : '先运行对齐后可接受'}
              >
                ✓ 接受对齐
              </Button>
              <Button
                size="sm"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleResetAlign}
                disabled={!alignResult && !runError}
              >
                ↶ 撤销
              </Button>
            </div>
          ) : (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                background: 'rgba(232,183,64,0.10)',
                border: '1px solid rgba(232,183,64,0.4)',
                borderRadius: 4,
                padding: 6,
              }}
            >
              未知策略。
            </div>
          )}
        </div>

        <PanelSection title="🧩 SAM3 区域">
          <SAM3Panel
            slot={tarKind}
            tarMesh={tarMesh}
            adoptedLabel={tarRegionLabel}
            onAdoptRegion={handleAdoptRegion}
            onReprojRegions={setTarReprojRegions}
            onStatus={onStatusChange}
          />
        </PanelSection>

        <PanelSection title="⚙️ ICP 参数">
          <NumberRow label="max iter" value={icpMaxIter} min={1} max={200} step={1} onChange={setIcpMaxIter} />
          <NumberRow label="reject × median" value={icpRejectMul} min={0.5} max={10} step={0.1} onChange={setIcpRejectMul} />
          <NumberRow label="sample count" value={icpSampleCount} min={50} max={5000} step={50} onChange={setIcpSampleCount} />
          <Hint>限制范围：SAM3 适采的 region（避免 partial-to-whole 漂移）</Hint>
        </PanelSection>

        <PanelSection title="💾 导出">
          <Button
            size="sm"
            variant="primary"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={handleExportAligned}
            disabled={!project || !srcMesh}
            title={!project ? '未打开工程' : !srcMesh ? 'src mesh 未加载' : '写入 page3.aligned'}
          >
            导出对齐后 Source GLB
          </Button>
          <Hint>
            如果有待接受的变换，会导出应用后的 mesh；否则导出当前 srcMesh。
          </Hint>
        </PanelSection>

        <PanelSection title="🎯 对齐模式">
          {ALIGN_STRATEGIES.map((s) => (
            <StrategyCardV2
              key={s.id}
              strategy={s}
              ctx={ctx}
              selected={selectedId === s.id}
              expanded={expandedReqs.has(s.id)}
              aligning={aligning}
              canRunManual={canRunManual}
              canRunAuto={canRunAuto}
              srcLandmarkCount={srcLandmarkCount}
              tarLandmarkCount={tarLandmarkCount}
              onSelect={() => setSelectedId(s.id)}
              onToggleReqs={() => toggleReqs(s.id)}
              onRunAuto={s.id === 'pose-proxy' ? handleRunPoseProxyStepwise : () => handleRunAuto(s.id as 'limb-structure' | 'surface')}
              onRunManualSvd={handleRunManual}
              onRunIcp={handleRefineIcp}
              hasAlignResult={alignResult !== null}
            />
          ))}
        </PanelSection>

        <PanelSection title={`📋 流程步骤 · ${selectedStrategy.label}`}>
          {selectedStrategy.steps.map((step, i) => {
            // Phase A4: 为 pose-proxy 策略计算真分步状态。
            // 其他策略保持旧行为（done/pending 二态）。
            const isPoseProxy = selectedStrategy.id === 'pose-proxy';
            const isIcpStep = /icp/i.test(step.id) || /icp/i.test(step.title);

            let stepStatus: 'pending' | 'ready' | 'running' | 'done' | 'stale';
            let stepResultHint: string | undefined;

            if (isPoseProxy) {
              // pose-proxy 5 步 → poseProxyState 槽位映射
              const slotMap = ['joints', 'srcRender', 'proxies', 'svd', 'icp'] as const;
              const slot = slotMap[i] as keyof typeof poseProxyState;
              const hasSlot = poseProxyState[slot] !== null;
              // 前一步是否已完成（第一步永远 ready，后续步依赖前一步）
              const prevDone = i === 0 || poseProxyState[slotMap[i - 1] as keyof typeof poseProxyState] !== null;

              if (aligning) {
                // 判断当前步是否正在运行：前一步 done + 当前步 null
                stepStatus = prevDone && !hasSlot ? 'running' : hasSlot ? 'done' : 'pending';
              } else if (hasSlot) {
                stepStatus = 'done';
                // 结果摘要
                if (slot === 'joints') stepResultHint = `src=${poseProxyState.joints!.srcJoints.length} tar=${poseProxyState.joints!.tarJoints.length} joints`;
                if (slot === 'svd') stepResultHint = `RMSE=${poseProxyState.svd!.lmFitRmse.toFixed(4)}`;
                if (slot === 'icp') stepResultHint = `RMSE=${poseProxyState.icp!.icpRmse.toFixed(4)} (${poseProxyState.icp!.method})`;
              } else if (prevDone) {
                stepStatus = 'ready';
              } else {
                stepStatus = 'pending';
              }
            } else {
              // 非 pose-proxy：沿用旧逻辑
              stepStatus = aligning ? 'running' : alignResult !== null ? 'done' : 'pending';
            }

            return (
              <StepCardV2
                key={step.id}
                step={step}
                index={i}
                status={stepStatus}
                onRerun={
                  isPoseProxy
                    ? () => handleRerunPoseProxyStep(i)
                    : isIcpStep
                      ? handleRefineIcp
                      : undefined
                }
                rerunLabel={isPoseProxy ? '重跑此步' : isIcpStep ? 'ICP 重跑' : '重跑此步'}
                rerunDisabledHint={
                  isPoseProxy
                    ? '需先完成上游步（或在 SAM3 面板渲染目标正交相机）'
                    : isIcpStep
                      ? '需先有一次对齐结果'
                      : '当前 runner 未拆分该步独立执行；请用卡片「一键」运行整管线'
                }
                rerunDisabled={
                  isPoseProxy
                    ? aligning || stepStatus === 'pending'
                    : isIcpStep
                      ? !alignResult || aligning
                      : true
                }
                resultHint={stepResultHint}
              />
            );
          })}
        </PanelSection>

        <DataSourceStatusBar project={project} />
      </aside>
      </div>

      {/* 底部：Mesh Gallery (Page2 高模缩略图横向滚动) */}
      <div
        style={{
          borderTop: '1px solid var(--border-default)',
          background: 'var(--bg-surface)',
          padding: '8px 12px',
          flex: '0 0 auto',
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {/* Source 侧：Page2 高模 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              🖼️ Source Mesh · Page2 highres
            </div>
            <HighresGallery
              currentSrcFile={srcChosenName ?? srcHistory[0]?.file ?? null}
              onPickSource={(item: HighresGalleryItem) => {
                setSrcChosenName(item.file);
                onStatusChange?.(`Mesh Gallery → Source: ${item.pipelineName} · ${item.file}`, 'info');
                refreshAssets();
              }}
              loadedModelIds={loadedModelIds}
              onLoadModel={handleLoadModel}
              onUnloadModel={handleUnloadModel}
            />
          </div>
          {/* Target 侧：Page1 Clothed / NoJacket。双击切换 tarKind + 联动 SegPack。 */}
          <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid var(--border-default)', paddingLeft: 12 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              🎯 Target Mesh · Page1 3D Model
            </div>
            <TargetGallery
              currentTargetKind={tarKind}
              currentTargetFile={tarChosenName}
              onPickTarget={(item: TargetGalleryItem) => {
                setTarKind(item.kind);
                setTarChosenName(item.file);
                onStatusChange?.(
                  `Mesh Gallery → Target: ${item.kind === 'clothed' ? 'Clothed' : 'NoJacket'} · ${item.file}`,
                  'info',
                );
                // refreshAssets 通过 tarKind/tarChosenName 依赖自动重跑。
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── 子组件 ─────────────────────── */

function StrategyCardV2({
  strategy,
  ctx,
  selected,
  expanded,
  aligning,
  canRunManual,
  canRunAuto,
  srcLandmarkCount,
  tarLandmarkCount,
  hasAlignResult,
  onSelect,
  onToggleReqs,
  onRunAuto,
  onRunManualSvd,
  onRunIcp,
}: {
  strategy: AlignStrategy;
  ctx: AlignStrategyContext;
  selected: boolean;
  expanded: boolean;
  aligning: boolean;
  canRunManual: boolean;
  canRunAuto: boolean;
  srcLandmarkCount: number;
  tarLandmarkCount: number;
  hasAlignResult: boolean;
  onSelect: () => void;
  onToggleReqs: () => void;
  onRunAuto: () => void;
  onRunManualSvd: () => void;
  onRunIcp: () => void;
}) {
  const checks = useMemo(() => strategy.requirements(ctx), [strategy, ctx]);
  const readiness = summarizeReadiness(checks);
  const color = READINESS_COLOR[readiness];

  return (
    <div
      onClick={onSelect}
      style={{
        marginBottom: 8,
        padding: 10,
        borderRadius: 4,
        border: selected ? '2px solid var(--accent-blue)' : '1px solid var(--border-default)',
        background: selected ? 'rgba(74,144,226,0.08)' : 'var(--bg-app)',
        cursor: 'pointer',
        transition: 'all 0.12s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <input type="radio" checked={selected} readOnly style={{ marginRight: 2 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
          {strategy.label}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1 }}>
          {strategy.summary}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color }}>
          {READINESS_ICON[readiness]} {READINESS_LABEL[readiness]}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleReqs();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: 10,
            cursor: 'pointer',
            padding: '2px 4px',
          }}
        >
          {expanded ? '详情 ▲' : '详情 ▼'}
        </button>
      </div>

      {expanded && <RequirementsList checks={checks} />}

      {strategy.kind === 'manual' ? (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            Source landmarks: <b style={{ color: 'var(--text-primary)' }}>{srcLandmarkCount}</b>
            {' · '}
            Target landmarks: <b style={{ color: 'var(--text-primary)' }}>{tarLandmarkCount}</b>
          </div>
          <Row>
            <Button
              size="sm"
              variant="primary"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={onRunManualSvd}
              disabled={!canRunManual || aligning}
              loading={aligning}
              title={canRunManual ? '' : `需 srcMesh + ≥3 对 landmark`}
            >
              SVD 对齐
            </Button>
            <Button
              size="sm"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={onRunIcp}
              disabled={!hasAlignResult || aligning}
              loading={aligning}
              title={hasAlignResult ? 'ICP 精化当前变换' : '先跑一次 SVD'}
            >
              ICP 精化
            </Button>
          </Row>
        </>
      ) : (
        <Button
          size="sm"
          variant={selected ? 'primary' : 'secondary'}
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => { onSelect(); onRunAuto(); }}
          disabled={readiness === 'blocked' || aligning || !canRunAuto}
          loading={aligning && selected}
          title={
            !canRunAuto
              ? '需两份 mesh 均已加载'
              : readiness === 'blocked'
                ? '前置条件不足'
                : `一键运行 ${strategy.label} 全管线（SVD + ICP）`
          }
        >
          一键 · {strategy.label} 对齐
        </Button>
      )}
    </div>
  );
}

function RequirementsList({ checks }: { checks: RequirementCheck[] }) {
  return (
    <div
      style={{
        padding: 8,
        background: 'var(--bg-surface)',
        borderRadius: 3,
        fontSize: 11,
        marginBottom: 8,
      }}
    >
      {checks.map((r, i) => {
        const color = r.status === 'ready' ? '#5cb85c' : r.status === 'optional' ? '#4a90e2' : '#e8b740';
        const icon = r.status === 'ready' ? '✓' : r.status === 'optional' ? '◐' : '✗';
        return (
          <div key={i} style={{ display: 'flex', gap: 6, color }}>
            <span>{icon}</span>
            <span style={{ flex: 1 }}>{r.label}</span>
            {r.detail && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}

function StepCardV2({
  step,
  index,
  status,
  onRerun,
  rerunLabel,
  rerunDisabled,
  rerunDisabledHint,
  resultHint,
}: {
  step: StrategyStep;
  index: number;
  /** Phase A4: 真分步状态 — pending(上游缺) / ready(可跑) / running / done(有结果) / stale(上游变了) */
  status: 'pending' | 'ready' | 'running' | 'done' | 'stale';
  onRerun?: () => void;
  rerunLabel: string;
  rerunDisabled?: boolean;
  rerunDisabledHint?: string;
  /** 可选：显示该步结果摘要（如 RMSE 值） */
  resultHint?: string;
}) {
  const icon: Record<typeof status, string> = {
    pending: '⏸️',
    ready: '▶️',
    running: '⏳',
    done: '✅',
    stale: '⚠️',
  };
  const color: Record<typeof status, string> = {
    pending: 'var(--text-muted)',
    ready: '#5cb85c',
    running: 'var(--accent-blue)',
    done: 'var(--text-primary)',
    stale: '#e8b740',
  };
  const statusLabel: Record<typeof status, string> = {
    pending: '等待上游',
    ready: '可执行',
    running: '运行中',
    done: '已完成',
    stale: '需重跑',
  };
  return (
    <div
      style={{
        marginBottom: 6,
        padding: '8px 10px',
        borderRadius: 4,
        border: '1px solid var(--border-default)',
        background: status === 'running' ? 'rgba(74,144,226,0.08)' : 'var(--bg-app)',
        borderLeft: `3px solid ${status === 'pending' ? 'var(--border-default)' : color[status]}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{icon[status]}</span>
        <span style={{ fontSize: 11, color: color[status], fontWeight: 600 }}>
          Step {index + 1} · {step.title}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {statusLabel[status]}
        </span>
      </div>
      {step.description && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, marginLeft: 18 }}>
          {step.description}
        </div>
      )}
      {resultHint && status === 'done' && (
        <div style={{ fontSize: 10, color: '#5cb85c', marginTop: 2, marginLeft: 18 }}>
          {resultHint}
        </div>
      )}
      <div style={{ marginTop: 6, marginLeft: 18 }}>
        <Button
          size="sm"
          style={{ padding: '2px 8px', fontSize: 10 }}
          onClick={onRerun}
          disabled={rerunDisabled || !onRerun || status === 'running' || status === 'pending'}
          title={(rerunDisabled || !onRerun || status === 'pending') ? (rerunDisabledHint ?? '') : ''}
        >
          {rerunLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Stage 8/4: V2 result preview overlay. Mirrors V1 ResultPreviewPanel
 * (ModelAssemble.tsx line 5310-5419) — overlay/aligned/target/original
 * 4 sub-modes via single MeshViewer with role/landmark color choices.
 */
function ResultPreviewV2({
  alignResult,
  srcFaces,
  originalSrcVertices,
  targetMesh,
  resultView,
}: {
  alignResult: AlignmentResult;
  srcFaces: Face3[];
  originalSrcVertices: Vec3[];
  targetMesh: { vertices: Vec3[]; faces: Face3[] };
  resultView: 'overlay' | 'aligned' | 'target' | 'original';
}) {
  const srcLandmarkPoints = alignResult.alignedSrcLandmarks.map((pos, i) => ({
    index: i + 1,
    vertexIdx: -1,
    position: pos,
  }));
  const tarLandmarkPoints = alignResult.targetLandmarks.map((pos, i) => ({
    index: i + 1,
    vertexIdx: -1,
    position: pos,
  }));
  if (resultView === 'overlay') {
    return (
      <MeshViewer
        role="result"
        vertices={alignResult.transformedVertices}
        faces={srcFaces}
        color="#4a90d9"
        viewMode="solid"
        height="100%"
        label="Overlay: Aligned Source (蓝) + Target (橙)"
        landmarks={srcLandmarkPoints}
        landmarkColor="#ff6b6b"
        overlayVertices={targetMesh.vertices}
        overlayFaces={targetMesh.faces}
        overlayColor="#d9734a"
        overlayLandmarks={tarLandmarkPoints}
        showViewModeToggle={false}
      />
    );
  }
  if (resultView === 'aligned') {
    return (
      <MeshViewer
        role="result"
        vertices={alignResult.transformedVertices}
        faces={srcFaces}
        color="#4a90d9"
        viewMode="solid"
        height="100%"
        label="Aligned Source"
        landmarks={srcLandmarkPoints}
        landmarkColor="#ff6b6b"
        showViewModeToggle={false}
      />
    );
  }
  if (resultView === 'target') {
    return (
      <MeshViewer
        role="target"
        vertices={targetMesh.vertices}
        faces={targetMesh.faces}
        color="#d9734a"
        viewMode="solid"
        height="100%"
        label="Target"
        landmarks={tarLandmarkPoints}
        landmarkColor="#a0d995"
        showViewModeToggle={false}
      />
    );
  }
  return (
    <MeshViewer
      role="source"
      vertices={originalSrcVertices}
      faces={srcFaces}
      color="#4a90d9"
      viewMode="solid"
      height="100%"
      label="Original Source"
      showViewModeToggle={false}
    />
  );
}

function QualityDrawer({
  open,
  onToggle,
  result,
}: {
  open: boolean;
  onToggle: () => void;
  result: AlignmentResult | null;
}) {
  const drawerWidth = 280;
  const asideWidth = 360;
  return (
    <>
      <button
        onClick={onToggle}
        title="结果质量"
        style={{
          position: 'fixed',
          top: 140,
          right: open ? asideWidth + drawerWidth : asideWidth,
          width: 26,
          padding: '12px 4px',
          background: '#5cb85c',
          color: '#fff',
          border: 'none',
          borderRadius: '4px 0 0 4px',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 700,
          writingMode: 'vertical-rl',
          letterSpacing: 2,
          boxShadow: '-2px 2px 8px rgba(0,0,0,0.5)',
          transition: 'right 0.2s ease',
          zIndex: 1001,
        }}
      >
        {open ? '收起 ▶' : '◀ 结果质量'}
      </button>
      <div
        style={{
          position: 'fixed',
          top: 0,
          bottom: 0,
          right: open ? asideWidth : asideWidth - drawerWidth - 20,
          width: drawerWidth,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          background: 'var(--bg-surface)',
          borderLeft: '3px solid #5cb85c',
          padding: 12,
          boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
          transition: 'right 0.2s ease, opacity 0.2s ease',
          zIndex: 1000,
          overflowY: 'auto',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>📊 结果质量</div>
        {result ? (
          <div style={{ fontSize: 11, color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>mode: <code>{result.mode}</code></div>
            <div>RMSE: <strong>{result.rmse.toFixed(4)}</strong></div>
            <div>mean error: {result.meanError.toFixed(4)}</div>
            <div>max error: {result.maxError.toFixed(4)}</div>
            <div>scale: {result.scale.toFixed(4)}</div>
            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
              点击 [✓ 接受] 应用变换。
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>尚未运行对齐</div>
        )}
      </div>
    </>
  );
}

function PanelSection({
  title,
  children,
  collapsed,
  onToggle,
}: {
  title: string;
  children: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const isCollapsible = onToggle !== undefined;
  const isCollapsed = collapsed === true;
  return (
    <div style={{ borderBottom: '1px solid var(--border-default)', padding: 10 }}>
      <div
        onClick={onToggle}
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: isCollapsed ? 0 : 8,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          cursor: isCollapsible ? 'pointer' : 'default',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {isCollapsible && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 8 }}>
            {isCollapsed ? '▶' : '▼'}
          </span>
        )}
        {title}
      </div>
      {!isCollapsed && children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>{children}</div>;
}

function VersionPicker({
  label,
  versions,
  chosen,
  onChoose,
}: {
  label: string;
  versions: AssetVersion[];
  chosen: string | null;
  onChoose: (name: string | null) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11 }}>
      <span style={{ color: 'var(--text-muted)', flex: '0 0 auto' }}>{label}</span>
      <select
        value={chosen ?? ''}
        onChange={(e) => onChoose(e.target.value === '' ? null : e.target.value)}
        style={{
          flex: 1,
          fontSize: 11,
          background: 'var(--bg-app)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-default)',
          borderRadius: 3,
          padding: '2px 4px',
        }}
      >
        <option value="">最新（默认）</option>
        {versions.map((v) => (
          <option key={v.file} value={v.file}>
            {v.file}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
      <span style={{ flex: 1, color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        style={{
          width: 72,
          fontSize: 11,
          background: 'var(--bg-app)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-default)',
          borderRadius: 3,
          padding: '2px 4px',
        }}
      />
    </div>
  );
}

function Hint({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        lineHeight: 1.5,
        marginTop: 4,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function asideStyle(side: 'left' | 'right'): CSSProperties {
  return {
    background: 'var(--bg-surface)',
    [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--border-default)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
  };
}

/**
 * 底部状态栏：显示当前工程名 + Page1 关节命中情况，便于诊断 ctx 上游数据。
 * （原 Stage 7 接通进度计数已废除——所有 ctx 字段已全部接通。）
 */
function DataSourceStatusBar({ project }: { project: ReturnType<typeof useProject>['project'] }) {
  const projectName = project?.meta.name ?? '(未打开工程)';
  const front = project?.meta.page1?.joints?.views.front?.joints;
  const jointsHint = front
    ? `page1.joints.front: ${front.length} pts`
    : 'page1.joints: 缺失';
  return (
    <div
      style={{
        marginTop: 'auto',
        padding: '8px 12px',
        borderTop: '1px solid var(--border-default)',
        background: 'var(--bg-app)',
        fontSize: 10,
        color: 'var(--text-muted)',
        lineHeight: 1.5,
      }}
    >
      <div>工程：{projectName}</div>
      <div>{jointsHint}</div>
    </div>
  );
}
