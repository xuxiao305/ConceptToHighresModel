import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  isProjectSupported,
  listNodeHistory,
  loadLatestNodeAsset,
  loadNodeAssetByName,
  pickAndOpenOrCreateProject,
  renameProject as renameProjectApi,
  saveNodeAsset,
  type AssetVersion,
  type ProjectHandle,
} from '../services/projectStore';

interface ProjectContextValue {
  /** 当前打开的工程，未打开则为 null（节点仍可运行，只是不会自动持久化） */
  project: ProjectHandle | null;
  /** 浏览器是否支持工程功能 */
  supported: boolean;

  newOrOpenProject: () => Promise<ProjectHandle>;
  closeProject: () => void;
  rename: (name: string) => Promise<void>;

  /** 保存节点产物，工程未打开时静默跳过并返回 null */
  saveAsset: (
    nodeKey: string,
    blob: Blob,
    ext: string,
    note?: string
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
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectHandle | null>(null);
  const supported = useMemo(() => isProjectSupported(), []);

  const newOrOpenProject = useCallback(async () => {
    const h = await pickAndOpenOrCreateProject();
    setProject(h);
    return h;
  }, []);

  const closeProject = useCallback(() => setProject(null), []);

  const rename = useCallback(
    async (name: string) => {
      if (!project) return;
      await renameProjectApi(project, name);
      // 触发 React 重渲染（meta 是 mutable，但要让消费者刷新）
      setProject({ ...project, meta: { ...project.meta } });
    },
    [project]
  );

  const saveAsset = useCallback(
    async (nodeKey: string, blob: Blob, ext: string, note?: string) => {
      if (!project) return null;
      return await saveNodeAsset(project, nodeKey, blob, ext, note);
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

  const value = useMemo<ProjectContextValue>(
    () => ({
      project,
      supported,
      newOrOpenProject,
      closeProject,
      rename,
      saveAsset,
      loadLatest,
      listHistory,
      loadByName,
    }),
    [project, supported, newOrOpenProject, closeProject, rename, saveAsset, loadLatest, listHistory, loadByName]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject 必须在 <ProjectProvider> 内部使用');
  return ctx;
}
