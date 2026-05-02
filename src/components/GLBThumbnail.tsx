/**
 * GLBThumbnail — compact textured 3D preview for use inside node cards
 * (e.g. the 3D Model node in the page-1 pipeline).
 *
 * Behavior:
 *   - Loads the GLB and renders its original PBR materials/textures.
 *   - Auto-fits the camera once, no user controls (tiny preview).
 *   - Slow auto-rotate so the user can see the model from multiple
 *     angles without interacting.
 *   - Falls back to a small placeholder while loading or on error.
 */

import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { loadGlb, type LoadedGlb } from '../three';

interface GLBThumbnailProps {
  /** Blob URL or remote URL for a .glb / .gltf file. */
  url: string;
  /** Container height (width fills parent). */
  height?: number | string;
  /** Background color. */
  background?: string;
  /** Auto-rotation speed in radians per second. 0 disables rotation. */
  autoRotateSpeed?: number;
}

export function GLBThumbnail({
  url,
  height = 160,
  background = 'radial-gradient(circle at 50% 45%, #3a3a3a 0%, #2a2a2a 60%, #1d1d1d 100%)',
  autoRotateSpeed = 0.4,
}: GLBThumbnailProps) {
  const [loaded, setLoaded] = useState<LoadedGlb | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    let cancelled = false;
    loadGlb(url)
      .then((data) => {
        if (cancelled) return;
        setLoaded(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div style={{ ...frameStyle(height, background), color: 'var(--accent-red)' }}>
        ⚠ 缩略图加载失败
      </div>
    );
  }

  if (!loaded) {
    return (
      <div style={{ ...frameStyle(height, background), color: 'var(--text-muted)' }}>
        <span style={{ fontSize: 24, opacity: 0.5 }}>◈</span>
      </div>
    );
  }

  return (
    <div style={frameStyle(height, background)}>
      <Canvas
        camera={{ fov: 35, near: 0.01, far: 1000 }}
        style={{ width: '100%', height: '100%' }}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={1.4} />
        <directionalLight position={[3, 4, 5]} intensity={1.8} />
        <directionalLight position={[-3, -2, -3]} intensity={0.7} />
        <ThumbScene
          scene={loaded.scene}
          bbox={loaded.bbox}
          autoRotateSpeed={autoRotateSpeed}
        />
      </Canvas>
    </div>
  );
}

// ---------------------------------------------------------------------------

function frameStyle(height: number | string, background: string) {
  return {
    width: '100%',
    height,
    background,
    border: '1px solid var(--border-subtle)',
    borderRadius: 3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative' as const,
  };
}

interface ThumbSceneProps {
  scene: THREE.Object3D;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  autoRotateSpeed: number;
}

function ThumbScene({ scene, bbox, autoRotateSpeed }: ThumbSceneProps) {
  const groupRef = useRef<THREE.Group>(null);
  const cameraSetRef = useRef(false);

  // Compute center + radius + ground-lift once
  const centerRef = useRef(new THREE.Vector3());
  const radiusRef = useRef(1);
  const groundOffsetRef = useRef(0);

  useEffect(() => {
    const min = new THREE.Vector3(...bbox.min);
    const max = new THREE.Vector3(...bbox.max);
    const box = new THREE.Box3(min, max);
    box.getCenter(centerRef.current);
    radiusRef.current = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    groundOffsetRef.current = -bbox.min[1]; // lift so bbox.min.y → y=0
    cameraSetRef.current = false; // re-fit when scene changes
  }, [bbox]);

  useFrame((state, delta) => {
    // One-shot camera placement on first frame after scene mounts
    if (!cameraSetRef.current) {
      const cam = state.camera as THREE.PerspectiveCamera;
      const fovRad = (cam.fov ?? 35) * (Math.PI / 180);
      // Tighter framing than the main viewer so the model is prominent
      const distance = (radiusRef.current / Math.sin(fovRad / 2)) * 1.0;
      const c = centerRef.current;
      const cy = c.y + groundOffsetRef.current; // world-space y after lift
      // Look from a slightly raised front-right angle for a "showcase" look
      cam.position.set(c.x + distance * 0.35, cy + distance * 0.15, c.z + distance * 0.95);
      cam.up.set(0, 1, 0);
      cam.near = Math.max(0.001, radiusRef.current / 100);
      cam.far = radiusRef.current * 100;
      cam.lookAt(c.x, cy, c.z);
      cam.updateProjectionMatrix();
      cameraSetRef.current = true;
    }
    if (groupRef.current && autoRotateSpeed) {
      groupRef.current.rotation.y += delta * autoRotateSpeed;
    }
  });

  // Outer group pivots at the model's vertical axis lifted to ground;
  // inner group pulls the model into local-origin so rotation is around
  // its own centerline (not its centroid in world space).
  return (
    <group position={[centerRef.current.x, centerRef.current.y + groundOffsetRef.current, centerRef.current.z]}>
      <group ref={groupRef} position={[-centerRef.current.x, -centerRef.current.y, -centerRef.current.z]}>
        <primitive object={scene} />
      </group>
    </group>
  );
}
