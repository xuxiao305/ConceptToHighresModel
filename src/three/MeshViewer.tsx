/**
 * MeshViewer — single 3D viewport for rendering a mesh from
 * vertices/faces, with optional landmarks, wireframe modes, dynamic
 * vertex updates (for streaming Fast_RNRR results in the future), and
 * camera-sync support.
 *
 * Adapted from D:/AI/Prototypes/WrapDeformation/frontend/src/components/MeshViewer.tsx
 *
 * Key contracts preserved verbatim so future Fast_RNRR integration is plug-in:
 *   - `vertices: Vec3[]` + `faces: Face3[]` data shape
 *   - `updatedVertices` channel for streaming per-step deformation
 *   - `role` slot reserved for 'result' (Fast_RNRR output)
 *   - `cameraSyncId` for cross-viewport camera sync
 *
 * UI controls (fit-to-screen button, view-mode toggle) use plain DOM
 * buttons — no antd dependency required.
 */

import {
  useRef,
  useMemo,
  useEffect,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec3, Face3, ViewMode, MeshRole } from './types';
import type { LandmarkPoint } from './landmarkStore';
import { LandmarkMarker } from './LandmarkMarker';
import { useCameraSyncStore } from './cameraSyncStore';

// ── Drag detection: distinguish click from drag ──
const DRAG_THRESHOLD_PX = 5;

// ---------------------------------------------------------------------------
// Internal mesh component
// ---------------------------------------------------------------------------

interface MeshObjectProps {
  vertices: Vec3[];
  faces: Face3[];
  color: string;
  viewMode: ViewMode;
  /** When true, attempts to swap in `updatedVertices` each frame (no realloc). */
  dynamic?: boolean;
  updatedVertices?: Vec3[];
  onMeshClick?: (
    vertexIdx: number,
    position: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => void;
  /** Expose the BufferGeometry so LandmarkMarker can do occlusion tests. */
  onGeometryReady?: (geo: THREE.BufferGeometry) => void;
}

function MeshObject({
  vertices,
  faces,
  color,
  viewMode,
  dynamic,
  updatedVertices,
  onMeshClick,
  onGeometryReady,
}: MeshObjectProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const shouldHandlePick = useRef(false);
  const downModifiers = useRef({ ctrlKey: false, shiftKey: false, altKey: false });
  const downIntersection = useRef<{
    face: { a: number; b: number; c: number };
    point: THREE.Vector3;
  } | null>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i++) {
      positions[i * 3] = vertices[i][0];
      positions[i * 3 + 1] = vertices[i][1];
      positions[i * 3 + 2] = vertices[i][2];
    }
    const indices = new Uint32Array(faces.length * 3);
    for (let i = 0; i < faces.length; i++) {
      indices[i * 3] = faces[i][0];
      indices[i * 3 + 1] = faces[i][1];
      indices[i * 3 + 2] = faces[i][2];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [vertices, faces]);

  useEffect(() => {
    if (onGeometryReady) onGeometryReady(geometry);
  }, [geometry, onGeometryReady]);

  // Streaming vertex update — used by Fast_RNRR step messages later
  useFrame(() => {
    if (!dynamic || !updatedVertices || !meshRef.current) return;
    const posAttr = meshRef.current.geometry.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const n = Math.min(updatedVertices.length, arr.length / 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = updatedVertices[i][0];
      arr[i * 3 + 1] = updatedVertices[i][1];
      arr[i * 3 + 2] = updatedVertices[i][2];
    }
    posAttr.needsUpdate = true;
    meshRef.current.geometry.computeVertexNormals();
    meshRef.current.geometry.computeBoundingSphere();
  });

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    downPos.current = { x: e.clientX, y: e.clientY };
    downModifiers.current = {
      ctrlKey: Boolean(e.ctrlKey),
      shiftKey: Boolean(e.shiftKey),
      altKey: Boolean(e.altKey),
    };
    shouldHandlePick.current = Boolean(onMeshClick && e.button === 0 && e.ctrlKey);
    if (shouldHandlePick.current) {
      // Prevent OrbitControls from consuming the click and causing a tiny camera twitch.
      e.stopPropagation();
    }
    const intersection = e.intersections?.[0];
    if (intersection && intersection.face) {
      downIntersection.current = {
        face: { a: intersection.face.a, b: intersection.face.b, c: intersection.face.c },
        point: intersection.point.clone(),
      };
    } else {
      downIntersection.current = null;
    }
  }, [onMeshClick]);

  const handlePointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!onMeshClick || !meshRef.current) return;
      if (!shouldHandlePick.current) return;
      if (!downPos.current) return;
      const dx = e.clientX - downPos.current.x;
      const dy = e.clientY - downPos.current.y;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      const stored = downIntersection.current;
      if (!stored) return;
      e.stopPropagation();
      const { face, point } = stored;
      const geo = meshRef.current.geometry;
      const posAttr = geo.attributes.position as THREE.BufferAttribute;
      const localPoint = meshRef.current.worldToLocal(point.clone());
      const vA = new THREE.Vector3().fromBufferAttribute(posAttr, face.a);
      const vB = new THREE.Vector3().fromBufferAttribute(posAttr, face.b);
      const vC = new THREE.Vector3().fromBufferAttribute(posAttr, face.c);
      const dists = [vA, vB, vC].map((v) => v.distanceTo(localPoint));
      const minIdx = dists.indexOf(Math.min(...dists));
      const vertexIdx = [face.a, face.b, face.c][minIdx];
      const hitPos: Vec3 = [localPoint.x, localPoint.y, localPoint.z];
      onMeshClick(vertexIdx, hitPos, downModifiers.current);
      downIntersection.current = null;
      downPos.current = null;
      shouldHandlePick.current = false;
    },
    [onMeshClick],
  );

  const showSolid = viewMode === 'solid' || viewMode === 'solid+wireframe';
  const showWireframe = viewMode === 'wireframe' || viewMode === 'solid+wireframe';

  return (
    <group>
      {showSolid && (
        <mesh
          ref={meshRef}
          geometry={geometry}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial
            color={color}
            side={THREE.DoubleSide}
            transparent={viewMode === 'solid+wireframe'}
            opacity={viewMode === 'solid+wireframe' ? 0.7 : 1}
            roughness={0.5}
            metalness={0.1}
          />
        </mesh>
      )}
      {showWireframe && (
        <mesh geometry={geometry}>
          <meshBasicMaterial color={showSolid ? '#333' : color} wireframe />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Region-grow highlight points
// ---------------------------------------------------------------------------

function HighlightPoints({
  vertices,
  indices,
  color,
  size = 6,
  opacity = 0.85,
}: {
  vertices: Vec3[];
  indices: number[];
  color: string;
  size?: number;
  opacity?: number;
}) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const v = vertices[indices[i]];
      if (!v) continue;
      positions[i * 3] = v[0];
      positions[i * 3 + 1] = v[1];
      positions[i * 3 + 2] = v[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, [vertices, indices]);

  return (
    <points geometry={geometry}>
      <pointsMaterial
        color={color}
        size={size}
        sizeAttenuation={false}
        depthTest={false}
        transparent
        opacity={opacity}
      />
    </points>
  );
}

// ---------------------------------------------------------------------------
// Auto-fit camera + sync
// ---------------------------------------------------------------------------

function AutoFitCamera({
  vertices,
  syncId,
  fitKey,
  groundOffsetY = 0,
}: {
  vertices: Vec3[];
  syncId?: string;
  fitKey?: number;
  /** Y offset applied to the rendered content (lift to ground). Camera target shifts by the same amount. */
  groundOffsetY?: number;
}) {
  const controlsRef = useRef<any>(null);
  const isUpdatingFromSync = useRef(false);
  const prevSyncState = useRef<string>('');

  useEffect(() => {
    if (!controlsRef.current || vertices.length === 0) return;
    const box = new THREE.Box3();
    for (const v of vertices) box.expandByPoint(new THREE.Vector3(v[0], v[1], v[2]));
    const center = box.getCenter(new THREE.Vector3());
    center.y += groundOffsetY; // shift target so the lifted model is centered in view
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    const cam = controlsRef.current.object as THREE.PerspectiveCamera;
    const fovRad = (cam.fov ?? 50) * (Math.PI / 180);
    const distance = (radius / Math.sin(fovRad / 2)) * 1.1;
    controlsRef.current.target.copy(center);
    cam.position.set(center.x, center.y, center.z + distance);
    cam.up.set(0, 1, 0);
    cam.near = Math.max(0.001, radius / 100);
    cam.far = radius * 100;
    cam.updateProjectionMatrix();
    controlsRef.current.update();
  }, [vertices, fitKey, groundOffsetY]);

  useFrame(() => {
    if (!syncId || !controlsRef.current) return;
    const store = useCameraSyncStore.getState();
    if (!store.syncEnabled || !store.cameraState) return;
    if (store.lastUpdater === syncId) return;
    const serialized = JSON.stringify(store.cameraState);
    if (serialized === prevSyncState.current) return;
    prevSyncState.current = serialized;
    isUpdatingFromSync.current = true;
    const [px, py, pz] = store.cameraState.position;
    const [tx, ty, tz] = store.cameraState.target;
    controlsRef.current.object.position.set(px, py, pz);
    controlsRef.current.target.set(tx, ty, tz);
    controlsRef.current.object.up.set(...store.cameraState.up);
    controlsRef.current.object.zoom = store.cameraState.zoom;
    controlsRef.current.object.updateProjectionMatrix();
    controlsRef.current.update();
    requestAnimationFrame(() => {
      isUpdatingFromSync.current = false;
    });
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      onChange={() => {
        if (!syncId || !controlsRef.current) return;
        const store = useCameraSyncStore.getState();
        if (!store.syncEnabled) return;
        if (isUpdatingFromSync.current) return;
        const pos = controlsRef.current.object.position;
        const tar = controlsRef.current.target;
        const up = controlsRef.current.object.up;
        const zoom = controlsRef.current.object.zoom;
        store.updateCamera(syncId, {
          position: [pos.x, pos.y, pos.z],
          target: [tar.x, tar.y, tar.z],
          up: [up.x, up.y, up.z],
          zoom,
        });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface MeshViewerProps {
  role: MeshRole;
  vertices: Vec3[];
  faces: Face3[];
  color?: string;
  viewMode?: ViewMode;
  /** Per-frame vertex stream (e.g. Fast_RNRR step messages) */
  updatedVertices?: Vec3[];
  landmarks?: LandmarkPoint[];
  landmarkColor?: string;
  selectedLandmarkIndex?: number | null;
  onLandmarkSelect?: (index: number) => void;
  onLandmarkDelete?: (index: number) => void;
  onLandmarkMove?: (index: number, position: Vec3) => void;
  onMeshClick?: (
    vertexIdx: number,
    position: Vec3,
    modifiers: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  ) => void;
  pickingEnabled?: boolean;
  height?: number | string;
  label?: string;
  /** Camera-sync ID — set the same string on multiple viewers to sync. */
  cameraSyncId?: string;
  /** Optional second mesh (rendered as wireframe) overlayed in same canvas. */
  overlayVertices?: Vec3[];
  overlayFaces?: Face3[];
  overlayColor?: string;
  /** Optional landmarks for overlay mesh (displayed in overlayColor) */
  overlayLandmarks?: LandmarkPoint[];
  /** Screen-fraction size for landmark spheres */
  landmarkScreenFraction?: number;
  /** Background color */
  background?: string;
  /** Extra absolute-positioned controls rendered top-right */
  topRightExtra?: ReactNode;
  /** Show the floor grid (default true) */
  showGrid?: boolean;
  /** Internal — initial view mode toggle button */
  showViewModeToggle?: boolean;
  /** Internal — fit-to-screen button */
  showFitButton?: boolean;
  /** External-controlled view mode change callback */
  onViewModeChange?: (mode: ViewMode) => void;
  /** Place the model on the grid (lift so bbox.min.y sits at y=0). Default true. */
  placeOnGround?: boolean;
  /**
   * Vertex indices (into `vertices`) to render as small highlight points.
   * Used by region-grow visualization.  No effect on picking.
   */
  highlightVertices?: number[];
  /** Color of highlight points (default '#7df0ff') */
  highlightColor?: string;
  /** Secondary (larger, brighter) highlight set, e.g. candidate vertices */
  candidateVertices?: number[];
  /** Color for the candidate set (default '#ffffff') */
  candidateColor?: string;
  /**
   * Generic debug point layers — render multiple independent point sets
   * with their own color/size/opacity.  Each layer is drawn after
   * highlight + candidate sets.
   */
  pointLayers?: Array<{
    indices: number[];
    color: string;
    size?: number;
    opacity?: number;
  }>;
}

export function MeshViewer({
  role,
  vertices,
  faces,
  color = '#4a90d9',
  viewMode = 'solid',
  updatedVertices,
  landmarks = [],
  landmarkColor = '#ff4d4f',
  selectedLandmarkIndex = null,
  onLandmarkSelect,
  onLandmarkDelete,
  onLandmarkMove,
  onMeshClick,
  pickingEnabled = false,
  height = '100%',
  label,
  cameraSyncId,
  overlayVertices,
  overlayFaces,
  overlayColor = '#d9734a',
  overlayLandmarks = [],
  landmarkScreenFraction,
  background = '#2a2a2a',
  topRightExtra,
  showGrid = true,
  showViewModeToggle = true,
  showFitButton = true,
  onViewModeChange,
  placeOnGround = true,
  highlightVertices,
  highlightColor = '#7df0ff',
  candidateVertices,
  candidateColor = '#ffffff',
  pointLayers,
}: MeshViewerProps) {
  const [meshGeometry, setMeshGeometry] = useState<THREE.BufferGeometry | null>(null);
  const handleGeometryReady = useCallback((geo: THREE.BufferGeometry) => {
    setMeshGeometry(geo);
  }, []);

  const [fitKey, setFitKey] = useState(0);
  const [internalMode, setInternalMode] = useState<ViewMode>(viewMode);

  // Keep internal mode in sync if parent changes prop
  useEffect(() => {
    setInternalMode(viewMode);
  }, [viewMode]);

  const setMode = (m: ViewMode) => {
    setInternalMode(m);
    onViewModeChange?.(m);
  };

  // Compute ground-lift offset so the lowest point sits on y=0.
  // Recomputes when source vertices change; ignores per-frame updatedVertices
  // to avoid jittery shifts during streaming deformation.
  const groundOffsetY = (() => {
    if (!placeOnGround || vertices.length === 0) return 0;
    let minY = Infinity;
    for (const v of vertices) if (v[1] < minY) minY = v[1];
    if (overlayVertices) {
      for (const v of overlayVertices) if (v[1] < minY) minY = v[1];
    }
    return Number.isFinite(minY) ? -minY : 0;
  })();

  if (vertices.length === 0) {
    return (
      <div
        style={{
          height,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background,
          color: '#666',
          fontSize: 13,
          position: 'relative',
        }}
      >
        {label && <ViewerLabel label={label} />}
        No mesh loaded
      </div>
    );
  }

  return (
    <div
      style={{
        height,
        width: '100%',
        position: 'relative',
        background,
        overflow: 'hidden',
        border: pickingEnabled ? '2px solid #1890ff' : 'none',
        cursor: pickingEnabled ? 'crosshair' : 'default',
      }}
    >
      {label && <ViewerLabel label={label} />}

      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', gap: 4 }}>
        {topRightExtra}
        {showViewModeToggle && <ViewModeButton mode={internalMode} setMode={setMode} />}
        {showFitButton && (
          <IconBtn title="Fit to screen" onClick={() => setFitKey((k) => k + 1)}>
            ⊡
          </IconBtn>
        )}
      </div>

      <Canvas
        camera={{ fov: 50, near: 0.01, far: 1000 }}
        style={{ background }}
        gl={{ preserveDrawingBuffer: true }}
      >
        <ambientLight intensity={1.0} />
        <directionalLight position={[5, 5, 5]} intensity={1.6} castShadow />
        <directionalLight position={[-3, -3, -3]} intensity={0.6} />

        <group position={[0, groundOffsetY, 0]}>
          <MeshObject
            vertices={vertices}
            faces={faces}
            color={color}
            viewMode={internalMode}
            dynamic={role === 'source' || role === 'result'}
            updatedVertices={updatedVertices}
            onMeshClick={onMeshClick}
            onGeometryReady={handleGeometryReady}
          />

          {overlayVertices && overlayVertices.length > 0 && overlayFaces && overlayFaces.length > 0 && (
            <MeshObject
              vertices={overlayVertices}
              faces={overlayFaces}
              color={overlayColor}
              viewMode="wireframe"
            />
          )}

          {highlightVertices && highlightVertices.length > 0 && (
            <HighlightPoints
              vertices={vertices}
              indices={highlightVertices}
              color={highlightColor}
            />
          )}

          {candidateVertices && candidateVertices.length > 0 && (
            <HighlightPoints
              vertices={vertices}
              indices={candidateVertices}
              color={candidateColor}
              size={14}
              opacity={1}
            />
          )}

          {pointLayers && pointLayers.map((layer, i) =>
            layer.indices.length > 0 ? (
              <HighlightPoints
                key={`pl-${i}-${layer.color}`}
                vertices={vertices}
                indices={layer.indices}
                color={layer.color}
                size={layer.size ?? 8}
                opacity={layer.opacity ?? 0.9}
              />
            ) : null,
          )}

          {landmarks.map((pt) => (
            <LandmarkMarker
              key={pt.index}
              index={pt.index}
              position={pt.position}
              label={`${pt.index}`}
              color={landmarkColor}
              occlusionGeometry={meshGeometry}
              screenFraction={landmarkScreenFraction ?? 0.010}
              selected={selectedLandmarkIndex === pt.index}
              parentOffsetY={groundOffsetY}
              onSelect={onLandmarkSelect}
              onDelete={onLandmarkDelete}
              onMove={onLandmarkMove}
            />
          ))}

          {overlayLandmarks.map((pt) => (
            <LandmarkMarker
              key={`overlay-${pt.index}`}
              index={pt.index}
              position={pt.position}
              label={`T${pt.index}`}
              color={overlayColor}
              occlusionGeometry={meshGeometry}
              screenFraction={landmarkScreenFraction ?? 0.010}
              selected={false}
              parentOffsetY={groundOffsetY}
              onSelect={undefined}
              onDelete={undefined}
              onMove={undefined}
            />
          ))}
        </group>

        {showGrid && <gridHelper args={[5, 10, '#555555', '#333333']} />}

        <AutoFitCamera
          vertices={updatedVertices && updatedVertices.length > 0 ? updatedVertices : vertices}
          syncId={cameraSyncId}
          fitKey={fitKey}
          groundOffsetY={groundOffsetY}
        />
      </Canvas>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small UI helpers (no external UI library)
// ---------------------------------------------------------------------------

function ViewerLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: 12,
        color: '#ddd',
        fontSize: 12,
        fontWeight: 600,
        zIndex: 10,
        background: 'rgba(0,0,0,0.5)',
        padding: '2px 8px',
        borderRadius: 4,
      }}
    >
      {label}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: active ? 'rgba(0,120,212,0.7)' : 'rgba(0,0,0,0.55)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 4,
        color: '#ddd',
        cursor: 'pointer',
        padding: '2px 7px',
        fontSize: 13,
        lineHeight: 1.4,
        userSelect: 'none',
      }}
    >
      {children}
    </button>
  );
}

function ViewModeButton({
  mode,
  setMode,
}: {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
}) {
  const next: Record<ViewMode, ViewMode> = {
    solid: 'wireframe',
    wireframe: 'solid+wireframe',
    'solid+wireframe': 'solid',
  };
  const label: Record<ViewMode, string> = {
    solid: '实体',
    wireframe: '线框',
    'solid+wireframe': '实体+线框',
  };
  return (
    <IconBtn
      title={`显示模式：${label[mode]}（点击切换）`}
      onClick={() => setMode(next[mode])}
    >
      {label[mode]}
    </IconBtn>
  );
}
