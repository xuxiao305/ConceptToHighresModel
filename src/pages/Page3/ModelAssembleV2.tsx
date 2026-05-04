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
 * 边界：
 *   - 不重新实现任何对齐算法；策略 run 仍由现存 ModelAssemble 持有。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { useProject } from '../../contexts/ProjectContext';
import type { Page3Session } from '../../services/projectStore';
import { parseSegmentationJson } from '../../services/segmentationPack';
import {
  DualViewport,
  loadGlbAsMesh,
  useLandmarkStore,
  type Face3,
  type Vec3,
  type ViewMode,
} from '../../three';
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

interface ModelAssembleV2Props {
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

export function ModelAssembleV2(_props: ModelAssembleV2Props) {
  const { project, listHistory, loadLatest, loadPage3SegPack, loadPage3Session } = useProject();
  // Stage 7/4: 订阅全局 landmark store（V1/V2 共享）。
  const srcLandmarks = useLandmarkStore((s) => s.srcLandmarks);
  const tarLandmarks = useLandmarkStore((s) => s.tarLandmarks);
  const srcLandmarkCount = srcLandmarks.length;
  const tarLandmarkCount = tarLandmarks.length;
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
          Page3 V2（Stage 8/1）：DualViewport 已接通，picking/SAM3/run 仍在 V1。生产路径请使用默认路由。
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
          <Row>
            <Button size="sm">Source GLB</Button>
            <Button size="sm">Target GLB</Button>
            <Button size="sm" onClick={refreshAssets} title="重新扫描工程内 GLB">↻</Button>
          </Row>
          <Hint>
            page2.highres: {sourceFileCount} 个 · page1.rough: {targetFileCount} 个
            {sourceFileCount === 0 && targetFileCount === 0 && '（工程内尚无 GLB）'}
          </Hint>
          <Hint>Stage 7/2 · 仅检测存在性；实际加载等后续切片接入视口</Hint>
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
            <Hint>page3_session.json 未生成（请在 V1 完成 2D 定位交互）</Hint>
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
          <span style={{ fontSize: 12, fontWeight: 600 }}>Result Overlay</span>
          <Button size="sm" variant="primary">Overlay</Button>
          <Button size="sm">Aligned</Button>
          <Button size="sm">Target</Button>
          <Button size="sm">Original</Button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            策略: {selectedStrategy.label}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {srcMesh && tarMesh ? (
            <DualViewport
              srcVertices={srcMesh.vertices}
              srcFaces={srcMesh.faces}
              tarVertices={tarMesh.vertices}
              tarFaces={tarMesh.faces}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              srcLandmarks={srcLandmarks}
              tarLandmarks={tarLandmarks}
              pickingEnabled={false}
              srcLabel="Source (page2.highres)"
              tarLabel="Target (page1.rough)"
              showCameraSync
              height="100%"
            />
          ) : (
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
        <QualityDrawer open={showQuality} onToggle={() => setShowQuality((v) => !v)} />

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
            <span style={{ color: 'var(--text-muted)' }}>RMSE 待接入</span>
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
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="primary" style={{ flex: 1, justifyContent: 'center' }}>
              ✓ 接受对齐
            </Button>
            <Button size="sm" style={{ flex: 1, justifyContent: 'center' }}>
              ↶ 撤销
            </Button>
          </div>
        </div>

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

function QualityDrawer({ open, onToggle }: { open: boolean; onToggle: () => void }) {
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
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          待挂接 alignResult.rmse / scale / iterationCount
        </div>
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
