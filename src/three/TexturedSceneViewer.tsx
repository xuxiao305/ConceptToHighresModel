/**
 * TexturedSceneViewer — renders an original three.js scene (e.g. a GLB
 * scene with PBR materials and textures) inside a Canvas with the same
 * camera/lighting/grid setup as `MeshViewer`, but as a primitive
 * `<scene>` rather than from raw vertices/faces.
 *
 * Used by `GLBViewer` when the user toggles the "材质" (material) mode.
 * Geometry mode still goes through `MeshViewer` so streaming vertex
 * updates (Fast_RNRR) keep working.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec3 } from './types';

export interface TexturedSceneViewerProps {
  scene: THREE.Object3D;
  /** Pre-computed bounding box (min / max). Used for camera auto-fit. */
  bbox: { min: Vec3; max: Vec3 };
  height?: number | string;
  background?: string;
  label?: string;
  /** Extra absolute-positioned controls rendered top-right */
  topRightExtra?: ReactNode;
  /** Show floor grid (default true) */
  showGrid?: boolean;
  /** Place model on the grid (lift so bbox.min.y sits at y=0). Default true. */
  placeOnGround?: boolean;
}

export function TexturedSceneViewer({
  scene,
  bbox,
  height = '100%',
  background = '#2a2a2a',
  label,
  topRightExtra,
  showGrid = true,
  placeOnGround = true,
}: TexturedSceneViewerProps) {
  const [fitKey, setFitKey] = useState(0);
  const groundOffsetY = placeOnGround ? -bbox.min[1] : 0;

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
      </div>

      <Canvas
        camera={{ fov: 50, near: 0.01, far: 1000 }}
        style={{ background }}
        gl={{ preserveDrawingBuffer: true }}
      >
        <ambientLight intensity={1.2} />
        <directionalLight position={[5, 5, 5]} intensity={1.8} castShadow />
        <directionalLight position={[-3, -3, -3]} intensity={0.6} />
        <group position={[0, groundOffsetY, 0]}>
          <primitive object={scene} />
        </group>
        {showGrid && <gridHelper args={[5, 10, '#555555', '#333333']} />}
        <AutoFit bbox={bbox} fitKey={fitKey} groundOffsetY={groundOffsetY} />
      </Canvas>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AutoFit({
  bbox,
  fitKey,
  groundOffsetY = 0,
}: {
  bbox: { min: Vec3; max: Vec3 };
  fitKey: number;
  groundOffsetY?: number;
}) {
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    if (!controlsRef.current) return;
    const min = new THREE.Vector3(...bbox.min);
    const max = new THREE.Vector3(...bbox.max);
    const box = new THREE.Box3(min, max);
    const center = box.getCenter(new THREE.Vector3());
    center.y += groundOffsetY; // shift target so the lifted model is centered
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
  }, [bbox, fitKey, groundOffsetY]);

  // Keep useFrame so r3f mounts properly even though we don't animate
  useFrame(() => {});

  return <OrbitControls ref={controlsRef} makeDefault />;
}
