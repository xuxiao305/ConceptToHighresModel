/**
 * LandmarkMarker — 3D marker sphere + DOM label with occlusion testing.
 *
 * Verbatim port from D:/AI/Prototypes/WrapDeformation/frontend/src/components/LandmarkMarker.tsx
 *
 * Behavior:
 *   - Constant screen-space size (scales with camera distance)
 *   - Hides via raycast occlusion test against an optional mesh geometry
 *   - DOM label uses @react-three/drei <Html>
 */

import { useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec3 } from './types';

interface LandmarkMarkerProps {
  position: Vec3;
  label: string;
  color: string;
  /** Screen-space size as a fraction of viewport height (default 0.020 = 2%) */
  screenFraction?: number;
  /** Mesh geometry to test occlusion against. If null, no occlusion testing. */
  occlusionGeometry?: THREE.BufferGeometry | null;
}

export function LandmarkMarker({
  position,
  label,
  color,
  screenFraction = 0.020,
  occlusionGeometry = null,
}: LandmarkMarkerProps) {
  const [visible, setVisible] = useState(true);
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const worldPos = useRef(new THREE.Vector3(position[0], position[1], position[2]));
  const frameCounter = useRef(0);

  // Lazy-create a fake mesh to use as the raycast target
  const fakeMesh = useRef<THREE.Mesh | null>(null);
  if (occlusionGeometry && !fakeMesh.current) {
    fakeMesh.current = new THREE.Mesh(occlusionGeometry, new THREE.MeshBasicMaterial());
  }
  if (occlusionGeometry && fakeMesh.current && fakeMesh.current.geometry !== occlusionGeometry) {
    fakeMesh.current.geometry = occlusionGeometry;
  }

  useFrame(() => {
    if (!groupRef.current) return;

    // ── Constant screen-space size ──
    groupRef.current.getWorldPosition(worldPos.current);
    const dist = camera.position.distanceTo(worldPos.current);
    const fov = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180);
    const screenHeightWorld = 2 * dist * Math.tan(fov / 2);
    const worldRadius = screenHeightWorld * screenFraction;
    groupRef.current.scale.setScalar(worldRadius);

    // ── Occlusion test (every 3 frames) ──
    frameCounter.current++;
    if (frameCounter.current % 3 !== 0) return;

    if (!occlusionGeometry || !fakeMesh.current) {
      if (!visible) setVisible(true);
      return;
    }

    const dir = worldPos.current.clone().sub(camera.position).normalize();
    const distance = camera.position.distanceTo(worldPos.current);
    raycaster.current.set(camera.position, dir);
    raycaster.current.far = distance + 0.001;
    raycaster.current.near = 0;

    const intersects = raycaster.current.intersectObject(fakeMesh.current, false);
    const isOccluded = intersects.length > 0 && intersects[0].distance < distance - 0.001;

    if (isOccluded && visible) setVisible(false);
    else if (!isOccluded && !visible) setVisible(true);
  });

  return (
    <group ref={groupRef} position={position} visible={visible}>
      <mesh>
        <sphereGeometry args={[1, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.8} />
      </mesh>
      <Html position={[0, 1.5, 0]} style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: color,
            color: 'white',
            borderRadius: '50%',
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 'bold',
            transform: 'translate(-50%, -100%)',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
            userSelect: 'none',
            visibility: visible ? 'visible' : 'hidden',
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}
