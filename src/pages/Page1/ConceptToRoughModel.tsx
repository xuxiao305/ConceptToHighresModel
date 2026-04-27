import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import type { NodeConfig, NodeState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { ImagePreviewModal } from '../../components/ImagePreviewModal';
import { runConceptToTPose, runTPoseMultiView } from '../../services/workflows';
import { runImageToModel, TripoServiceError } from '../../services/tripo';
import { useProject } from '../../contexts/ProjectContext';
import type { AssetVersion } from '../../services/projectStore';

const NODES: NodeConfig[] = [
  { id: 'concept', title: 'Concept', display: 'image', description: '上传概念设计稿' },
  { id: 'tpose', title: 'T Pose', display: 'image', description: '生成标准 T Pose 正视图' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview', description: '生成多角度视图' },
  { id: 'rough', title: 'Rough Model', display: '3d', description: 'Tripo AI 生成 3D 粗模 (GLB)' },
  { id: 'rigging', title: 'Rough Model Rigging', display: '3d', description: '骨骼绑定' },
];

/** 节点索引 → projectStore 中的 nodeKey（用于历史读写） */
const NODE_KEYS = [
  'page1.concept',
  'page1.tpose',
  'page1.multiview',
  'page1.rough',
  'page1.rigging',
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
  const { project, saveAsset, loadLatest, listHistory, loadByName } = useProject();
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

  // 每个节点的历史版本列表（[0] = 最新）
  const [histories, setHistories] = useState<Record<number, AssetVersion[]>>({});
  // 每个节点当前选中的历史版本文件名
  const [selectedFiles, setSelectedFiles] = useState<Record<number, string>>({});
  // 大图预览
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  // 链式运行中标记，避免并发
  const chainRunningRef = useRef(false);

  // 用 ref 镜像最新的 outputs/states，便于异步链式运行读取最新值
  const outputsRef = useRef(outputs);
  useEffect(() => { outputsRef.current = outputs; }, [outputs]);
  const statesRef = useRef(states);
  useEffect(() => { statesRef.current = states; }, [states]);

  const setNodeState = useCallback((idx: number, s: NodeState) => {
    setStates((prev) => {
      const next = [...prev];
      next[idx] = s;
      return next;
    });
  }, []);

  // ---- 历史版本读取 -------------------------------------------------------
  const refreshHistory = useCallback(async (idx: number) => {
    if (!project) {
      setHistories((prev) => ({ ...prev, [idx]: [] }));
      return;
    }
    try {
      const list = await listHistory(NODE_KEYS[idx]);
      setHistories((prev) => ({ ...prev, [idx]: list }));
    } catch (err) {
      console.warn('[history] load failed', NODE_KEYS[idx], err);
    }
  }, [project, listHistory]);

  const refreshAllHistories = useCallback(async () => {
    await Promise.all(NODES.map((_, i) => refreshHistory(i)));
  }, [refreshHistory]);

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

      // 同步拉取全部节点的历史列表
      await refreshAllHistories();
      // 当前选中的版本默认是最新一个
      const sel: Record<number, string> = {};
      if (concept) sel[0] = concept.version.file;
      if (tpose) sel[1] = tpose.version.file;
      if (multiview) sel[2] = multiview.version.file;
      if (rough) sel[3] = rough.version.file;
      setSelectedFiles(sel);
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
        (v) => {
          if (v) {
            onStatusChange(`已保存到工程：${v.file}`, 'success');
            setSelectedFiles((prev) => ({ ...prev, 0: v.file }));
            refreshHistory(0);
          }
        },
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
  const runTPose = useCallback(async (sourceFile?: File): Promise<string | null> => {
    const file = sourceFile ?? outputsRef.current.conceptFile;
    if (!file) {
      onStatusChange('请先在 Concept 节点上传图片', 'error');
      return null;
    }
    setNodeState(1, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 1: '' } }));
    try {
      const url = await runConceptToTPose(file, {
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
          if (v) {
            onStatusChange(`T Pose 已保存到工程：${v.file}`, 'success');
            setSelectedFiles((prev) => ({ ...prev, 1: v.file }));
            refreshHistory(1);
          }
        } catch (e) {
          onStatusChange(
            `T Pose 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error'
          );
        }
      }
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[T Pose] failed:', err);
      setNodeState(1, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 1: msg } }));
      onStatusChange(`T Pose 生成失败：${msg}`, 'error');
      return null;
    }
  }, [onStatusChange, setNodeState, project, saveAsset, refreshHistory]);

  // ---- Multi-View node (real ComfyUI workflow) ----------------------------
  const runMultiView = useCallback(async (sourceUrl?: string): Promise<string | null> => {
    const tposeUrl = sourceUrl ?? outputsRef.current.tposeUrl;
    if (!tposeUrl) {
      onStatusChange('请先生成 T Pose', 'error');
      return null;
    }
    setNodeState(2, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 2: '' } }));
    try {
      const url = await runTPoseMultiView(tposeUrl, {
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
          if (v) {
            onStatusChange(`Multi-View 已保存到工程：${v.file}`, 'success');
            setSelectedFiles((prev) => ({ ...prev, 2: v.file }));
            refreshHistory(2);
          }
        } catch (e) {
          onStatusChange(
            `Multi-View 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error'
          );
        }
      }
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Multi-View] failed:', err);
      setNodeState(2, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 2: msg } }));
      onStatusChange(`Multi-View 生成失败：${msg}`, 'error');
      return null;
    }
  }, [onStatusChange, setNodeState, project, saveAsset, refreshHistory]);

  // ---- Rough Model node (Tripo AI image → GLB) ---------------------------
  const runRoughModel = useCallback(async (sourceUrl?: string): Promise<string | null> => {
    const mvUrl = sourceUrl ?? outputsRef.current.multiviewUrl;
    if (!mvUrl) {
      onStatusChange('请先生成 Multi-View', 'error');
      return null;
    }
    setNodeState(3, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 3: '' } }));

    const ctrl = new AbortController();
    roughAbortRef.current = ctrl;

    try {
      // 使用 Multi-View 作为 Tripo 输入（匹配流水线的连接）。
      const inputBlob = await (await fetch(mvUrl)).blob();

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
            setSelectedFiles((prev) => ({ ...prev, 3: v.file }));
            refreshHistory(3);
          }
        } catch (e) {
          onStatusChange(
            `粗模保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error'
          );
        }
      }

      const url = URL.createObjectURL(blob);
      setOutputs((prev) => {
        if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
        return {
          ...prev,
          roughUrl: url,
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
      return url;
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
      return null;
    } finally {
      roughAbortRef.current = null;
    }
  }, [onStatusChange, setNodeState, project, saveAsset, refreshHistory]);

  const cancelRoughModel = useCallback(() => {
    roughAbortRef.current?.abort();
    roughAbortRef.current = null;
  }, []);

  // ---- Mock runner for nodes 3..4 (Rough Model / Rigging) -----------------
  const runMockNode = useCallback(
    (idx: number): Promise<boolean> => {
      setNodeState(idx, 'running');
      onStatusChange(`正在运行：${NODES[idx].title}（mock）`, 'info');
      return new Promise<boolean>((resolve) => {
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
          resolve(true);
        }, 2000);
      });
    },
    [onStatusChange, setNodeState]
  );

  // ---- 链式运行：自动跑完前面所有未完成的节点 ----------------------------
  const runUpToNode = useCallback(async (target: number) => {
    if (chainRunningRef.current) return;
    if (target <= 0) return;
    chainRunningRef.current = true;
    try {
      // Concept 节点不能自动运行（必须人工上传）
      if (!outputsRef.current.conceptFile) {
        onStatusChange('请先在 Concept 节点上传图片', 'error');
        return;
      }

      let tposeUrl: string | null = outputsRef.current.tposeUrl;
      let mvUrl: string | null = outputsRef.current.multiviewUrl;

      if (target >= 1 && statesRef.current[1] !== 'complete') {
        tposeUrl = await runTPose(outputsRef.current.conceptFile);
        if (!tposeUrl) return;
      }
      if (target >= 2 && statesRef.current[2] !== 'complete') {
        mvUrl = await runMultiView(tposeUrl ?? undefined);
        if (!mvUrl) return;
      }
      if (target >= 3 && statesRef.current[3] !== 'complete') {
        const ru = await runRoughModel(mvUrl ?? undefined);
        if (!ru) return;
      }
      if (target >= 4 && statesRef.current[4] !== 'complete') {
        const ok = await runMockNode(4);
        if (!ok) return;
      }
    } finally {
      chainRunningRef.current = false;
    }
  }, [onStatusChange, runTPose, runMultiView, runRoughModel, runMockNode]);

  // ---- 切换某节点的历史版本 ------------------------------------------------
  const handleSelectHistory = useCallback(async (idx: number, fileName: string) => {
    if (!project) return;
    if (!fileName) return;
    try {
      const r = await loadByName(NODE_KEYS[idx], fileName);
      if (!r) {
        onStatusChange('无法读取该历史版本', 'error');
        return;
      }
      setSelectedFiles((prev) => ({ ...prev, [idx]: fileName }));
      setOutputs((prev) => {
        const next = { ...prev };
        if (idx === 0) {
          if (prev.conceptUrl) URL.revokeObjectURL(prev.conceptUrl);
          next.conceptUrl = r.url;
          next.conceptFile = new File([r.blob], fileName, {
            type: r.blob.type || 'image/png',
          });
        } else if (idx === 1) {
          if (prev.tposeUrl) URL.revokeObjectURL(prev.tposeUrl);
          next.tposeUrl = r.url;
        } else if (idx === 2) {
          if (prev.multiviewUrl) URL.revokeObjectURL(prev.multiviewUrl);
          next.multiviewUrl = r.url;
        } else if (idx === 3) {
          if (prev.roughUrl) URL.revokeObjectURL(prev.roughUrl);
          next.roughUrl = r.url;
          next.roughFile = fileName;
        }
        next.errors = { ...prev.errors, [idx]: '' };
        return next;
      });
      setStates((prev) => {
        const next = [...prev];
        next[idx] = 'complete';
        // 切换上游版本后下游状态保留为 ready 而不强制刷新
        if (idx + 1 < next.length && next[idx + 1] === 'idle') {
          next[idx + 1] = 'ready';
        }
        return next;
      });
      onStatusChange(`已切换到历史版本：${fileName}`, 'success');
    } catch (err) {
      onStatusChange(
        `加载历史版本失败：${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
  }, [project, loadByName, onStatusChange]);

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
                <NodeCard
                  title={`${idx + 1}. ${node.title}`}
                  state={state}
                  actions={actions}
                  headerExtra={
                    project && (histories[idx]?.length ?? 0) > 0 ? (
                      <HistoryDropdown
                        history={histories[idx] ?? []}
                        selected={selectedFiles[idx]}
                        onSelect={(f) => handleSelectHistory(idx, f)}
                      />
                    ) : undefined
                  }
                  onBodyClick={
                    idx === 0 ? undefined : () => { void runUpToNode(idx); }
                  }
                  onBodyDoubleClick={
                    imageUrl
                      ? () => setPreview({ url: imageUrl, title: `${idx + 1}. ${node.title}` })
                      : undefined
                  }
                >
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

      {preview && (
        <ImagePreviewModal
          url={preview.url}
          title={preview.title}
          onClose={() => setPreview(null)}
        />
      )}
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
  onRunMock: (idx: number) => void | Promise<boolean>;
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

// ---------------------------------------------------------------------------
// 历史版本下拉
// ---------------------------------------------------------------------------

interface HistoryDropdownProps {
  history: AssetVersion[];
  selected?: string;
  onSelect: (fileName: string) => void;
}

function HistoryDropdown({ history, selected, onSelect }: HistoryDropdownProps) {
  return (
    <select
      value={selected ?? ''}
      onChange={(e) => onSelect(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      title="选择历史版本"
      style={{
        background: 'var(--bg-surface-3)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-default)',
        borderRadius: 3,
        fontSize: 10,
        padding: '1px 4px',
        maxWidth: 110,
      }}
    >
      {history.map((v) => (
        <option key={v.file} value={v.file}>
          {prettyVersionLabel(v)}
        </option>
      ))}
    </select>
  );
}

function prettyVersionLabel(v: AssetVersion): string {
  // 时间戳形如 20260427_171530_123.png；优先用 timestamp（ISO）转成短格式
  try {
    const d = new Date(v.timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return v.file;
  }
}
