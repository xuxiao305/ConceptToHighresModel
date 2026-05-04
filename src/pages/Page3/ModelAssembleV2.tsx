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
 *   - hasAdjacency：逻辑上等价于 hasSource && hasTarget（只要两份 mesh 能 load，
 *     buildMeshAdjacency 就能跑），避免在 V2 重走 GLB 加载。
 *   - 进度：7/9。剩下 2/9 是与交互强绑定的 transient state：
 *     hasTargetRegion / hasMaskReprojection / hasOrthoCamera → 需用户在 V1
 *     跳走 2D 定位流程后产生，本阶段保留 stub。
 *   - 这里只判存在性，不实际 load blob（避免 URL.createObjectURL 泄漏，且接
 *     通 mesh 视口是更后面的切片）。
 *   - 进度：3/9。
 *
 * 边界：
 *   - 不重新实现任何对齐算法；策略 run 仍由现存 ModelAssemble 持有。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { useProject } from '../../contexts/ProjectContext';
import { useLandmarkStore } from '../../three';
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
 * Stub 定义：记录哪些字段还不是真实数据。后续切片逐个拿掉。
 *
 * TODO 未接入字段 (2/9 需用户交互产生)：
 *   - hasTargetRegion               : 需 SAM3 region selector state（transient）
 *   - hasMaskReprojection           : 需 反投影计算 state（transient）
 *   - hasOrthoCamera                : 需 正交相机装载 state（transient）
 *
 * 1/9 可推导但未作（避免 V2 重走全量 SegPack 解析）：
 *   - hasBodyTorsoRegion            : 需 SegPack regions 中 findMaskRegion(['body','torso'])
 */
const STUB_FALLBACK: Pick<
  AlignStrategyContext,
  'hasTargetRegion' | 'hasMaskReprojection' | 'hasOrthoCamera' | 'hasBodyTorsoRegion'
> = {
  hasTargetRegion: true,
  hasMaskReprojection: true,
  hasOrthoCamera: true,
  hasBodyTorsoRegion: false, // 故意 missing → limb-structure 显示 partial
};

/** Stage 7/1、7/2、7/3c、7/4: 实时接通的字段名单。 */
const REAL_FIELDS: ReadonlyArray<keyof AlignStrategyContext> = [
  'hasPoseProxyJoints',
  'hasSource',
  'hasTarget',
  'hasSegPack',
  'hasAdjacency',
  'srcLandmarkCount',
  'tarLandmarkCount',
];
const TOTAL_FIELDS = 9;


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

export function ModelAssembleV2(_props: ModelAssembleV2Props) {
  const { project, listHistory, loadPage3SegPack } = useProject();
  // Stage 7/4: 订阅全局 landmark store（V1/V2 共享）。
  const srcLandmarkCount = useLandmarkStore((s) => s.srcLandmarks.length);
  const tarLandmarkCount = useLandmarkStore((s) => s.tarLandmarks.length);
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
  // Stage 7/3c: SegPack 检测。仅记录“存在 + dirName”，不解析 / 不加载 mask，
  // 避免为了一个 bool 乘载两块二进制。真正要用 segPack 的面板后续切片再 load。
  const [segPackDirName, setSegPackDirName] = useState<string | null>(null);
  const refreshAssets = useCallback(() => {
    if (!project) {
      setSourceFileCount(0);
      setTargetFileCount(0);
      setSegPackDirName(null);
      return;
    }
    void Promise.all([
      listHistory('page2.highres'),
      listHistory('page1.rough'),
      loadPage3SegPack(),
    ]).then(([src, tar, segpack]) => {
      setSourceFileCount(src.length);
      setTargetFileCount(tar.length);
      setSegPackDirName(segpack?.dirName ?? null);
    });
  }, [project, listHistory, loadPage3SegPack]);
  // Effect 只在 project 变化时跑；在其他页面落盘后的新资产需手动 ↻ 按钮。
  useEffect(() => {
    refreshAssets();
  }, [refreshAssets]);

  // Stage 7/1+7/2+7/3c+7/4: 逐个接通。
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
      // hasAdjacency 逻辑等价于 两份 mesh 都能 load（buildMeshAdjacency 是纯函数）。
      hasAdjacency: hasSource && hasTarget,
      srcLandmarkCount,
      tarLandmarkCount,
    };
  }, [
    project?.meta.page1?.joints,
    sourceFileCount,
    targetFileCount,
    segPackDirName,
    srcLandmarkCount,
    tarLandmarkCount,
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
          <Hint>SAM3 区域选择器待挂接（当前仅检测 SegPack 存在性）</Hint>
        </PanelSection>

        <PanelSection
          title="📊 诊断日志"
          collapsed={!showLogs}
          onToggle={() => setShowLogs((v) => !v)}
        >
          <Hint>alignmentTrace 待接入</Hint>
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

        <div
          style={{
            flex: 1,
            background: 'var(--bg-app)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 14,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎬</div>
            <div>3D Viewport (待挂接 DualViewport)</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              Stage 6 scaffold · ?v2
            </div>
          </div>
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
        <strong style={{ color: '#5cb85c' }}>Stage 7/1</strong> · 真实数据接通{' '}
        {realCount}/{TOTAL_FIELDS} · 工程：{projectName}
      </div>
      <div>{jointsHint}</div>
    </div>
  );
}
