import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { ExtractionMode, NodeConfig, NodeState, PartPipelineState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { useProject } from '../../contexts/ProjectContext';
import { EXTRACTION_PROMPT_PRESETS, extractWithPrompt } from '../../services/extraction';

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

const EXTRACTION_MODE_LABEL: Record<ExtractionMode, string> = {
  banana: 'Banana Pro 提示词',
  sam3: 'SAM3 切割',
};

interface Props {
  pipeline: PartPipelineState;
  index: number;
  onUpdate: (id: string, next: PartPipelineState) => void;
  onDelete: (id: string) => void;
  onStatus: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function PartPipeline({ pipeline, index, onUpdate, onDelete, onStatus }: Props) {
  const { project, loadLatest, saveAsset } = useProject();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const [splitView, setSplitView] = useState(false);

  // Source image for Extraction (loaded from page1.multiview on the active project).
  // Falls back to "no source available" if the project hasn't been opened or
  // the Multi-View node is empty.
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const sourceUrlRef = useRef<string | null>(null);

  // Sync sourceUrlRef so the cleanup effect can revoke even after re-renders.
  useEffect(() => { sourceUrlRef.current = sourceUrl; }, [sourceUrl]);
  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
  }, []);

  // Load Multi-View image whenever the active project changes.
  useEffect(() => {
    let cancelled = false;
    if (!project) {
      setSourceFile(null);
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      setSourceUrl(null);
      return;
    }
    (async () => {
      const r = await loadLatest('page1.multiview');
      if (cancelled) {
        if (r?.url) URL.revokeObjectURL(r.url);
        return;
      }
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (r) {
        setSourceFile(new File([r.blob], r.version.file, { type: r.blob.type || 'image/png' }));
        setSourceUrl(r.url);
      } else {
        setSourceFile(null);
        setSourceUrl(null);
      }
    })().catch((err) => {
      if (cancelled) return;
      console.warn('[PartPipeline] load page1.multiview failed:', err);
    });
    return () => { cancelled = true; };
  }, [project, loadLatest]);

  // Helpers to update extraction sub-state immutably.
  const extraction = pipeline.extraction ?? { mode: 'banana', promptIndex: 0, resultUrl: null };
  const updateExtraction = useCallback(
    (patch: Partial<NonNullable<PartPipelineState['extraction']>>) => {
      const next: PartPipelineState = {
        ...pipeline,
        extraction: { ...extraction, ...patch },
      };
      onUpdate(pipeline.id, next);
    },
    [pipeline, extraction, onUpdate]
  );

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

  // Real Extraction runner (Banana Pro). Returns the blob: URL on success.
  const runExtraction = useCallback(async (): Promise<string | null> => {
    if (extraction.mode === 'sam3') {
      onStatus(`[${pipeline.name}] SAM3 模式尚未实现`, 'warning');
      return null;
    }
    if (!sourceFile) {
      onStatus(`[${pipeline.name}] 缺少源图片：请先在 Page1 生成 Multi-View`, 'error');
      return null;
    }
    const preset = EXTRACTION_PROMPT_PRESETS[extraction.promptIndex] ?? EXTRACTION_PROMPT_PRESETS[0];
    // Set running
    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 0 ? 'running' : v)),
      extraction: { ...extraction, error: undefined },
    });
    onStatus(`[${pipeline.name}] Banana Pro 提取中…`, 'info');
    try {
      const url = await extractWithPrompt({
        source: sourceFile,
        prompt: preset.prompt,
        onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
      });
      // Revoke previous result URL if any
      if (extraction.resultUrl) URL.revokeObjectURL(extraction.resultUrl);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => {
          if (idx === 0) return 'complete';
          if (idx === 1) {
            // Promote Multi-View to ready
            const cfg = PART_NODES[idx];
            if (cfg.optional) return v === 'idle' ? 'optional' : v;
            return v === 'idle' ? 'ready' : v;
          }
          return v;
        }),
        extraction: { ...extraction, resultUrl: url, error: undefined },
      });
      onStatus(`[${pipeline.name}] Extraction 完成`, 'success');

      // 持久化到工程目录 page2_highres/01_extraction/
      // 文件名形如 <pipelineName>_<ts>.png（多 Pipeline 之间隔离）
      if (project) {
        try {
          const blob = await (await fetch(url)).blob();
          const v = await saveAsset(
            'page2.extraction',
            blob,
            'png',
            `${pipeline.name} · ${preset.label}`,
            pipeline.name,
          );
          if (v) {
            onStatus(`[${pipeline.name}] 已保存到工程：${v.file}`, 'success');
          }
        } catch (e) {
          onStatus(
            `[${pipeline.name}] 保存到工程失败：${e instanceof Error ? e.message : String(e)}`,
            'error',
          );
        }
      }
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartPipeline] extraction failed:', err);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 0 ? 'error' : v)),
        extraction: { ...extraction, error: msg },
      });
      onStatus(`[${pipeline.name}] Extraction 失败：${msg}`, 'error');
      return null;
    }
  }, [pipeline, extraction, sourceFile, onStatus, onUpdate, project, saveAsset]);

  const runNode = useCallback(
    (i: number) => {
      // Extraction node: real Banana Pro call
      if (i === 0) {
        void runExtraction();
        return;
      }
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
    [pipeline, onUpdate, onStatus, runExtraction]
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
                  value={extraction.mode}
                  onChange={(e) => updateExtraction({ mode: e.target.value as ExtractionMode })}
                  onClick={(e) => e.stopPropagation()}
                  title="切换提取模式"
                  style={{
                    background: 'var(--bg-app)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-default)',
                    fontSize: 10,
                    padding: '2px 4px',
                    borderRadius: 2,
                    maxWidth: 130,
                  }}
                >
                  <option value="banana">{EXTRACTION_MODE_LABEL.banana}</option>
                  <option value="sam3">{EXTRACTION_MODE_LABEL.sam3}</option>
                </select>
              ) : undefined;

            const displayType =
              node.id === 'highres' && splitView && state === 'complete'
                ? 'split3d'
                : node.display;

            const body: ReactNode = (
              <>
                {node.id === 'extraction' ? (
                  <ExtractionBody
                    state={state}
                    mode={extraction.mode}
                    promptIndex={extraction.promptIndex}
                    resultUrl={extraction.resultUrl}
                    sourceUrl={sourceUrl}
                    error={extraction.error}
                    onPromptChange={(idx) => updateExtraction({ promptIndex: idx })}
                    label={`${pipeline.name} · ${node.title}`}
                  />
                ) : (
                  <Placeholder type={displayType} state={state} label={`${pipeline.name} · ${node.title}`} />
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

// ---------------------------------------------------------------------------
// Extraction node body
// ---------------------------------------------------------------------------

interface ExtractionBodyProps {
  state: NodeState;
  mode: ExtractionMode;
  promptIndex: number;
  resultUrl: string | null;
  sourceUrl: string | null;
  error?: string;
  onPromptChange: (idx: number) => void;
  label: string;
}

function ExtractionBody({
  state,
  mode,
  promptIndex,
  resultUrl,
  sourceUrl,
  error,
  onPromptChange,
  label,
}: ExtractionBodyProps) {
  // Pick the image to preview: result if present, otherwise the source.
  const previewUrl = resultUrl ?? sourceUrl;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Placeholder
        type="image"
        // Force placeholder to render the image whenever we actually have one,
        // regardless of node `state` (idle/ready both should still preview).
        state={previewUrl && state !== 'running' && state !== 'error' ? 'complete' : state}
        label={label}
        imageUrl={previewUrl ?? undefined}
        height={140}
      />

      {mode === 'banana' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            提取提示词
          </label>
          <select
            value={promptIndex}
            onChange={(e) => onPromptChange(Number(e.target.value))}
            disabled={state === 'running'}
            title={EXTRACTION_PROMPT_PRESETS[promptIndex]?.prompt}
            style={{
              background: 'var(--bg-app)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
              fontSize: 11,
              padding: '3px 4px',
              borderRadius: 2,
              width: '100%',
            }}
          >
            {EXTRACTION_PROMPT_PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.label}</option>
            ))}
          </select>
          {!sourceUrl && (
            <div style={{ fontSize: 10, color: 'var(--accent-yellow, #d49b3b)' }}>
              未检测到源图片：请先在 Page1 生成 Multi-View
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            padding: '6px 8px',
            border: '1px dashed var(--border-default)',
            borderRadius: 2,
            textAlign: 'center',
          }}
        >
          SAM3 切割模式 — 待实现
        </div>
      )}

      {error && (
        <div style={{ fontSize: 10, color: 'var(--accent-red)' }} title={error}>
          ⚠ {error.length > 80 ? error.slice(0, 80) + '…' : error}
        </div>
      )}
    </div>
  );
}
