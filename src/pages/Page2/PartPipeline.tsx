import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { NodeConfig, NodeState, PartPipelineState, PipelineMode } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { ImagePreviewModal } from '../../components/ImagePreviewModal';
import { useProject } from '../../contexts/ProjectContext';
import {
  EXTRACT_JACKET_PROMPT,
  extractWithPrompt,
} from '../../services/extraction';
import { type AssetVersion } from '../../services/projectStore';
import { splitMultiView, enlargeMultiViewToFill } from '../../services/multiviewSplit';

/**
 * Pipeline node list. The standalone `multiview` node was removed once the
 * Extract Jacket node started producing a 4-view sheet (+ split per-view
 * sub-set + 等比放大撑满) directly. Both pipeline modes now share the same
 * node list — the only difference is which Page1 asset is loaded as source.
 */
export const PART_NODES: NodeConfig[] = [
  { id: 'imageInput', title: 'Image Input', display: 'image' },
  { id: 'extraction', title: 'Extract Jacket', display: 'image' },
  { id: 'modify', title: 'Modify', display: 'image', optional: true },
  { id: 'highres', title: 'Highres Model 3D', display: '3d' },
  { id: 'retex', title: 'Re-Texturing', display: '3d', optional: true },
  { id: 'region', title: 'Region Define', display: '3d', optional: true },
];

/** Returns the node list for a given pipeline mode (currently mode-agnostic). */
export function getPartNodes(_mode: PipelineMode): NodeConfig[] {
  return PART_NODES;
}

const PIPELINE_MODE_LABEL: Record<PipelineMode, string> = {
  extraction: 'General Extraction',
  multiview: 'Extract Jacket',
};

interface Props {
  pipeline: PartPipelineState;
  index: number;
  onUpdate: (id: string, next: PartPipelineState) => void;
  onDelete: (id: string) => void;
  onStatus: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function PartPipeline({ pipeline, index, onUpdate, onDelete, onStatus }: Props) {
  const { project, loadLatest, saveAsset, listHistory, loadByName, saveSegments } = useProject();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const [splitView, setSplitView] = useState(false);

  // Pipeline node list (both modes share the same list; the standalone Multi-View
  // node was removed since Extract Jacket already produces the 4-view sheet).
  const partNodes = getPartNodes(pipeline.mode);

  // Extraction 节点历史版本（仅本 Pipeline 自己的，按 pipeline.name 前缀过滤）
  const [extractionHistory, setExtractionHistory] = useState<AssetVersion[]>([]);
  // 图片大图预览
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);

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

  // Load source image whenever the active project or pipeline mode changes.
  // Mode A (extraction): loads page1.extraction, falls back to page1.multiview
  // Mode B (multiview):  loads page1.multiview
  useEffect(() => {
    let cancelled = false;
    if (!project) {
      setSourceFile(null);
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      setSourceUrl(null);
      return;
    }
    (async () => {
      let r;
      if (pipeline.mode === 'multiview') {
        r = await loadLatest('page1.multiview');
      } else {
        r = await loadLatest('page1.extraction');
        if (!r) r = await loadLatest('page1.multiview');
      }
      if (cancelled) {
        if (r?.url) URL.revokeObjectURL(r.url);
        return;
      }
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (r) {
        setSourceFile(new File([r.blob], r.version.file, { type: r.blob.type || 'image/png' }));
        setSourceUrl(r.url);
        // Mark Image Input node (idx 0) as complete and Extraction (idx 1) as ready
        // only if they haven't been manually set to something more advanced.
        onUpdate(pipeline.id, {
          ...pipeline,
          nodeStates: pipeline.nodeStates.map((v, idx) => {
            if (idx === 0 && v !== 'complete') return 'complete';
            if (idx === 1 && v === 'idle') return 'ready';
            return v;
          }),
        });
      } else {
        setSourceFile(null);
        setSourceUrl(null);
      }
    })().catch((err) => {
      if (cancelled) return;
      console.warn('[PartPipeline] load source image failed:', err);
    });
    return () => { cancelled = true; };
  }, [project, loadLatest, pipeline.mode]);

  // Extraction sub-state — Page2 fixes mode='banana' and the "Extract Jacket"
  // prompt, so no UI mutator is needed; runner reads/writes resultUrl/file.
  const extraction = pipeline.extraction ?? { mode: 'banana', promptIndex: 0, resultUrl: null };

  // Helpers to update imageInput sub-state immutably.
  const imageInput = pipeline.imageInput ?? { imageUrl: null };
  // @ts-expect-error — will be used when Image Input source selection is implemented
  const updateImageInput = useCallback(
    (patch: Partial<NonNullable<PartPipelineState['imageInput']>>) => {
      const next: PartPipelineState = {
        ...pipeline,
        imageInput: { ...imageInput, ...patch },
      };
      onUpdate(pipeline.id, next);
    },
    [pipeline, imageInput, onUpdate]
  );

  // 加载本 Pipeline 的 Extraction 历史（按 pipeline.name 前缀过滤）。
  const safeName = pipeline.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const refreshExtractionHistory = useCallback(async () => {
    if (!project) {
      setExtractionHistory([]);
      return;
    }
    try {
      const all = await listHistory('page2.extraction');
      const mine = all.filter((v) => v.file.startsWith(`${safeName}_`));
      setExtractionHistory(mine);
    } catch (err) {
      console.warn('[PartPipeline] list extraction history failed:', err);
      setExtractionHistory([]);
    }
  }, [project, listHistory, safeName]);

  useEffect(() => { void refreshExtractionHistory(); }, [refreshExtractionHistory]);

  // Project loaded but the in-memory extraction state is empty → auto-load the
  // latest saved extraction as the current preview, so the node doesn't snap
  // back to "show the multi-view source" after a reload.
  useEffect(() => {
    if (!project) return;
    if (extraction.resultUrl || extraction.resultFile) return;
    if (extractionHistory.length === 0) return;
    const latest = extractionHistory[0];
    void handleSelectExtractionHistory(latest.file);
    // Only run when the history list materializes for the first time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, extractionHistory]);

  // 切换历史版本：从工程目录加载 blob，替换当前 resultUrl/resultFile。
  const handleSelectExtractionHistory = useCallback(async (fileName: string) => {
    if (!project || !fileName) return;
    try {
      const r = await loadByName('page2.extraction', fileName);
      if (!r) {
        onStatus(`[${pipeline.name}] 无法读取该历史版本`, 'error');
        return;
      }
      if (extraction.resultUrl) URL.revokeObjectURL(extraction.resultUrl);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 1 ? 'complete' : v)),
        extraction: { ...extraction, resultUrl: r.url, resultFile: fileName, error: undefined },
      });
      onStatus(`[${pipeline.name}] 已切换到 ${fileName}`, 'success');
    } catch (err) {
      onStatus(
        `[${pipeline.name}] 加载历史版本失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  }, [project, loadByName, pipeline, extraction, onUpdate, onStatus]);

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

  // Real Extraction runner. Calls Banana Pro with the fixed "Extract Jacket"
  // prompt and writes the final 4-view PNG (+ split per-view sub-set) to the
  // project, exactly like Page1's Multi-View node.
  const runExtraction = useCallback(async (): Promise<string | null> => {
    if (!sourceFile) {
      onStatus(`[${pipeline.name}] 缺少源图片：请先在 Page1 生成 Extraction 或 Multi-View`, 'error');
      return null;
    }

    const noteForMode = `${pipeline.name} · Extract Jacket`;

    // Set running
    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 1 ? 'running' : v)),
      extraction: { ...extraction, error: undefined },
    });
    onStatus(`[${pipeline.name}] Extract Jacket 提取中…`, 'info');

    try {
      const url = await extractWithPrompt({
        source: sourceFile,
        prompt: EXTRACT_JACKET_PROMPT,
        onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
      });

      // Revoke previous result URL if any
      if (extraction.resultUrl) URL.revokeObjectURL(extraction.resultUrl);

      // Post-process: 对 Banana Pro 输出的 4-view 做"分别等比放大撑满象限"，
      // 让每个 view 的主体尺度更接近，再交给后续紧凑切分。
      let processedBlob: Blob;
      let processedUrl: string;
      try {
        const rawBlob = await (await fetch(url)).blob();
        onStatus(`[${pipeline.name}] 等比放大每个视图…`, 'info');
        processedBlob = await enlargeMultiViewToFill(rawBlob);
        processedUrl = URL.createObjectURL(processedBlob);
        // 释放 Banana Pro 返回的原始 blob URL
        URL.revokeObjectURL(url);
      } catch (e) {
        onStatus(
          `[${pipeline.name}] 等比放大失败，回退使用原图：${e instanceof Error ? e.message : String(e)}`,
          'warning',
        );
        processedBlob = await (await fetch(url)).blob();
        processedUrl = url;
      }

      // Save to project (full 4-view PNG)
      let savedFile: string | null = null;
      if (project) {
        try {
          const v = await saveAsset('page2.extraction', processedBlob, 'png', noteForMode, pipeline.name);
          if (v) {
            savedFile = v.file;
            onStatus(`[${pipeline.name}] 已保存到工程：${v.file}`, 'success');

            // Auto-split 2x2 grid into 4 individual views (front/left/back/right),
            // mirroring page1.multiview's behaviour. Stored under
            // <basename>_v0001/{view}_v0001.png plus segments.json.
            try {
              const slices = await splitMultiView(processedBlob);
              const baseName = v.file.replace(/\.[^.]+$/, '');
              const setHandle = await saveSegments(
                'page2.extraction',
                baseName,
                v.file,
                slices.map((s) => ({
                  name: `${s.view}_{v}.png`,
                  blob: s.blob,
                  meta: { view: s.view, bbox: s.bbox, size: s.size },
                })),
              );
              if (setHandle) {
                onStatus(
                  `[${pipeline.name}] 已切分 4 视图 → ${setHandle.dirName}/`,
                  'success',
                );
              }
            } catch (e) {
              onStatus(
                `[${pipeline.name}] 4 视图切分失败：${e instanceof Error ? e.message : String(e)}`,
                'warning',
              );
            }
          }
        } catch (e) {
          onStatus(
            `[${pipeline.name}] 保存到工程失败：${e instanceof Error ? e.message : String(e)}`,
            'error',
          );
        }
      }

      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => {
          if (idx === 1) return 'complete';
          if (idx === 2) {
            // Promote next node to ready (Modify, optional)
            const cfg = partNodes[idx];
            if (cfg?.optional) return v === 'idle' ? 'optional' : v;
            return v === 'idle' ? 'ready' : v;
          }
          return v;
        }),
        extraction: { ...extraction, resultUrl: processedUrl, resultFile: savedFile, error: undefined },
      });
      onStatus(`[${pipeline.name}] Extract Jacket 完成`, 'success');
      // Reload the per-pipeline history dropdown.
      void refreshExtractionHistory();
      return processedUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartPipeline] extract jacket failed:', err);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 1 ? 'error' : v)),
        extraction: { ...extraction, error: msg },
      });
      onStatus(`[${pipeline.name}] Extract Jacket 失败：${msg}`, 'error');
      return null;
    }
  }, [pipeline, extraction, sourceFile, onStatus, onUpdate, project, saveAsset, saveSegments, refreshExtractionHistory]);

  const runNode = useCallback(
    (i: number) => {
      // Extraction node: real Banana Pro call
      if (i === 1) {
        void runExtraction();
        return;
      }
      const updated: PartPipelineState = {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === i ? 'running' : v)),
      };
      onUpdate(pipeline.id, updated);
      onStatus(`[${pipeline.name}] 运行 ${partNodes[i].title} …`, 'info');

      window.setTimeout(() => {
        // Re-read latest by referencing current pipeline (closure captures pre-state, fine for mock)
        const after: PartPipelineState = {
          ...pipeline,
          nodeStates: pipeline.nodeStates.map((v, idx) => {
            if (idx === i) return 'complete';
            // promote next non-optional node to ready
            if (idx === i + 1) {
              const cfg = partNodes[idx];
              if (cfg?.optional) return v === 'idle' ? 'optional' : v;
              return v === 'idle' ? 'ready' : v;
            }
            return v;
          }),
        };
        onUpdate(pipeline.id, after);
        onStatus(`[${pipeline.name}] ${partNodes[i].title} 完成`, 'success');
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
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 3,
            background: pipeline.mode === 'multiview' ? 'var(--accent-purple, #8b5cf6)' : 'var(--accent-blue)',
            color: '#fff',
            letterSpacing: 0.5,
          }}
        >
          {PIPELINE_MODE_LABEL[pipeline.mode]}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {pipeline.nodeStates.filter((s) => s === 'complete').length} / {partNodes.length} 完成
        </span>
        <Button variant="ghost" size="sm" onClick={() => onDelete(pipeline.id)}>
          🗑 删除
        </Button>
      </div>

      {/* Node row */}
      <div style={{ overflowX: 'auto', padding: '20px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {partNodes.map((node, i) => {
            const state = pipeline.nodeStates[i];
            const expanded = !!pipeline.expanded[i];

            const headerExtra =
              node.id === 'extraction' && project && extractionHistory.length > 0 ? (
                <HistoryDropdown
                  history={extractionHistory}
                  selected={extraction.resultFile ?? undefined}
                  onSelect={handleSelectExtractionHistory}
                />
              ) : undefined;

            const displayType =
              node.id === 'highres' && splitView && state === 'complete'
                ? 'split3d'
                : node.display;

            const body: ReactNode = (
              <>
                {node.id === 'imageInput' ? (
                  <ImageInputBody
                    state={state}
                    imageUrl={imageInput.imageUrl}
                    sourceUrl={sourceUrl}
                    mode={pipeline.mode}
                    label={`${pipeline.name} · ${node.title}`}
                  />
                ) : node.id === 'extraction' ? (
                  <ExtractionBody
                    state={state}
                    resultUrl={extraction.resultUrl}
                    resultFile={extraction.resultFile ?? null}
                    sourceUrl={sourceUrl}
                    error={extraction.error}
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

            // 双击节点正文：图像类节点弹大图预览。
            const previewImageUrl =
              node.id === 'imageInput'
                ? imageInput.imageUrl ?? sourceUrl
                : node.id === 'extraction'
                  ? extraction.resultUrl ?? sourceUrl
                  : undefined;
            const onBodyDoubleClick = previewImageUrl
              ? () => setPreview({ url: previewImageUrl, title: `${i + 1}. ${node.title} · ${pipeline.name}` })
              : undefined;

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
                  onBodyDoubleClick={onBodyDoubleClick}
                  actions={actions}
                >
                  {body}
                </NodeCard>
                {i < partNodes.length - 1 && (
                  <NodeConnector fromState={state} toState={pipeline.nodeStates[i + 1]} />
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

  // Image Input node: auto-loaded from Page1, no manual action needed.
  if (node.id === 'imageInput') {
    return null;
  }

  const isRunning = state === 'running';
  const isComplete = state === 'complete';
  const isError = state === 'error';

  const primaryLabel = isComplete ? '重新生成' : '生成';

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
// Image Input node body
// ---------------------------------------------------------------------------

interface ImageInputBodyProps {
  state: NodeState;
  imageUrl: string | null;
  sourceUrl: string | null;
  mode: PipelineMode;
  label: string;
}

function ImageInputBody({ state, imageUrl, sourceUrl, mode, label }: ImageInputBodyProps) {
  // Preview: user-set image > source image from Page1
  const previewUrl = imageUrl ?? sourceUrl;

  const sourceHint =
    mode === 'multiview'
      ? '来源：Page1 · Multi-View'
      : '来源：Page1 · Extraction（回退 Multi-View）';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Placeholder
        type="image"
        state={previewUrl && state !== 'running' && state !== 'error' ? 'complete' : state}
        label={label}
        imageUrl={previewUrl ?? undefined}
        height={140}
      />
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
        {previewUrl ? sourceHint : '未检测到源图片'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extraction node body — Page2 "Extract Jacket"（固定 Banana Pro + 固定提示词）
// ---------------------------------------------------------------------------

interface ExtractionBodyProps {
  state: NodeState;
  resultUrl: string | null;
  resultFile: string | null;
  sourceUrl: string | null;
  error?: string;
  label: string;
}

function ExtractionBody({
  state,
  resultUrl,
  resultFile: _resultFile,
  sourceUrl,
  error,
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

      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        固定提示词：提取外套，补全被遮挡部分
      </div>
      {!sourceUrl && (
        <div style={{ fontSize: 10, color: 'var(--accent-yellow, #d49b3b)' }}>
          未检测到源图片：请先在 Page1 生成 Extraction 或 Multi-View
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

// ---------------------------------------------------------------------------
// History dropdown (与 Page1 保持一致的样式)
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
        maxWidth: 130,
      }}
    >
      {!selected && <option value="" disabled>选择历史版本…</option>}
      {history.map((v) => (
        <option key={v.file} value={v.file}>
          {prettyVersionLabel(v)}
        </option>
      ))}
    </select>
  );
}

function prettyVersionLabel(v: AssetVersion): string {
  try {
    const d = new Date(v.timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return v.file;
  }
}
