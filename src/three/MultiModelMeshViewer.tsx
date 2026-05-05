/**
 * MultiModelMeshViewer — renders multiple LoadedModel meshes in a single
 * Canvas with shared camera / lighting / OrbitControls.
 *
 * Each model is a MeshObject with its own geometry + color.  The selected
 * model receives an emissive highlight.  View mode applies to all models.
 *
 * Created for Page3 multi-model Source Viewport (Phase 1b).
 */

import {
  useRef,
  useMemo,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { ViewMode, LoadedModel, UserTransform } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// Per-model mesh component
// ═══════════════════════════════════════════════════════════════════════════

interface MultiMeshObjectProps {
  model: LoadedModel;
  viewMode: ViewMode;
  highlighted: boolean;
  highlightColor?: string;
  userTransform: UserTransform;
  onGeometryReady?: (geo: THREE.BufferGeometry) => void;
}

function MultiMeshObject({
  model,
  viewMode,
  highlighted,
  highlightColor = '#ffdd00',
  userTransform,
  onGeometryReady,
}: MultiMeshObjectProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(model.vertices.length * 3);
    for (let i = 0; i < model.vertices.length; i++) {
      positions[i * 3] = model.vertices[i][0];
      positions[i * 3 + 1] = model.vertices[i][1];
      positions[i * 3 + 2] = model.vertices[i][2];
    }
    const indices = new Uint32Array(model.faces.length * 3);
    for (let i = 0; i < model.faces.length; i++) {
      indices[i * 3] = model.faces[i][0];
      indices[i * 3 + 1] = model.faces[i][1];
      indices[i * 3 + 2] = model.faces[i][2];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [model.vertices, model.faces]);

  useEffect(() => {
    onGeometryReady?.(geometry);
  }, [geometry, onGeometryReady]);

  const showSolid = viewMode === 'solid' || viewMode === 'solid+wireframe';
  const showWireframe = viewMode === 'wireframe' || viewMode === 'solid+wireframe';

  return (
    <group
      ref={groupRef}
      position={userTransform.position as [number, number, number]}
      rotation={userTransform.rotation as [number, number, number]}
      scale={userTransform.scale as [number, number, number]}
    >
      {showSolid && (
        <mesh
          ref={meshRef}
          geometry={geometry}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial
            color={model.color}
            side={THREE.DoubleSide}
            transparent={viewMode === 'solid+wireframe'}
            opacity={viewMode === 'solid+wireframe' ? 0.7 : 1}
            roughness={0.5}
            metalness={0.1}
            emissive={highlighted ? highlightColor : '#000000'}
            emissiveIntensity={highlighted ? 0.4 : 0}
          />
        </mesh>
      )}
      {showWireframe && (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            color={showSolid ? (highlighted ? highlightColor : '#333') : model.color}
            wireframe
          />
        </mesh>
      )}
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-fit camera (adapted for multi-model)
// ═══════════════════════════════════════════════════════════════════════════

function AutoFitCamera({
  models,
  fitKey,
  groundOffsetY = 0,
}: {
  models: LoadedModel[];
  fitKey?: number;
  groundOffsetY?: number;
}) {
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    if (!controlsRef.current || models.length === 0) return;
    const box = new THREE.Box3();
    for (const model of models) {
      // Apply userTransform to compute world-space bbox
      const t = model.userTransform;
      const pos = new THREE.Vector3(t.position[0], t.position[1], t.position[2]);
      const euler = new THREE.Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'YXZ');
      const quat = new THREE.Quaternion().setFromEuler(euler);
      const scale = new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]);
      for (const v of model.vertices) {
        const p = new THREE.Vector3(v[0], v[1], v[2])
          .multiply(scale)
          .applyQuaternion(quat)
          .add(pos);
        box.expandByPoint(p);
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    center.y += groundOffsetY;
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
  }, [models, fitKey, groundOffsetY]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Public component
// ═══════════════════════════════════════════════════════════════════════════

export interface MultiModelMeshViewerProps {
  /** All models currently loaded in the viewport. */
  models: LoadedModel[];
  viewMode?: ViewMode;
  height?: number | string;
  label?: string;
  background?: string;
  /** Extra absolute-positioned controls rendered top-right */
  topRightExtra?: ReactNode;
  /** Show the floor grid (default true) */
  showGrid?: boolean;
  /** Show fit-to-screen button (default true) */
  showFitButton?: boolean;
  /** Place models on the grid (lift so lowest bbox.min.y sits at y=0). Default true. */
  placeOnGround?: boolean;
  /** Color used for the selected model highlight. */
  highlightColor?: string;
  /** Called when view mode is changed via internal toggle. */
  onViewModeChange?: (mode: ViewMode) => void;
}

export function MultiModelMeshViewer({
  models,
  viewMode = 'solid',
  height = '100%',
  label,
  background = '#2a2a2a',
  topRightExtra,
  showGrid = true,
  showFitButton = true,
  placeOnGround = true,
  highlightColor = '#ffdd00',
  onViewModeChange,
}: MultiModelMeshViewerProps) {
  const [fitKey, setFitKey] = useState(0);
  const [internalMode, setInternalMode] = useState<ViewMode>(viewMode);

  useEffect(() => {
    setInternalMode(viewMode);
  }, [viewMode]);

  const setMode = (m: ViewMode) => {
    setInternalMode(m);
    onViewModeChange?.(m);
  };

  // Compute ground-lift offset across all models
  const groundOffsetY = useMemo(() => {
    if (!placeOnGround) return 0;
    let minY = Infinity;
    for (const model of models) {
      const t = model.userTransform;
      if (t.position[1] === 0 && t.rotation.every((r) => r === 0) && t.scale.every((s) => s === 1)) {
        // Untransformed — use raw vertices
        for (const v of model.vertices) {
          if (v[1] < minY) minY = v[1];
        }
      } else {
        // Transformed — approximate with bbox of first few vertices
        for (const v of model.vertices.slice(0, 500)) {
          const wy = v[1] * t.scale[1] + t.position[1];
          if (wy < minY) minY = wy;
        }
      }
    }
    return Number.isFinite(minY) ? -minY : 0;
  }, [placeOnGround, models]);

  if (models.length === 0) {
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
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📦</div>
          <div>No models loaded</div>
          <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>
            从下方 Source Mesh Gallery 点击 + 加载模型
          </div>
        </div>
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
      }}
    >
      {label && <ViewerLabel label={label} />}

      {/* Top-right controls */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 10,
          display: 'flex',
          gap: 4,
        }}
      >
        {topRightExtra}
        {/* Mode toggle */}
        <ModeToggle mode={internalMode} onChange={setMode} />
        {showFitButton && (
          <button
            title="Fit to screen"
            onClick={() => setFitKey((k) => k + 1)}
            style={{
              background: 'rgba(0,0,0,0.55)',
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
            ⊡
          </button>
        )}
      </div>

      <Canvas
        gl={{
          preserveDrawingBuffer: false,
          antialias: true,
        }}
        camera={{
          fov: 50,
          near: 0.01,
          far: 1000,
          position: [0, 0, 5],
        }}
        style={{ width: '100%', height: '100%' }}
      >
        {/* Lighting */}
        <ambientLight intensity={1.0} />
        <directionalLight position={[5, 5, 5]} intensity={1.6} />
        <directionalLight position={[-3, -3, -3]} intensity={0.6} />

        {/* Grid */}
        {showGrid && (
          <group position={[0, groundOffsetY, 0]}>
            <gridHelper args={[5, 10, '#555555', '#333333']} />
          </group>
        )}

        {/* Models */}
        <group position={[0, groundOffsetY, 0]}>
          {models.map((model) => (
            <MultiMeshObject
              key={model.id}
              model={model}
              viewMode={internalMode}
              highlighted={model.selected}
              highlightColor={highlightColor}
              userTransform={model.userTransform}
            />
          ))}
        </group>

        {/* Camera */}
        <AutoFitCamera
          models={models}
          fitKey={fitKey}
          groundOffsetY={groundOffsetY}
        />
      </Canvas>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

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

function ModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const modes: ViewMode[] = ['solid', 'wireframe', 'solid+wireframe'];
  const labels: Record<ViewMode, string> = {
    solid: 'Solid',
    wireframe: 'Wire',
    'solid+wireframe': 'S+W',
    textured: 'Tex',
  };
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {modes.map((m) => (
        <button
          key={m}
          title={labels[m]}
          onClick={() => onChange(m)}
          style={{
            background: mode === m ? 'rgba(74,144,226,0.6)' : 'rgba(0,0,0,0.45)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 3,
            color: mode === m ? '#fff' : '#aaa',
            cursor: 'pointer',
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: mode === m ? 700 : 400,
            userSelect: 'none',
          }}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}
