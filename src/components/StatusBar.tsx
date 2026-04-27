interface StatusBarProps {
  message: string;
  status?: 'info' | 'success' | 'warning' | 'error';
  rightInfo?: string;
}

const statusColor: Record<NonNullable<StatusBarProps['status']>, string> = {
  info: 'var(--text-secondary)',
  success: 'var(--accent-green)',
  warning: 'var(--accent-yellow)',
  error: 'var(--accent-red)',
};

export function StatusBar({ message, status = 'info', rightInfo }: StatusBarProps) {
  return (
    <div
      style={{
        height: 'var(--statusbar-height)',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border-default)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        fontSize: 11,
        color: statusColor[status],
        gap: 8,
        flex: '0 0 auto',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor[status],
          opacity: 0.8,
        }}
      />
      <span>{message}</span>
      <div style={{ flex: 1 }} />
      {rightInfo && <span style={{ color: 'var(--text-muted)' }}>{rightInfo}</span>}
    </div>
  );
}
