import { useState, useCallback, type ReactNode } from 'react';
import type { NodeConfig, NodeState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';

const NODES: NodeConfig[] = [
  { id: 'concept', title: 'Concept', display: 'image', description: '上传概念设计稿' },
  { id: 'tpose', title: 'T Pose', display: 'image', description: '生成标准 T Pose 正视图' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview', description: '生成多角度视图' },
  { id: 'rough', title: 'Rough Model', display: '3d', description: '生成 3D 粗模' },
  { id: 'rigging', title: 'Rough Model Rigging', display: '3d', description: '骨骼绑定' },
];

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function ConceptToRoughModel({ onStatusChange }: Props) {
  const [states, setStates] = useState<NodeState[]>([
    'ready', 'idle', 'idle', 'idle', 'idle',
  ]);

  const setNodeState = useCallback((idx: number, s: NodeState) => {
    setStates((prev) => {
      const next = [...prev];
      next[idx] = s;
      return next;
    });
  }, []);

  const runNode = useCallback(
    (idx: number) => {
      setNodeState(idx, 'running');
      onStatusChange(`正在运行：${NODES[idx].title}`, 'info');
      window.setTimeout(() => {
        setStates((prev) => {
          const next = [...prev];
          next[idx] = 'complete';
          if (idx + 1 < next.length && next[idx + 1] === 'idle') {
            next[idx + 1] = 'ready';
          }
          return next;
        });
        onStatusChange(`${NODES[idx].title} 已完成`, 'success');
      }, 2000);
    },
    [onStatusChange, setNodeState]
  );

  const resetAll = () => {
    setStates(['ready', 'idle', 'idle', 'idle', 'idle']);
    onStatusChange('已重置 Pipeline', 'info');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Pipeline header */}
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
        <span style={{ fontSize: 13, fontWeight: 600 }}>Pipeline · 单条流水线（5 节点固定）</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          从左到右依次运行，节点完成后自动激活下一节点
        </span>
        <div style={{ flex: 1 }} />
        <Button onClick={resetAll} size="sm">重置 Pipeline</Button>
      </div>

      {/* Canvas */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px 16px',
          background: 'var(--bg-app)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', minHeight: '100%' }}>
          {NODES.map((node, idx) => {
            const state = states[idx];
            const nodeContent = renderNodeBody(node, state);
            const actions = renderActions(node, state, idx, runNode, setNodeState);

            return (
              <div key={node.id} style={{ display: 'flex', alignItems: 'center' }}>
                <NodeCard title={`${idx + 1}. ${node.title}`} state={state} actions={actions}>
                  {nodeContent}
                </NodeCard>
                {idx < NODES.length - 1 && (
                  <NodeConnector fromState={state} toState={states[idx + 1]} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function renderNodeBody(node: NodeConfig, state: NodeState): ReactNode {
  return (
    <>
      <Placeholder type={node.display} state={state} label={node.title} />
      {node.description && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--text-muted)',
            lineHeight: 1.4,
          }}
        >
          {node.description}
        </div>
      )}
    </>
  );
}

function renderActions(
  node: NodeConfig,
  state: NodeState,
  idx: number,
  runNode: (idx: number) => void,
  setNodeState: (idx: number, s: NodeState) => void
): ReactNode {
  const isRunning = state === 'running';
  const isComplete = state === 'complete';
  const isError = state === 'error';

  // Concept node: upload-style controls
  if (node.id === 'concept') {
    return (
      <>
        <Button size="sm" disabled={isRunning} onClick={() => setNodeState(idx, 'idle')}>
          清除
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={isRunning}
          onClick={() => {
            // simulate "uploaded" → ready, then auto-mark as complete to feed downstream
            setNodeState(idx, 'complete');
            // also unlock T Pose
            window.setTimeout(() => setNodeState(idx + 1, 'ready'), 50);
          }}
        >
          {isComplete ? '替换图片' : '上传图片'}
        </Button>
      </>
    );
  }

  return (
    <>
      <Button size="sm" disabled={!isComplete}>导出</Button>
      {isError ? (
        <Button variant="primary" size="sm" onClick={() => runNode(idx)}>
          重试
        </Button>
      ) : isRunning ? (
        <Button variant="danger" size="sm" onClick={() => setNodeState(idx, 'ready')}>
          取消
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={state === 'idle'}
          onClick={() => runNode(idx)}
        >
          {isComplete ? '重新生成' : '生成'}
        </Button>
      )}
    </>
  );
}
