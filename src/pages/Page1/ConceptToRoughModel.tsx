import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import type { CSSProperties } from 'react';
import type { NodeConfig, NodeState } from '../../types';
import { NodeCard } from '../../components/NodeCard';
import { NodeConnector } from '../../components/NodeConnector';
import { Button } from '../../components/Button';
import { Placeholder } from '../../components/Placeholder';
import { ImagePreviewModal } from '../../components/ImagePreviewModal';
import { GLBViewer } from '../../components/GLBViewer';
import { GLBThumbnail } from '../../components/GLBThumbnail';
import { runConceptToTPose, runTPoseMultiView } from '../../services/workflows';
import { runImageToModel, runMultiViewToModel, TripoServiceError } from '../../services/tripo';
import {
  generateModel as runTrellis2,
  getHealth as getTrellis2Health,
  TRELLIS2_DEFAULTS,
  type Trellis2Params,
} from '../../services/trellis2';
import { splitMultiView } from '../../services/multiviewSplit';
import { detectAndConvertToGlobalJoints, globalJointsToPage1Views } from '../../services/dwpose';
import type { Page1JointsMeta, Page1SplitsMeta, ViewName } from '../../types/joints';
import { extractWithPrompt, REMOVE_JACKET_PROMPT } from '../../services/extraction';
import { useProject } from '../../contexts/ProjectContext';
import type { AssetVersion } from '../../services/projectStore';

const NODES: NodeConfig[] = [
  { id: 'concept', title: 'Concept', display: 'image', description: '上传概念设计稿' },
  { id: 'tpose', title: 'T Pose', display: 'image', description: '生成标准 T Pose 正视图' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview', description: '生成多角度视图' },
  { id: 'rough', title: '3D Model', display: '3d', description: 'Tripo / TRELLIS.2 生成 3D 模型 (GLB)' },
  { id: 'rigging', title: '3D Model Rigging', display: '3d', description: '骨骼绑定' },
  // 独立节点，与上游不走连线（输入从 Multi-View 读，输出单独供 Page 2 使用）
  { id: 'extraction', title: 'Remove Jacket', display: 'image', description: '基于 Multi-View，使用 Banana Pro 移除外套' },
];

/** 节点索引 → projectStore 中的 nodeKey（用于历史读写） */
const NODE_KEYS = [
  'page1.concept',
  'page1.tpose',
  'page1.multiview',
  'page1.rough',
  'page1.rigging',
  'page1.extraction',
];

// ----------------------------------------------------------------------------
// 3D Model 后端选择
// ----------------------------------------------------------------------------
type RoughBackend = 'tripo' | 'trellis2';

const BACKEND_LABEL: Record<RoughBackend, string> = {
  tripo: 'Tripo (multi-view)',
  trellis2: 'TRELLIS.2 (single-view, 自部署)',
};

const ROUGH_BACKEND_LS_KEY = 'page1.rough.backend';
const TRELLIS2_PARAMS_LS_KEY = 'page1.rough.trellis2Params';

function loadRoughBackend(): RoughBackend {
  try {
    const v = localStorage.getItem(ROUGH_BACKEND_LS_KEY);
    if (v === 'tripo' || v === 'trellis2') return v;
  } catch {
    /* ignore */
  }
  return 'tripo';
}

function loadTrellis2Params(): Trellis2Params {
  try {
    const raw = localStorage.getItem(TRELLIS2_PARAMS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Trellis2Params;
      return { ...TRELLIS2_DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...TRELLIS2_DEFAULTS };
}

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface NodeOutputs {
  conceptFile: File | null;
  conceptUrl: string | null;
  tposeUrl: string | null;
  multiviewUrl: string | null;
  /** 3D Model（GLB）blob URL，用于触发浏览器下载 */
  roughUrl: string | null;
  /** 3D Model 工程文件名（用于显示） */
  roughFile: string | null;
  /** Extraction（Banana Pro）输出 */
  extractionUrl: string | null;
  extractionFile: string | null;
  errors: Record<number, string>;
}

export function ConceptToRoughModel({ onStatusChange }: Props) {
  const { project, saveAsset, loadLatest, listHistory, loadByName, saveSegments, loadLatestSegments, savePage1Splits, savePage1Joints } = useProject();
  const [states, setStates] = useState<NodeState[]>([
    'idle', 'idle', 'idle', 'idle', 'idle', 'idle',
  ]);
  const [outputs, setOutputs] = useState<NodeOutputs>({
    conceptFile: null,
    conceptUrl: null,
    tposeUrl: null,
    multiviewUrl: null,
    roughUrl: null,
    roughFile: null,
    extractionUrl: null,
    extractionFile: null,
    errors: {},
  });
  const roughAbortRef = useRef<AbortController | null>(null);

  // 3D Model 后端选择 + 各后端参数（持久化到 localStorage）
  const [roughBackend, setRoughBackend] = useState<RoughBackend>(loadRoughBackend);
  const [trellis2Params, setTrellis2Params] = useState<Trellis2Params>(loadTrellis2Params);
  // 仅当 backend === 'trellis2' 时显示参数面板
  const [showTrellis2Params, setShowTrellis2Params] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(ROUGH_BACKEND_LS_KEY, roughBackend); } catch { /* ignore */ }
  }, [roughBackend]);

  useEffect(() => {
    try { localStorage.setItem(TRELLIS2_PARAMS_LS_KEY, JSON.stringify(trellis2Params)); } catch { /* ignore */ }
  }, [trellis2Params]);

  // Extraction (Banana Pro) 节点：固定使用 REMOVE_JACKET_PROMPT，不再提供下拉选择。

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 每个节点的历史版本列表（[0] = 最新）
  const [histories, setHistories] = useState<Record<number, AssetVersion[]>>({});
  // 每个节点当前选中的历史版本文件名
  const [selectedFiles, setSelectedFiles] = useState<Record<number, string>>({});
  // 大图预览
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  // 3D Mesh Viewer 当前显示的 GLB URL（双击 3D Model 节点设置）
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLabel, setViewerLabel] = useState<string | null>(null);
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
      const extraction = await loadLatest('page1.extraction');
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
        if (prev.extractionUrl) URL.revokeObjectURL(prev.extractionUrl);
        return {
          conceptFile,
          conceptUrl: concept?.url ?? null,
          tposeUrl: tpose?.url ?? null,
          multiviewUrl: multiview?.url ?? null,
          roughUrl: rough?.url ?? null,
          roughFile: rough?.version.file ?? null,
          extractionUrl: extraction?.url ?? null,
          extractionFile: extraction?.version.file ?? null,
          errors: {},
        };
      });
      setStates(() => {
        const next: NodeState[] = ['idle', 'idle', 'idle', 'idle', 'idle', 'idle'];
        if (concept) next[0] = 'complete';
        if (tpose) next[1] = 'complete';
        else if (concept) next[1] = 'ready';
        if (multiview) next[2] = 'complete';
        else if (tpose) next[2] = 'ready';
        if (rough) next[3] = 'complete';
        else if (multiview) next[3] = 'ready';
        // Extraction 是独立节点：源是 Multi-View，但不阻塞 3D Model 链路。
        if (extraction) next[5] = 'complete';
        else if (multiview) next[5] = 'ready';
        return next;
      });

      const loaded: string[] = [];
      if (concept) loaded.push('Concept');
      if (tpose) loaded.push('T Pose');
      if (multiview) loaded.push('Multi-View');
      if (rough) loaded.push('3D Model');
      if (extraction) loaded.push('Extraction');
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
      if (extraction) sel[5] = extraction.version.file;
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
      if (prev.extractionUrl) URL.revokeObjectURL(prev.extractionUrl);
      return {
        conceptFile: file,
        conceptUrl: URL.createObjectURL(file),
        tposeUrl: null,
        multiviewUrl: null,
        roughUrl: null,
        roughFile: null,
        extractionUrl: null,
        extractionFile: null,
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
      if (prev.extractionUrl) URL.revokeObjectURL(prev.extractionUrl);
      return {
        conceptFile: null,
        conceptUrl: null,
        tposeUrl: null,
        multiviewUrl: null,
        roughUrl: null,
        roughFile: null,
        extractionUrl: null,
        extractionFile: null,
        errors: {},
      };
    });
    setStates(['idle', 'idle', 'idle', 'idle', 'idle', 'idle']);
    onStatusChange('已清除', 'info');
  };

  // ---- T Pose node ----------------------------------------------------------
  const runTPose = useCallback(async (sourceFile?: File): Promise<string | null> => {
    // 防御：当作为 button onClick handler 直接绑定时，会收到 SyntheticEvent 作为参数
    const file = (sourceFile instanceof File ? sourceFile : null) ?? outputsRef.current.conceptFile;
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
    // 防御：当作为 button onClick handler 直接绑定时，会收到 SyntheticEvent 作为参数
    const tposeUrl = (typeof sourceUrl === 'string' ? sourceUrl : null) ?? outputsRef.current.tposeUrl;
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

            // 自动切分四视图并保存到子目录 <baseName>_v0001/...
            try {
              const slices = await splitMultiView(blob);
              const baseName = v.file.replace(/\.[^.]+$/, '');
              const setHandle = await saveSegments(
                'page1.multiview',
                baseName,
                v.file,
                slices.map((s) => ({
                  // 文件名包含版本号占位符，由 saveSegments 替换为目录的版本号
                  // 例：front_v0001.png / left_v0001.png ...
                  name: `${s.view}_{v}.png`,
                  blob: s.blob,
                  meta: { view: s.view, bbox: s.bbox, size: s.size },
                })),
              );
              if (setHandle) {
                onStatusChange(
                  `已切分 4 视图 → ${setHandle.dirName}/`,
                  'success',
                );

                // ── Stage 1: 持久化 page1.splits + page1.joints ───────────
                // 设计意图：Page1 是唯一的关节生产者；这里把 split bbox 和
                // DWPose 结果一并塞进 project.json，让 Page3 不再依赖 Page2.
                try {
                  // Stage 1 guard: split 必须返回完整四视图
                  const requiredViews: ViewName[] = ['front', 'left', 'back', 'right'];
                  const gotViews = new Set(slices.map((s) => s.view));
                  const missing = requiredViews.filter((v) => !gotViews.has(v));
                  if (missing.length > 0) {
                    throw new Error(`splitMultiView 缺少视图: ${missing.join(', ')}（共 ${slices.length}/4）`);
                  }
                  const versionTag = setHandle.index.version; // e.g. "v0001"
                  const viewMeta = new Map<ViewName, { bbox: { x0: number; y0: number; x1: number; y1: number }; size: { w: number; h: number } }>();
                  for (const s of slices) viewMeta.set(s.view, { bbox: s.bbox, size: s.size });
                  const fileFor = (vw: ViewName) => `${vw}_${versionTag}.png`;
                  const splitsMeta: Page1SplitsMeta = {
                    version: 1,
                    source: v.file,
                    segmentDir: setHandle.dirName,
                    views: {
                      front: { view: 'front', file: fileFor('front'), ...viewMeta.get('front')! },
                      left:  { view: 'left',  file: fileFor('left'),  ...viewMeta.get('left')!  },
                      back:  { view: 'back',  file: fileFor('back'),  ...viewMeta.get('back')!  },
                      right: { view: 'right', file: fileFor('right'), ...viewMeta.get('right')! },
                    },
                    generatedAt: new Date().toISOString(),
                  };
                  await savePage1Splits(splitsMeta);

                  // DWPose 失败仅打 warning，不阻塞主流程
                  try {
                    const dataUrl = await blobToDataUrl(blob);
                    const { joints: globalJoints } = await detectAndConvertToGlobalJoints(
                      dataUrl,
                      v.file,
                      { includeHand: false, includeFace: false },
                    );
                    const perView = globalJointsToPage1Views(globalJoints, splitsMeta);
                    const jointsMeta: Page1JointsMeta = {
                      version: 1,
                      source: v.file,
                      global: globalJoints,
                      views: perView,
                      generatedAt: new Date().toISOString(),
                    };
                    await savePage1Joints(jointsMeta);
                    const total = globalJoints.keypoints.length;
                    // Stage 1 guard: 关键点过少（< 4）通常是输入图质量差或遮挡，提示但不阻塞
                    if (total < 4) {
                      onStatusChange(
                        `⚠️ 关节检测异常：仅检到 ${total} 个关键点，建议检查输入图质量（已写入但 Page3 可能不可用）`,
                        'warning',
                      );
                    } else {
                      onStatusChange(`关节已检测：${total} 个关键点已写入 project.json`, 'success');
                    }
                  } catch (e) {
                    console.warn('[Page1] DWPose 失败（不阻塞 multiview）:', e);
                    onStatusChange(
                      `DWPose 关节检测失败（已忽略，可稍后重跑）：${e instanceof Error ? e.message : String(e)}`,
                      'warning',
                    );
                  }
                } catch (e) {
                  console.warn('[Page1] 写入 page1.splits/joints 失败:', e);
                  onStatusChange(
                    `Page1 splits/joints 持久化失败：${e instanceof Error ? e.message : String(e)}`,
                    'warning',
                  );
                }
              }
            } catch (e) {
              onStatusChange(
                `Multi-View 切分失败：${e instanceof Error ? e.message : String(e)}`,
                'warning',
              );
            }
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
  }, [onStatusChange, setNodeState, project, saveAsset, saveSegments, refreshHistory, savePage1Splits, savePage1Joints]);

  // ---- 3D Model node (Tripo / TRELLIS.2 image → GLB) ----------------
  const runRoughModel = useCallback(async (sourceUrl?: string): Promise<string | null> => {
    // 防御：当作为 button onClick handler 直接绑定时，会收到 SyntheticEvent 作为参数
    const mvUrl = (typeof sourceUrl === 'string' ? sourceUrl : null) ?? outputsRef.current.multiviewUrl;
    if (!mvUrl) {
      onStatusChange('请先生成 Multi-View', 'error');
      return null;
    }
    setNodeState(3, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 3: '' } }));

    const ctrl = new AbortController();
    roughAbortRef.current = ctrl;

    const backend = roughBackend;
    onStatusChange(`3D Model: 使用后端 ${BACKEND_LABEL[backend]}`, 'info');

    try {
      // 读取多视图切分（front/left/back/right）—— Tripo 多视图模式与 trellis2 单图模式都依赖 front 视图
      let multiInputs: { front: Blob; left?: Blob | null; back?: Blob | null; right?: Blob | null } | null = null;
      if (project) {
        try {
          const seg = await loadLatestSegments('page1.multiview');
          if (seg) {
            const fileMap: Record<string, string | null> = {
              front: null, left: null, back: null, right: null,
            };
            const pick = (view: string): Blob | null => {
              const entry = seg.index.entries.find(
                (e) => (e.meta as { view?: string } | undefined)?.view === view,
              );
              if (!entry) return null;
              const blob = seg.files.get(entry.file) ?? null;
              if (blob) fileMap[view] = entry.file;
              return blob;
            };
            const front = pick('front');
            if (front) {
              multiInputs = {
                front,
                left:  pick('left'),
                back:  pick('back'),
                right: pick('right'),
              };
              const presentList = ['front',
                multiInputs.left  ? 'left'  : null,
                multiInputs.back  ? 'back'  : null,
                multiInputs.right ? 'right' : null,
              ].filter(Boolean).join(' / ');
              onStatusChange(
                `检测到切分子目录 ${seg.dirName}/，可用视图：${presentList}`,
                'info',
              );
              console.log(
                `[3D Model] 多视图源（dir=${seg.dirName}, source=${seg.index.source}）:\n` +
                  `  front: ${fileMap.front ?? '(缺失)'}\n` +
                  `  left:  ${fileMap.left  ?? '(缺失)'}\n` +
                  `  back:  ${fileMap.back  ?? '(缺失)'}\n` +
                  `  right: ${fileMap.right ?? '(缺失)'}`,
              );
            }
          }
        } catch (e) {
          console.warn('[3D Model] 读取切分集失败：', e);
        }
      }

      let blob: Blob;
      let saveLabel: string;

      if (backend === 'trellis2') {
        // TRELLIS.2 单图建模：优先使用切分的 front 视图，否则退化为 multiview 整图
        const inputBlob = multiInputs?.front ?? await (await fetch(mvUrl)).blob();
        const sourceLabel = multiInputs?.front ? 'front 视图' : 'Multi-View 整图';
        onStatusChange(`TRELLIS.2: 探测服务状态…`, 'info');
        try {
          const health = await getTrellis2Health();
          if (!health.modelLoaded) {
            onStatusChange('TRELLIS.2 服务未加载模型，请先 warmup（点开参数面板有按钮）', 'error');
            throw new Error('TRELLIS.2 model not loaded');
          }
          onStatusChange(
            `TRELLIS.2 就绪 · ${health.gpuName ?? 'GPU'} · 输入：${sourceLabel}`,
            'info',
          );
        } catch (e) {
          // /health 接口本身打不通：报错 + 抛出（前端 vite proxy 失败时给清晰提示）
          throw new Error(
            `TRELLIS.2 服务不可达：${e instanceof Error ? e.message : String(e)} ` +
            `（请检查 SSH 隧道 D:\\AI\\Services\\Trellis2Service\\deploy\\ssh_tunnel.ps1 是否启动）`
          );
        }

        onStatusChange(`TRELLIS.2 生成中…（典型耗时 4-5 分钟）`, 'info');
        const t2Result = await runTrellis2(inputBlob, trellis2Params);
        blob = t2Result.blob;
        saveLabel = `trellis2 seed=${t2Result.meta.seed} ` +
          `gen=${t2Result.meta.elapsedGenSec}s bake=${t2Result.meta.elapsedBakeSec}s`;
        console.log('[3D Model] TRELLIS.2 meta:', t2Result.meta);
        onStatusChange(
          `TRELLIS.2 完成 · 总 ${t2Result.meta.elapsedTotalSec}s（生成 ${t2Result.meta.elapsedGenSec}s + 烘焙 ${t2Result.meta.elapsedBakeSec}s）· ${(t2Result.meta.glbBytes / 1024 / 1024).toFixed(1)} MB`,
          'success',
        );
      } else {
        // Tripo：优先多视图，否则单图
        const tripoResult = multiInputs
          ? await runMultiViewToModel(multiInputs, {
              onStatus: (msg) => onStatusChange(msg, 'info'),
              signal: ctrl.signal,
            })
          : await runImageToModel(await (await fetch(mvUrl)).blob(), {
              onStatus: (msg) => onStatusChange(msg, 'info'),
              signal: ctrl.signal,
              filename: 'multiview.png',
            });
        blob = tripoResult.blob;
        saveLabel = `tripo task ${tripoResult.result.task_id}`;
      }

      // 持久化 + 产生预览 URL
      let savedFile: string | null = null;
      if (project) {
        try {
          const v = await saveAsset(
            'page1.rough',
            blob,
            'glb',
            saveLabel,
          );
          if (v) {
            savedFile = v.file;
            onStatusChange(`3D Model 已保存到工程：${v.file}`, 'success');
            setSelectedFiles((prev) => ({ ...prev, 3: v.file }));
            refreshHistory(3);
          }
        } catch (e) {
          onStatusChange(
            `3D Model 保存失败：${e instanceof Error ? e.message : String(e)}`,
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
      onStatusChange('3D Model 生成完成', 'success');
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
      console.error('[3D Model] failed:', err);
      setNodeState(3, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 3: msg } }));
      onStatusChange(`3D Model 生成失败：${msg}`, 'error');
      return null;
    } finally {
      roughAbortRef.current = null;
    }
  }, [onStatusChange, setNodeState, project, saveAsset, refreshHistory, loadLatestSegments, roughBackend, trellis2Params]);

  const cancelRoughModel = useCallback(() => {
    roughAbortRef.current?.abort();
    roughAbortRef.current = null;
  }, []);

  // ---- Extraction node (Banana Pro on Multi-View) -------------------------
  // 独立节点，不与上游链路绑定，输出会被 Page 2 的 PartPipeline 当作部件源图使用。
  const runExtraction = useCallback(async (): Promise<string | null> => {
    const mvUrl = outputsRef.current.multiviewUrl;
    if (!mvUrl) {
      onStatusChange('请先生成 Multi-View', 'error');
      return null;
    }

    setNodeState(5, 'running');
    setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 5: '' } }));
    try {
      // 把 Multi-View blob URL 转成 File 喂给 Banana Pro
      const mvBlob = await (await fetch(mvUrl)).blob();
      const sourceFile = new File([mvBlob], 'multiview.png', { type: mvBlob.type || 'image/png' });

      const url = await extractWithPrompt({
        source: sourceFile,
        prompt: REMOVE_JACKET_PROMPT,
        onStatus: (m) => onStatusChange(`Remove Jacket · ${m}`, 'info'),
      });

      // 持久化 + 4 视图切分（与 Multi-View 节点完全一致的命名）
      let savedFile: string | null = null;
      if (project) {
        try {
          const blob = await (await fetch(url)).blob();
          const v = await saveAsset(
            'page1.extraction',
            blob,
            'png',
            'Remove Jacket',
          );
          if (v) {
            savedFile = v.file;
            onStatusChange(`Remove Jacket 已保存到工程：${v.file}`, 'success');

            try {
              const slices = await splitMultiView(blob);
              const baseName = v.file.replace(/\.[^.]+$/, '');
              const setHandle = await saveSegments(
                'page1.extraction',
                baseName,
                v.file,
                slices.map((s) => ({
                  name: `${s.view}_{v}.png`,
                  blob: s.blob,
                  meta: { view: s.view, bbox: s.bbox, size: s.size },
                })),
              );
              if (setHandle) {
                onStatusChange(`已切分 4 视图 → ${setHandle.dirName}/`, 'success');
              }
            } catch (e) {
              onStatusChange(
                `Remove Jacket 4 视图切分失败：${e instanceof Error ? e.message : String(e)}`,
                'warning',
              );
            }
            setSelectedFiles((prev) => ({ ...prev, 5: v.file }));
            refreshHistory(5);
          }
        } catch (e) {
          onStatusChange(
            `Remove Jacket 保存失败：${e instanceof Error ? e.message : String(e)}`,
            'error',
          );
        }
      }

      setOutputs((prev) => {
        if (prev.extractionUrl) URL.revokeObjectURL(prev.extractionUrl);
        return { ...prev, extractionUrl: url, extractionFile: savedFile };
      });
      setNodeState(5, 'complete');
      onStatusChange('Remove Jacket 生成完成', 'success');
      return url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Remove Jacket] failed:', err);
      setNodeState(5, 'error');
      setOutputs((prev) => ({ ...prev, errors: { ...prev.errors, 5: msg } }));
      onStatusChange(`Remove Jacket 生成失败：${msg}`, 'error');
      return null;
    }
  }, [onStatusChange, setNodeState, project, saveAsset, saveSegments, refreshHistory]);

  // ---- Mock runner for nodes 3..4 (3D Model / Rigging) -----------------
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
      if (prev.extractionUrl) URL.revokeObjectURL(prev.extractionUrl);
      return {
        conceptFile: null,
        conceptUrl: null,
        tposeUrl: null,
        multiviewUrl: null,
        roughUrl: null,
        roughFile: null,
        extractionUrl: null,
        extractionFile: null,
        errors: {},
      };
    });
    setStates(['idle', 'idle', 'idle', 'idle', 'idle', 'idle']);
    onStatusChange('已重置 Pipeline', 'info');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
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

      {/* Pipeline 区（顶部，紧凑高度，可横向滚动） */}
      <div
        style={{
          flex: '0 0 auto',
          overflowX: 'auto',
          overflowY: 'hidden',
          padding: '16px 16px',
          background: 'var(--bg-app)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {NODES.map((node, idx) => {
            const state = states[idx];
            const imageUrl = imageForNode(idx, outputs);
            const errMsg = outputs.errors[idx];

            const body: ReactNode = (
              <>
                {node.id === 'rough' && state === 'complete' && outputs.roughUrl ? (
                  <GLBThumbnail url={outputs.roughUrl} height={160} />
                ) : (
                  <Placeholder
                    type={node.display}
                    state={state}
                    label={node.title}
                    imageUrl={imageUrl}
                  />
                )}
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
                    {node.id === 'rough'
                      ? `后端：${BACKEND_LABEL[roughBackend]}`
                      : node.description}
                    {idx === 0 && outputs.conceptFile && (
                      <div style={{ marginTop: 2, color: 'var(--text-secondary)' }}>
                        {outputs.conceptFile.name}
                      </div>
                    )}
                  </div>
                )}
                {node.id === 'rough' && (
                  <RoughBackendPanel
                    backend={roughBackend}
                    onChangeBackend={setRoughBackend}
                    trellis2Params={trellis2Params}
                    onChangeTrellis2Params={setTrellis2Params}
                    expanded={showTrellis2Params}
                    onToggleExpanded={() => setShowTrellis2Params((v) => !v)}
                    onWarmup={async () => {
                      try {
                        onStatusChange('TRELLIS.2: 触发 warmup（首次约 1-3 分钟）…', 'info');
                        const { warmup } = await import('../../services/trellis2');
                        await warmup();
                        onStatusChange('TRELLIS.2: warmup 完成', 'success');
                      } catch (e) {
                        onStatusChange(
                          `TRELLIS.2 warmup 失败：${e instanceof Error ? e.message : String(e)}`,
                          'error',
                        );
                      }
                    }}
                    disabled={state === 'running'}
                  />
                )}
                {node.id === 'extraction' && (
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                    固定提示词：移除外套，补全 T 恤与手臂
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
              onRunExtraction: runExtraction,
              conceptReady: !!outputs.conceptFile,
              tposeReady: !!outputs.tposeUrl,
              multiviewReady: !!outputs.multiviewUrl,
              roughReady: !!outputs.roughUrl,
              extractionReady: !!outputs.extractionUrl,
            });

            return (
              <div key={node.id} style={{ display: 'flex', alignItems: 'center' }}>
                <NodeCard
                  title={`${idx + 1}. ${node.title}`}
                  state={state}
                  actions={actions}
                  headerExtra={
                    <>
                      {/* Stage 1: Multi-View 节点显示"关节已检测"绿勾 */}
                      {idx === 2 && project?.meta.page1?.joints ? (
                        <span
                          title={`page1.joints @ ${project.meta.page1.joints.source}`}
                          style={{
                            color: '#16a34a',
                            fontSize: 12,
                            marginRight: 8,
                            fontWeight: 500,
                          }}
                        >
                          ✓ 关节已检测
                        </span>
                      ) : null}
                      {project && (histories[idx]?.length ?? 0) > 0 ? (
                        <HistoryDropdown
                          history={histories[idx] ?? []}
                          selected={selectedFiles[idx]}
                          onSelect={(f) => handleSelectHistory(idx, f)}
                        />
                      ) : null}
                    </>
                  }
                  onBodyClick={
                    // Concept (idx 0) 不支持单击运行链；
                    // Extraction (idx 5) 是独立节点，不参与上游链式运行
                    idx === 0 || idx === 5 ? undefined : () => { void runUpToNode(idx); }
                  }
                  onBodyDoubleClick={(() => {
                    // 3D 节点：双击送入下方 3D Mesh Viewer
                    if (node.display === '3d') {
                      if (idx === 3 && outputs.roughUrl) {
                        return () => {
                          setViewerUrl(outputs.roughUrl);
                          setViewerLabel(`${idx + 1}. ${node.title}${outputs.roughFile ? ' · ' + outputs.roughFile : ''}`);
                        };
                      }
                      return undefined;
                    }
                    // 图像节点：维持原有大图预览
                    return imageUrl
                      ? () => setPreview({ url: imageUrl, title: `${idx + 1}. ${node.title}` })
                      : undefined;
                  })()}
                >
                  {body}
                </NodeCard>
                {/* 不渲染连接线：
                    1) 最后一个节点之后
                    2) Extraction 节点（idx=5）是独立节点，与上游 rigging（idx=4）之间不画箭头 */}
                {idx < NODES.length - 1 && idx + 1 !== 5 && (
                  <NodeConnector fromState={state} toState={states[idx + 1]} />
                )}
                {/* Extraction 之前用一个视觉间隔代替连接线 */}
                {idx + 1 === 5 && (
                  <div style={{ width: 32, flex: '0 0 auto' }} aria-hidden />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 3D Mesh Viewer（Pipeline 下方，填充剩余空间） */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <GLBViewer url={viewerUrl} label={viewerLabel ?? '3D Mesh Viewer'} />
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

/** Encode a Blob into a data: URL (used as input to /api/dwpose). */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      buf.subarray(i, Math.min(i + CHUNK, buf.length)) as unknown as number[],
    );
  }
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${btoa(bin)}`;
}

function imageForNode(idx: number, outputs: NodeOutputs): string | undefined {
  if (idx === 0) return outputs.conceptUrl ?? undefined;
  if (idx === 1) return outputs.tposeUrl ?? undefined;
  if (idx === 2) return outputs.multiviewUrl ?? undefined;
  if (idx === 5) return outputs.extractionUrl ?? undefined;
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
  onRunExtraction: () => void;
  conceptReady: boolean;
  tposeReady: boolean;
  multiviewReady: boolean;
  roughReady: boolean;
  extractionReady: boolean;
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

  if (node.id === 'extraction') {
    return (
      <>
        <Button size="sm" disabled={!isComplete}>导出</Button>
        {isError ? (
          <Button variant="primary" size="sm" onClick={h.onRunExtraction}>重试</Button>
        ) : isRunning ? (
          <Button variant="danger" size="sm" disabled title="生成中…">生成中…</Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!h.multiviewReady}
            onClick={h.onRunExtraction}
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
// 3D Model 后端选择 + TRELLIS.2 参数面板
// ---------------------------------------------------------------------------

interface RoughBackendPanelProps {
  backend: RoughBackend;
  onChangeBackend: (b: RoughBackend) => void;
  trellis2Params: Trellis2Params;
  onChangeTrellis2Params: (p: Trellis2Params) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onWarmup: () => void;
  disabled?: boolean;
}

function RoughBackendPanel({
  backend,
  onChangeBackend,
  trellis2Params,
  onChangeTrellis2Params,
  expanded,
  onToggleExpanded,
  onWarmup,
  disabled,
}: RoughBackendPanelProps) {
  const labelStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--text-muted)',
    minWidth: 64,
  };
  const inputStyle: CSSProperties = {
    flex: 1,
    fontSize: 11,
    padding: '2px 4px',
    background: 'var(--bg-input, var(--bg-app))',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 3,
  };
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  };

  // 控件：受控 number 输入
  const numInput = (
    label: string,
    value: number | undefined,
    fallback: number,
    update: (n: number) => void,
    min?: number,
    max?: number,
    step?: number,
  ) => (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        type="number"
        disabled={disabled}
        value={value ?? fallback}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) update(n);
        }}
        style={inputStyle}
      />
    </div>
  );

  return (
    <div
      style={{
        marginTop: 6,
        padding: 6,
        background: 'var(--bg-surface-2, rgba(255,255,255,0.03))',
        border: '1px solid var(--border-subtle)',
        borderRadius: 3,
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>后端</span>
        <select
          disabled={disabled}
          value={backend}
          onChange={(e) => onChangeBackend(e.target.value as RoughBackend)}
          style={{ ...inputStyle, padding: '2px' }}
        >
          <option value="tripo">Tripo (multi-view)</option>
          <option value="trellis2">TRELLIS.2 (single-view)</option>
        </select>
      </div>

      {backend === 'trellis2' && (
        <>
          <div
            style={{
              marginTop: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={onToggleExpanded}
              style={{
                fontSize: 10,
                padding: '2px 6px',
                background: 'transparent',
                color: 'var(--accent-blue)',
                border: '1px solid var(--accent-blue)',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              {expanded ? '隐藏参数 ▲' : '展开参数 ▼'}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onWarmup}
              title="提前加载模型，避免首次推理慢启动"
              style={{
                fontSize: 10,
                padding: '2px 6px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              Warmup
            </button>
          </div>
          {expanded && (
            <>
              {numInput(
                'SS steps',
                trellis2Params.sparseStructureSteps,
                TRELLIS2_DEFAULTS.sparseStructureSteps,
                (n) => onChangeTrellis2Params({ ...trellis2Params, sparseStructureSteps: n }),
                1, 50, 1,
              )}
              {numInput(
                'SLat steps',
                trellis2Params.slatSteps,
                TRELLIS2_DEFAULTS.slatSteps,
                (n) => onChangeTrellis2Params({ ...trellis2Params, slatSteps: n }),
                1, 50, 1,
              )}
              {numInput(
                'CFG',
                trellis2Params.cfg,
                TRELLIS2_DEFAULTS.cfg,
                (n) => onChangeTrellis2Params({ ...trellis2Params, cfg: n }),
                0, 20, 0.1,
              )}
              {numInput(
                'Decim',
                trellis2Params.decimationTarget,
                TRELLIS2_DEFAULTS.decimationTarget,
                (n) => onChangeTrellis2Params({ ...trellis2Params, decimationTarget: n }),
                1000, 10_000_000, 10000,
              )}
              {numInput(
                'TexSize',
                trellis2Params.textureSize,
                TRELLIS2_DEFAULTS.textureSize,
                (n) => onChangeTrellis2Params({ ...trellis2Params, textureSize: n }),
                512, 4096, 256,
              )}
              <div style={rowStyle}>
                <span style={labelStyle}>Remesh</span>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={trellis2Params.remesh ?? TRELLIS2_DEFAULTS.remesh}
                  onChange={(e) =>
                    onChangeTrellis2Params({ ...trellis2Params, remesh: e.target.checked })
                  }
                />
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Seed</span>
                <input
                  type="number"
                  disabled={disabled}
                  placeholder="留空=随机"
                  value={trellis2Params.seed ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    onChangeTrellis2Params({
                      ...trellis2Params,
                      seed: v === '' ? undefined : Number(v),
                    });
                  }}
                  style={inputStyle}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
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
