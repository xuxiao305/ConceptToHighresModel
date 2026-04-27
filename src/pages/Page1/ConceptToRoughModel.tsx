import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import type { NodeConfig, NodeState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { runConceptToTPose, runTPoseMultiView } from '../../services/workflows';
import { runImageToModel, TripoServiceError } from '../../services/tripo';
import { useProject } from '../../contexts/ProjectContext';

const NODES: NodeConfig[] = [
  { id: 'concept', title: 'Concept', display: 'image', description: '上传概念设计稿' },
  { id: 'tpose', title: 'T Pose', display: 'image', description: '生成标准 T Pose 正视图' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview', description: '生成多角度视图' },
  { id: 'rough', title: 'Rough Model', display: '3d', description: 'Tripo AI 生成 3D 粗模 (GLB)' },
  { id: 'rigging', title: 'Rough Model Rigging', display: '3d', description: '骨骼绑定' },
];

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface NodeOutputs {
  conceptFile: File | null;
  conceptUrl: string | null;
  tposeUrl: string | null;
  multiviewUrl: string | null;
  /** Rough model（GLB）blob URL，用于触发浏览器下载 */
  roughUrl: string | null;
  /** Rough model 工程文件名（用于显示） */
  roughFile: string | null;
  errors: Record<number, string>;
}

export function ConceptToRoughModel({ onStatusChange }: Props) {
  const { project, saveAsset, loadLatest } = useProject();
  const [states, setStates] = useState<NodeState[]>([
    'idle', 'idle', 'idle', 'idle', 'idle',
  ]);
  const [outputs, setOutputs] = useState<NodeOutputs>({
    conceptFile: null,
    conceptUrl: null,
    tposeUrl: null,
    multiviewUrl: null,
    roughUrl: null,
    roughFile: null,
    errors: {},
  });
  const roughAbortRef = useRef<AbortController | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const setNodeState = useCallback((idx: number, s: NodeState) => {
    setStates((prev) => {
      const next = [...prev];
      next[idx] = s;
      return next;
    });
  }, []);

  // ---- Project load: 切换工程时拉取最新历史版本 ---------------------------
  useEffect(() => {
    let cancelled = false;
    if (!project) return;

    (async () => {
      const concept = await loadLatest('page1.concept');
      const tpose = await loadLatest('page1.tpose');
      const multiview = await loadLatest('page1.multiview');
      const rough = await loadLatest('page1.rough');
      if (cancelled) return;

      // 用读出的 Blob 构造一个 File 对象，使后续 T Pose 节点可直接复用
      const conceptFile = concept
        ? new File([concept.blob], concept.version.file, { type: concept.blob.type || 'image/png' })
        : null;

      setOutputs((prev) => {
        if (prev.conceptUrl) URL.revokeObjectURL(prev.conceptUrl);
        if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
        if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
        if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
        return {
          conceptFile,
          conceptUrl: concept?.url ?? null,
          tposeUrl: tpose?.url ?? null,
          multiviewUrl: multiview?.url ?? null,
          roughUrl: rough?.url ?? null,
          roughFile: rough?.version.file ?? null,
          errors: {},
        };
      });

      setStates(() => {
        const next: NodeState[] = ['idle', 'idle', 'idle', 'idle', 'idle'];
        if (concept) next[0] = 'complete';
        if (tpose) next[1] = 'complete';
        else if (concept) next[1] = 'ready';
        if (multiview) next[2] = 'complete';
        else if (tpose) next[2] = 'ready';
        if (rough) next[3] = 'complete';
        else if (multiview) next[3] = 'ready';
        return next;
      });

      const loaded: string[] = [];
      if (concept) loaded.push('Concept');
      if (tpose) loaded.push('T Pose');
      if (multiview) loaded.push('Multi-View');
      if (rough) loaded.push('Rough Model');
      onStatusChange(
        loaded.length
          ? `已从工程加载：${loaded.join(' / ')}`
          : '工程为空，可从 Concept 节点开始',
        loaded.length ? 'success' : 'info'
      );
    })().catch((err) => {
      if (cancelled) return;
      onStatusChange(`加载工程数据失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    });

    return () => {
      cancelled = true;
    };
    // 仅在工程切换时重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

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
      if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
      if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
      return {
        conceptFile: file,
        conceptUrl: URL.createObjectURL(file),
        tposeUrl: null,
        multiviewUrl: null,
        roughUrl: null,
        roughFile: null,
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

    // 持久化到工程
    if (project) {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      saveAsset('page1.concept', file, ext, file.name).then(
        (v) => v && onStatusChange(`已保存到工程：${v.file}`, 'success'),
        (err) => onStatusChange(`保存到工程失败：${err.message ?? err}`, 'error')
      );
    }
  };

  const handleClearConcept = () => {
    setOutputs((prev) => {
      if (prev.conceptUrl) URL.revokeObjectURL(prev.conceptUrl);
      if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
      if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
      if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
      return {
        conceptFile: null,
        conceptUrl: null,
        tposeUrl: null,
        multiviewUrl: null,
        roughUrl: null,
        roughFile: null,
        errors: {},
      };
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
        if (next[2] === 'idle' || next[2] === 'error') next[2] = 'ready';
        // Invalidate downstream
        for (let i = 3; i < next.length; i++) next[i] = 'idle';
        return next;
      });
      // Also clear stale multi-view output
      setOutputs((prev) => {
        if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
        return { ...prev, multiviewUrl: null };
      });
      onStatusChange('T Pose 生成完成', 'success');

      // 持久化
      if (project) {
        try {
          const blob = await (await fetch(url)).blob();
          const v = await saveAsset('page1.tpose', blob, 'png');
          if (v) onStatusChange(`T Pose 已保存到工程：${v.file}`, 'success');
        } catch (e) {
          onStatusChange(
            `T Pose 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error'
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[T Pose] failed:', err);
      setNodeState(1, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 1: msg } }));
      onStatusChange(`T Pose 生成失败：${msg}`, 'error');
    }
  }, [outputs.conceptFile, onStatusChange, setNodeState, project, saveAsset]);

  // ---- Multi-View node (real ComfyUI workflow) ----------------------------
  const runMultiView = useCallback(async () => {
    if (!outputs.tposeUrl) {
      onStatusChange('请先生成 T Pose', 'error');
      return;
    }
    setNodeState(2, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 2: '' } }));
    try {
      const url = await runTPoseMultiView(outputs.tposeUrl, {
        onStatus: (msg) => onStatusChange(msg, 'info'),
      });
      setOutputs((prev) => {
        if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
        return { ...prev, multiviewUrl: url };
      });
      setStates((prev) => {
        const next = [...prev];
        next[2] = 'complete';
        if (next[3] === 'idle') next[3] = 'ready';
        return next;
      });
      onStatusChange('Multi-View 生成完成', 'success');

      // 持久化
      if (project) {
        try {
          const blob = await (await fetch(url)).blob();
          const v = await saveAsset('page1.multiview', blob, 'png');
          if (v) onStatusChange(`Multi-View 已保存到工程：${v.file}`, 'success');
        } catch (e) {
          onStatusChange(
            `Multi-View 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error'
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Multi-View] failed:', err);
      setNodeState(2, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 2: msg } }));
      onStatusChange(`Multi-View 生成失败：${msg}`, 'error');
    }
  }, [outputs.tposeUrl, onStatusChange, setNodeState, project, saveAsset]);

  // ---- Rough Model node (Tripo AI image → GLB) ---------------------------
  const runRoughModel = useCallback(async () => {
    if (!outputs.multiviewUrl) {
      onStatusChange('请先生成 Multi-View', 'error');
      return;
    }
    setNodeState(3, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 3: '' } }));

    const ctrl = new AbortController();
    roughAbortRef.current = ctrl;

    try {
      // 使用 Multi-View 作为 Tripo 输入（匹配流水线的连接）。
      // 如果后续需更高质量，可改为 outputs.tposeUrl（干净正视图）。
      const inputBlob = await (await fetch(outputs.multiviewUrl)).blob();

      const { blob, result } = await runImageToModel(inputBlob, {
        onStatus: (msg) => onStatusChange(msg, 'info'),
        signal: ctrl.signal,
        filename: 'multiview.png',
      });

      // 持久化 + 产生预览 URL
      let savedFile: string | null = null;
      if (project) {
        try {
          const v = await saveAsset(
            'page1.rough',
            blob,
            'glb',
            `tripo task ${result.task_id}`
          );
          if (v) {
            savedFile = v.file;
            onStatusChange(`粗模已保存到工程：${v.file}`, 'success');
          }
        } catch (e) {
          onStatusChange(
            `粗模保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error'
          );
        }
      }

      setOutputs((prev) => {
        if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
        return {
          ...prev,
          roughUrl: URL.createObjectURL(blob),
          roughFile: savedFile,
        };
      });
      setStates((prev) => {
        const next = [...prev];
        next[3] = 'complete';
        if (next[4] === 'idle') next[4] = 'ready';
        return next;
      });
      onStatusChange('Rough Model 生成完成', 'success');
    } catch (err) {
      const msg =
        err instanceof TripoServiceError
          ? `${err.message}${err.error_code ? ` (code ${err.error_code})` : ''}${
              err.task_id ? ` [task ${err.task_id}]` : ''
            }`
          : err instanceof Error
          ? err.message
          : String(err);
      console.error('[Rough Model] failed:', err);
      setNodeState(3, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 3: msg } }));
      onStatusChange(`Rough Model 生成失败：${msg}`, 'error');
    } finally {
      roughAbortRef.current = null;
    }
  }, [outputs.multiviewUrl, onStatusChange, setNodeState, project, saveAsset]);

  const cancelRoughModel = useCallback(() => {
    roughAbortRef.current?.abort();
    roughAbortRef.current = null;
  }, []);

  // ---- Mock runner for nodes 3..4 (Rough Model / Rigging) -----------------
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
      if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
      if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
      return {
        conceptFile: null,
        conceptUrl: null,
        tposeUrl: null,
        multiviewUrl: null,
        roughUrl: null,
        roughFile: null,
        errors: {},
      };
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
          T Pose / Multi-View 调用 ComfyUI（http://127.0.0.1:8188）
          {project ? ' · 自动保存到工程' : ' · 未打开工程（不持久化）'}
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
              onRunMultiView: runMultiView,
              onRunRoughModel: runRoughModel,
              onCancelRoughModel: cancelRoughModel,
              onDownloadRough: () => {
                if (!outputs.roughUrl) return;
                const a = document.createElement('a');
                a.href = outputs.roughUrl;
                a.download = outputs.roughFile ?? 'rough_model.glb';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              },
              onRunMock: runMockNode,
              onCancelMock: () => setNodeState(idx, 'idle'),
              conceptReady: !!outputs.conceptFile,
              tposeReady: !!outputs.tposeUrl,
              multiviewReady: !!outputs.multiviewUrl,
              roughReady: !!outputs.roughUrl,
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
  if (idx === 2) return outputs.multiviewUrl ?? undefined;
  return undefined;
}

interface ActionHandlers {
  onUpload: () => void;
  onClearConcept: () => void;
  onRunTPose: () => void;
  onRunMultiView: () => void;
  onRunRoughModel: () => void;
  onCancelRoughModel: () => void;
  onDownloadRough: () => void;
  onRunMock: (idx: number) => void;
  onCancelMock: () => void;
  conceptReady: boolean;
  tposeReady: boolean;
  multiviewReady: boolean;
  roughReady: boolean;
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

  if (node.id === 'multiview') {
    return (
      <>
        <Button size="sm" disabled={!isComplete}>导出</Button>
        {isError ? (
          <Button variant="primary" size="sm" onClick={h.onRunMultiView}>重试</Button>
        ) : isRunning ? (
          <Button variant="danger" size="sm" disabled title="ComfyUI 任务无法从前端取消">
            生成中…
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!h.tposeReady}
            onClick={h.onRunMultiView}
          >
            {isComplete ? '重新生成' : '生成'}
          </Button>
        )}
      </>
    );
  }

  if (node.id === 'rough') {
    return (
      <>
        <Button size="sm" disabled={!h.roughReady} onClick={h.onDownloadRough}>
          下载 GLB
        </Button>
        {isError ? (
          <Button variant="primary" size="sm" onClick={h.onRunRoughModel}>重试</Button>
        ) : isRunning ? (
          <Button variant="danger" size="sm" onClick={h.onCancelRoughModel}>
            取消
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!h.multiviewReady}
            onClick={h.onRunRoughModel}
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
