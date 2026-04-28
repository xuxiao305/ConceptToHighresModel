import { useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import {
  DualViewport,
  MeshViewer,
  useLandmarkStore,
  loadGlbAsMesh,
  type Vec3,
  type Face3,
  type ViewMode,
} from '../../three';
import {
  alignSourceMeshByLandmarks,
  type AlignmentMode,
  type AlignmentResult,
  applyTransform,
} from '../../three/alignment';

interface Props {
  onStatusChange: (msg: string, status?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface MeshData {
  name: string;
  vertices: Vec3[];
  faces: Face3[];
}

type CenterViewMode = 'landmark' | 'result';
type ResultViewMode = 'overlay' | 'aligned' | 'target' | 'original';

interface ResultPreview {
  mode: AlignmentMode;
  originalVertices: Vec3[];
  alignedVertices: Vec3[];
  alignedSrcLandmarks: Vec3[];
  targetLandmarks: Vec3[];
  faces: Face3[];
  rmse: number;
  meanError: number;
  maxError: number;
  scale: number;
}

const DEMO_SOURCE: MeshData = {
  name: 'Demo Source',
  vertices: [
    [-0.6, 0.0, -0.3],
    [0.7, 0.0, -0.2],
    [0.6, 0.0, 0.5],
    [-0.5, 0.0, 0.4],
    [-0.4, 1.0, -0.25],
    [0.5, 1.1, -0.1],
    [0.45, 1.05, 0.45],
    [-0.35, 0.95, 0.35],
    [-0.1, 1.55, 0.0],
    [0.15, 1.75, 0.08],
  ],
  faces: [
    [0, 1, 2], [0, 2, 3],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
    [4, 8, 9], [5, 9, 8],
    [6, 9, 5], [7, 8, 4],
  ],
};

function makeDemoTarget(source: MeshData): MeshData {
  const angleY = Math.PI * 0.28;
  const c = Math.cos(angleY);
  const s = Math.sin(angleY);
  const scale = 1.1;
  const tx = 0.85;
  const ty = -0.05;
  const tz = 0.55;
  const matrix4x4 = [
    [scale * c, 0, scale * s, tx],
    [0, scale, 0, ty],
    [-scale * s, 0, scale * c, tz],
    [0, 0, 0, 1],
  ];

  return {
    name: 'Demo Target',
    vertices: source.vertices.map((v) => applyTransform(v, matrix4x4)),
    faces: source.faces,
  };
}

export function ModelAssemble({ onStatusChange }: Props) {
  const demoTarget = useMemo(() => makeDemoTarget(DEMO_SOURCE), []);

  const [srcMesh, setSrcMesh] = useState<MeshData>(DEMO_SOURCE);
  const [tarMesh, setTarMesh] = useState<MeshData>(demoTarget);
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const [landmarkSize, setLandmarkSize] = useState(0.01);
  const [alignmentMode, setAlignmentMode] = useState<AlignmentMode>('similarity');
  const [aligning, setAligning] = useState(false);
  const [alignResult, setAlignResult] = useState<AlignmentResult | null>(null);
  const [centerViewMode, setCenterViewMode] = useState<CenterViewMode>('landmark');
  const [resultViewMode, setResultViewMode] = useState<ResultViewMode>('overlay');
  const [resultPreview, setResultPreview] = useState<ResultPreview | null>(null);
  const [selectedSrcIndex, setSelectedSrcIndex] = useState<number | null>(null);
  const [selectedTarIndex, setSelectedTarIndex] = useState<number | null>(null);

  const srcInputRef = useRef<HTMLInputElement | null>(null);
  const tarInputRef = useRef<HTMLInputElement | null>(null);

  const srcLandmarks = useLandmarkStore((s) => s.srcLandmarks);
  const tarLandmarks = useLandmarkStore((s) => s.tarLandmarks);
  const addSrcLandmark = useLandmarkStore((s) => s.addSrcLandmark);
  const addTarLandmark = useLandmarkStore((s) => s.addTarLandmark);
  const updateSrcLandmark = useLandmarkStore((s) => s.updateSrcLandmark);
  const updateTarLandmark = useLandmarkStore((s) => s.updateTarLandmark);
  const removeSrcLandmark = useLandmarkStore((s) => s.removeSrcLandmark);
  const removeTarLandmark = useLandmarkStore((s) => s.removeTarLandmark);
  const clearSrcLandmarks = useLandmarkStore((s) => s.clearSrcLandmarks);
  const clearTarLandmarks = useLandmarkStore((s) => s.clearTarLandmarks);
  const clearAllLandmarks = useLandmarkStore((s) => s.clearAll);

  const pairCount = Math.min(srcLandmarks.length, tarLandmarks.length);
  const isBalanced = srcLandmarks.length === tarLandmarks.length && srcLandmarks.length > 0;
  const hasResultPreview = resultPreview !== null;

  const resetPreview = () => {
    if (alignResult) setAlignResult(null);
    if (resultPreview) setResultPreview(null);
    if (centerViewMode === 'result') setCenterViewMode('landmark');
  };

  const selectSourceLandmark = (index: number) => {
    setSelectedSrcIndex(index);
    setSelectedTarIndex(null);
  };

  const selectTargetLandmark = (index: number) => {
    setSelectedTarIndex(index);
    setSelectedSrcIndex(null);
  };

  const loadMeshFromFile = async (file: File, side: 'source' | 'target') => {
    const url = URL.createObjectURL(file);
    try {
      onStatusChange(`正在加载 ${side === 'source' ? 'Source' : 'Target'} GLB：${file.name}`, 'info');
      const loaded = await loadGlbAsMesh(url);
      const mesh: MeshData = {
        name: file.name,
        vertices: loaded.vertices,
        faces: loaded.faces,
      };
      if (side === 'source') {
        setSrcMesh(mesh);
        setSelectedSrcIndex(null);
      } else {
        setTarMesh(mesh);
        setSelectedTarIndex(null);
      }
      clearAllLandmarks();
      resetPreview();
      onStatusChange(`${side === 'source' ? 'Source' : 'Target'} 已加载，landmark 已清空`, 'success');
    } catch (err) {
      onStatusChange(`加载失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const onSrcFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadMeshFromFile(file, 'source');
    e.currentTarget.value = '';
  };

  const onTarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadMeshFromFile(file, 'target');
    e.currentTarget.value = '';
  };

  const handleSrcClick = (
    idx: number,
    pos: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => {
    if (!modifiers.ctrlKey) return;
    const nextIndex = (srcLandmarks[srcLandmarks.length - 1]?.index ?? 0) + 1;
    addSrcLandmark(idx, pos);
    selectSourceLandmark(nextIndex);
    resetPreview();
    onStatusChange(`Source Landmark #${nextIndex} 已添加 (Ctrl+Click)`, 'info');
  };

  const handleTarClick = (
    idx: number,
    pos: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => {
    if (!modifiers.ctrlKey) return;
    const nextIndex = (tarLandmarks[tarLandmarks.length - 1]?.index ?? 0) + 1;
    addTarLandmark(idx, pos);
    selectTargetLandmark(nextIndex);
    resetPreview();
    onStatusChange(`Target Landmark #${nextIndex} 已添加 (Ctrl+Click)`, 'info');
  };

  const handleDeleteSrcLandmark = (index: number) => {
    removeSrcLandmark(index);
    if (selectedSrcIndex === index) setSelectedSrcIndex(null);
    resetPreview();
    onStatusChange(`已删除 Source Landmark #${index}`, 'warning');
  };

  const handleDeleteTarLandmark = (index: number) => {
    removeTarLandmark(index);
    if (selectedTarIndex === index) setSelectedTarIndex(null);
    resetPreview();
    onStatusChange(`已删除 Target Landmark #${index}`, 'warning');
  };

  const handleMoveSrcLandmark = (index: number, position: Vec3) => {
    updateSrcLandmark(index, position, -1);
    selectSourceLandmark(index);
    resetPreview();
  };

  const handleMoveTarLandmark = (index: number, position: Vec3) => {
    updateTarLandmark(index, position, -1);
    selectTargetLandmark(index);
    resetPreview();
  };

  const handleRunAlign = () => {
    if (!isBalanced) {
      onStatusChange('Source/Target landmark 数量不一致，无法对齐', 'error');
      return;
    }
    if (pairCount < 3) {
      onStatusChange('至少需要 3 对 landmark 才能执行刚体/相似对齐', 'error');
      return;
    }

    setAligning(true);
    try {
      const result = alignSourceMeshByLandmarks(
        srcMesh.vertices,
        srcLandmarks.map((p) => p.position),
        tarLandmarks.map((p) => p.position),
        alignmentMode,
      );
      setAlignResult(result);
      setResultPreview({
        mode: result.mode,
        originalVertices: srcMesh.vertices,
        alignedVertices: result.transformedVertices,
        alignedSrcLandmarks: result.alignedSrcLandmarks,
        targetLandmarks: result.targetLandmarks,
        faces: srcMesh.faces,
        rmse: result.rmse,
        meanError: result.meanError,
        maxError: result.maxError,
        scale: result.scale,
      });
      setCenterViewMode('result');
      setResultViewMode('overlay');
      onStatusChange(
        `${alignmentMode === 'rigid' ? 'Rigid' : 'Similarity'} 对齐完成，RMSE=${result.rmse.toFixed(4)}`,
        'success',
      );
    } catch (err) {
      onStatusChange(`对齐失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
    } finally {
      setAligning(false);
    }
  };

  const handleApplyAlignedTransform = () => {
    if (!alignResult) return;
    
    const newVertices = srcMesh.vertices.map((v) => applyTransform(v, alignResult.matrix4x4));
    setSrcMesh((prev) => ({
      ...prev,
      vertices: newVertices,
    }));
    
    // 手动变换每一个 landmark
    srcLandmarks.forEach((landmark) => {
      const newPos = applyTransform(landmark.position, alignResult.matrix4x4);
      updateSrcLandmark(landmark.index, newPos);
    });
    
    setAlignResult(null);
    setSelectedSrcIndex(null);
    setCenterViewMode('landmark');
    onStatusChange('已将对齐结果应用到 Source 模型与 Source landmarks', 'success');
  };

  const restoreDemo = () => {
    setSrcMesh(DEMO_SOURCE);
    setTarMesh(demoTarget);
    clearAllLandmarks();
    setAlignResult(null);
    setSelectedSrcIndex(null);
    setSelectedTarIndex(null);
    onStatusChange('已恢复 Demo Source/Target', 'info');
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '230px 1fr 320px',
        overflow: 'hidden',
        background: 'var(--bg-app)',
      }}
    >
      <aside
        style={{
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          padding: 10,
          gap: 10,
        }}
      >
        <PanelSection title="模型输入">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Button size="sm" onClick={() => srcInputRef.current?.click()}>导入 Source GLB</Button>
            <Button size="sm" onClick={() => tarInputRef.current?.click()}>导入 Target GLB</Button>
            <Button size="sm" onClick={restoreDemo}>恢复 Demo</Button>
          </div>
          <input ref={srcInputRef} type="file" accept=".glb" style={{ display: 'none' }} onChange={onSrcFileChange} />
          <input ref={tarInputRef} type="file" accept=".glb" style={{ display: 'none' }} onChange={onTarFileChange} />
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Source: {srcMesh.name}
            <br />
            V/F: {srcMesh.vertices.length} / {srcMesh.faces.length}
            <br />
            Target: {tarMesh.name}
            <br />
            V/F: {tarMesh.vertices.length} / {tarMesh.faces.length}
          </div>
        </PanelSection>

        <PanelSection title="对齐模式">
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant={alignmentMode === 'similarity' ? 'primary' : 'secondary'}
              onClick={() => setAlignmentMode('similarity')}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              Similarity
            </Button>
            <Button
              size="sm"
              variant={alignmentMode === 'rigid' ? 'primary' : 'secondary'}
              onClick={() => setAlignmentMode('rigid')}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              Rigid
            </Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {alignmentMode === 'similarity'
              ? 'Similarity: 旋转 + 平移 + 统一缩放'
              : 'Rigid: 仅旋转 + 平移'}
          </div>
        </PanelSection>

        <PanelSection title="Landmark 显示">
          <input
            type="range"
            min={0.005}
            max={0.05}
            step={0.001}
            value={landmarkSize}
            onChange={(e) => setLandmarkSize(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
            Marker Size: {(landmarkSize * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
            Ctrl+左键点击网格添加点。左键拖拽 marker 可移动，右键 marker 可删除。
          </div>
        </PanelSection>
      </aside>

      <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          <Button
            size="sm"
            variant={centerViewMode === 'landmark' ? 'primary' : 'secondary'}
            onClick={() => setCenterViewMode('landmark')}
          >
            对点视图
          </Button>
          <Button
            size="sm"
            variant={centerViewMode === 'result' ? 'primary' : 'secondary'}
            onClick={() => hasResultPreview && setCenterViewMode('result')}
            disabled={!hasResultPreview}
            title="显示对齐后的重叠预览"
          >
            重叠预览
          </Button>
          <Button size="sm" variant={viewMode === 'solid' ? 'primary' : 'secondary'} onClick={() => setViewMode('solid')}>实体</Button>
          <Button size="sm" variant={viewMode === 'wireframe' ? 'primary' : 'secondary'} onClick={() => setViewMode('wireframe')}>线框</Button>
          <Button size="sm" variant={viewMode === 'solid+wireframe' ? 'primary' : 'secondary'} onClick={() => setViewMode('solid+wireframe')}>实体+线框</Button>
          <span style={{ flex: 1 }} />
          <span>Pairs: {pairCount}</span>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {centerViewMode === 'landmark' && (
            <DualViewport
              srcVertices={srcMesh.vertices}
              srcFaces={srcMesh.faces}
              tarVertices={tarMesh.vertices}
              tarFaces={tarMesh.faces}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              srcLandmarks={srcLandmarks}
              tarLandmarks={tarLandmarks}
              onSrcClick={handleSrcClick}
              onTarClick={handleTarClick}
              selectedSrcLandmarkIndex={selectedSrcIndex}
              selectedTarLandmarkIndex={selectedTarIndex}
              onSelectSrcLandmark={selectSourceLandmark}
              onSelectTarLandmark={selectTargetLandmark}
              onDeleteSrcLandmark={handleDeleteSrcLandmark}
              onDeleteTarLandmark={handleDeleteTarLandmark}
              onMoveSrcLandmark={handleMoveSrcLandmark}
              onMoveTarLandmark={handleMoveTarLandmark}
              height="100%"
              landmarkScreenFraction={landmarkSize}
              srcUpdatedVertices={alignResult?.transformedVertices}
              srcLabel="Source"
              tarLabel="Target"
              showCameraSync
            />
          )}
          {centerViewMode === 'result' && resultPreview && (
            <ResultPreviewPanel
              resultViewMode={resultViewMode}
              onResultViewModeChange={setResultViewMode}
              resultPreview={resultPreview}
              targetMesh={tarMesh}
            />
          )}
        </div>
      </main>

      <aside
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}
      >
        <PanelSection title="Landmark Pairs">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Source 与 Target 按添加顺序一一配对。按住 Ctrl 在对应网格上左键点击可新增。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <LandmarkList
              title={`Source (${srcLandmarks.length})`}
              items={srcLandmarks}
              color="var(--state-busy)"
              selectedIndex={selectedSrcIndex}
              onSelect={selectSourceLandmark}
              onRemove={handleDeleteSrcLandmark}
            />
            <LandmarkList
              title={`Target (${tarLandmarks.length})`}
              items={tarLandmarks}
              color="var(--accent-blue)"
              selectedIndex={selectedTarIndex}
              onSelect={selectTargetLandmark}
              onRemove={handleDeleteTarLandmark}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                clearSrcLandmarks();
                setSelectedSrcIndex(null);
                resetPreview();
                onStatusChange('已清空 Source landmarks', 'warning');
              }}
              style={{ justifyContent: 'center' }}
            >
              清空 Source
            </Button>
            <Button
              size="sm"
              onClick={() => {
                clearTarLandmarks();
                setSelectedTarIndex(null);
                resetPreview();
                onStatusChange('已清空 Target landmarks', 'warning');
              }}
              style={{ justifyContent: 'center' }}
            >
              清空 Target
            </Button>
          </div>
        </PanelSection>

        <PanelSection title="Align Tools">
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            模式: {alignmentMode === 'similarity' ? 'Similarity' : 'Rigid'}
            <br />
            规则: 3 对以上 landmarks，按顺序配对
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <Button
              variant="primary"
              size="sm"
              loading={aligning}
              onClick={handleRunAlign}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              执行对齐
            </Button>
            <Button
              size="sm"
              onClick={handleApplyAlignedTransform}
              disabled={!alignResult}
              style={{ flex: 1, justifyContent: 'center' }}
              title="将当前对齐结果真正写回 Source 网格与 Source landmarks"
            >
              应用变换
            </Button>
          </div>

          {alignResult && (
            <div
              style={{
                marginTop: 10,
                padding: 8,
                borderRadius: 3,
                border: '1px solid var(--state-complete)',
                background: 'var(--bg-app)',
                fontSize: 11,
                color: 'var(--text-primary)',
                lineHeight: 1.6,
              }}
            >
              <div style={{ color: 'var(--accent-green)' }}>
                ✓ {alignResult.mode === 'rigid' ? 'Rigid' : 'Similarity'} Alignment Ready
              </div>
              <div>RMSE: {alignResult.rmse.toFixed(5)}</div>
              <div>Mean: {alignResult.meanError.toFixed(5)}</div>
              <div>Max: {alignResult.maxError.toFixed(5)}</div>
              {alignResult.mode === 'similarity' && <div>Scale: {alignResult.scale.toFixed(5)}</div>}
            </div>
          )}
        </PanelSection>

        {resultPreview && (
          <PanelSection title="Result View">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <Button
                size="sm"
                variant={resultViewMode === 'overlay' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('overlay');
                }}
                style={{ justifyContent: 'center' }}
              >
                Overlay
              </Button>
              <Button
                size="sm"
                variant={resultViewMode === 'aligned' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('aligned');
                }}
                style={{ justifyContent: 'center' }}
              >
                Aligned
              </Button>
              <Button
                size="sm"
                variant={resultViewMode === 'target' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('target');
                }}
                style={{ justifyContent: 'center' }}
              >
                Target
              </Button>
              <Button
                size="sm"
                variant={resultViewMode === 'original' ? 'primary' : 'secondary'}
                onClick={() => {
                  setCenterViewMode('result');
                  setResultViewMode('original');
                }}
                style={{ justifyContent: 'center' }}
              >
                Original
              </Button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Overlay 会把对齐后的 Source 与 Target 放进同一个坐标系和同一个 grid 里，适合检查复杂模型是否真的重合。
            </div>
          </PanelSection>
        )}
      </aside>
    </div>
  );
}

function ResultPreviewPanel({
  resultViewMode,
  onResultViewModeChange,
  resultPreview,
  targetMesh,
}: {
  resultViewMode: ResultViewMode;
  onResultViewModeChange: (mode: ResultViewMode) => void;
  resultPreview: ResultPreview;
  targetMesh: MeshData;
}) {
  // Convert Vec3[] to LandmarkPoint[] for display
  const srcLandmarkPoints = resultPreview.alignedSrcLandmarks.map((pos, i) => ({
    index: i + 1,
    vertexIdx: -1,
    position: pos,
  }));

  const tarLandmarkPoints = resultPreview.targetLandmarks.map((pos, i) => ({
    index: i + 1,
    vertexIdx: -1,
    position: pos,
  }));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
          Alignment Result
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={resultViewMode === 'overlay' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('overlay')}>Overlay</Button>
          <Button size="sm" variant={resultViewMode === 'aligned' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('aligned')}>Aligned</Button>
          <Button size="sm" variant={resultViewMode === 'target' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('target')}>Target</Button>
          <Button size="sm" variant={resultViewMode === 'original' ? 'primary' : 'secondary'} onClick={() => onResultViewModeChange('original')}>Original</Button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {resultViewMode === 'overlay' && (
          <MeshViewer
            role="result"
            vertices={resultPreview.alignedVertices}
            faces={resultPreview.faces}
            color="#4a90d9"
            viewMode="solid"
            height="100%"
            label="Overlay: Aligned Source (蓝色点) + Target (橙色点)"
            landmarks={srcLandmarkPoints}
            landmarkColor="#ff6b6b"
            overlayVertices={targetMesh.vertices}
            overlayFaces={targetMesh.faces}
            overlayColor="#d9734a"
            overlayLandmarks={tarLandmarkPoints}
            showViewModeToggle={false}
          />
        )}
        {resultViewMode === 'aligned' && (
          <MeshViewer
            role="result"
            vertices={resultPreview.alignedVertices}
            faces={resultPreview.faces}
            color="#4a90d9"
            viewMode="solid"
            height="100%"
            label="Aligned Source (with src landmarks)"
            landmarks={srcLandmarkPoints}
            landmarkColor="#ff6b6b"
            showViewModeToggle={false}
          />
        )}
        {resultViewMode === 'target' && (
          <MeshViewer
            role="target"
            vertices={targetMesh.vertices}
            faces={targetMesh.faces}
            color="#d9734a"
            viewMode="solid"
            height="100%"
            label="Target (with tar landmarks)"
            landmarks={tarLandmarkPoints}
            landmarkColor="#a0d995"
            showViewModeToggle={false}
          />
        )}
        {resultViewMode === 'original' && (
          <MeshViewer
            role="source"
            vertices={resultPreview.originalVertices}
            faces={resultPreview.faces}
            color="#4a90d9"
            viewMode="solid"
            height="100%"
            label="Original Source"
            showViewModeToggle={false}
          />
        )}
      </div>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border-default)', padding: 10 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function LandmarkList({
  title,
  items,
  color,
  selectedIndex,
  onSelect,
  onRemove,
}: {
  title: string;
  items: { index: number }[];
  color: string;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 4 }}>{title}</div>
      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 3,
          background: 'var(--bg-app)',
          maxHeight: 220,
          overflow: 'auto',
        }}
      >
        {items.length === 0 && (
          <div style={{ padding: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>—</div>
        )}
        {items.map((p) => (
          <div
            key={p.index}
            onClick={() => onSelect(p.index)}
            style={{
              display: 'flex',
              alignItems: 'center',
              borderBottom: '1px solid var(--border-subtle)',
              padding: '4px 6px',
              fontSize: 11,
              cursor: 'pointer',
              background: selectedIndex === p.index ? 'var(--bg-surface-2)' : 'transparent',
              boxShadow: selectedIndex === p.index ? `inset 2px 0 0 ${color}` : 'none',
            }}
          >
            <span style={{ flex: 1, color: selectedIndex === p.index ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              #{p.index}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.index);
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: 2,
              }}
              title="删除"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
