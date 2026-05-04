/**
 * 工程管理服务（基于 File System Access API）
 *
 * 工程目录结构：
 *   <ProjectRoot>/
 *     project.json                 -- 工程元数据
 *     page1_concept_to_rough/
 *       01_concept/
 *         index.json               -- { history: [{file, timestamp, note}], latest }
 *         20260427_171530_123.png  -- 按时间戳命名的版本文件
 *       02_tpose/
 *       ...
 *     page2_highres/
 *     page3_assemble/
 *
 * 仅支持 Edge/Chrome 等基于 Chromium 的浏览器。
 */

export interface ProjectMeta {
  name: string;
  createdAt: string;     // ISO timestamp
  updatedAt: string;
  version: 1;
  /** 工程根目录的本地绝对路径（如 D:\AI\Prototypes\.../GirlOrangeJacket）。
   *  浏览器无法直接获取，需用户首次打开工程时人工提供，存盘后复用。 */
  absolutePath?: string;
  /**
   * Stage 1 (refactor master plan) — Page1 作为唯一关节生产者。
   * - splits: 4 视图切分元信息（指向 page1.multiview 节点下的 segment set）
   * - joints: DWPose 跑在 4 合 1 多视图上后，按视图切分到 split-local 坐标
   * 这两份数据让 Page3 完全脱离 Page2 的关节生产链。
   */
  page1?: {
    splits?: Page1SplitsMeta;
    joints?: Page1JointsMeta;
  };
}

export interface AssetVersion {
  file: string;          // 相对于节点目录的文件名
  timestamp: string;     // ISO 字符串
  note?: string;
}

export interface NodeIndex {
  history: AssetVersion[];   // 按时间倒序，[0] = 最新
}

import type { PipelineJointsMeta, SmartCropTransformMeta, SplitTransformMeta, Page1SplitsMeta, Page1JointsMeta } from '../types/joints';

// 节点目录命名（含序号便于在文件管理器中按顺序查看）
export interface NodeDir {
  pageDir: string;
  nodeDir: string;
}

/** 页面 → 节点的目录命名映射（与 UI 中的 NODES 顺序对齐） */
export const NODE_DIRS: Record<string, NodeDir> = {
  // Page 1
  'page1.concept':   { pageDir: 'page1_concept_to_rough', nodeDir: '01_concept' },
  'page1.tpose':     { pageDir: 'page1_concept_to_rough', nodeDir: '02_tpose' },
  'page1.multiview': { pageDir: 'page1_concept_to_rough', nodeDir: '03_multiview' },
  'page1.rough':     { pageDir: 'page1_concept_to_rough', nodeDir: '04_rough' },
  'page1.rigging':   { pageDir: 'page1_concept_to_rough', nodeDir: '05_rigging' },
  'page1.extraction': { pageDir: 'page1_concept_to_rough', nodeDir: '06_extraction' },
  // Page 2
  'page2.imageInput': { pageDir: 'page2_highres', nodeDir: '00_image_input' },
  'page2.extraction': { pageDir: 'page2_highres', nodeDir: '01_extraction' },
  'page2.modify':     { pageDir: 'page2_highres', nodeDir: '02_modify' },
  'page2.highres':   { pageDir: 'page2_highres', nodeDir: '02_highres' },
  // Page 3
  'page3.segpack':   { pageDir: 'page3_assemble', nodeDir: '01_segpack' },
};

/** File System Access API 类型补丁（TS lib 暂未完整覆盖） */
type FSDirHandle = FileSystemDirectoryHandle;
type FSFileHandle = FileSystemFileHandle;

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FSDirHandle>;
  }
}

/** 浏览器是否支持工程功能 */
export function isProjectSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ---------------------------------------------------------------------------
// IndexedDB — 持久化 FileSystemDirectoryHandle，实现"自动打开上次工程"
// ---------------------------------------------------------------------------

const IDB_NAME = 'concept-to-highres';
const IDB_VERSION = 1;
const IDB_STORE = 'handles';
const IDB_KEY = 'lastProject';

async function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 将当前打开的工程目录句柄持久化到 IndexedDB。
 * 下次页面加载时可通过 restoreLastProjectHandle() 恢复，无需用户再次导航目录。
 */
export async function persistLastProjectHandle(root: FSDirHandle): Promise<void> {
  const db = await openIdb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(root, IDB_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * 尝试从 IndexedDB 恢复上一次打开的工程目录句柄。
 * 恢复成功时会检查权限 —— 在 Chrome 中同一 origin 的句柄通常自动授予。
 * 返回 null 表示无历史句柄或权限被拒绝。
 */
export async function restoreLastProjectHandle(): Promise<FSDirHandle | null> {
  try {
    const db = await openIdb();
    const root: FSDirHandle | undefined = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();

    if (!root) return null;

    // 检查权限：已授权 → 直接用；需提示 → 尝试请求；拒绝 → 返回 null
    const qr = await (root as any).queryPermission?.({ mode: 'readwrite' });
    if (qr === 'granted') return root;
    if (qr === 'prompt') {
      const rr = await (root as any).requestPermission?.({ mode: 'readwrite' });
      if (rr === 'granted') return root;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 尝试从 IndexedDB 恢复上次工程。成功返回 ProjectHandle, 否则返回 null。
 * 同时清除可能已失效的句柄。
 */
export async function tryRestoreLastProject(): Promise<ProjectHandle | null> {
  const root = await restoreLastProjectHandle();
  if (!root) return null;

  try {
    const meta = await tryReadJson<ProjectMeta>(root, 'project.json');
    if (!meta) return null;
    return { root, meta };
  } catch {
    // 句柄失效，从 IndexedDB 中清除
    try {
      const db = await openIdb();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      db.close();
    } catch { /* ignore */ }
    return null;
  }
}

/** 清除 IndexedDB 中存储的上次工程句柄（用户主动关闭工程时调用） */
export async function clearLastProjectHandle(): Promise<void> {
  try {
    const db = await openIdb();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    db.close();
  } catch { /* ignore */ }
}

/** 生成时间戳文件名（精确到毫秒，避免重复） */
export function makeTimestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

// ---------------------------------------------------------------------------
// 目录 / 文件辅助
// ---------------------------------------------------------------------------

async function getOrCreateDir(parent: FSDirHandle, name: string): Promise<FSDirHandle> {
  return await parent.getDirectoryHandle(name, { create: true });
}

async function writeFile(dir: FSDirHandle, name: string, data: Blob | string): Promise<void> {
  const fh: FSFileHandle = await dir.getFileHandle(name, { create: true });
  // FileSystemWritableFileStream 也未在 TS lib 中暴露
  const w = await (fh as unknown as { createWritable: () => Promise<{
    write: (d: Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }>}).createWritable();
  await w.write(data);
  await w.close();
}

async function readFileBlob(dir: FSDirHandle, name: string): Promise<Blob> {
  const fh = await dir.getFileHandle(name);
  return await fh.getFile();
}

async function readFileText(dir: FSDirHandle, name: string): Promise<string> {
  const blob = await readFileBlob(dir, name);
  return await blob.text();
}

async function tryReadJson<T>(dir: FSDirHandle, name: string): Promise<T | null> {
  try {
    const txt = await readFileText(dir, name);
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 工程操作
// ---------------------------------------------------------------------------

export interface ProjectHandle {
  root: FSDirHandle;
  meta: ProjectMeta;
}

/**
 * 弹窗让用户选择/新建一个目录作为工程根。如目录下已有 project.json 则视为打开已有工程。
 */
export async function pickAndOpenOrCreateProject(defaultName?: string): Promise<ProjectHandle> {
  if (!isProjectSupported()) {
    throw new Error('当前浏览器不支持 File System Access API（请使用 Edge/Chrome）');
  }
  const root = await window.showDirectoryPicker!({ mode: 'readwrite' });
  let meta = await tryReadJson<ProjectMeta>(root, 'project.json');

  if (!meta) {
    meta = {
      name: defaultName ?? root.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    await writeFile(root, 'project.json', JSON.stringify(meta, null, 2));
  }

  // 持久化目录句柄，下次页面加载时自动恢复
  persistLastProjectHandle(root).catch(() => { /* 非关键路径 */ });

  return { root, meta };
}

/** 仅打开（要求目录中存在 project.json） */
export async function openExistingProject(): Promise<ProjectHandle> {
  if (!isProjectSupported()) {
    throw new Error('当前浏览器不支持 File System Access API（请使用 Edge/Chrome）');
  }
  const root = await window.showDirectoryPicker!({ mode: 'readwrite' });
  const meta = await tryReadJson<ProjectMeta>(root, 'project.json');
  if (!meta) {
    throw new Error('该目录不是工程目录（缺少 project.json）');
  }
  return { root, meta };
}

/** 更新工程 meta 的 updatedAt 字段并写回 */
export async function touchProject(handle: ProjectHandle): Promise<void> {
  handle.meta.updatedAt = new Date().toISOString();
  await writeFile(handle.root, 'project.json', JSON.stringify(handle.meta, null, 2));
}

/** 重命名工程 */
export async function renameProject(handle: ProjectHandle, newName: string): Promise<void> {
  handle.meta.name = newName;
  await touchProject(handle);
}

/** 设置/更新工程根目录的本地绝对路径（用户人工提供，便于"复制路径"功能） */
export async function setProjectAbsolutePath(
  handle: ProjectHandle,
  absolutePath: string,
): Promise<void> {
  // 标准化分隔符：保留用户原样（Windows 反斜杠 / POSIX 正斜杠均可）
  const trimmed = absolutePath.trim().replace(/[\\/]+$/, '');
  handle.meta.absolutePath = trimmed || undefined;
  await touchProject(handle);
}

// ---------------------------------------------------------------------------
// 节点资产读写
// ---------------------------------------------------------------------------

async function getNodeDir(
  handle: ProjectHandle,
  nodeKey: string,
  create: boolean
): Promise<FSDirHandle | null> {
  const dirs = NODE_DIRS[nodeKey];
  if (!dirs) throw new Error(`未注册的节点 key: ${nodeKey}`);
  try {
    const page = create
      ? await getOrCreateDir(handle.root, dirs.pageDir)
      : await handle.root.getDirectoryHandle(dirs.pageDir);
    const node = create
      ? await getOrCreateDir(page, dirs.nodeDir)
      : await page.getDirectoryHandle(dirs.nodeDir);
    return node;
  } catch {
    return null;
  }
}

async function loadIndex(nodeDir: FSDirHandle): Promise<NodeIndex> {
  const idx = await tryReadJson<NodeIndex>(nodeDir, 'index.json');
  return idx ?? { history: [] };
}

async function saveIndex(nodeDir: FSDirHandle, idx: NodeIndex): Promise<void> {
  await writeFile(nodeDir, 'index.json', JSON.stringify(idx, null, 2));
}

/**
 * 保存一个节点资产（图片/模型 blob），追加为最新版本。
 *
 * @param nodeKey 例如 "page1.tpose"
 * @param blob    要写入的二进制
 * @param ext     文件扩展名（不带点），如 "png" / "glb"
 * @param note    可选备注
 * @param prefix  可选文件名前缀（如 pipeline 名），生成 `<prefix>_<ts>.<ext>`
 * @returns 写入的版本信息
 */
export async function saveNodeAsset(
  handle: ProjectHandle,
  nodeKey: string,
  blob: Blob,
  ext: string,
  note?: string,
  prefix?: string,
): Promise<AssetVersion> {
  const nodeDir = await getNodeDir(handle, nodeKey, true);
  if (!nodeDir) throw new Error(`无法创建节点目录: ${nodeKey}`);

  const ts = makeTimestamp();
  const safePrefix = prefix ? `${prefix.replace(/[^A-Za-z0-9._-]/g, '_')}_` : '';
  const fileName = `${safePrefix}${ts}.${ext.replace(/^\./, '')}`;
  await writeFile(nodeDir, fileName, blob);

  const idx = await loadIndex(nodeDir);
  const ver: AssetVersion = { file: fileName, timestamp: new Date().toISOString(), note };
  idx.history.unshift(ver);
  await saveIndex(nodeDir, idx);

  // 顺手更新工程 updatedAt
  await touchProject(handle);
  return ver;
}

/** 读取某节点最新版本，返回 Blob；不存在返回 null */
export async function loadLatestNodeAsset(
  handle: ProjectHandle,
  nodeKey: string
): Promise<{ blob: Blob; version: AssetVersion } | null> {
  const nodeDir = await getNodeDir(handle, nodeKey, false);
  if (!nodeDir) return null;
  const idx = await loadIndex(nodeDir);
  const latest = idx.history[0];
  if (!latest) return null;
  try {
    const blob = await readFileBlob(nodeDir, latest.file);
    return { blob, version: latest };
  } catch {
    return null;
  }
}

/** 列出某节点的全部历史版本（[0] = 最新） */
export async function listNodeHistory(
  handle: ProjectHandle,
  nodeKey: string
): Promise<AssetVersion[]> {
  const nodeDir = await getNodeDir(handle, nodeKey, false);
  if (!nodeDir) return [];
  const idx = await loadIndex(nodeDir);
  return idx.history;
}

/** 按文件名读取某节点的指定历史版本 */
export async function loadNodeAssetByName(
  handle: ProjectHandle,
  nodeKey: string,
  fileName: string
): Promise<{ blob: Blob; version: AssetVersion } | null> {
  const nodeDir = await getNodeDir(handle, nodeKey, false);
  if (!nodeDir) return null;
  const idx = await loadIndex(nodeDir);
  const version = idx.history.find((v) => v.file === fileName);
  if (!version) return null;
  try {
    const blob = await readFileBlob(nodeDir, fileName);
    return { blob, version };
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// 子集 / 切分版本（例如 SAM3 输出的 multi-view 切片）
// ---------------------------------------------------------------------------

export interface SegmentSetEntry {
  /** 在子目录中的文件名 */
  file: string;
  /** 元信息透传（bbox / score / mask_value 等），无要求 */
  meta?: Record<string, unknown>;
}

export interface SegmentSetIndex {
  /** 来源原图相对节点目录的文件名（例如 "20260427_213238_894.png"） */
  source: string;
  /** 子目录创建时间 */
  createdAt: string;
  /** 版本号（v0001, v0002…），与目录后缀一致 */
  version: string;
  /** 各切片元信息 */
  entries: SegmentSetEntry[];
}

export interface SegmentSetHandle {
  /** 子目录名（含版本后缀），例如 "20260427_213238_894_v0001" */
  dirName: string;
  index: SegmentSetIndex;
}

/**
 * 在节点目录下创建一个新的「切分子目录」，命名格式为
 *   <baseName>_v0001 / _v0002 / ...
 * 自动找到下一个可用版本号。`baseName` 通常是来源图（如 multi-view）的文件名
 * 去掉扩展名。所有传入的 files 都会写入该子目录，并生成 segments.json 索引。
 *
 * 文件名 `name` 可包含 `{v}` 占位符，会被替换为本次的版本号字符串（如 "v0001"），
 * 例如传入 `front_{v}.png` 会生成 `front_v0001.png`。
 */
export async function saveSegmentSet(
  handle: ProjectHandle,
  nodeKey: string,
  baseName: string,
  source: string,
  files: { name: string; blob: Blob; meta?: Record<string, unknown> }[],
): Promise<SegmentSetHandle> {
  const nodeDir = await getNodeDir(handle, nodeKey, true);
  if (!nodeDir) throw new Error(`无法创建节点目录: ${nodeKey}`);

  // 找到下一个版本号
  const existing = new Set<string>();
  const dirIter = (nodeDir as unknown as {
    entries: () => AsyncIterable<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name] of dirIter) {
    existing.add(name);
  }
  let n = 1;
  let dirName = `${baseName}_v${String(n).padStart(4, '0')}`;
  while (existing.has(dirName)) {
    n += 1;
    dirName = `${baseName}_v${String(n).padStart(4, '0')}`;
  }
  const versionTag = `v${String(n).padStart(4, '0')}`;

  const subDir = await getOrCreateDir(nodeDir, dirName);

  const entries: SegmentSetEntry[] = [];
  for (const f of files) {
    const finalName = f.name.replace(/\{v\}/g, versionTag);
    await writeFile(subDir, finalName, f.blob);
    entries.push({ file: finalName, meta: f.meta });
  }

  const index: SegmentSetIndex = {
    source,
    createdAt: new Date().toISOString(),
    version: versionTag,
    entries,
  };
  await writeFile(subDir, 'segments.json', JSON.stringify(index, null, 2));
  await touchProject(handle);

  return { dirName, index };
}

/**
 * 读取节点目录下"最新"的切分子目录（按目录名末尾的 `_v####` 排序，号最大者优先）。
 * 可选 `baseName` 过滤：只匹配以 `<baseName>_v` 开头的子目录。
 */
export async function loadLatestSegmentSet(
  handle: ProjectHandle,
  nodeKey: string,
  baseName?: string,
): Promise<{
  dirName: string;
  index: SegmentSetIndex;
  files: Map<string, Blob>;
} | null> {
  const nodeDir = await getNodeDir(handle, nodeKey, false);
  if (!nodeDir) return null;

  const candidates: { name: string; n: number }[] = [];
  const iter = (nodeDir as unknown as {
    entries: () => AsyncIterable<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, fh] of iter) {
    if (fh.kind !== 'directory') continue;
    const m = name.match(/_v(\d{4,})$/);
    if (!m) continue;
    if (baseName && !name.startsWith(`${baseName}_v`)) continue;
    candidates.push({ name, n: parseInt(m[1], 10) });
  }
  if (candidates.length === 0) return null;
  // 排序优先级：先按完整目录名降序（时间戳前缀天然可排序），再按版本号降序兜底。
  // 之前只按 n 排序导致同 baseName 不同时间戳的多个 _v0001 子目录无法正确选最新。
  candidates.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? 1 : -1;
    return b.n - a.n;
  });
  const latest = candidates[0].name;
  const subDir = await nodeDir.getDirectoryHandle(latest);
  const idx = await tryReadJson<SegmentSetIndex>(subDir, 'segments.json');
  if (!idx) return null;

  const files = new Map<string, Blob>();
  for (const e of idx.entries) {
    try {
      files.set(e.file, await readFileBlob(subDir, e.file));
    } catch {
      // 跳过缺失的文件
    }
  }
  return { dirName: latest, index: idx, files };
}


// ---------------------------------------------------------------------------
// Page3 SegPack 持久化（Stage 7/3a）
// ---------------------------------------------------------------------------
//
// SAM3 多区域分割包（SegmentationPack）以前只是 Page3 运行时状态，
// 每次重进页面都需手动 load。这里复用 saveSegmentSet 的多文件子
// 目录机制，把 JSON + mask PNG 这一对存为一个版本，允许在重进
// 工程后自动恢复。
//
// 设计要点：
//   - 不序列化运行时结构体，只存原始 json + png，避免 schema 漂移。
//   - mask 文件名保留原名（例如 segmentation_mask.png / segformer_label_mask.png）
//     以便 parseSegmentationJson 后 maskName 字段能对上。
//   - source 记录为生成这份 SegPack 的参考图名（通常是正交渲染输出）。

/**
 * 保存一对 SegPack 文件。
 * - jsonBlob：segmentation.json 内容。
 * - maskBlob：mask png 内容。
 * - maskName：mask 文件原始名（必须与 jsonBlob 里的 mask_png 字段一致）。
 * - source：生成这份分割的参考图文件名（仅诊断用）。
 */
export async function savePage3SegPack(
  handle: ProjectHandle,
  jsonBlob: Blob,
  maskBlob: Blob,
  maskName: string,
  source: string,
): Promise<SegmentSetHandle> {
  const baseName = `segpack_${makeTimestamp()}`;
  return await saveSegmentSet(handle, 'page3.segpack', baseName, source, [
    { name: 'segmentation.json', blob: jsonBlob },
    { name: maskName, blob: maskBlob },
  ]);
}

/**
 * 读取工程内最新保存的 SegPack。返回 原始 json blob + mask blob + mask
 * 文件名，供调用方重走 parseSegmentationJson + URL.createObjectURL 流程。
 */
export async function loadLatestPage3SegPack(
  handle: ProjectHandle,
): Promise<{
  jsonBlob: Blob;
  maskBlob: Blob;
  maskName: string;
  source: string;
  dirName: string;
} | null> {
  const result = await loadLatestSegmentSet(handle, 'page3.segpack');
  if (!result) return null;
  const jsonBlob = result.files.get('segmentation.json');
  if (!jsonBlob) return null;
  // mask = entries 里除 segmentation.json 之外的唯一 entry
  const maskEntry = result.index.entries.find((e) => e.file !== 'segmentation.json');
  if (!maskEntry) return null;
  const maskBlob = result.files.get(maskEntry.file);
  if (!maskBlob) return null;
  return {
    jsonBlob,
    maskBlob,
    maskName: maskEntry.file,
    source: result.index.source,
    dirName: result.dirName,
  };
}


// ---------------------------------------------------------------------------
// Page2 Pipeline 配置持久化
// ---------------------------------------------------------------------------

/** 单条 Pipeline 的可持久化字段（存到 page2_highres/pipelines.json） */
export interface PersistedPipeline {
  /** Pipeline 稳定 ID（用于跨页面同步当前输出；旧工程可能缺失） */
  id?: string;
  /** Pipeline 名称（用户可编辑） */
  name: string;
  /** 源图片模式：'extraction' = General Extract（SAM3），'multiview' = Jacket Extract（Banana+RMBG） */
  mode: 'extraction' | 'multiview';
  /** 用户手动设置的 Image Input 文件名（工程内相对路径，null 表示自动加载） */
  imageFile?: string | null;
  /** 当前 Extraction 结果文件名（工程内相对路径，用于恢复显示） */
  resultFile?: string | null;
  /** 当前 Modify 结果文件名（工程内相对路径，用于恢复显示） */
  modifyFile?: string | null;
  /** 当前 3D Model GLB 文件名（工程内相对路径，用于恢复显示） */
  modelFile?: string | null;
  /** 3D Model 生成模式 */
  modelMode?: 'single' | 'frontBack' | 'fourView';
  /** SmartCrop transform metadata — captured during extraction for joints generation */
  smartCropMeta?: SmartCropTransformMeta;
  /** Split transform metadata — captured during extraction for joints generation */
  splitMeta?: SplitTransformMeta;
  /**
   * @deprecated Stage 3: Page2 不再生产关节。新工程一律读 `project.meta.page1.joints`。
   * 保留字段仅用于读取旧 project.json 的兼容回退（Page3 双源查询）。
   * 下一次 schema bump 时移除。
   */
  jointsMeta?: PipelineJointsMeta;
  /** Pre-crop masked blob 文件名（存于 page2.extraction_masked 节点，供 Smart Crop All 复用） */
  maskedFile?: string | null;
}

export interface Page2PipelinesIndex {
  /** 版本号（便于后续迁移） */
  version: 1;
  pipelines: PersistedPipeline[];
}

/**
 * 将 Page2 的 Pipeline 配置保存到工程目录。
 * 写入 page2_highres/pipelines.json，自动创建所需子目录。
 */
export async function savePipelines(
  handle: ProjectHandle,
  pipelines: PersistedPipeline[],
): Promise<void> {
  const pageDir = await getOrCreateDir(handle.root, 'page2_highres');
  const index: Page2PipelinesIndex = { version: 1, pipelines };
  await writeFile(pageDir, 'pipelines.json', JSON.stringify(index, null, 2));
  await touchProject(handle);
}

/**
 * 从工程目录加载 Page2 Pipeline 配置。
 * 若文件不存在或工程未打开，返回 null。
 */
export async function loadPipelines(
  handle: ProjectHandle,
): Promise<Page2PipelinesIndex | null> {
  try {
    const pageDir = await handle.root.getDirectoryHandle('page2_highres');
    const idx = await tryReadJson<Page2PipelinesIndex>(pageDir, 'pipelines.json');
    if (!idx) return null;
    // 非预期版本 / 格式不完整 → 视为无有效数据
    if (idx.version !== 1 || !Array.isArray(idx.pipelines)) return null;
    return idx;
  } catch {
    return null;
  }
}

/**
 * Find the pipeline joints for a given pipeline ID.
 * Returns undefined if the pipeline or its joints are not found.
 */
export async function getPipelineJoints(
  handle: ProjectHandle,
  pipelineId: string,
): Promise<PipelineJointsMeta | undefined> {
  const index = await loadPipelines(handle);
  if (!index) return undefined;
  const pipeline = index.pipelines.find((p) => p.id === pipelineId);
  return pipeline?.jointsMeta;
}

/**
 * Find the pipeline joints for the pipeline associated with a given
 * model file (GLB). Returns undefined if not found.
 */
export async function getPipelineJointsByModelFile(
  handle: ProjectHandle,
  modelFile: string,
): Promise<PipelineJointsMeta | undefined> {
  const index = await loadPipelines(handle);
  if (!index) return undefined;
  const pipeline = index.pipelines.find((p) => p.modelFile === modelFile);
  return pipeline?.jointsMeta;
}

// ---------------------------------------------------------------------------
// Page1 Splits / Joints (Stage 1: Page1 = sole joints producer)
// ---------------------------------------------------------------------------

/**
 * 写入 Page1 splits 元信息到 project.json.meta.page1.splits.
 * 工程未打开时静默跳过。
 */
export async function savePage1Splits(
  handle: ProjectHandle,
  splits: Page1SplitsMeta,
): Promise<void> {
  if (!handle.meta.page1) handle.meta.page1 = {};
  handle.meta.page1.splits = splits;
  await touchProject(handle);
}

/**
 * 写入 Page1 joints 元信息到 project.json.meta.page1.joints.
 */
export async function savePage1Joints(
  handle: ProjectHandle,
  joints: Page1JointsMeta,
): Promise<void> {
  if (!handle.meta.page1) handle.meta.page1 = {};
  handle.meta.page1.joints = joints;
  await touchProject(handle);
}

export function getPage1Splits(handle: ProjectHandle): Page1SplitsMeta | undefined {
  return handle.meta.page1?.splits;
}

export function getPage1Joints(handle: ProjectHandle): Page1JointsMeta | undefined {
  return handle.meta.page1?.joints;
}