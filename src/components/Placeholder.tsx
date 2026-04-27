import type { CSSProperties } from 'react';
import type { DisplayType, NodeState } from '../types';

interface PlaceholderProps {
  type: DisplayType;
  state: NodeState;
  label?: string;
  height?: number | string;
}

const stateLabels: Record<NodeState, string> = {
  idle: '等待输入',
  ready: '已就绪',
  running: '运行中…',
  complete: '已完成',
  error: '运行失败',
  optional: '可选 — 点击展开',
};

export function Placeholder({ type, state, label, height = 160 }: PlaceholderProps) {
  const isMultiView = type === 'multiview';
  const isSplit = type === 'split3d';

  const baseStyle: CSSProperties = {
    width: '100%',
    height,
    background:
      'repeating-linear-gradient(45deg, #242424 0 10px, #1f1f1f 10px 20px)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: 11,
    position: 'relative',
    overflow: 'hidden',
  };

  if (state === 'running') {
    return (
      <div style={baseStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 24,
              height: 24,
              border: '2px solid var(--accent-blue)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <span style={{ color: 'var(--accent-blue)' }}>生成中…</span>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ ...baseStyle, color: 'var(--accent-red)' }}>
        ⚠ 生成失败
      </div>
    );
  }

  if (isMultiView && state === 'complete') {
    return (
      <div
        style={{
          ...baseStyle,
          background: 'var(--bg-app)',
          padding: 4,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: 4,
        }}
      >
        {['前', '后', '左', '右'].map((v) => (
          <div
            key={v}
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: 'var(--text-secondary)',
            }}
          >
            {v}视图
          </div>
        ))}
      </div>
    );
  }

  if (isSplit && state === 'complete') {
    return (
      <div
        style={{
          ...baseStyle,
          background: 'var(--bg-app)',
          padding: 4,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 4,
        }}
      >
        <div style={panelStyle}>粗模 3D</div>
        <div style={panelStyle}>高清模型 3D</div>
      </div>
    );
  }

  if (state === 'complete') {
    if (type === '3d') {
      return (
        <div
          style={{
            ...baseStyle,
            background:
              'radial-gradient(circle at 50% 45%, #4a4a4a 0%, #2a2a2a 60%, #1a1a1a 100%)',
            color: 'var(--text-secondary)',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span style={{ fontSize: 28, opacity: 0.5 }}>◈</span>
          <span style={{ fontSize: 10 }}>{label ?? '3D 模型'}</span>
        </div>
      );
    }
    return (
      <div
        style={{
          ...baseStyle,
          background:
            'linear-gradient(135deg, #4a5a6a 0%, #3a4a5a 50%, #2a3a4a 100%)',
          color: 'var(--text-primary)',
          opacity: 0.85,
        }}
      >
        {label ?? '生成结果'}
      </div>
    );
  }

  return (
    <div style={baseStyle}>
      <span style={{ animation: state === 'ready' ? 'pulse 2s ease-in-out infinite' : undefined }}>
        {label ?? stateLabels[state]}
      </span>
    </div>
  );
}

const panelStyle: CSSProperties = {
  background:
    'radial-gradient(circle at 50% 50%, #444 0%, #2a2a2a 70%)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  color: 'var(--text-secondary)',
};
