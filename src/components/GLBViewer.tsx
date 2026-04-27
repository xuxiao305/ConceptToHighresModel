/**
 * GLBViewer — single 3D viewport for displaying GLB/GLTF models.
 *
 * Tech stack matches D:/AI/Prototypes/WrapDeformation:
 *   - @react-three/fiber (Canvas)
 *   - @react-three/drei (OrbitControls)
 *   - three.js GLTFLoader
 *
 * Designed for reuse on Page 1 (rough model preview) and Page 3
 * (model assemble — full WrapDeformation parity).
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type ViewMode = 'solid' | 'wireframe' | 'solid+wireframe';

export interface GLBViewerProps {
  /** Blob URL or remote URL for a .glb / .gltf file. null → empty state. */
  url: string | null;
  /** Optional title shown top-left. */
  label?: string;
  viewMode?: ViewMode;
  /** Background color of the canvas. */
  background?: string;
  /** Container height; defaults to filling parent. */
  height?: number | string;
}

// ---------------------------------------------------------------------------
// Loaded-model object
// ---------------------------------------------------------------------------

function GLBObject({
  url,
  viewMode,
  onBoundsReady,
}: {
  url: string;
  viewMode: ViewMode;
  onBoundsReady: (box: THREE.Box3) => void;
}) {
  const [scene, setScene] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (cancelled) return;
        setScene(gltf.scene);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        onBoundsReady(box);
      },
      undefined,
      (err) => {
        console.error('[GLBViewer] failed to load', url, err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, onBoundsReady]);

  // Apply view mode by walking the scene each render
  useEffect(() => {
    if (!scene) return;
    const showSolid = viewMode === 'solid' || viewMode === 'solid+wireframe';
    const showWireframe = viewMode === 'wireframe' || viewMode === 'solid+wireframe';
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        const mat = m as THREE.MeshStandardMaterial & { wireframe?: boolean };
        if (showWireframe && !showSolid) {
          mat.wireframe = true;
          mat.transparent = false;
          mat.opacity = 1;
        } else if (showSolid && showWireframe) {
          mat.wireframe = false;
          mat.transparent = true;
          mat.opacity = 0.85;
        } else {
          mat.wireframe = false;
          mat.transparent = false;
          mat.opacity = 1;
        }
        mat.needsUpdate = true;
      });
    });
  }, [scene, viewMode]);

  if (!scene) return null;

  // Wireframe overlay pass when in solid+wireframe mode
  const overlay = useMemo(() => {
    if (viewMode !== 'solid+wireframe' || !scene) return null;
    const group = new THREE.Group();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const wireMesh = new THREE.Mesh(
        mesh.geometry,
        new THREE.MeshBasicMaterial({ color: '#222', wireframe: true }),
      );
      mesh.updateWorldMatrix(true, false);
      wireMesh.applyMatrix4(mesh.matrixWorld);
      group.add(wireMesh);
    });
    return group;
  }, [scene, viewMode]);

  return (
    <>
      <primitive object={scene} />
      {overlay && <primitive object={overlay} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Auto-fit camera
// ---------------------------------------------------------------------------

function AutoFitCamera({ box, fitKey }: { box: THREE.Box3 | null; fitKey: number }) {
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();

  useEffect(() => {
    if (!box || !controlsRef.current) return;
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = sphere.radius || 1;
    const persp = camera as THREE.PerspectiveCamera;
    const fovRad = (persp.fov ?? 50) * (Math.PI / 180);
    const distance = (radius / Math.sin(fovRad / 2)) * 1.2;
    controlsRef.current.target.copy(center);
    persp.position.set(center.x, center.y, center.z + distance);
    persp.up.set(0, 1, 0);
    persp.near = Math.max(0.001, radius / 100);
    persp.far = radius * 100;
    persp.updateProjectionMatrix();
    controlsRef.current.update();
  }, [box, fitKey, camera]);

  return <OrbitControls ref={controlsRef} makeDefault />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GLBViewer({
  url,
  label,
  viewMode = 'solid',
  background = '#1a1a2e',
  height = '100%',
}: GLBViewerProps) {
  const [box, setBox] = useState<THREE.Box3 | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [mode, setMode] = useState<ViewMode>(viewMode);

  // Reset bounds when URL changes
  useEffect(() => {
    setBox(null);
  }, [url]);

  const empty = !url;

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
      {label && (
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
      )}

      {!empty && (
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
          <ViewModeButton mode={mode} setMode={setMode} />
          <IconBtn title="Fit to screen" onClick={() => setFitKey((k) => k + 1)}>
            ⊡
          </IconBtn>
        </div>
      )}

      {empty ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#666',
            fontSize: 13,
          }}
        >
          双击 Pipeline 中的 Rough Model 节点以在此显示
        </div>
      ) : (
        <Canvas
          camera={{ fov: 50, near: 0.01, far: 1000, position: [0, 0, 3] }}
          style={{ background }}
          gl={{ preserveDrawingBuffer: true }}
        >
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 5, 5]} intensity={0.9} />
          <directionalLight position={[-3, -3, -3]} intensity={0.3} />
          <Suspense fallback={null}>
            <GLBObject url={url!} viewMode={mode} onBoundsReady={setBox} />
          </Suspense>
          <gridHelper args={[5, 10, '#555555', '#333333']} />
          <AutoFitCamera box={box} fitKey={fitKey} />
        </Canvas>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
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
