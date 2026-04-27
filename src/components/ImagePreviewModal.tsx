import { useEffect } from 'react';

interface ImagePreviewModalProps {
  url: string;
  title?: string;
  onClose: () => void;
}

/**
 * 全屏图片预览（双击节点触发）。点击遮罩或按 Esc 关闭。
 */
export function ImagePreviewModal({ url, title, onClose }: ImagePreviewModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        cursor: 'zoom-out',
      }}
    >
      {title && (
        <div
          style={{
            color: 'var(--text-primary)',
            fontSize: 13,
            marginBottom: 12,
            fontWeight: 500,
          }}
        >
          {title}
        </div>
      )}
      <img
        src={url}
        alt={title ?? 'preview'}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '95vw',
          maxHeight: '85vh',
          objectFit: 'contain',
          background: '#1a1a1a',
          border: '1px solid var(--border-default)',
          borderRadius: 4,
          boxShadow: 'var(--shadow-elevated)',
          cursor: 'default',
        }}
      />
      <div
        style={{
          marginTop: 12,
          color: 'var(--text-muted)',
          fontSize: 11,
        }}
      >
        点击空白处或按 Esc 关闭
      </div>
    </div>
  );
}
