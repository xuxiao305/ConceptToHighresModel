import { useState, useCallback } from 'react';
import type { NodeState, PartPipelineState } from '../../types';
import { Button } from '../../components/Button';
import { PART_NODES, PartPipeline } from './PartPipeline';

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

const makeInitialNodeStates = (): NodeState[] =>
  PART_NODES.map((n) => (n.optional ? 'optional' : 'idle'));

const makePart = (idx: number): PartPipelineState => ({
  id: `part-${Date.now()}-${idx}`,
  name: `Part ${idx + 1}`,
  nodeStates: (() => {
    const arr = makeInitialNodeStates();
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
  const [parts, setParts] = useState<PartPipelineState[]>(() => [makePart(0), makePart(1)]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const updatePart = useCallback((id: string, next: PartPipelineState) => {
    setParts((prev) => prev.map((p) => (p.id === id ? next : p)));
  }, []);

  const addPart = () => {
    setParts((prev) => {
      const next = [...prev, makePart(prev.length)];
      onStatusChange(`已添加 Part ${prev.length + 1}`, 'success');
      return next;
    });
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
        <Button variant="primary" size="sm" onClick={addPart}>
          ＋ 添加 Pipeline
        </Button>
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
