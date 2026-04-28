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
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Vec3 } from './types';

interface LandmarkMarkerProps {
  index: number;
  position: Vec3;
  label: string;
  color: string;
  /** Screen-space size as a fraction of viewport height (default 0.020 = 2%) */
  screenFraction?: number;
  /** Mesh geometry to test occlusion against. If null, no occlusion testing. */
  occlusionGeometry?: THREE.BufferGeometry | null;
  selected?: boolean;
  parentOffsetY?: number;
  onSelect?: (index: number) => void;
  onDelete?: (index: number) => void;
  onMove?: (index: number, position: Vec3) => void;
}

export function LandmarkMarker({
  index,
  position,
  label,
  color,
  screenFraction = 0.020,
  occlusionGeometry = null,
  selected = false,
  parentOffsetY = 0,
  onSelect,
  onDelete,
  onMove,
}: LandmarkMarkerProps) {
  const [visible, setVisible] = useState(true);
  const groupRef = useRef<THREE.Group>(null);
  const { camera, controls, gl } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const ndc = useRef(new THREE.Vector2());
  const worldPos = useRef(new THREE.Vector3(position[0], position[1], position[2]));
  const frameCounter = useRef(0);
  const dragging = useRef(false);
  const controlsWereEnabled = useRef(true);

  // Lazy-create a fake mesh to use as the raycast target
  const fakeMesh = useRef<THREE.Mesh | null>(null);
  if (occlusionGeometry && !fakeMesh.current) {
    fakeMesh.current = new THREE.Mesh(
      occlusionGeometry,
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
  }
  if (occlusionGeometry && fakeMesh.current && fakeMesh.current.geometry !== occlusionGeometry) {
    fakeMesh.current.geometry = occlusionGeometry;
  }

  const syncFakeMeshTransform = () => {
    if (!fakeMesh.current) return;
    fakeMesh.current.position.set(0, parentOffsetY, 0);
    fakeMesh.current.updateMatrixWorld(true);
  };

  const finishDrag = () => {
    dragging.current = false;
    const orbitControls = controls as { enabled?: boolean } | undefined;
    if (orbitControls) {
      orbitControls.enabled = controlsWereEnabled.current;
    }
  };

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onSelect?.(index);

    if (e.button !== 0 || !onMove || !groupRef.current || !fakeMesh.current) return;

    dragging.current = true;

    const orbitControls = controls as { enabled?: boolean } | undefined;
    controlsWereEnabled.current = orbitControls?.enabled ?? true;
    if (orbitControls) orbitControls.enabled = false;

    const target = e.target as {
      setPointerCapture?: (pointerId: number) => void;
    } | null;
    if (target?.setPointerCapture) {
      target.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current || !onMove || !fakeMesh.current) return;
    e.stopPropagation();

    syncFakeMeshTransform();

    const rect = gl.domElement.getBoundingClientRect();
    ndc.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.current.setFromCamera(ndc.current, camera);
    raycaster.current.near = 0;
    raycaster.current.far = camera.far;

    const hits = raycaster.current.intersectObject(fakeMesh.current, false);
    if (hits.length === 0) return;
    // Intersections are sorted by distance ascending: pick nearest surface.
    const hit = hits[0].point;
    onMove(index, [hit.x, hit.y - parentOffsetY, hit.z]);
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const target = e.target as {
      releasePointerCapture?: (pointerId: number) => void;
    } | null;
    if (target?.releasePointerCapture) {
      target.releasePointerCapture(e.pointerId);
    }
    finishDrag();
  };

  const handleContextMenu = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    e.nativeEvent.preventDefault();
    onSelect?.(index);
    onDelete?.(index);
    finishDrag();
  };

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

    syncFakeMeshTransform();

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
      <mesh
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={handleContextMenu}
      >
        <sphereGeometry args={[1, 16, 16]} />
        <meshStandardMaterial
          color={selected ? '#ffffff' : color}
          emissive={selected ? '#ffffff' : color}
          emissiveIntensity={selected ? 1.2 : 0.8}
        />
      </mesh>
      {selected && (
        <mesh>
          <sphereGeometry args={[1.3, 16, 16]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={0.85} />
        </mesh>
      )}
      <Html position={[0, 1.5, 0]} style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: selected ? '#ffffff' : color,
            borderRadius: '50%',
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 'bold',
            transform: 'translate(-50%, -100%)',
            boxShadow: selected ? `0 0 0 2px ${color}, 0 2px 8px rgba(0,0,0,0.45)` : '0 2px 6px rgba(0,0,0,0.4)',
            userSelect: 'none',
            visibility: visible ? 'visible' : 'hidden',
            border: selected ? `2px solid ${color}` : 'none',
            color: selected ? '#111' : 'white',
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}
