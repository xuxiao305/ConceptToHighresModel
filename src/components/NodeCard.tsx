import type { CSSProperties, ReactNode } from 'react';
import type { NodeState } from '../types';

interface NodeCardProps {
  title: string;
  state: NodeState;
  children: ReactNode;
  /** Footer button area */
  actions?: ReactNode;
  /** Optional header right-side controls (e.g. dropdown) */
  headerExtra?: ReactNode;
  width?: number | string;
  optional?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

const stateBorder: Record<NodeState, string> = {
  idle: 'var(--state-idle)',
  ready: 'var(--state-ready)',
  running: 'var(--state-running)',
  complete: 'var(--state-complete)',
  error: 'var(--state-error)',
  optional: 'var(--state-optional)',
};

const stateBadge: Record<NodeState, { label: string; color: string }> = {
  idle: { label: '待输入', color: 'var(--text-muted)' },
  ready: { label: '就绪', color: 'var(--accent-blue)' },
  running: { label: '运行中', color: 'var(--accent-blue)' },
  complete: { label: '完成', color: 'var(--accent-green)' },
  error: { label: '错误', color: 'var(--accent-red)' },
  optional: { label: '可选', color: 'var(--text-muted)' },
};

export function NodeCard({
  title,
  state,
  children,
  actions,
  headerExtra,
  width = 'var(--node-width)',
  optional = false,
  expanded = true,
  onToggleExpand,
}: NodeCardProps) {
  const borderStyle = optional && state === 'optional' ? 'dashed' : 'solid';
  const isCollapsed = optional && !expanded;

  const cardStyle: CSSProperties = {
    width,
    minWidth: typeof width === 'number' ? width : undefined,
    flex: '0 0 auto',
    background: 'var(--bg-surface)',
    border: `1.5px ${borderStyle} ${stateBorder[state]}`,
    borderRadius: 4,
    boxShadow: 'var(--shadow-card)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  };

  const badge = stateBadge[state];

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div
        style={{
          padding: '8px 10px',
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: optional && onToggleExpand ? 'pointer' : 'default',
        }}
        onClick={optional && onToggleExpand ? onToggleExpand : undefined}
      >
        {optional && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {expanded ? '▼' : '▶'}
          </span>
        )}
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 10,
            color: badge.color,
            border: `1px solid ${badge.color}`,
            borderRadius: 2,
            padding: '1px 5px',
            opacity: 0.9,
          }}
        >
          {badge.label}
        </span>
        {headerExtra}
      </div>

      {/* Body */}
      {!isCollapsed && (
        <>
          <div style={{ padding: 10 }}>{children}</div>
          {actions && (
            <div
              style={{
                padding: '8px 10px',
                borderTop: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface-2)',
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
              }}
            >
              {actions}
            </div>
          )}
        </>
      )}
    </div>
  );
}
