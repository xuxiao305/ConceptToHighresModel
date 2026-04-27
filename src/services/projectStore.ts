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
}

export interface AssetVersion {
  file: string;          // 相对于节点目录的文件名
  timestamp: string;     // ISO 字符串
  note?: string;
}

export interface NodeIndex {
  history: AssetVersion[];   // 按时间倒序，[0] = 最新
}

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
  // Page 2 / 3 占位（后续节点接入时按需追加）
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
 * @returns 写入的版本信息
 */
export async function saveNodeAsset(
  handle: ProjectHandle,
  nodeKey: string,
  blob: Blob,
  ext: string,
  note?: string
): Promise<AssetVersion> {
  const nodeDir = await getNodeDir(handle, nodeKey, true);
  if (!nodeDir) throw new Error(`无法创建节点目录: ${nodeKey}`);

  const ts = makeTimestamp();
  const fileName = `${ts}.${ext.replace(/^\./, '')}`;
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
  candidates.sort((a, b) => b.n - a.n);
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



