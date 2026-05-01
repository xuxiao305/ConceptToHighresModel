import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  clearLastProjectHandle,
  isProjectSupported,
  listNodeHistory,
  loadLatestNodeAsset,
  loadLatestSegmentSet,
  loadNodeAssetByName,
  loadPipelines,
  pickAndOpenOrCreateProject,
  renameProject as renameProjectApi,
  saveNodeAsset,
  savePipelines,
  saveSegmentSet,
  setProjectAbsolutePath,
  tryRestoreLastProject,
  type AssetVersion,
  type Page2PipelinesIndex,
  type PersistedPipeline,
  type ProjectHandle,
  type SegmentSetHandle,
  type SegmentSetIndex,
} from '../services/projectStore';

interface ProjectContextValue {
  /** 当前打开的工程，未打开则为 null（节点仍可运行，只是不会自动持久化） */
  project: ProjectHandle | null;
  /** 浏览器是否支持工程功能 */
  supported: boolean;

  newOrOpenProject: () => Promise<ProjectHandle>;
  closeProject: () => void;
  /** 尝试重新打开上次工程（从 IndexedDB 恢复句柄） */
  tryReopenLast: () => Promise<ProjectHandle | null>;
  rename: (name: string) => Promise<void>;
  /** 保存工程根目录的本地绝对路径（用户人工提供） */
  setAbsolutePath: (path: string) => Promise<void>;

  /** 保存节点产物，工程未打开时静默跳过并返回 null */
  saveAsset: (
    nodeKey: string,
    blob: Blob,
    ext: string,
    note?: string,
    prefix?: string,
  ) => Promise<AssetVersion | null>;

  /** 读取节点最新产物（含 Blob 与 ObjectURL）；未打开 / 无数据返回 null */
  loadLatest: (
    nodeKey: string
  ) => Promise<{ blob: Blob; url: string; version: AssetVersion } | null>;

  /** 列出节点的历史版本（[0] = 最新）；未打开返回空数组 */
  listHistory: (nodeKey: string) => Promise<AssetVersion[]>;

  /** 按文件名加载节点的某个历史版本（含 Blob 与 ObjectURL） */
  loadByName: (
    nodeKey: string,
    fileName: string
  ) => Promise<{ blob: Blob; url: string; version: AssetVersion } | null>;

  /** 在节点目录下创建版本化子目录，写入若干文件（如 SAM3 切分输出） */
  saveSegments: (
    nodeKey: string,
    baseName: string,
    source: string,
    files: { name: string; blob: Blob; meta?: Record<string, unknown> }[],
  ) => Promise<SegmentSetHandle | null>;

  /** 读取节点最新一版切分子目录（按 _v#### 序号取最大者） */
  loadLatestSegments: (
    nodeKey: string,
    baseName?: string,
  ) => Promise<{ dirName: string; index: SegmentSetIndex; files: Map<string, Blob> } | null>;

  /** 保存 Page2 Pipeline 配置到工程目录 */
  savePipelines: (pipelines: PersistedPipeline[]) => Promise<void>;

  /** 从工程目录加载 Page2 Pipeline 配置，未打开/不存在返回 null */
  loadPipelines: () => Promise<Page2PipelinesIndex | null>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectHandle | null>(null);
  const supported = useMemo(() => isProjectSupported(), []);
  const restoreAttempted = useRef(false);

  // 页面加载时自动尝试恢复上次打开的工程（IndexedDB 持久化的目录句柄）
  useEffect(() => {
    if (!supported || restoreAttempted.current) return;
    restoreAttempted.current = true;

    tryRestoreLastProject().then((h) => {
      if (h) setProject(h);
    }).catch(() => { /* 静默 — 无历史句柄或权限不足 */ });
  }, [supported]);

  const newOrOpenProject = useCallback(async () => {
    const h = await pickAndOpenOrCreateProject();
    setProject(h);
    return h;
  }, []);

  const closeProject = useCallback(() => {
    clearLastProjectHandle().catch(() => {});
    setProject(null);
  }, []);

  const tryReopenLast = useCallback(async (): Promise<ProjectHandle | null> => {
    const h = await tryRestoreLastProject();
    if (h) setProject(h);
    return h;
  }, []);

  const rename = useCallback(
    async (name: string) => {
      if (!project) return;
      await renameProjectApi(project, name);
      // 触发 React 重渲染（meta 是 mutable，但要让消费者刷新）
      setProject({ ...project, meta: { ...project.meta } });
    },
    [project]
  );

  const setAbsolutePath = useCallback(
    async (path: string) => {
      if (!project) return;
      await setProjectAbsolutePath(project, path);
      setProject({ ...project, meta: { ...project.meta } });
    },
    [project]
  );

  const saveAsset = useCallback(
    async (nodeKey: string, blob: Blob, ext: string, note?: string, prefix?: string) => {
      if (!project) return null;
      return await saveNodeAsset(project, nodeKey, blob, ext, note, prefix);
    },
    [project]
  );

  const loadLatest = useCallback(
    async (nodeKey: string) => {
      if (!project) return null;
      const r = await loadLatestNodeAsset(project, nodeKey);
      if (!r) return null;
      const url = URL.createObjectURL(r.blob);
      return { blob: r.blob, url, version: r.version };
    },
    [project]
  );

  const listHistory = useCallback(
    async (nodeKey: string) => {
      if (!project) return [];
      return await listNodeHistory(project, nodeKey);
    },
    [project]
  );

  const loadByName = useCallback(
    async (nodeKey: string, fileName: string) => {
      if (!project) return null;
      const r = await loadNodeAssetByName(project, nodeKey, fileName);
      if (!r) return null;
      const url = URL.createObjectURL(r.blob);
      return { blob: r.blob, url, version: r.version };
    },
    [project]
  );

  const saveSegments = useCallback(
    async (
      nodeKey: string,
      baseName: string,
      source: string,
      files: { name: string; blob: Blob; meta?: Record<string, unknown> }[],
    ) => {
      if (!project) return null;
      return await saveSegmentSet(project, nodeKey, baseName, source, files);
    },
    [project],
  );

  const loadLatestSegments = useCallback(
    async (nodeKey: string, baseName?: string) => {
      if (!project) return null;
      return await loadLatestSegmentSet(project, nodeKey, baseName);
    },
    [project],
  );

  const savePipelinesCb = useCallback(
    async (pipelines: PersistedPipeline[]) => {
      if (!project) return;
      await savePipelines(project, pipelines);
    },
    [project],
  );

  const loadPipelinesCb = useCallback(async (): Promise<Page2PipelinesIndex | null> => {
    if (!project) return null;
    return await loadPipelines(project);
  }, [project]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      project,
      supported,
      newOrOpenProject,
      closeProject,
      tryReopenLast,
      rename,
      setAbsolutePath,
      saveAsset,
      loadLatest,
      listHistory,
      loadByName,
      saveSegments,
      loadLatestSegments,
      savePipelines: savePipelinesCb,
      loadPipelines: loadPipelinesCb,
    }),
    [project, supported, newOrOpenProject, closeProject, tryReopenLast, rename, setAbsolutePath, saveAsset, loadLatest, listHistory, loadByName, saveSegments, loadLatestSegments, savePipelinesCb, loadPipelinesCb]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject 必须在 <ProjectProvider> 内部使用');
  return ctx;
}
