/**
 * Page3 重构 UI Mockup — 仅布局示意，无任何功能。
 *
 * 用于和用户确认整体布局/视觉结构后，再逐步把真实交互接进来。
 *
 * 与生产 ModelAssemble 相比：
 * - 左侧扩宽到 360px，承载 模型输入 / Gallery / SAM3 / 区域选择 / 日志
 * - 右侧 360px，承载 4 张策略卡 / 步骤产出 / 结果质量 / 高级
 * - 中间保持视口区
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../../components/Button';

type StrategyId = 'pose-proxy' | 'limb' | 'surface' | 'manual';
type StrategyState = 'ready' | 'partial' | 'unavailable';

interface StrategyMeta {
  id: StrategyId;
  title: string;
  scene: string;
  state: StrategyState;
  stateLabel: string;
  reqs: Array<{ ok: boolean; label: string; note?: string }>;
}

const STRATEGIES: StrategyMeta[] = [
  {
    id: 'pose-proxy',
    title: 'Pose Proxy',
    scene: '推荐 · 外套 / 上衣整体',
    state: 'ready',
    stateLabel: '全部就绪',
    reqs: [
      { ok: true, label: 'Source mesh' },
      { ok: true, label: 'Target mesh + 区域' },
      { ok: true, label: 'Page2 pipeline joints' },
      { ok: true, label: 'Page1 MultiView front' },
      { ok: true, label: 'DWPose 服务' },
    ],
  },
  {
    id: 'limb',
    title: '四肢大结构',
    scene: '手臂 / 腿 单部件',
    state: 'partial',
    stateLabel: '缺 body 区域',
    reqs: [
      { ok: true, label: 'Source mesh' },
      { ok: true, label: 'Target mesh + 区域' },
      { ok: false, label: 'Body / Torso 区域', note: 'SAM3 需要识别出 body 区域' },
    ],
  },
  {
    id: 'surface',
    title: 'Surface RANSAC',
    scene: '兜底 · 局部表面匹配',
    state: 'ready',
    stateLabel: '就绪',
    reqs: [
      { ok: true, label: 'Source mesh + 邻接' },
      { ok: true, label: 'Target mesh + 区域 + 邻接' },
    ],
  },
  {
    id: 'manual',
    title: '手动 Landmark',
    scene: '人工兜底 · Ctrl+左键添加点对',
    state: 'ready',
    stateLabel: '0 / 0',
    reqs: [
      { ok: true, label: 'Source mesh' },
      { ok: true, label: 'Target mesh' },
    ],
  },
];

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

interface StepDef {
  idx: number;
  name: string;
  detail: string;
  status: StepStatus;
  time: string;
  params?: Array<{ label: string; value: string }>;
}

const ICP_PARAMS = [
  { label: '最大迭代', value: '30' },
  { label: '采样点数', value: '400' },
  { label: '拒绝倍数', value: '2.5' },
  { label: '收敛阈值', value: '0.5%' },
];

const STEPS_BY_STRATEGY: Record<StrategyId, StepDef[]> = {
  'pose-proxy': [
    { idx: 1, name: '区域定位',     detail: '2,847 顶点',                    status: 'done',    time: '0.3s' },
    { idx: 2, name: 'Pose Proxy 解算', detail: '8 anchor + 4 joint pairs',     status: 'done',    time: '0.8s',
      params: [
        { label: 'Anchor 间隔', value: '0.05' },
        { label: 'DWPose 阈值', value: '0.6' },
      ] },
    { idx: 3, name: 'Landmark SVD',  detail: 'RMSE 0.034',                  status: 'done',    time: '0.1s' },
    { idx: 4, name: 'ICP refine',    detail: '30 轮 · kept 287 · RMSE 0.023', status: 'running', time: '…',
      params: ICP_PARAMS },
  ],
  limb: [
    { idx: 1, name: '区域定位',      detail: '左手臂 · 1,204 顶点',         status: 'done',    time: '0.2s' },
    { idx: 2, name: '主轴 / 端点提取', detail: '主轴 ↑ + 2 端点',              status: 'done',    time: '0.4s',
      params: [{ label: 'PCA 采样点', value: '512' }] },
    { idx: 3, name: 'Limb 锚点对',  detail: '6 对主体 + 2 对端点',         status: 'done',    time: '0.1s' },
    { idx: 4, name: 'Landmark SVD',   detail: 'RMSE 0.041',                   status: 'done',    time: '0.1s' },
    { idx: 5, name: 'ICP refine',     detail: '待运行',                          status: 'pending', time: '',
      params: ICP_PARAMS },
  ],
  surface: [
    { idx: 1, name: '区域定位',      detail: '2,847 顶点',                  status: 'done',    time: '0.3s' },
    { idx: 2, name: 'FPFH 描述子',   detail: 'Source 25 · Target 80',          status: 'done',    time: '1.4s',
      params: [
        { label: 'Source 采样', value: '25' },
        { label: 'Target 采样', value: '80' },
        { label: 'Top-K',      value: '8' },
      ] },
    { idx: 3, name: 'RANSAC 候选',  detail: '600 迭代 · best inlier 47%', status: 'running', time: '…',
      params: [{ label: '迭代次数', value: '600' }] },
    { idx: 4, name: 'ICP refine',     detail: '待运行',                        status: 'pending', time: '',
      params: ICP_PARAMS },
  ],
  manual: [
    { idx: 1, name: '拾取点对',     detail: 'Source 0 · Target 0 (Ctrl+左键添加)', status: 'pending', time: '—' },
    { idx: 2, name: 'Landmark SVD', detail: '待资料',                              status: 'pending', time: '' },
    { idx: 3, name: 'ICP refine',   detail: '待运行',                              status: 'pending', time: '',
      params: ICP_PARAMS },
  ],
};

interface ModelAssembleMockupProps {
  onStatusChange?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function ModelAssembleMockup(_props: ModelAssembleMockupProps) {
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyId>('pose-proxy');
  const [showLogs, setShowLogs] = useState(false);
  const [expandedReqs, setExpandedReqs] = useState<Set<StrategyId>>(new Set());
  const [expandedStepParams, setExpandedStepParams] = useState<Set<number>>(new Set());
  const [showQuality, setShowQuality] = useState(false);

  const toggleStepParams = (idx: number) => {
    setExpandedStepParams((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const steps = STEPS_BY_STRATEGY[selectedStrategy];

  const toggleReqs = (id: StrategyId) => {
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
      {/* ─────────────────── 左侧：数据 / 区域 / 日志 ─────────────────── */}
      <aside style={asideStyle('left')}>
        <PanelSection title="📦 模型输入">
          <Row>
            <Button size="sm">Source GLB</Button>
            <Button size="sm">Target GLB</Button>
          </Row>
          <Row>
            <Button size="sm">加载 Demo</Button>
            <Button size="sm">加载粗模</Button>
          </Row>
          <Hint>
            Source: arm_hires_Deformed.glb · 12,478 V<br/>
            Target: bot.glb · 38,221 V
          </Hint>
        </PanelSection>

        <PanelSection title="️ SAM3 分割包">
          <Button size="sm" style={{ width: '100%', justifyContent: 'center' }}>
            加载分割包目录
          </Button>
          <div style={statusBoxStyle('ok')}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>✓ 已加载</div>
            <div>参考图: ref_front.png</div>
            <div>Mask: mask_v2.png</div>
            <div>检测到 4 个区域</div>
          </div>
        </PanelSection>

        <PanelSection title="🎯 目标区域 (必填)">
          <select style={selectStyle()}>
            <option>jacket</option>
            <option>left_arm</option>
            <option>right_arm</option>
            <option>body</option>
          </select>
          <Hint>系统推荐: jacket · 当前: jacket · 2,847 顶点</Hint>
          <Hint style={{ color: 'var(--accent-blue)' }}>
            💡 切换区域将清空当前对齐结果
          </Hint>
        </PanelSection>

        <PanelSection
          title={`📊 诊断日志 (12 条)`}
          collapsed={!showLogs}
          onToggle={() => setShowLogs(v => !v)}
        >
          <Row>
            <input
              placeholder="按 stage 名过滤..."
              style={inputStyle()}
            />
            <Button size="sm">复制</Button>
          </Row>
          <pre style={preStyle()}>
{`[14:23:01] auto-align-click
  mode: pose-proxy
  region: jacket

[14:23:01] auto-region-from-existing
  vertices: 2847

[14:23:02] auto-pose-proxies
  srcAnchors: 5
  tarAnchors: 5

[14:23:02] auto-pose-svd
  rmse: 0.034
  reliable: true`}
          </pre>
        </PanelSection>
      </aside>

      {/* ─────────────────── 中间：视口 ─────────────────── */}
      <main style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          background: 'var(--bg-surface)',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Result Overlay</span>
          <Button size="sm" variant="primary">Overlay</Button>
          <Button size="sm">Aligned</Button>
          <Button size="sm">Target</Button>
          <Button size="sm">Original</Button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            按 Ctrl + 左键 添加 landmark · 当前模式: 手动
          </span>
        </div>

        <div style={{
          flex: 1,
          background: 'var(--bg-app)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 14,
          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 20px, rgba(255,255,255,0.02) 20px, rgba(255,255,255,0.02) 40px)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎬</div>
            <div>3D Viewport (DualViewport / ResultPreview)</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>mockup placeholder</div>
          </div>
        </div>

        {/* Source Gallery — 横向滚动条，承载该 source 的所有部件 / 变体 */}
        <div style={{
          borderTop: '1px solid var(--border-default)',
          background: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{
            padding: '6px 12px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span>🖼️ Source Gallery</span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
              当前: #1 · jacket_v3 · 12,478 V
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 10 }}>
              共 12 个部件
            </span>
          </div>
          <div style={{
            padding: '0 8px 8px',
            display: 'flex',
            gap: 6,
            overflowX: 'auto',
          }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{
                minWidth: 88,
                height: 88,
                background: 'var(--bg-surface-2)',
                border: i === 0 ? '2px solid var(--accent-blue)' : '1px solid var(--border-subtle)',
                borderRadius: 3,
                fontSize: 10,
                color: 'var(--text-muted)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}>
                <div style={{ fontSize: 18 }}>📦</div>
                <div style={{ marginTop: 4 }}>part_{i + 1}</div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* ─────────────────── 右侧：策略 / 进度 ─────────────────── */}
      <aside style={{ ...asideStyle('right'), position: 'relative' }}>
        {/* 结果质量抽屉 — 详情默认收起，点边缘 tab 拉出 */}
        <QualityDrawer open={showQuality} onToggle={() => setShowQuality(v => !v)} />

        {/* 常驻操作条 — 接受 / 撤销 + 质量摘要（永远可见，不被忽略）*/}
        <div style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--border-default)',
          background: 'linear-gradient(180deg, rgba(92,184,92,0.10), transparent)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
          }}>
            <span style={{ color: '#5cb85c', fontWeight: 700 }}>★★★ 良好</span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ color: 'var(--text-secondary)' }}>RMSE 0.023</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setShowQuality(v => !v)}
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
          {STRATEGIES.map(s => (
            <StrategyCard
              key={s.id}
              meta={s}
              selected={selectedStrategy === s.id}
              expanded={expandedReqs.has(s.id)}
              onSelect={() => setSelectedStrategy(s.id)}
              onToggleReqs={() => toggleReqs(s.id)}
            />
          ))}
        </PanelSection>

        <PanelSection title={`📋 流程步骤 · ${selectedStrategy}`}>
          {steps.map(step => (
            <StepCard
              key={step.idx}
              step={step}
              expanded={expandedStepParams.has(step.idx)}
              onToggleParams={() => toggleStepParams(step.idx)}
            />
          ))}
        </PanelSection>
      </aside>
    </div>
  );
}

/* ─────────────────────── 子组件 ─────────────────────── */
function QualityDrawer({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const drawerWidth = 280;
  const asideWidth = 360; // 右侧栏宽度，和 grid 模板一致
  return (
    <>
      {/* 边缘 tab 按钮 — 固定贴在右侧栏的左边缘外侧 */}
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

      {/* 抽屉面板 */}
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
          borderTop: '1px solid var(--border-default)',
          borderBottom: '1px solid var(--border-default)',
          padding: 12,
          boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
          transition: 'right 0.2s ease, opacity 0.2s ease',
          zIndex: 1000,
          overflowY: 'auto',
        }}
      >
        <div style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span>📊 结果质量</span>
        </div>
        <div style={{
          padding: 10,
          border: '1px solid #5cb85c',
          borderRadius: 4,
          background: 'var(--bg-app)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          lineHeight: 1.7,
          marginBottom: 10,
        }}>
          <div style={{ color: '#5cb85c', fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
            ★★★ 良好
          </div>
          <div>策略: Pose Proxy</div>
          <div>目标区域: jacket · 2,847 顶点</div>
          <div>匹配点: 12 对</div>
          <div>RMSE: 0.023</div>
          <div>Scale: 0.412</div>
          <div>方法: ICP (30轮收敛)</div>
          <div>耗时: 1.2s</div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
          接受 / 撤销 按钮在右栏顶部 ↗
        </div>
      </div>
    </>
  );
}
function StrategyCard({
  meta,
  selected,
  expanded,
  onSelect,
  onToggleReqs,
}: {
  meta: StrategyMeta;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleReqs: () => void;
}) {
  const stateColor = {
    ready: '#5cb85c',
    partial: '#e8b740',
    unavailable: '#888',
  }[meta.state];

  const stateIcon = {
    ready: '🟢',
    partial: '🟡',
    unavailable: '⚪',
  }[meta.state];

  return (
    <div
      onClick={onSelect}
      style={{
        marginBottom: 8,
        padding: 10,
        borderRadius: 4,
        border: selected
          ? '2px solid var(--accent-blue)'
          : '1px solid var(--border-default)',
        background: selected ? 'rgba(74,144,226,0.08)' : 'var(--bg-app)',
        cursor: 'pointer',
        transition: 'all 0.12s',
      }}
    >
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <input
          type="radio"
          checked={selected}
          readOnly
          style={{ marginRight: 2 }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
          {meta.title}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1 }}>
          {meta.scene}
        </span>
      </div>

      {/* 状态徽章 + 详情按钮 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: stateColor }}>
          {stateIcon} {meta.stateLabel}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={(e) => { e.stopPropagation(); onToggleReqs(); }}
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

      {/* 前置数据列表 */}
      {expanded && (
        <div style={{
          padding: 8,
          background: 'var(--bg-surface)',
          borderRadius: 3,
          fontSize: 11,
          marginBottom: 8,
        }}>
          {meta.reqs.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, color: r.ok ? '#5cb85c' : '#e8b740' }}>
              <span>{r.ok ? '✓' : '✗'}</span>
              <span style={{ flex: 1 }}>{r.label}</span>
              {r.note && <span style={{ fontSize: 10 }}>{r.note}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 执行按钮区域 */}
      {meta.id === 'manual' ? (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            Source landmarks: <b style={{ color: 'var(--text-primary)' }}>0</b>
            {' · '}
            Target landmarks: <b style={{ color: 'var(--text-primary)' }}>0</b>
          </div>
          <Row>
            <Button size="sm" variant="primary" style={{ flex: 1, justifyContent: 'center' }}>
              SVD 对齐
            </Button>
            <Button size="sm" style={{ flex: 1, justifyContent: 'center' }}>
              ICP 精化
            </Button>
          </Row>
        </>
      ) : (
        <Button
          size="sm"
          variant={selected ? 'primary' : 'secondary'}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          一键 · {meta.title} 对齐
        </Button>
      )}
    </div>
  );
}

function StepCard({
  step,
  expanded,
  onToggleParams,
}: {
  step: StepDef;
  expanded: boolean;
  onToggleParams: () => void;
}) {
  const icon = { pending: '⏸️', running: '⏳', done: '✅', failed: '❌' }[step.status];
  const color = {
    pending: 'var(--text-muted)',
    running: 'var(--accent-blue)',
    done: 'var(--text-primary)',
    failed: '#d9534f',
  }[step.status];
  const hasParams = step.params && step.params.length > 0;

  return (
    <div style={{
      marginBottom: 6,
      padding: '8px 10px',
      borderRadius: 4,
      border: '1px solid var(--border-default)',
      background: step.status === 'running' ? 'rgba(74,144,226,0.08)' : 'var(--bg-app)',
      borderLeft: `3px solid ${step.status === 'pending' ? 'var(--border-default)' : color}`,
    }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{icon}</span>
        <span style={{ fontSize: 11, color, fontWeight: 600 }}>
          Step {step.idx} · {step.name}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{step.time}</span>
        {hasParams && (
          <button
            onClick={onToggleParams}
            title="参数"
            style={{
              background: 'transparent',
              border: 'none',
              color: expanded ? 'var(--accent-blue)' : 'var(--text-muted)',
              fontSize: 11,
              cursor: 'pointer',
              padding: '0 2px',
            }}
          >
            ⚙ {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>

      {/* 数据描述 */}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, marginLeft: 18 }}>
        {step.detail}
      </div>

      {/* 重跑此步 */}
      <div style={{ marginTop: 6, marginLeft: 18 }}>
        <Button size="sm" style={{ padding: '2px 8px', fontSize: 10 }}>
          重跑此步
        </Button>
      </div>

      {/* 参数区（可折叠）*/}
      {expanded && hasParams && (
        <div style={{
          marginTop: 8,
          marginLeft: 18,
          padding: 8,
          background: 'var(--bg-surface)',
          borderRadius: 3,
        }}>
          {step.params!.map((p, i) => (
            <SliderRow key={i} label={p.label} value={p.value} />
          ))}
        </div>
      )}
    </div>
  );
}

function SliderRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 10,
        color: 'var(--text-muted)',
      }}>
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <input type="range" style={{ width: '100%' }} />
    </div>
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
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>{children}</div>
  );
}

function Hint({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 11,
      color: 'var(--text-muted)',
      lineHeight: 1.5,
      marginTop: 4,
      ...style,
    }}>
      {children}
    </div>
  );
}

/* ─────────────────────── 样式辅助 ─────────────────────── */

function asideStyle(side: 'left' | 'right'): CSSProperties {
  return {
    background: 'var(--bg-surface)',
    [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--border-default)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
  };
}

function statusBoxStyle(_kind: 'ok' | 'warn' | 'err'): CSSProperties {
  return {
    marginTop: 6,
    padding: 8,
    border: '1px solid var(--border-default)',
    borderRadius: 3,
    background: 'var(--bg-app)',
    fontSize: 11,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
  };
}

function selectStyle(): CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 3,
    padding: '4px 6px',
    fontSize: 11,
  };
}

function inputStyle(): CSSProperties {
  return {
    flex: 1,
    background: 'var(--bg-app)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 3,
    padding: '4px 6px',
    fontSize: 11,
  };
}

function preStyle(): CSSProperties {
  return {
    margin: 0,
    marginTop: 6,
    padding: 8,
    maxHeight: 220,
    overflow: 'auto',
    background: 'var(--bg-app)',
    border: '1px solid var(--border-default)',
    borderRadius: 3,
    color: 'var(--text-secondary)',
    fontSize: 10,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
}
