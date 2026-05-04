import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { Model3DMode, NodeConfig, NodeState, PartPipelineState, PipelineMode } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { ImagePreviewModal } from '../../components/ImagePreviewModal';
import { GLBThumbnail } from '../../components/GLBThumbnail';
import { useProject } from '../../contexts/ProjectContext';
import {
  EXTRACT_JACKET_PROMPT,
  MODIFY_HIGHRES_RETRY_PROMPT,
  extractWithPrompt,
  extractWithSAM3,
  removeBackgroundRMBG,
  RMBGNotWiredError,
  SAM3CancelledError,
  SAM3NotWiredError,
} from '../../services/extraction';
import { type AssetVersion } from '../../services/projectStore';
import { splitMultiView, splitMultiViewWithMeta, smartCropAndEnlargeAutoWithMeta } from '../../services/multiviewSplit';
import type { SmartCropTransformMeta, SplitTransformMeta } from '../../types/joints';
import { runImageToModel, runMultiViewToModel, TripoServiceError, type MultiViewInputs } from '../../services/tripo';

/**
 * Full node list for Page2 part pipelines. Both Page2 modes keep the extracted
 * 4-view sheet inside the Extraction node, so there is no standalone
 * Multi-View node between Extraction and Modify/3D Model.
 *
 * The `extraction` node's display title is mode-dependent — see
 * {@link getPartNodes}. Mode 'multiview' uses the Banana Pro "Extract Jacket"
 * prompt and is labelled "Jacket Extraction". Mode 'extraction' uses SAM3
 * interactive segmentation and is labelled "General Extraction".
 */
export const PART_NODES: NodeConfig[] = [
  { id: 'imageInput', title: 'Image Input', display: 'image' },
  { id: 'extraction', title: 'Jacket Extraction', display: 'image' },
  { id: 'modify', title: 'Modify', display: 'image', optional: true },
  { id: 'highres', title: '3D Model', display: '3d' },
  { id: 'retex', title: 'Re-Texturing', display: '3d', optional: true },
  { id: 'region', title: 'Region Define', display: '3d', optional: true },
];

/** Returns the node list for a given pipeline mode. */
export function getPartNodes(mode: PipelineMode): NodeConfig[] {
  if (mode === 'extraction') {
    // General Extract pipeline: rename the extraction node to reflect the
    // actual runner.
    return PART_NODES
      .map((n) => (n.id === 'extraction' ? { ...n, title: 'General Extraction' } : n));
  }
  return PART_NODES;
}

function initialNodeStatesFor(partNodes: NodeConfig[]): NodeState[] {
  return partNodes.map((n) => (n.optional ? 'optional' : 'idle'));
}

/**
 * Migrates old in-memory Jacket Extract rows that still contain the removed
 * `multiview` node state at index 2.
 */
function normalizeNodeStatesForMode(mode: PipelineMode, states: NodeState[]): NodeState[] {
  const partNodes = getPartNodes(mode);
  if (states.length === partNodes.length) return states;

  let next = states;
  if (mode === 'multiview' && states.length === partNodes.length + 1) {
    next = states.filter((_, idx) => idx !== 2);
  }

  if (next.length === partNodes.length) return next;
  const defaults = initialNodeStatesFor(partNodes);
  return partNodes.map((_, idx) => next[idx] ?? defaults[idx]);
}

/**
 * Promote all downstream nodes after `completedIdx` from 'idle' to either
 * 'ready' (non-optional) or 'optional' (optional). Optional nodes don't gate
 * the chain — they're just labels — so a non-optional node further down
 * should still be promoted to 'ready' even if intervening optional nodes were
 * skipped.
 */
function promoteDownstream(
  nodeStates: NodeState[],
  completedIdx: number,
  partNodes: NodeConfig[],
): NodeState[] {
  return nodeStates.map((v, idx) => {
    if (idx <= completedIdx) return v;
    if (v !== 'idle' && v !== 'optional') return v;
    const cfg = partNodes[idx];
    return cfg?.optional ? 'optional' : 'ready';
  });
}

const PIPELINE_MODE_LABEL: Record<PipelineMode, string> = {
  extraction: 'General Extract',
  multiview: 'Jacket Extract',
};

const MODEL_3D_MODE_LABEL: Record<Model3DMode, string> = {
  single: '单独生成',
  frontBack: '前后图生成',
  fourView: '四视图生成',
};

const MODEL_3D_MODE_DESC: Record<Model3DMode, string> = {
  single: 'Tripo 单图 image_to_model：只使用 front 视图。',
  frontBack: 'Tripo multiview_to_model：只提交 front + back。',
  fourView: 'Tripo multiview_to_model：front / left / back / right，顺序与现有 3D Model 接口一致。',
};

interface Props {
  pipeline: PartPipelineState;
  index: number;
  onUpdate: (id: string, next: PartPipelineState) => void;
  onDelete: (id: string) => void;
  onPreviewModel?: (url: string, label: string) => void;
  onStatus: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function PartPipeline({ pipeline, index, onUpdate, onDelete, onPreviewModel, onStatus }: Props) {
  const { project, loadLatest, saveAsset, listHistory, loadByName, saveSegments } = useProject();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const modelAbortRef = useRef<AbortController | null>(null);

  // Mode-specific node list. Extraction keeps the 4-view sheet in the
  // Extraction node; downstream 3D generation splits it on demand.
  const partNodes = getPartNodes(pipeline.mode);
  const nodeStates = normalizeNodeStatesForMode(pipeline.mode, pipeline.nodeStates);

  // Extraction 节点历史版本（仅本 Pipeline 自己的，按 pipeline.name 前缀过滤）
  const [extractionHistory, setExtractionHistory] = useState<AssetVersion[]>([]);
  // Modify 节点历史版本（仅本 Pipeline 自己的，按 pipeline.name 前缀过滤）
  const [modifyHistory, setModifyHistory] = useState<AssetVersion[]>([]);
  // 3D Model 节点历史版本（仅本 Pipeline 自己的，按 pipeline.name 前缀过滤）
  const [modelHistory, setModelHistory] = useState<AssetVersion[]>([]);
  // 图片大图预览
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);

  // Source image for Extraction (loaded from page1.multiview or page1.extraction
  // on the active project). Falls back to "no source available" if the project
  // hasn't been opened or the required Page1 output is empty.
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
          nodeStates: nodeStates.map((v, idx) => {
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
  const extraction = pipeline.extraction ?? { resultUrl: null };
  const modify = pipeline.modify ?? { resultUrl: null };
  const model3d = pipeline.model3d ?? { glbUrl: null, mode: 'fourView' as Model3DMode };

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

  const refreshModelHistory = useCallback(async () => {
    if (!project) {
      setModelHistory([]);
      return;
    }
    try {
      const all = await listHistory('page2.highres');
      const mine = all.filter((v) => v.file.startsWith(`${safeName}_`));
      setModelHistory(mine);
    } catch (err) {
      console.warn('[PartPipeline] list 3D model history failed:', err);
      setModelHistory([]);
    }
  }, [project, listHistory, safeName]);

  const refreshModifyHistory = useCallback(async () => {
    if (!project) {
      setModifyHistory([]);
      return;
    }
    try {
      const all = await listHistory('page2.modify');
      const mine = all.filter((v) => v.file.startsWith(`${safeName}_`));
      setModifyHistory(mine);
    } catch (err) {
      console.warn('[PartPipeline] list modify history failed:', err);
      setModifyHistory([]);
    }
  }, [project, listHistory, safeName]);

  useEffect(() => { void refreshExtractionHistory(); }, [refreshExtractionHistory]);
  useEffect(() => { void refreshModifyHistory(); }, [refreshModifyHistory]);
  useEffect(() => { void refreshModelHistory(); }, [refreshModelHistory]);

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
        nodeStates: promoteDownstream(
          nodeStates.map((v, idx) => (idx === 1 ? 'complete' : v)),
          1,
          partNodes,
        ),
        extraction: { ...extraction, resultUrl: r.url, resultFile: fileName, error: undefined },
      });
      onStatus(`[${pipeline.name}] 已切换到 ${fileName}`, 'success');
    } catch (err) {
      onStatus(
        `[${pipeline.name}] 加载历史版本失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  }, [project, loadByName, pipeline, extraction, partNodes, onUpdate, onStatus]);

  // Project restore path: `pipelines.json` may contain resultFile, but React
  // state cannot persist the blob: URL. Reload that exact file so preview and
  // downstream 3D Model input are in sync with the selected history item.
  useEffect(() => {
    if (!project) return;
    if (!extraction.resultFile || extraction.resultUrl) return;
    void handleSelectExtractionHistory(extraction.resultFile);
  }, [project, extraction.resultFile, extraction.resultUrl, handleSelectExtractionHistory]);

  // First-time / legacy project path: no persisted resultFile yet, but history
  // exists. Auto-load the newest per-pipeline extraction as the current output.
  useEffect(() => {
    if (!project) return;
    if (extraction.resultUrl || extraction.resultFile) return;
    if (extractionHistory.length === 0) return;
    void handleSelectExtractionHistory(extractionHistory[0].file);
  }, [project, extraction.resultUrl, extraction.resultFile, extractionHistory, handleSelectExtractionHistory]);

  const handleSelectModifyHistory = useCallback(async (fileName: string) => {
    if (!project || !fileName) return;
    try {
      const r = await loadByName('page2.modify', fileName);
      if (!r) {
        onStatus(`[${pipeline.name}] 无法读取该 Modify 历史版本`, 'error');
        return;
      }
      if (modify.resultUrl) URL.revokeObjectURL(modify.resultUrl);
      const modifyIdx = partNodes.findIndex((n) => n.id === 'modify');
      onUpdate(pipeline.id, {
        ...pipeline,
        expanded: modifyIdx >= 0 ? { ...pipeline.expanded, [modifyIdx]: true } : pipeline.expanded,
        nodeStates: modifyIdx >= 0
          ? promoteDownstream(
              nodeStates.map((v, idx) => (idx === modifyIdx ? 'complete' : v)),
              modifyIdx,
              partNodes,
            )
          : nodeStates,
        modify: { ...modify, resultUrl: r.url, resultFile: fileName, error: undefined },
      });
      onStatus(`[${pipeline.name}] 已切换到 Modify：${fileName}`, 'success');
    } catch (err) {
      onStatus(
        `[${pipeline.name}] 加载 Modify 历史失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  }, [project, loadByName, pipeline, modify, partNodes, onUpdate, onStatus]);

  useEffect(() => {
    if (!project) return;
    if (!modify.resultFile || modify.resultUrl) return;
    void handleSelectModifyHistory(modify.resultFile);
  }, [project, modify.resultFile, modify.resultUrl, handleSelectModifyHistory]);

  const handleSelectModelHistory = useCallback(async (fileName: string) => {
    if (!project || !fileName) return;
    try {
      const r = await loadByName('page2.highres', fileName);
      if (!r) {
        onStatus(`[${pipeline.name}] 无法读取该 3D Model 历史版本`, 'error');
        return;
      }
      if (model3d.glbUrl) URL.revokeObjectURL(model3d.glbUrl);
      const modelIdx = partNodes.findIndex((n) => n.id === 'highres');
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: modelIdx >= 0
          ? promoteDownstream(
              nodeStates.map((v, idx) => (idx === modelIdx ? 'complete' : v)),
              modelIdx,
              partNodes,
            )
          : nodeStates,
        model3d: { ...model3d, glbUrl: r.url, glbFile: fileName, error: undefined },
      });
      onStatus(`[${pipeline.name}] 已切换到 3D Model：${fileName}`, 'success');
    } catch (err) {
      onStatus(
        `[${pipeline.name}] 加载 3D Model 历史失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  }, [project, loadByName, pipeline, model3d, partNodes, onUpdate, onStatus]);

  useEffect(() => {
    if (!project) return;
    if (!model3d.glbFile || model3d.glbUrl) return;
    void handleSelectModelHistory(model3d.glbFile);
  }, [project, model3d.glbFile, model3d.glbUrl, handleSelectModelHistory]);

  const setStateAt = useCallback(
    (i: number, s: NodeState) => {
      const next: PartPipelineState = {
        ...pipeline,
        nodeStates: nodeStates.map((v, idx) => (idx === i ? s : v)),
      };
      onUpdate(pipeline.id, next);
    },
    [pipeline, onUpdate]
  );

  // Real Extraction runner. Two pipelines, exactly mirroring the ComfyUI
  // workflows in Document/Design/Pipelines_Page2:
  //
  //   pipeline.mode === 'multiview' (Pipeline 1 "Jacket Extract"):
  //     Banana Pro (EXTRACT_JACKET_PROMPT) → RMBG-2.0 (white bg)
  //                                       → SmartCropAndEnlargeAuto
  //     Mirrors ComfyuiWorkflow/BananaExtractJacket.json.
  //
  //   pipeline.mode === 'extraction' (Pipeline 2 "General Extract"):
  //     SAM3 GUI segmentation → mask × source (white bg, full size)
  //                            → SmartCropAndEnlargeAuto
  //     Mirrors ComfyuiWorkflow/SAM3_ExtractParts.json.
  //
  // Both paths converge on the same persistence + 4-view split tail.
  const runExtraction = useCallback(async (): Promise<string | null> => {
    if (!sourceFile) {
      onStatus(`[${pipeline.name}] 缺少源图片：请先在 Page1 生成 Extraction 或 Multi-View`, 'error');
      return null;
    }

    const useSAM3 = pipeline.mode === 'extraction';
    const modeLabel = useSAM3 ? 'General Extract' : 'Jacket Extract';
    const noteForMode = `${pipeline.name} · ${modeLabel}`;

    // Set running
    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: nodeStates.map((v, idx) => (idx === 1 ? 'running' : v)),
      extraction: { ...extraction, error: undefined },
    });
    onStatus(`[${pipeline.name}] ${modeLabel} 提取中…`, 'info');

    try {
      // ── Step ① + ②: extract → mask-on-white (full 4-view size) ─────────
      let maskedBlob: Blob;
      if (useSAM3) {
        const r = await extractWithSAM3({
          source: sourceFile,
          onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
        });
        maskedBlob = r.blob;
      } else {
        const url = await extractWithPrompt({
          source: sourceFile,
          prompt: EXTRACT_JACKET_PROMPT,
          onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
        });
        const bananaBlob = await (await fetch(url)).blob();
        URL.revokeObjectURL(url);
        // RMBG-2.0 to white background — matches BananaExtractJacket.json node 10.
        const rmbgUrl = await removeBackgroundRMBG({
          source: bananaBlob,
          backgroundColor: '#ffffff',
          processRes: 1024,
          sensitivity: 1.0,
          onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
        });
        maskedBlob = await (await fetch(rmbgUrl)).blob();
        URL.revokeObjectURL(rmbgUrl);
      }

      // Revoke previous result URL if any
      if (extraction.resultUrl) URL.revokeObjectURL(extraction.resultUrl);

      // ── Save maskedBlob pre-crop for Smart Crop All ──
      let maskedFile: string | null = null;
      if (project) {
        try {
          const maskedVer = await saveAsset(
            'page2.extraction_masked',
            maskedBlob,
            'png',
            `${noteForMode} · pre-crop`,
            pipeline.name,
          );
          if (maskedVer) maskedFile = maskedVer.file;
        } catch (e) {
          onStatus(
            `[${pipeline.name}] 保存 masked 中间产物失败：${e instanceof Error ? e.message : String(e)}`,
            'warning',
          );
        }
      }

      // ── Step ③: SmartCropAndEnlargeAuto with workflow-specific params ──
      onStatus(`[${pipeline.name}] Smart Crop & Enlarge (Auto)…`, 'info');
      let processedBlob: Blob;
      let processedUrl: string;
      let smartCropMeta: SmartCropTransformMeta | undefined;
      try {
        const scResult = useSAM3
          ? await smartCropAndEnlargeAutoWithMeta(maskedBlob, {
              // SAM3_ExtractParts.json node 13 params (with overrides per project spec:
              // workflow had max_objects=16 / uniform_scale=false / preserve_position=false
              // by mistake — corrected here to keep 4-view layout aligned)
              padding: 30,
              whiteThreshold: 240,
              useAlpha: false,
              minArea: 64,
              maxObjects: 4,
              layout: 'auto',
              uniformScale: true,
              preservePosition: true,
              background: '#ffffff',
            })
          : await smartCropAndEnlargeAutoWithMeta(maskedBlob, {
              // BananaExtractJacket.json node 12 params
              padding: 30,
              whiteThreshold: 240,
              useAlpha: false,
              minArea: 10,
              maxObjects: 16,
              layout: 'auto',
              uniformScale: true,
              preservePosition: true,
              background: '#ffffff',
            });
        processedBlob = scResult.blob;
        smartCropMeta = scResult.meta;
        processedUrl = URL.createObjectURL(processedBlob);
      } catch (e) {
        onStatus(
          `[${pipeline.name}] Smart Crop 失败，回退使用 mask 原图：${e instanceof Error ? e.message : String(e)}`,
          'warning',
        );
        processedBlob = maskedBlob;
        processedUrl = URL.createObjectURL(processedBlob);
        // No smartCropMeta available — joints generation will skip this pipeline
      }

      // Save to project (full 4-view PNG)
      let savedFile: string | null = null;
      let splitMeta: SplitTransformMeta | undefined;
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
              const splitResult = await splitMultiViewWithMeta(processedBlob);
              splitMeta = splitResult.meta;
              const baseName = v.file.replace(/\.[^.]+$/, '');
              const setHandle = await saveSegments(
                'page2.extraction',
                baseName,
                v.file,
                splitResult.slices.map((s) => ({
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
        nodeStates: promoteDownstream(
          nodeStates.map((v, idx) => (idx === 1 ? 'complete' : v)),
          1,
          partNodes,
        ),
        extraction: { ...extraction, resultUrl: processedUrl, resultFile: savedFile, smartCropMeta, splitMeta, maskedFile, error: undefined },
      });
      onStatus(`[${pipeline.name}] ${modeLabel} 完成`, 'success');
      // Reload the per-pipeline history dropdown.
      void refreshExtractionHistory();
      return processedUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // SAM3CancelledError → soft revert to "ready" with a warning toast.
      if (err instanceof SAM3CancelledError) {
        console.warn('[PartPipeline] SAM3 cancelled:', err);
        onUpdate(pipeline.id, {
          ...pipeline,
          nodeStates: nodeStates.map((v, idx) => (idx === 1 ? 'ready' : v)),
          extraction: { ...extraction, error: undefined },
        });
        onStatus(`[${pipeline.name}] 已取消 SAM3 标注`, 'warning');
        return null;
      }
      const friendlyMsg =
        err instanceof SAM3NotWiredError
          ? `SAM3 子进程桥接异常（${msg}）`
          : err instanceof RMBGNotWiredError
            ? `RMBG 子进程桥接异常（${msg}）`
            : msg;
      console.error('[PartPipeline] extract jacket failed:', err);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: nodeStates.map((v, idx) => (idx === 1 ? 'error' : v)),
        extraction: { ...extraction, error: friendlyMsg },
      });
      onStatus(`[${pipeline.name}] ${modeLabel} 失败：${friendlyMsg}`, 'error');
      return null;
    }
  }, [pipeline, extraction, sourceFile, onStatus, onUpdate, project, saveAsset, saveSegments, refreshExtractionHistory]);

  const runModify = useCallback(async (): Promise<string | null> => {
    const modifyIdx = partNodes.findIndex((n) => n.id === 'modify');
    if (modifyIdx < 0) return null;

    let inputBlob: Blob | null = null;
    if (extraction.resultUrl) {
      inputBlob = await (await fetch(extraction.resultUrl)).blob();
    } else if (project && extraction.resultFile) {
      const r = await loadByName('page2.extraction', extraction.resultFile);
      inputBlob = r?.blob ?? null;
    }
    if (!inputBlob) {
      onStatus(`[${pipeline.name}] 缺少 Extraction 输出：请先完成 General/Jacket Extraction`, 'error');
      return null;
    }

    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: nodeStates.map((v, idx) => (idx === modifyIdx ? 'running' : v)),
      modify: { ...modify, error: undefined },
    });
    onStatus(`[${pipeline.name}] Modify · Banana Pro 高清化中…`, 'info');

    try {
      const url = await extractWithPrompt({
        source: inputBlob,
        prompt: MODIFY_HIGHRES_RETRY_PROMPT,
        statusAction: '重绘/高清化',
        aspectRatio: 'auto',
        resolution: '2K',
        onStatus: (m) => onStatus(`[${pipeline.name}] ${m}`, 'info'),
      });
      const blob = await (await fetch(url)).blob();
      if (modify.resultUrl) URL.revokeObjectURL(modify.resultUrl);

      let savedFile: string | null = null;
      if (project) {
        try {
          const v = await saveAsset('page2.modify', blob, 'png', `${pipeline.name} · Modify · Banana Pro`, pipeline.name);
          if (v) {
            savedFile = v.file;
            onStatus(`[${pipeline.name}] Modify 已保存到工程：${v.file}`, 'success');

            try {
              const slices = await splitMultiView(blob);
              const baseName = v.file.replace(/\.[^.]+$/, '');
              const setHandle = await saveSegments(
                'page2.modify',
                baseName,
                v.file,
                slices.map((s) => ({
                  name: `${s.view}_{v}.png`,
                  blob: s.blob,
                  meta: { view: s.view, bbox: s.bbox, size: s.size },
                })),
              );
              if (setHandle) {
                onStatus(`[${pipeline.name}] Modify 已切分 4 视图 → ${setHandle.dirName}/`, 'success');
              }
            } catch (e) {
              onStatus(
                `[${pipeline.name}] Modify 4 视图切分失败：${e instanceof Error ? e.message : String(e)}`,
                'warning',
              );
            }
          }
        } catch (e) {
          onStatus(
            `[${pipeline.name}] Modify 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error',
          );
        }
      }

      onUpdate(pipeline.id, {
        ...pipeline,
        expanded: { ...pipeline.expanded, [modifyIdx]: true },
        nodeStates: promoteDownstream(
          nodeStates.map((v, idx) => (idx === modifyIdx ? 'complete' : v)),
          modifyIdx,
          partNodes,
        ),
        modify: { ...modify, resultUrl: url, resultFile: savedFile, error: undefined },
      });
      void refreshModifyHistory();
      onStatus(`[${pipeline.name}] Modify 完成`, 'success');
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PartPipeline] modify failed:', err);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: nodeStates.map((v, idx) => (idx === modifyIdx ? 'error' : v)),
        modify: { ...modify, error: msg },
      });
      onStatus(`[${pipeline.name}] Modify 失败：${msg}`, 'error');
      return null;
    }
  }, [partNodes, extraction, project, loadByName, pipeline, modify, onStatus, onUpdate, saveAsset, saveSegments, refreshModifyHistory]);

  const run3DModel = useCallback(async (): Promise<string | null> => {
    const modelIdx = partNodes.findIndex((n) => n.id === 'highres');
    if (modelIdx < 0) return null;

    const useModify = !!(modify.resultUrl || modify.resultFile);
    let modelInputBlob: Blob | null = null;
    if (useModify && modify.resultUrl) {
      modelInputBlob = await (await fetch(modify.resultUrl)).blob();
    } else if (useModify && project && modify.resultFile) {
      const r = await loadByName('page2.modify', modify.resultFile);
      modelInputBlob = r?.blob ?? null;
    } else if (extraction.resultUrl) {
      modelInputBlob = await (await fetch(extraction.resultUrl)).blob();
    } else if (project && extraction.resultFile) {
      const r = await loadByName('page2.extraction', extraction.resultFile);
      modelInputBlob = r?.blob ?? null;
    }
    if (!modelInputBlob) {
      onStatus(`[${pipeline.name}] 缺少图片输出：请先完成 Extraction，或选择有效的 Modify 输出`, 'error');
      return null;
    }

    const mode = model3d.mode ?? 'fourView';
    const ctrl = new AbortController();
    modelAbortRef.current = ctrl;

    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: nodeStates.map((v, idx) => (idx === modelIdx ? 'running' : v)),
      model3d: { ...model3d, error: undefined },
    });
    onStatus(`[${pipeline.name}] 3D Model · ${MODEL_3D_MODE_LABEL[mode]} 开始…`, 'info');

    try {
      const slices = await splitMultiView(modelInputBlob);
      const byView = new Map(slices.map((s) => [s.view, s.blob]));
      const front = byView.get('front');
      const left = byView.get('left') ?? null;
      const back = byView.get('back') ?? null;
      const right = byView.get('right') ?? null;

      if (!front) throw new Error('未能从 Extraction 输出中切分出 front 视图');
      if (mode === 'frontBack' && !back) throw new Error('前后图生成需要 front + back 视图');
      if (mode === 'fourView' && (!left || !back || !right)) {
        throw new Error('四视图生成需要 front / left / back / right 四张视图');
      }

      let blob: Blob;
      let saveLabel: string;
      if (mode === 'single') {
        const r = await runImageToModel(front, {
          onStatus: (msg) => onStatus(`[${pipeline.name}] ${msg}`, 'info'),
          signal: ctrl.signal,
          filename: 'front.png',
        });
        blob = r.blob;
        saveLabel = `3D Model · Tripo single front · task ${r.result.task_id}`;
      } else {
        const inputs: MultiViewInputs = mode === 'frontBack'
          ? { front, back }
          : { front, left, back, right };
        const r = await runMultiViewToModel(inputs, {
          onStatus: (msg) => onStatus(`[${pipeline.name}] ${msg}`, 'info'),
          signal: ctrl.signal,
        });
        blob = r.blob;
        saveLabel = `3D Model · Tripo ${mode === 'frontBack' ? 'front/back' : 'four-view'} · task ${r.result.task_id}`;
      }

      let savedFile: string | null = null;
      if (project) {
        try {
          const v = await saveAsset('page2.highres', blob, 'glb', saveLabel, pipeline.name);
          if (v) {
            savedFile = v.file;
            onStatus(`[${pipeline.name}] 3D Model 已保存到工程：${v.file}`, 'success');
          }
        } catch (e) {
          onStatus(
            `[${pipeline.name}] 3D Model 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error',
          );
        }
      }

      const glbUrl = URL.createObjectURL(blob);
      if (model3d.glbUrl) URL.revokeObjectURL(model3d.glbUrl);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: promoteDownstream(
          nodeStates.map((v, idx) => (idx === modelIdx ? 'complete' : v)),
          modelIdx,
          partNodes,
        ),
        model3d: { ...model3d, glbUrl, glbFile: savedFile, mode, error: undefined },
      });
      void refreshModelHistory();
      onStatus(`[${pipeline.name}] 3D Model 完成`, 'success');
      return glbUrl;
    } catch (err) {
      if (err instanceof TripoServiceError && err.message === '已取消') {
        onUpdate(pipeline.id, {
          ...pipeline,
          nodeStates: nodeStates.map((v, idx) => (idx === modelIdx ? 'ready' : v)),
          model3d: { ...model3d, error: undefined },
        });
        onStatus(`[${pipeline.name}] 已取消 3D Model 生成`, 'warning');
        return null;
      }
      const msg =
        err instanceof TripoServiceError
          ? `${err.message}${err.error_code ? ` (code ${err.error_code})` : ''}${
              err.task_id ? ` [task ${err.task_id}]` : ''
            }`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error('[PartPipeline] 3D Model failed:', err);
      onUpdate(pipeline.id, {
        ...pipeline,
        nodeStates: nodeStates.map((v, idx) => (idx === modelIdx ? 'error' : v)),
        model3d: { ...model3d, error: msg },
      });
      onStatus(`[${pipeline.name}] 3D Model 失败：${msg}`, 'error');
      return null;
    } finally {
      modelAbortRef.current = null;
    }
  }, [partNodes, modify, extraction, project, loadByName, pipeline, model3d, onStatus, onUpdate, saveAsset, refreshModelHistory]);

  const clearModify = useCallback(() => {
    if (modify.resultUrl) URL.revokeObjectURL(modify.resultUrl);
    const modifyIdx = partNodes.findIndex((n) => n.id === 'modify');
    onUpdate(pipeline.id, {
      ...pipeline,
      nodeStates: modifyIdx >= 0
        ? nodeStates.map((v, idx) => (idx === modifyIdx ? 'ready' : v))
        : nodeStates,
      modify: { resultUrl: null, resultFile: null, error: undefined },
    });
    onStatus(`[${pipeline.name}] 已撤销 Modify 输出，3D Model 将使用 Extraction 输出`, 'info');
  }, [modify.resultUrl, partNodes, pipeline, onUpdate, onStatus]);

  const cancel3DModel = useCallback(() => {
    modelAbortRef.current?.abort();
    modelAbortRef.current = null;
  }, []);

  const runNode = useCallback(
    (i: number) => {
      // Extraction node: dispatches to SAM3 (General Extraction) or Banana
      // Pro (Extract Jacket) based on pipeline.mode — see runExtraction().
      if (i === 1) {
        void runExtraction();
        return;
      }
      if (partNodes[i]?.id === 'modify') {
        void runModify();
        return;
      }
      if (partNodes[i]?.id === 'highres') {
        void run3DModel();
        return;
      }
      const updated: PartPipelineState = {
        ...pipeline,
        nodeStates: nodeStates.map((v, idx) => (idx === i ? 'running' : v)),
      };
      onUpdate(pipeline.id, updated);
      onStatus(`[${pipeline.name}] 运行 ${partNodes[i].title} …`, 'info');

      window.setTimeout(() => {
        // Re-read latest by referencing current pipeline (closure captures pre-state, fine for mock)
        const after: PartPipelineState = {
          ...pipeline,
          nodeStates: nodeStates.map((v, idx) => {
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
    [pipeline, onUpdate, onStatus, runExtraction, runModify, run3DModel, partNodes]
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
          {nodeStates.filter((s) => s === 'complete').length} / {partNodes.length} 完成
        </span>
        <Button variant="ghost" size="sm" onClick={() => onDelete(pipeline.id)}>
          🗑 删除
        </Button>
      </div>

      {/* Node row */}
      <div style={{ overflowX: 'auto', padding: '20px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {partNodes.map((node, i) => {
            const state = nodeStates[i];
            const hasModifyOutput = node.id === 'modify' && !!(modify.resultUrl || modify.resultFile);
            const expanded = pipeline.expanded[i] ?? hasModifyOutput;

            const headerExtra =
              node.id === 'extraction' && project && extractionHistory.length > 0 ? (
                <HistoryDropdown
                  history={extractionHistory}
                  selected={extraction.resultFile ?? undefined}
                  onSelect={handleSelectExtractionHistory}
                />
              ) : node.id === 'modify' && project && modifyHistory.length > 0 ? (
                <HistoryDropdown
                  history={modifyHistory}
                  selected={modify.resultFile ?? undefined}
                  onSelect={handleSelectModifyHistory}
                />
              ) : node.id === 'highres' && project && modelHistory.length > 0 ? (
                <HistoryDropdown
                  history={modelHistory}
                  selected={model3d.glbFile ?? undefined}
                  onSelect={handleSelectModelHistory}
                />
              ) : undefined;

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
                    mode={pipeline.mode}
                  />
                ) : node.id === 'modify' ? (
                  <ModifyBody
                    state={state}
                    resultUrl={modify.resultUrl}
                    resultFile={modify.resultFile ?? null}
                    inputUrl={extraction.resultUrl ?? sourceUrl}
                    error={modify.error}
                    label={`${pipeline.name} · ${node.title}`}
                  />
                ) : node.id === 'highres' ? (
                  <Model3DBody
                    state={state}
                    glbUrl={model3d.glbUrl}
                    glbFile={model3d.glbFile ?? null}
                    error={model3d.error}
                    mode={model3d.mode ?? 'fourView'}
                    onModeChange={(mode) => {
                      onUpdate(pipeline.id, {
                        ...pipeline,
                        model3d: { ...model3d, mode },
                      });
                    }}
                    disabled={state === 'running'}
                  />
                ) : (
                  <Placeholder type={node.display} state={state} label={`${pipeline.name} · ${node.title}`} />
                )}
              </>
            );

            const actions = renderPartActions(
              node,
              state,
              i,
              runNode,
              setStateAt,
              cancel3DModel,
              clearModify,
              model3d.glbUrl
                ? () => {
                    const a = document.createElement('a');
                    a.href = model3d.glbUrl!;
                    a.download = model3d.glbFile ?? `${pipeline.name}_3d_model.glb`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }
                : undefined,
            );

            // 双击节点正文：图像类节点弹大图预览。
            const previewImageUrl =
              node.id === 'imageInput'
                ? imageInput.imageUrl ?? sourceUrl
                : node.id === 'extraction'
                  ? extraction.resultUrl ?? sourceUrl
                  : node.id === 'modify'
                    ? modify.resultUrl ?? extraction.resultUrl ?? sourceUrl
                  : undefined;
            const onBodyDoubleClick = previewImageUrl
              ? () => setPreview({ url: previewImageUrl, title: `${i + 1}. ${node.title} · ${pipeline.name}` })
              : node.id === 'highres' && model3d.glbUrl
                ? () => onPreviewModel?.(
                    model3d.glbUrl!,
                    `${i + 1}. ${node.title} · ${pipeline.name}${model3d.glbFile ? ' · ' + model3d.glbFile : ''}`,
                  )
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
                  <NodeConnector fromState={state} toState={nodeStates[i + 1]} />
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
  cancel3DModel?: () => void,
  clearModify?: () => void,
  download3DModel?: () => void,
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
        key="download"
        size="sm"
        disabled={!download3DModel}
        onClick={download3DModel}
      >
        下载 GLB
      </Button>
    );
  }
  if (node.id === 'modify' && state !== 'optional') {
    extraButtons.push(
      <Button key="undo" size="sm" disabled={isRunning} onClick={clearModify}>撤销</Button>
    );
  }

  return (
    <>
      {extraButtons}
      {isError ? (
        <Button variant="primary" size="sm" onClick={() => runNode(idx)}>重试</Button>
      ) : isRunning ? (
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            if (node.id === 'highres') cancel3DModel?.();
            setStateAt(idx, 'ready');
          }}
        >
          取消
        </Button>
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
// Extraction node body — Page2 Pipeline 1 (Jacket Extract) / Pipeline 2 (General Extract)
// ---------------------------------------------------------------------------

interface ExtractionBodyProps {
  state: NodeState;
  resultUrl: string | null;
  resultFile: string | null;
  sourceUrl: string | null;
  error?: string;
  label: string;
  mode: PipelineMode;
}

function ExtractionBody({
  state,
  resultUrl,
  resultFile: _resultFile,
  sourceUrl,
  error,
  label,
  mode,
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
        {mode === 'multiview'
          ? 'Banana Pro（固定提示词：提取外套，补全被遮挡部分）→ RMBG-2.0 → Smart Crop'
          : 'SAM3 交互分割（整图保留 4-view）→ Smart Crop'}
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
// Modify node body — Banana Pro high-res redraw while preserving 4-view order
// ---------------------------------------------------------------------------

interface ModifyBodyProps {
  state: NodeState;
  resultUrl: string | null;
  resultFile: string | null;
  inputUrl: string | null;
  error?: string;
  label: string;
}

function ModifyBody({
  state,
  resultUrl,
  resultFile: _resultFile,
  inputUrl,
  error,
  label,
}: ModifyBodyProps) {
  const previewUrl = resultUrl ?? inputUrl;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Placeholder
        type="image"
        state={previewUrl && state !== 'running' && state !== 'error' ? 'complete' : state}
        label={label}
        imageUrl={previewUrl ?? undefined}
        height={140}
      />

      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 }}>
        Banana Pro：按 2×2 顺序（front / left / right / back）对同一主体高清化，保持整体画风。
      </div>
      {!inputUrl && (
        <div style={{ fontSize: 10, color: 'var(--accent-yellow, #d49b3b)' }}>
          未检测到输入：请先完成 Extraction
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
// 3D Model node body
// ---------------------------------------------------------------------------

interface Model3DBodyProps {
  state: NodeState;
  glbUrl: string | null;
  glbFile: string | null;
  error?: string;
  mode: Model3DMode;
  onModeChange: (mode: Model3DMode) => void;
  disabled?: boolean;
}

function Model3DBody({
  state,
  glbUrl,
  glbFile,
  error,
  mode,
  onModeChange,
  disabled,
}: Model3DBodyProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {state === 'complete' && glbUrl ? (
        <GLBThumbnail url={glbUrl} height={140} />
      ) : (
        <Placeholder type="3d" state={state} label="3D Model" height={140} />
      )}

      <div
        style={{
          padding: 6,
          background: 'var(--bg-surface-2, rgba(255,255,255,0.03))',
          border: '1px solid var(--border-subtle)',
          borderRadius: 3,
          fontSize: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 48 }}>模式</span>
          <select
            disabled={disabled}
            value={mode}
            onChange={(e) => onModeChange(e.target.value as Model3DMode)}
            style={{
              flex: 1,
              fontSize: 11,
              padding: '2px 4px',
              background: 'var(--bg-input, var(--bg-app))',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
              borderRadius: 3,
            }}
          >
            <option value="single">Tripo-Single</option>
            <option value="frontBack">Tripo-2View</option>
            <option value="fourView">Tripo-4View</option>
          </select>
        </div>
        {glbFile && (
          <div style={{ marginTop: 4, color: 'var(--text-secondary)' }} title={glbFile}>
            {glbFile.length > 34 ? `${glbFile.slice(0, 34)}…` : glbFile}
          </div>
        )}
      </div>

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
