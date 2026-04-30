import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { ExtractionMode, NodeConfig, NodeState, PartPipelineState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { ImagePreviewModal } from '../../components/ImagePreviewModal';
import { useProject } from '../../contexts/ProjectContext';
import {
  EXTRACTION_PROMPT_PRESETS,
  extractWithPrompt,
  extractWithSAM3,
  SAM3CancelledError,
  SAM3NotWiredError,
} from '../../services/extraction';
import { NODE_DIRS, type AssetVersion } from '../../services/projectStore';
import { splitMultiView } from '../../services/multiviewSplit';

export const PART_NODES: NodeConfig[] = [
  { id: 'extraction', title: 'Extraction', display: 'image' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview' },
  { id: 'modify', title: 'Modify', display: 'image', optional: true },
  { id: 'highres', title: 'Highres Model 3D', display: '3d' },
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
  const { project, loadLatest, saveAsset, listHistory, loadByName, saveSegments } = useProject();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const [splitView, setSplitView] = useState(false);

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

  // Load source image whenever the active project changes.
  // Prefer page1.extraction (Page1 的"提取"节点输出) — it's already a 4-view
  // sheet of the isolated subject. Fall back to page1.multiview if no
  // extraction has been generated yet.
  useEffect(() => {
    let cancelled = false;
    if (!project) {
      setSourceFile(null);
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      setSourceUrl(null);
      return;
    }
    (async () => {
      let r = await loadLatest('page1.extraction');
      if (!r) r = await loadLatest('page1.multiview');
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
      console.warn('[PartPipeline] load source image failed:', err);
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
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 0 ? 'complete' : v)),
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

  // "复制图片所在路径"：浏览器无法直接打开资源管理器，只能把绝对路径放剪贴板。
  // 路径精确到文件夹一级（不含文件名），便于直接粘贴到资源管理器地址栏。
  const handleCopyExtractionPath = useCallback(async () => {
    if (!project) {
      onStatus(`[${pipeline.name}] 未打开工程`, 'warning');
      return;
    }
    if (!project.meta.absolutePath) {
      onStatus(
        `[${pipeline.name}] 未配置工程绝对路径，请先点击右上角"📋 路径"按钮设置`,
        'warning',
      );
      return;
    }
    const dirs = NODE_DIRS['page2.extraction'];
    const sep = /[\\]/.test(project.meta.absolutePath) ? '\\' : '/';
    const fullDir = [project.meta.absolutePath, dirs.pageDir, dirs.nodeDir].join(sep);
    try {
      await navigator.clipboard.writeText(fullDir);
      onStatus(`[${pipeline.name}] 已复制目录路径：${fullDir}`, 'success');
    } catch {
      onStatus(`[${pipeline.name}] 复制失败 — 路径：${fullDir}`, 'warning');
    }
  }, [pipeline.name, project, onStatus]);

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

  // Real Extraction runner. Dispatches by mode then writes the final 4-view
  // PNG (+ split per-view sub-set) to the project, exactly like Page1's
  // Multi-View node.
  const runExtraction = useCallback(async (): Promise<string | null> => {
    if (!sourceFile) {
      onStatus(`[${pipeline.name}] 缺少源图片：请先在 Page1 生成 Extraction 或 Multi-View`, 'error');
      return null;
    }

    const preset = EXTRACTION_PROMPT_PRESETS[extraction.promptIndex] ?? EXTRACTION_PROMPT_PRESETS[0];
    const noteForMode =
      extraction.mode === 'banana'
        ? `${pipeline.name} · Banana · ${preset.label}`
        : `${pipeline.name} · SAM3`;

    // Set running
    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 0 ? 'running' : v)),
      extraction: { ...extraction, error: undefined },
    });
    onStatus(
      `[${pipeline.name}] ${extraction.mode === 'banana' ? 'Banana Pro' : 'SAM3'} 提取中…`,
      'info',
    );

    try {
      const url =
        extraction.mode === 'banana'
          ? await extractWithPrompt({
              source: sourceFile,
              prompt: preset.prompt,
              onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
            })
          : await extractWithSAM3({
              source: sourceFile,
              onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
            });

      // Revoke previous result URL if any
      if (extraction.resultUrl) URL.revokeObjectURL(extraction.resultUrl);

      // Save to project (full 4-view PNG)
      let savedFile: string | null = null;
      if (project) {
        try {
          const blob = await (await fetch(url)).blob();
          const v = await saveAsset('page2.extraction', blob, 'png', noteForMode, pipeline.name);
          if (v) {
            savedFile = v.file;
            onStatus(`[${pipeline.name}] 已保存到工程：${v.file}`, 'success');

            // Auto-split 2x2 grid into 4 individual views (front/left/back/right),
            // mirroring page1.multiview's behaviour. Stored under
            // <basename>_v0001/{view}_v0001.png plus segments.json.
            try {
              const slices = await splitMultiView(blob);
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
          if (idx === 0) return 'complete';
          if (idx === 1) {
            // Promote Multi-View to ready
            const cfg = PART_NODES[idx];
            if (cfg.optional) return v === 'idle' ? 'optional' : v;
            return v === 'idle' ? 'ready' : v;
          }
          return v;
        }),
        extraction: { ...extraction, resultUrl: url, resultFile: savedFile, error: undefined },
      });
      onStatus(`[${pipeline.name}] Extraction 完成`, 'success');
      // Reload the per-pipeline history dropdown.
      void refreshExtractionHistory();
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // SAM3CancelledError → soft revert to "ready" with a warning toast.
      if (err instanceof SAM3CancelledError) {
        console.warn('[PartPipeline] SAM3 cancelled:', err);
        onUpdate(pipeline.id, {
          ...pipeline,
          nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 0 ? 'ready' : v)),
          extraction: { ...extraction, error: undefined },
        });
        onStatus(`[${pipeline.name}] 已取消 SAM3 标注`, 'warning');
        return null;
      }
      const friendlyMsg =
        err instanceof SAM3NotWiredError
          ? `SAM3 子进程桥接异常（${msg}）`
          : msg;
      console.error('[PartPipeline] extraction failed:', err);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: pipeline.nodeStates.map((v, idx) => (idx === 0 ? 'error' : v)),
        extraction: { ...extraction, error: friendlyMsg },
      });
      onStatus(`[${pipeline.name}] Extraction 失败：${friendlyMsg}`, 'error');
      return null;
    }
  }, [pipeline, extraction, sourceFile, onStatus, onUpdate, project, saveAsset, saveSegments, refreshExtractionHistory]);

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
                {node.id === 'extraction' ? (
                  <ExtractionBody
                    state={state}
                    mode={extraction.mode}
                    promptIndex={extraction.promptIndex}
                    resultUrl={extraction.resultUrl}
                    resultFile={extraction.resultFile ?? null}
                    sourceUrl={sourceUrl}
                    error={extraction.error}
                    onModeChange={(m) => updateExtraction({ mode: m })}
                    onPromptChange={(idx) => updateExtraction({ promptIndex: idx })}
                    onCopyPath={handleCopyExtractionPath}
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
              node.id === 'extraction'
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
                {i < PART_NODES.length - 1 && (
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
// Extraction node body
// ---------------------------------------------------------------------------

interface ExtractionBodyProps {
  state: NodeState;
  mode: ExtractionMode;
  promptIndex: number;
  resultUrl: string | null;
  resultFile: string | null;
  sourceUrl: string | null;
  error?: string;
  onModeChange: (mode: ExtractionMode) => void;
  onPromptChange: (idx: number) => void;
  onCopyPath: () => void;
  label: string;
}

function ExtractionBody({
  state,
  mode,
  promptIndex,
  resultUrl,
  resultFile,
  sourceUrl,
  error,
  onModeChange,
  onPromptChange,
  onCopyPath,
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

      {/* 提取模式选择器（从节点头部下拉移到正文，给历史下拉腾位置） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <label style={{ fontSize: 10, color: 'var(--text-muted)' }}>提取模式</label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as ExtractionMode)}
          disabled={state === 'running'}
          title="切换提取模式"
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
          <option value="banana">{EXTRACTION_MODE_LABEL.banana}</option>
          <option value="sam3">{EXTRACTION_MODE_LABEL.sam3}</option>
        </select>
      </div>

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
              未检测到源图片：请先在 Page1 生成 Extraction 或 Multi-View
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 10,
            color: 'var(--text-muted)',
            padding: '6px 8px',
            border: '1px dashed var(--border-default)',
            borderRadius: 2,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
            SAM3 切割模式
          </div>
          <div>
            点击下方“生成”按钮，会弹出 SAM3 标注窗口并自动加载源图（优先 Page1 Extraction，其次 Multi-View）。
            在窗口中完成点选/框选后点“导出 JSON”，窗口会自动关闭并把结果回传到这里。
          </div>
          {!sourceUrl && (
            <div style={{ color: 'var(--accent-yellow, #d49b3b)', marginTop: 2 }}>
              未检测到源图片：请先在 Page1 生成 Extraction 或 Multi-View
            </div>
          )}
        </div>
      )}

      {/* 复制路径（浏览器无法直接 reveal in folder） */}
      {resultFile && (
        <button
          onClick={(e) => { e.stopPropagation(); onCopyPath(); }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={`复制图片所在文件夹的绝对路径到剪贴板\n文件名：${resultFile}`}
          style={{
            background: 'var(--bg-app)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-default)',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 2,
            cursor: 'pointer',
            textAlign: 'left',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          📋 复制所在文件夹路径
        </button>
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
