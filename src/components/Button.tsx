import type { CSSProperties, ReactNode } from 'react';

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  title?: string;
  style?: CSSProperties;
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  loading = false,
  size = 'md',
  title,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  const base: CSSProperties = {
    border: '1px solid var(--border-default)',
    borderRadius: 3,
    padding: size === 'sm' ? '3px 8px' : '5px 12px',
    fontSize: size === 'sm' ? 11 : 12,
    fontWeight: 500,
    background: 'var(--bg-surface-3)',
    color: 'var(--text-primary)',
    transition: 'background 0.12s, border-color 0.12s, color 0.12s',
    opacity: isDisabled ? 0.5 : 1,
    pointerEvents: isDisabled ? 'none' : 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  };

  const variantStyles: Record<string, CSSProperties> = {
    primary: {
      background: 'var(--accent-blue)',
      borderColor: 'var(--accent-blue)',
      color: '#fff',
    },
    secondary: {},
    danger: {
      background: 'var(--accent-red)',
      borderColor: 'var(--accent-red)',
      color: '#fff',
    },
    ghost: {
      background: 'transparent',
      borderColor: 'transparent',
      color: 'var(--text-secondary)',
    },
  };

  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      style={{ ...base, ...variantStyles[variant], ...style }}
      onMouseEnter={(e) => {
        if (isDisabled) return;
        if (variant === 'primary') {
          (e.currentTarget as HTMLButtonElement).style.background =
            'var(--accent-blue-hover)';
        } else if (variant === 'secondary') {
          (e.currentTarget as HTMLButtonElement).style.background =
            'var(--bg-elevated)';
        } else if (variant === 'ghost') {
          (e.currentTarget as HTMLButtonElement).style.color =
            'var(--text-primary)';
        }
      }}
      onMouseLeave={(e) => {
        const target = e.currentTarget as HTMLButtonElement;
        if (variant === 'primary') {
          target.style.background = 'var(--accent-blue)';
        } else if (variant === 'secondary') {
          target.style.background = 'var(--bg-surface-3)';
        } else if (variant === 'ghost') {
          target.style.color = 'var(--text-secondary)';
        }
      }}
    >
      {loading && (
        <span
          style={{
            width: 10,
            height: 10,
            border: '1.5px solid currentColor',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite',
            display: 'inline-block',
          }}
        />
      )}
      {children}
    </button>
  );
}
