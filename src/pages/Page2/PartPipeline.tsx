import { useState, useCallback, type ReactNode } from 'react';
import type { NodeConfig, NodeState, PartPipelineState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';

export const PART_NODES: NodeConfig[] = [
  { id: 'extraction', title: 'Extraction', display: 'image' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview' },
  { id: 'modify', title: 'Modify', display: 'image', optional: true },
  { id: 'rough', title: 'Rough Model 3D', display: '3d' },
  { id: 'highres', title: 'Highres Model 3D', display: '3d' },
  { id: 'model', title: 'Final Model', display: '3d' },
  { id: 'retex', title: 'Re-Texturing', display: '3d', optional: true },
  { id: 'region', title: 'Region Define', display: '3d', optional: true },
];

const EXTRACTION_METHODS = ['SAM3 自动分割', '手动框选', '调色板 Mask', 'Auto Detect'];

interface Props {
  pipeline: PartPipelineState;
  index: number;
  onUpdate: (id: string, next: PartPipelineState) => void;
  onDelete: (id: string) => void;
  onStatus: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function PartPipeline({ pipeline, index, onUpdate, onDelete, onStatus }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const [extractionMethod, setExtractionMethod] = useState(EXTRACTION_METHODS[0]);
  const [splitView, setSplitView] = useState(false);

  const setStateAt = useCallback(
    (i: number, s: NodeState) => {
      const next: PartPipelineState = {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === i ? s : v)),
      };
      onUpdate(pipeline.id, next);
    },
    [pipeline, onUpdate]
  );

  const runNode = useCallback(
    (i: number) => {
      const updated: PartPipelineState = {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === i ? 'running' : v)),
      };
      onUpdate(pipeline.id, updated);
      onStatus(`[${pipeline.name}] 运行 ${PART_NODES[i].title} …`, 'info');

      window.setTimeout(() => {
        // Re-read latest by referencing current pipeline (closure captures pre-state, fine for mock)
        const after: PartPipelineState = {
          ...pipeline,
          nodeStates: pipeline.nodeStates.map((v, idx) => {
            if (idx === i) return 'complete';
            // promote next non-optional node to ready
            if (idx === i + 1) {
              const cfg = PART_NODES[idx];
              if (cfg.optional) return v === 'idle' ? 'optional' : v;
              return v === 'idle' ? 'ready' : v;
            }
            return v;
          }),
        };
        onUpdate(pipeline.id, after);
        onStatus(`[${pipeline.name}] ${PART_NODES[i].title} 完成`, 'success');
      }, 2000);
    },
    [pipeline, onUpdate, onStatus]
  );

  const toggleExpand = (i: number) => {
    onUpdate(pipeline.id, {
      ...pipeline,
      expanded: { ...pipeline.expanded, [i]: !pipeline.expanded[i] },
    });
  };

  const handleRename = () => {
    if (draftName.trim().length > 0) {
      onUpdate(pipeline.id, { ...pipeline, name: draftName.trim() });
    } else {
      setDraftName(pipeline.name);
    }
    setRenaming(false);
  };

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 4,
        marginBottom: 12,
        overflow: 'hidden',
      }}
    >
      {/* Pipeline row header */}
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ color: 'var(--text-muted)', fontSize: 11, width: 28 }}>
          #{String(index + 1).padStart(2, '0')}
        </span>
        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') {
                setDraftName(pipeline.name);
                setRenaming(false);
              }
            }}
            style={{
              background: 'var(--bg-app)',
              border: '1px solid var(--accent-blue)',
              color: 'var(--text-primary)',
              padding: '2px 6px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 2,
              outline: 'none',
              width: 180,
            }}
          />
        ) : (
          <span
            onDoubleClick={() => {
              setDraftName(pipeline.name);
              setRenaming(true);
            }}
            title="双击重命名"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary)',
              cursor: 'text',
            }}
          >
            {pipeline.name}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {pipeline.nodeStates.filter((s) => s === 'complete').length} / {PART_NODES.length} 完成
        </span>
        <Button variant="ghost" size="sm" onClick={() => onDelete(pipeline.id)}>
          🗑 删除
        </Button>
      </div>

      {/* Node row */}
      <div style={{ overflowX: 'auto', padding: '20px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {PART_NODES.map((node, i) => {
            const state = pipeline.nodeStates[i];
            const expanded = !!pipeline.expanded[i];

            const headerExtra =
              node.id === 'extraction' ? (
                <select
                  value={extractionMethod}
                  onChange={(e) => setExtractionMethod(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: 'var(--bg-app)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-default)',
                    fontSize: 10,
                    padding: '2px 4px',
                    borderRadius: 2,
                    maxWidth: 110,
                  }}
                >
                  {EXTRACTION_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : undefined;

            const displayType =
              node.id === 'highres' && splitView && state === 'complete'
                ? 'split3d'
                : node.display;

            const body: ReactNode = (
              <>
                <Placeholder type={displayType} state={state} label={`${pipeline.name} · ${node.title}`} />
                {node.id === 'extraction' && (
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                    方法：{extractionMethod}
                  </div>
                )}
                {node.id === 'highres' && state === 'complete' && (
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                    {splitView ? '左右分屏对比中' : '单视图模式'}
                  </div>
                )}
              </>
            );

            const actions = renderPartActions(node, state, i, runNode, setStateAt, splitView, setSplitView);

            return (
              <div key={node.id} style={{ display: 'flex', alignItems: 'center' }}>
                <NodeCard
                  title={`${i + 1}. ${node.title}`}
                  state={state}
                  width="var(--node-width-narrow)"
                  optional={node.optional}
                  expanded={node.optional ? expanded : true}
                  onToggleExpand={node.optional ? () => toggleExpand(i) : undefined}
                  headerExtra={headerExtra}
                  actions={actions}
                >
                  {body}
                </NodeCard>
                {i < PART_NODES.length - 1 && (
                  <NodeConnector fromState={state} toState={pipeline.nodeStates[i + 1]} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function renderPartActions(
  node: NodeConfig,
  state: NodeState,
  idx: number,
  runNode: (i: number) => void,
  setStateAt: (i: number, s: NodeState) => void,
  splitView: boolean,
  setSplitView: (v: boolean) => void
): ReactNode {
  if (node.optional && state === 'optional') {
    return (
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          setStateAt(idx, 'ready');
        }}
      >
        启用此节点
      </Button>
    );
  }

  const isRunning = state === 'running';
  const isComplete = state === 'complete';
  const isError = state === 'error';

  const primaryLabel = isComplete
    ? node.id === 'model'
      ? '已确认'
      : '重新生成'
    : node.id === 'model'
    ? '确认'
    : '生成';

  const extraButtons: ReactNode[] = [];
  if (node.id === 'highres' && isComplete) {
    extraButtons.push(
      <Button
        key="cmp"
        size="sm"
        onClick={() => setSplitView(!splitView)}
      >
        {splitView ? '关闭对比' : '对比粗模'}
      </Button>
    );
  }
  if (node.id === 'modify' && state !== 'optional') {
    extraButtons.push(
      <Button key="undo" size="sm" disabled={isRunning}>撤销</Button>
    );
  }

  return (
    <>
      {extraButtons}
      {isError ? (
        <Button variant="primary" size="sm" onClick={() => runNode(idx)}>重试</Button>
      ) : isRunning ? (
        <Button variant="danger" size="sm" onClick={() => setStateAt(idx, 'ready')}>取消</Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={state === 'idle'}
          onClick={() => runNode(idx)}
        >
          {primaryLabel}
        </Button>
      )}
    </>
  );
}
