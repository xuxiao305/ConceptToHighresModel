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
 * 边界：
 *   - 不重新实现任何对齐算法；策略 run 仍由现存 ModelAssemble 持有。
 *   - 本组件目前不挂接真实 ProjectContext 数据，requirements 走 stub 上下文，
 *     验证注册表契约可用即可。后续切片用 useProject() 把真实值喂进去。
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../components/Button';
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
 * 占位上下文：让 requirements() 在没接通 ProjectContext 时也能渲染合理状态。
 * 后续切片把 useProject() / ModelAssemble state hook 的值搬过来即可。
 */
const STUB_CTX: AlignStrategyContext = {
  hasSource: true,
  hasTarget: true,
  hasTargetRegion: true,
  hasSegPack: true,
  hasMaskReprojection: true,
  hasPoseProxyJoints: true,
  hasOrthoCamera: true,
  hasBodyTorsoRegion: false, // 故意 missing → limb-structure 显示 partial
  hasAdjacency: true,
  srcLandmarkCount: 0,
  tarLandmarkCount: 0,
};

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
  const [selectedId, setSelectedId] = useState<AlignStrategyId>('pose-proxy');
  const [expandedReqs, setExpandedReqs] = useState<Set<AlignStrategyId>>(new Set());
  const [showLogs, setShowLogs] = useState(false);
  const [showQuality, setShowQuality] = useState(false);

  const ctx = STUB_CTX;
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
          </Row>
          <Hint>V2 scaffold · 待接入 useProject / loadByName 真实数据</Hint>
        </PanelSection>

        <PanelSection title="🎯 目标区域 (必填)">
          <Hint>SAM3 区域选择器待挂接（当前用 stub 上下文）</Hint>
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
