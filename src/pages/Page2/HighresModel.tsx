import { useState, useCallback, useRef, useEffect } from 'react';
import type { NodeState, PartPipelineState, PipelineMode } from '../../types';
import { Button } from '../../components/Button';
import { GLBViewer } from '../../components/GLBViewer';
import { getPartNodes, PartPipeline } from './PartPipeline';
import { useProject } from '../../contexts/ProjectContext';
import type { PersistedPipeline } from '../../services/projectStore';
import {
  smartCropAndEnlargeAutoWithMeta,
  splitMultiViewWithMeta,
} from '../../services/multiviewSplit';

const PIPELINE_MODE_LABEL: Record<PipelineMode, string> = {
  extraction: 'General Extract',
  multiview: 'Jacket Extract',
};

const PIPELINE_MODE_DESC: Record<PipelineMode, string> = {
  extraction: '使用 Page1 的 Extraction 输出作为源图片，由 SAM3 交互式分割 → Smart Crop（保留 4-view 整图）',
  multiview: '使用 Page1 的 Multi-View 输出作为源图片，由 Banana Pro（提取外套）+ RMBG-2.0 → Smart Crop',
};;

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
    resultUrl: null,
  },
  modify: {
    resultUrl: null,
  },
  model3d: {
    glbUrl: null,
    mode: 'fourView',
  },
});

/** PartPipelineState → 可持久化的精简表示 */
function toPersisted(p: PartPipelineState): PersistedPipeline {
  return {
    id: p.id,
    name: p.name,
    mode: p.mode,
    imageFile: p.imageInput?.imageFile ?? null,
    resultFile: p.extraction?.resultFile ?? null,
    modifyFile: p.modify?.resultFile ?? null,
    modelFile: p.model3d?.glbFile ?? null,
    modelMode: p.model3d?.mode ?? 'fourView',
    smartCropMeta: p.extraction?.smartCropMeta,
    splitMeta: p.extraction?.splitMeta,
    maskedFile: p.extraction?.maskedFile ?? null,
    jointsMeta: p.jointsMeta,
  };
}

/** 从持久化数据重建 PartPipelineState */
function fromPersisted(pp: PersistedPipeline, index: number): PartPipelineState {
  const nodeStates = makeInitialNodeStates(pp.mode);
  nodeStates[0] = pp.imageFile ? 'complete' : 'ready';
  if (pp.resultFile) nodeStates[1] = 'complete';
  const nodes = getPartNodes(pp.mode);
  const modifyIdx = nodes.findIndex((n) => n.id === 'modify');
  if (pp.modifyFile && modifyIdx >= 0) nodeStates[modifyIdx] = 'complete';
  const modelIdx = nodes.findIndex((n) => n.id === 'highres');
  if (pp.modelFile && modelIdx >= 0) nodeStates[modelIdx] = 'complete';
  // Promote downstream nodes (across optional gaps) so e.g. 3D Model
  // becomes 'ready' instead of stuck at 'idle' when Modify is optional.
  const lastComplete = pp.modelFile && modelIdx >= 0
    ? modelIdx
    : pp.modifyFile && modifyIdx >= 0
      ? modifyIdx
      : pp.resultFile
        ? 1
        : pp.imageFile
          ? 0
          : -1;
  if (lastComplete >= 0) {
    for (let i = lastComplete + 1; i < nodeStates.length; i++) {
      if (nodeStates[i] !== 'idle' && nodeStates[i] !== 'optional') continue;
      nodeStates[i] = nodes[i]?.optional ? 'optional' : 'ready';
    }
  }
  return {
    id: pp.id ?? `part-${Date.now()}-${index}`,
    name: pp.name,
    mode: pp.mode,
    nodeStates,
    expanded: pp.modifyFile && modifyIdx >= 0 ? { [modifyIdx]: true } : {},
    imageInput: {
      imageUrl: null,
      imageFile: pp.imageFile ?? null,
    },
    extraction: {
      resultUrl: null,
      resultFile: pp.resultFile ?? null,
      smartCropMeta: pp.smartCropMeta,
      splitMeta: pp.splitMeta,
      maskedFile: pp.maskedFile ?? null,
    },
    modify: {
      resultUrl: null,
      resultFile: pp.modifyFile ?? null,
    },
    model3d: {
      glbUrl: null,
      glbFile: pp.modelFile ?? null,
      mode: pp.modelMode ?? 'fourView',
    },
    jointsMeta: pp.jointsMeta,
  };
}

export function HighresModel({ onStatusChange }: Props) {
  const { project, savePipelines, loadPipelines, loadByName } = useProject();
  const [parts, setParts] = useState<PartPipelineState[]>(() => [makePart(0, 'extraction'), makePart(1, 'extraction')]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const addDropdownRef = useRef<HTMLDivElement>(null);
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLabel, setViewerLabel] = useState<string | null>(null);

  // Resizable split: left panel width as percentage
  const [splitPos, setSplitPos] = useState(58);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Track whether we've restored pipelines for the current open project.
  const loadedForProject = useRef<string | null>(null);
  const initialised = useRef(false);

  // On project open/close: restore saved pipelines or reset to defaults.
  useEffect(() => {
    const key = project?.meta.createdAt ?? null;
    // Avoid re-running when project identity hasn't changed.
    if (loadedForProject.current === key && initialised.current) return;
    loadedForProject.current = key;
    initialised.current = true;

    if (!project) {
      setParts([makePart(0, 'extraction'), makePart(1, 'extraction')]);
      return;
    }

    let cancelled = false;
    (async () => {
      const idx = await loadPipelines();
      if (cancelled) return;
      if (idx && idx.pipelines.length > 0) {
        setParts(idx.pipelines.map((pp, i) => fromPersisted(pp, i)));
        onStatusChange(`已从工程恢复 ${idx.pipelines.length} 条 Pipeline`, 'info');
      }
      // If no pipelines saved yet, keep the defaults (already set by useState).
    })();

    return () => { cancelled = true; };
  }, [project]);

  // Auto-save pipelines whenever parts change (debounced 500ms).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!project) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void savePipelines(parts.map(toPersisted));
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [parts, project, savePipelines]);

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

  // Drag-to-resize splitter
  useEffect(() => {
    const container = splitContainerRef.current;
    if (!container) return;

    let dragging = false;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.dataset.splitter) return;
      dragging = true;
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPos(Math.max(20, Math.min(85, pct)));
    };

    const onMouseUp = () => {
      dragging = false;
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

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

  // ── Generate Joint Info (Stage 3 已移除) ────────────────────────────
  // 关节生产现在统一在 Page1 multiview 之后自动跑（见 Stage 1）。Page2 只是
  // 抽取/3D 代工，不再生产关节。整个 handler、状态、按钮、overlay 预览均已删除。

  // ── Smart Crop All ───────────────────────────────────────────────────
  // Re-runs SmartCrop + Split on each pipeline's saved maskedBlob
  // (pre-crop intermediate), updating smartCropMeta / splitMeta without
  // touching resultUrl.  This avoids re-running the slow Extraction step
  // (Banana / SAM3).
  const [smartCropAllRunning, setSmartCropAllRunning] = useState(false);
  const [smartCropAllStatus, setSmartCropAllStatus] = useState<string | null>(null);

  const handleSmartCropAll = useCallback(async () => {
    if (!project || parts.length === 0) return;

    setSmartCropAllRunning(true);
    setSmartCropAllStatus('Smart Crop All: 开始…');
    onStatusChange('Smart Crop All: 开始重算 SmartCrop + Split 元数据…', 'info');

    const statusLines: string[] = [];
    let okCount = 0;
    let skipCount = 0;

    const updatedParts = await Promise.all(
      parts.map(async (p) => {
        const maskedFile = p.extraction?.maskedFile;
        if (!maskedFile) {
          skipCount++;
          statusLines.push(
            `${p.name}: 跳过（缺 pre-crop 中间产物，请重跑一次 Extraction 即可复用）`,
          );
          return p;
        }

        try {
          const loaded = await loadByName('page2.extraction_masked', maskedFile);
          if (!loaded) {
            skipCount++;
            statusLines.push(
              `${p.name}: 跳过（无法读取 masked 中间产物 ${maskedFile}，请重跑 Extraction）`,
            );
            return p;
          }

          const blob = loaded.blob;
          const useSAM3 = p.mode === 'extraction';
          const scOpts = useSAM3
            ? {
                padding: 30,
                whiteThreshold: 240,
                useAlpha: false,
                minArea: 64,
                maxObjects: 4,
                layout: 'auto' as const,
                uniformScale: true,
                preservePosition: true,
                background: '#ffffff',
              }
            : {
                padding: 30,
                whiteThreshold: 240,
                useAlpha: false,
                minArea: 10,
                maxObjects: 16,
                layout: 'auto' as const,
                uniformScale: true,
                preservePosition: true,
                background: '#ffffff',
              };

          const scResult = await smartCropAndEnlargeAutoWithMeta(blob, scOpts);
          const splitResult = await splitMultiViewWithMeta(scResult.blob);

          okCount++;
          statusLines.push(
            `${p.name}: SmartCrop OK (${scResult.meta.objects.length} objects) · Split OK (${splitResult.slices.length} views)`,
          );

          return {
            ...p,
            extraction: {
              ...p.extraction!,
              smartCropMeta: scResult.meta,
              splitMeta: splitResult.meta,
            },
          };
        } catch (err) {
          skipCount++;
          statusLines.push(
            `${p.name}: 失败（${err instanceof Error ? err.message : String(err)}）`,
          );
          return p;
        }
      }),
    );

    setParts(updatedParts);

    const summary =
      `Smart Crop All: ${okCount} 成功` +
      (skipCount > 0 ? `, ${skipCount} 跳过/失败` : '');
    const fullStatus = summary + '\n' + statusLines.join('\n');
    setSmartCropAllStatus(fullStatus);
    onStatusChange(fullStatus, okCount > 0 ? 'success' : 'warning');
    setSmartCropAllRunning(false);
  }, [project, parts, loadByName, onStatusChange]);

  // ── Render ───────────────────────────────────────────────────────────

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
        <Button
          variant="secondary"
          size="sm"
          disabled={smartCropAllRunning || !project}
          onClick={handleSmartCropAll}
          title={smartCropAllStatus ?? '对所有 Pipeline 重算 SmartCrop + Split 元数据（跳过慢速的 Banana/SAM3 提取）'}
        >
          {smartCropAllRunning ? '⏳ Smart Crop…' : '🪄 Smart Crop All'}
        </Button>
        {smartCropAllStatus && !smartCropAllRunning && (
          <span
            title={smartCropAllStatus}
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              maxWidth: 320,
              whiteSpace: 'pre-line',
              lineHeight: 1.35,
            }}
          >
            {smartCropAllStatus}
          </span>
        )}
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

      {/* Main split: pipelines on the left, 3D preview on the right */}
      <div
        ref={splitContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          background: 'var(--bg-app)',
        }}
      >
        <div
          style={{
            width: `${splitPos}%`,
            minWidth: 280,
            maxWidth: '85%',
            overflow: 'auto',
            padding: '12px 12px 12px 16px',
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
              onPreviewModel={(url, label) => {
                setViewerUrl(url);
                setViewerLabel(label);
              }}
              onStatus={onStatusChange}
            />
          ))}
        </div>

        {/* Draggable splitter */}
        <div
          data-splitter="true"
          style={{
            width: 6,
            marginLeft: -3,
            marginRight: -3,
            zIndex: 10,
            cursor: 'col-resize',
            background: 'transparent',
            flexShrink: 0,
            position: 'relative',
          }}
          title="拖拽调整面板宽度"
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: '50%',
              width: 2,
              transform: 'translateX(-50%)',
              background: 'var(--border-default)',
              transition: 'background 0.15s',
            }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
          <GLBViewer url={viewerUrl} label={viewerLabel ?? 'Page2 · 3D Preview'} />
        </div>
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