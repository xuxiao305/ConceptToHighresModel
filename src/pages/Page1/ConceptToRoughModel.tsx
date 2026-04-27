import { useState, useCallback, useRef, type ReactNode } from 'react';
import type { NodeConfig, NodeState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { runConceptToTPose } from '../../services/workflows';

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

interface NodeOutputs {
  conceptFile: File | null;
  conceptUrl: string | null;
  tposeUrl: string | null;
  errors: Record<number, string>;
}

export function ConceptToRoughModel({ onStatusChange }: Props) {
  const [states, setStates] = useState<NodeState[]>([
    'idle', 'idle', 'idle', 'idle', 'idle',
  ]);
  const [outputs, setOutputs] = useState<NodeOutputs>({
    conceptFile: null,
    conceptUrl: null,
    tposeUrl: null,
    errors: {},
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const setNodeState = useCallback((idx: number, s: NodeState) => {
    setStates((prev) => {
      const next = [...prev];
      next[idx] = s;
      return next;
    });
  }, []);

  // ---- Concept node ---------------------------------------------------------
  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      onStatusChange('请选择图片文件', 'error');
      return;
    }

    setOutputs((prev) => {
      if (prev.conceptUrl) URL.revokeObjectURL(prev.conceptUrl);
      if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
      return {
        conceptFile: file,
        conceptUrl: URL.createObjectURL(file),
        tposeUrl: null,
        errors: {},
      };
    });
    setStates((prev) => {
      const next = [...prev];
      next[0] = 'complete';
      next[1] = 'ready';
      for (let i = 2; i < next.length; i++) next[i] = 'idle';
      return next;
    });
    onStatusChange(`已加载概念图：${file.name}`, 'success');
  };

  const handleClearConcept = () => {
    setOutputs((prev) => {
      if (prev.conceptUrl) URL.revokeObjectURL(prev.conceptUrl);
      if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
      return { conceptFile: null, conceptUrl: null, tposeUrl: null, errors: {} };
    });
    setStates(['idle', 'idle', 'idle', 'idle', 'idle']);
    onStatusChange('已清除', 'info');
  };

  // ---- T Pose node ----------------------------------------------------------
  const runTPose = useCallback(async () => {
    if (!outputs.conceptFile) {
      onStatusChange('请先在 Concept 节点上传图片', 'error');
      return;
    }
    setNodeState(1, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 1: '' } }));
    try {
      const url = await runConceptToTPose(outputs.conceptFile, {
        onStatus: (msg) => onStatusChange(msg, 'info'),
      });
      setOutputs((prev) => {
        if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
        return { ...prev, tposeUrl: url };
      });
      setStates((prev) => {
        const next = [...prev];
        next[1] = 'complete';
        if (next[2] === 'idle') next[2] = 'ready';
        return next;
      });
      onStatusChange('T Pose 生成完成', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[T Pose] failed:', err);
      setNodeState(1, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 1: msg } }));
      onStatusChange(`T Pose 生成失败：${msg}`, 'error');
    }
  }, [outputs.conceptFile, onStatusChange, setNodeState]);

  // ---- Mock runner for nodes 2..4 -----------------------------------------
  const runMockNode = useCallback(
    (idx: number) => {
      setNodeState(idx, 'running');
      onStatusChange(`正在运行：${NODES[idx].title}（mock）`, 'info');
      window.setTimeout(() => {
        setStates((prev) => {
          const next = [...prev];
          next[idx] = 'complete';
          if (idx + 1 < next.length && next[idx + 1] === 'idle') {
            next[idx + 1] = 'ready';
          }
          return next;
        });
        onStatusChange(`${NODES[idx].title} 已完成（mock）`, 'success');
      }, 2000);
    },
    [onStatusChange, setNodeState]
  );

  const resetAll = () => {
    setOutputs((prev) => {
      if (prev.conceptUrl) URL.revokeObjectURL(prev.conceptUrl);
      if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
      return { conceptFile: null, conceptUrl: null, tposeUrl: null, errors: {} };
    });
    setStates(['idle', 'idle', 'idle', 'idle', 'idle']);
    onStatusChange('已重置 Pipeline', 'info');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

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
          T Pose 调用 ComfyUI（http://127.0.0.1:8188），其余节点为 Mock
        </span>
        <div style={{ flex: 1 }} />
        <Button onClick={resetAll} size="sm">重置 Pipeline</Button>
      </div>

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
            const imageUrl = imageForNode(idx, outputs);
            const errMsg = outputs.errors[idx];

            const body: ReactNode = (
              <>
                <Placeholder
                  type={node.display}
                  state={state}
                  label={node.title}
                  imageUrl={imageUrl}
                />
                {errMsg && state === 'error' && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: 6,
                      background: 'rgba(217, 83, 79, 0.12)',
                      border: '1px solid var(--accent-red)',
                      borderRadius: 3,
                      fontSize: 10,
                      color: 'var(--accent-red)',
                      lineHeight: 1.4,
                      maxHeight: 60,
                      overflow: 'auto',
                    }}
                  >
                    {errMsg}
                  </div>
                )}
                {!errMsg && node.description && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      lineHeight: 1.4,
                    }}
                  >
                    {node.description}
                    {idx === 0 && outputs.conceptFile && (
                      <div style={{ marginTop: 2, color: 'var(--text-secondary)' }}>
                        {outputs.conceptFile.name}
                      </div>
                    )}
                  </div>
                )}
              </>
            );

            const actions = renderActions(node, state, idx, {
              onUpload: handleUploadClick,
              onClearConcept: handleClearConcept,
              onRunTPose: runTPose,
              onRunMock: runMockNode,
              onCancelMock: () => setNodeState(idx, 'idle'),
              conceptReady: !!outputs.conceptFile,
            });

            return (
              <div key={node.id} style={{ display: 'flex', alignItems: 'center' }}>
                <NodeCard title={`${idx + 1}. ${node.title}`} state={state} actions={actions}>
                  {body}
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

function imageForNode(idx: number, outputs: NodeOutputs): string | undefined {
  if (idx === 0) return outputs.conceptUrl ?? undefined;
  if (idx === 1) return outputs.tposeUrl ?? undefined;
  return undefined;
}

interface ActionHandlers {
  onUpload: () => void;
  onClearConcept: () => void;
  onRunTPose: () => void;
  onRunMock: (idx: number) => void;
  onCancelMock: () => void;
  conceptReady: boolean;
}

function renderActions(
  node: NodeConfig,
  state: NodeState,
  idx: number,
  h: ActionHandlers
): ReactNode {
  const isRunning = state === 'running';
  const isComplete = state === 'complete';
  const isError = state === 'error';

  if (node.id === 'concept') {
    return (
      <>
        <Button size="sm" disabled={!isComplete} onClick={h.onClearConcept}>
          清除
        </Button>
        <Button variant="primary" size="sm" onClick={h.onUpload}>
          {isComplete ? '替换图片' : '上传图片'}
        </Button>
      </>
    );
  }

  if (node.id === 'tpose') {
    return (
      <>
        <Button size="sm" disabled={!isComplete}>导出</Button>
        {isError ? (
          <Button variant="primary" size="sm" onClick={h.onRunTPose}>重试</Button>
        ) : isRunning ? (
          <Button variant="danger" size="sm" disabled title="ComfyUI 任务无法从前端取消">
            生成中…
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!h.conceptReady}
            onClick={h.onRunTPose}
          >
            {isComplete ? '重新生成' : '生成'}
          </Button>
        )}
      </>
    );
  }

  return (
    <>
      <Button size="sm" disabled={!isComplete}>导出</Button>
      {isError ? (
        <Button variant="primary" size="sm" onClick={() => h.onRunMock(idx)}>重试</Button>
      ) : isRunning ? (
        <Button variant="danger" size="sm" onClick={h.onCancelMock}>取消</Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={state === 'idle'}
          onClick={() => h.onRunMock(idx)}
        >
          {isComplete ? '重新生成' : '生成'}
        </Button>
      )}
    </>
  );
}
