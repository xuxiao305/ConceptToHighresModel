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
import type { Page3Session } from '../../services/projectStore';
import { parseSegmentationJson } from '../../services/segmentationPack';
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
} from '../../three';
import { alignSourceMeshByLandmarks, type AlignmentResult } from '../../three/alignment';
import { runLimbStructure, runSurface, runPoseProxy } from '../../services/alignStrategies/runners';
import { SAM3Panel } from './SAM3Panel';
import type { Joint2D } from '../../types/joints';
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

interface ModelAssembleProps {
  onStatusChange?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

/**
 * Stage 7/6）：STUB_FALLBACK 已清空，所有 9 字段都从真实数据推导。
 */
const STUB_FALLBACK = {} as const;

/** Stage 7/1、7/2、7/3c、7/4、7/5、7/6: 实时接通的字段名单（9/9）。 */
const REAL_FIELDS: ReadonlyArray<keyof AlignStrategyContext> = [
  'hasPoseProxyJoints',
  'hasSource',
  'hasTarget',
  'hasSegPack',
  'hasBodyTorsoRegion',
  'hasAdjacency',
  'srcLandmarkCount',
  'tarLandmarkCount',
  'hasOrthoCamera',
  'hasMaskReprojection',
  'hasTargetRegion',
];
const TOTAL_FIELDS = 11;

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
  const { project, listHistory, loadLatest, loadPage3SegPack, loadPage3Session, saveAsset } = useProject();
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
  // Stage 8/4: 中央视图模式 与 结果预览子模式。
  type CenterView = 'landmark' | 'result';
  type ResultView = 'overlay' | 'aligned' | 'target' | 'original';
  const [centerView, setCenterView] = useState<CenterView>('landmark');
  const [resultView, setResultView] = useState<ResultView>('overlay');
  // Stage 9: SAM3 target region + ortho camera (V2-native, replaces V1 panel).
  const [tarRegion, setTarRegion] = useState<MeshRegion | null>(null);
  const [tarRegionLabel, setTarRegionLabel] = useState<string | null>(null);
  const [tarOrthoCamera, setTarOrthoCamera] = useState<OrthoFrontCamera | null>(null);
  const handleAdoptRegion = useCallback(
    (region: MeshRegion | null, label: string | null, camera: OrthoFrontCamera | null) => {
      setTarRegion(region);
      setTarRegionLabel(label);
      setTarOrthoCamera(camera);
    },
    [],
  );
  // Stage 8/1: 中央视口需要的 mesh 数据。null = 尚未加载/工程内无文件。
  const [srcMesh, setSrcMesh] = useState<MeshData | null>(null);
  const [tarMesh, setTarMesh] = useState<MeshData | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const [meshLoadError, setMeshLoadError] = useState<string | null>(null);
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
      return;
    }
    const seq = ++refreshSeqRef.current;
    void Promise.all([
      listHistory('page2.highres'),
      listHistory('page1.rough'),
      loadPage3SegPack(),
      loadPage3Session(),
    ]).then(async ([src, tar, segpack, sess]) => {
      if (seq !== refreshSeqRef.current) return;
      setSourceFileCount(src.length);
      setTargetFileCount(tar.length);
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
      const loadSide = async (nodeKey: string): Promise<MeshData | null> => {
        try {
          const latest = await loadLatest(nodeKey);
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
          src.length > 0 ? loadSide('page2.highres') : Promise.resolve(null),
          tar.length > 0 ? loadSide('page1.rough') : Promise.resolve(null),
        ]);
        if (seq !== refreshSeqRef.current) return;
        setSrcMesh(s);
        setTarMesh(t);
      } catch (err) {
        if (seq !== refreshSeqRef.current) return;
        setMeshLoadError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [project, listHistory, loadLatest, loadPage3SegPack, loadPage3Session]);
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
      ...STUB_FALLBACK,
      hasPoseProxyJoints: !!(front && front.length > 0),
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
      const refined: AlignmentResult = {
        ...alignResult,
        matrix4x4: icp.matrix4x4,
        transformedVertices: transformed,
        alignedSrcLandmarks: alignedSrcLm,
        rmse: icp.rmse,
        // ICP doesn't recompute mean/max in our wrapper; reuse rmse as a coarse proxy.
        meanError: icp.rmse,
        maxError: icp.rmse,
      };
      setAlignResult(refined);
      const lastIter = icp.iterations[icp.iterations.length - 1];
      pushTrace({
        method: 'icp-refine',
        rmse: icp.rmse,
        meanError: icp.rmse,
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
  }, [alignResult, srcMesh, tarMesh, tarRegion, srcLandmarks, icpMaxIter, icpRejectMul, icpSampleCount, onStatusChange, pushTrace]);

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
        </PanelSection>

        <PanelSection title="🎯 目标区域 (必填)">
          <Hint>
            SegPack: {segPackDirName ?? '未保存'}
            {segPackDirName && '（V1 加载后自动持久化）'}
          </Hint>
          {segPackRegionLabels.length > 0 && (
            <Hint>区域: {segPackRegionLabels.join(', ')}</Hint>
          )}
          <Hint>SAM3 区域选择器待挂接（当前仅检测 SegPack 存在性 + body/torso 标签）</Hint>
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
          <div style={{ marginTop: 8, fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>对齐运行记录</div>
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
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            策略: {selectedStrategy.label}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {srcMesh && tarMesh && centerView === 'landmark' && (
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
              onSelectSrcLandmark={setSelectedSrcIndex}
              onSelectTarLandmark={setSelectedTarIndex}
              onDeleteSrcLandmark={handleDeleteSrc}
              onDeleteTarLandmark={handleDeleteTar}
              onMoveSrcLandmark={handleMoveSrc}
              onMoveTarLandmark={handleMoveTar}
              srcLabel="Source (page2.highres)"
              tarLabel="Target (page1.rough)"
              showCameraSync
              height="100%"
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
          {(!srcMesh || !tarMesh) && (
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
                onClick={handleRunManual}
                disabled={!canRunManual || aligning}
                loading={aligning}
                title={canRunManual ? '' : `需 srcMesh + 至少 3 对 landmark（当前 src=${srcLandmarkCount} tar=${tarLandmarkCount}）`}
              >
                ▶ Manual SVD
              </Button>
              <Button
                size="sm"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleRefineIcp}
                disabled={!alignResult || !tarMesh || aligning}
                loading={aligning}
                title={alignResult ? 'ICP 精化当前变换' : '先跑一次 SVD'}
              >
                🔄 ICP
              </Button>
              <Button
                size="sm"
                style={{ justifyContent: 'center' }}
                onClick={handleAcceptAlign}
                disabled={!alignResult}
                title="接受并应用变换到 src mesh"
              >
                ✓
              </Button>
              <Button
                size="sm"
                style={{ justifyContent: 'center' }}
                onClick={handleResetAlign}
                disabled={!alignResult && !runError}
              >
                ↶
              </Button>
            </div>
          ) : selectedId === 'limb-structure' || selectedId === 'surface' || selectedId === 'pose-proxy' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                variant="primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => handleRunAuto(selectedId)}
                disabled={!canRunAuto || aligning}
                loading={aligning}
                title={canRunAuto ? '' : '需两份 mesh 均已加载'}
              >
                ▶ 运行 {selectedStrategy.label}
              </Button>
              <Button
                size="sm"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleRefineIcp}
                disabled={!alignResult || !tarMesh || aligning}
                loading={aligning}
                title={alignResult ? 'ICP 精化' : '先跑一次一键对齐'}
              >
                🔄 ICP
              </Button>
              <Button
                size="sm"
                style={{ justifyContent: 'center' }}
                onClick={handleAcceptAlign}
                disabled={!alignResult}
              >
                ✓
              </Button>
              <Button
                size="sm"
                style={{ justifyContent: 'center' }}
                onClick={handleResetAlign}
                disabled={!alignResult && !runError}
              >
                ↶
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
            tarMesh={tarMesh}
            adoptedLabel={tarRegionLabel}
            onAdoptRegion={handleAdoptRegion}
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
              onSelect={() => setSelectedId(s.id)}
              onToggleReqs={() => toggleReqs(s.id)}
            />
          ))}
        </PanelSection>

        <PanelSection title={`📋 流程步骤 · ${selectedStrategy.label}`}>
          {selectedStrategy.steps.map((step) => (
            <StepCardV2 key={step.id} step={step} />
          ))}
        </PanelSection>

        <DataSourceStatusBar project={project} />
      </aside>
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
  onSelect,
  onToggleReqs,
}: {
  strategy: AlignStrategy;
  ctx: AlignStrategyContext;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleReqs: () => void;
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
        <Row>
          <Button size="sm" variant="primary" style={{ flex: 1, justifyContent: 'center' }}>
            SVD 对齐
          </Button>
          <Button size="sm" style={{ flex: 1, justifyContent: 'center' }}>
            ICP 精化
          </Button>
        </Row>
      ) : (
        <Button
          size="sm"
          variant={selected ? 'primary' : 'secondary'}
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={readiness === 'blocked'}
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

function StepCardV2({ step }: { step: StrategyStep }) {
  return (
    <div
      style={{
        marginBottom: 6,
        padding: '8px 10px',
        borderRadius: 4,
        border: '1px solid var(--border-default)',
        background: 'var(--bg-app)',
        borderLeft: '3px solid var(--border-default)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{step.manual ? '✋' : '⏸️'}</span>
        <span style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>
          {step.title}
        </span>
      </div>
      {step.description && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, marginLeft: 18 }}>
          {step.description}
        </div>
      )}
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
 * Stage 7/1 切片：实时显示 V2 ctx 字段接通进度。
 * 后续切片每接通一个字段，就把 REAL_FIELDS 数组扩一个，UI 自动反映。
 */
function DataSourceStatusBar({ project }: { project: ReturnType<typeof useProject>['project'] }) {
  const realCount = REAL_FIELDS.length;
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
      <div>
        <strong style={{ color: realCount === TOTAL_FIELDS ? '#5cb85c' : '#e8b740' }}>
          Stage 7
        </strong>{' '}
        · 真实数据接通 {realCount}/{TOTAL_FIELDS} · 工程：{projectName}
      </div>
      <div>{jointsHint}</div>
      {realCount < TOTAL_FIELDS && (
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          剩余字段未接通（该提示不应出现）
        </div>
      )}
    </div>
  );
}
