import { useState, useCallback, useRef, useEffect } from 'react';
import type { NodeState, PartPipelineState, PipelineMode } from '../../types';
import { Button } from '../../components/Button';
import { getPartNodes, PartPipeline } from './PartPipeline';

const PIPELINE_MODE_LABEL: Record<PipelineMode, string> = {
  extraction: '基于 Extraction',
  multiview: 'Extract Jacket',
};

const PIPELINE_MODE_DESC: Record<PipelineMode, string> = {
  extraction: '使用 Page1 的 Extraction 输出作为源图片，由 SAM3 交互式分割 + Banana Pro 重组 4 视图',
  multiview: '使用 Page1 的 Multi-View 输出作为源图片，由 Extract Jacket 节点重新生成 4 视图',
};

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

const makeInitialNodeStates = (mode: PipelineMode): NodeState[] =>
  getPartNodes(mode).map((n) => (n.optional ? 'optional' : 'idle'));

const makePart = (idx: number, mode: PipelineMode = 'extraction'): PartPipelineState => ({
  id: `part-${Date.now()}-${idx}`,
  name: `Part ${idx + 1}`,
  mode,
  nodeStates: (() => {
    const arr = makeInitialNodeStates(mode);
    arr[0] = 'ready'; // Image Input node always starts ready
    return arr;
  })(),
  expanded: {},
  imageInput: {
    imageUrl: null,
  },
  extraction: {
    mode: 'banana',
    promptIndex: 0,
    resultUrl: null,
  },
});

export function HighresModel({ onStatusChange }: Props) {
  const [parts, setParts] = useState<PartPipelineState[]>(() => [makePart(0, 'extraction'), makePart(1, 'extraction')]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const addDropdownRef = useRef<HTMLDivElement>(null);
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);

  // Close dropdown on outside click
  useEffect(() => {
    if (!addDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (addDropdownRef.current && !addDropdownRef.current.contains(e.target as Node)) {
        setAddDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [addDropdownOpen]);

  const updatePart = useCallback((id: string, next: PartPipelineState) => {
    setParts((prev) => prev.map((p) => (p.id === id ? next : p)));
  }, []);

  const addPart = (mode: PipelineMode) => {
    setParts((prev) => {
      const next = [...prev, makePart(prev.length, mode)];
      onStatusChange(`已添加 Part ${prev.length + 1}（${PIPELINE_MODE_LABEL[mode]}）`, 'success');
      return next;
    });
    setAddDropdownOpen(false);
  };

  const requestDelete = (id: string) => setPendingDelete(id);
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const target = parts.find((p) => p.id === pendingDelete);
    setParts((prev) => prev.filter((p) => p.id !== pendingDelete));
    onStatusChange(`已删除 ${target?.name ?? 'Pipeline'}`, 'warning');
    setPendingDelete(null);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div
        style={{
          padding: '10px 16px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          多 Part 并行 Pipeline
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          每条 Pipeline 对应一个部件，可独立运行
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          共 {parts.length} 条 Pipeline
        </span>
        <div ref={addDropdownRef} style={{ position: 'relative' }}>
          <Button variant="primary" size="sm" onClick={() => setAddDropdownOpen((v) => !v)}>
            ＋ 添加 Pipeline ▾
          </Button>
          {addDropdownOpen && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: 4,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-default)',
                borderRadius: 4,
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                zIndex: 100,
                minWidth: 220,
                overflow: 'hidden',
              }}
            >
              {(['extraction', 'multiview'] as PipelineMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => addPart(m)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <div style={{ fontWeight: 600 }}>{PIPELINE_MODE_LABEL[m]}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {PIPELINE_MODE_DESC[m]}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Vertical stack of pipelines */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 16px',
          background: 'var(--bg-app)',
        }}
      >
        {parts.length === 0 && (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-muted)',
              border: '1px dashed var(--border-default)',
              borderRadius: 4,
            }}
          >
            暂无 Pipeline，点击右上角 “＋ 添加 Pipeline” 创建第一个部件
          </div>
        )}
        {parts.map((p, i) => (
          <PartPipeline
            key={p.id}
            pipeline={p}
            index={i}
            onUpdate={updatePart}
            onDelete={requestDelete}
            onStatus={onStatusChange}
          />
        ))}
      </div>

      {/* Confirmation modal */}
      {pendingDelete && (
        <ConfirmDialog
          message={`确认删除 ${parts.find((p) => p.id === pendingDelete)?.name}？\n此操作不可撤销。`}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: 4,
          padding: 20,
          width: 360,
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>确认操作</div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-line',
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        >
          {message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onCancel}>取消</Button>
          <Button variant="danger" onClick={onConfirm}>确认删除</Button>
        </div>
      </div>
    </div>
  );
}
