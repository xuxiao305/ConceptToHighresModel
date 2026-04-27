/**
 * GLB → Vec3[]/Face3[] loader.
 *
 * Walks all meshes in a GLTF scene, applies world transforms, and merges
 * them into a single vertex/face array. This lets the rest of the
 * pipeline (MeshViewer, future Fast_RNRR client) work uniformly with
 * raw geometry instead of three.js scenes.
 *
 * Limitations:
 *   - Drops vertex colors / UVs / materials (preview-only purpose).
 *   - Duplicate vertices across submeshes are NOT merged (no welding).
 *     Fast_RNRR requires welding + isolated-point removal — to be done
 *     server-side when that integration lands.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Vec3, Face3 } from './types';

export interface LoadedMesh {
  vertices: Vec3[];
  faces: Face3[];
  /** Bounding box for camera fitting / scaling. */
  bbox: { min: Vec3; max: Vec3 };
}

export interface LoadedGlb extends LoadedMesh {
  /** Original GLTF scene (with materials/textures preserved) for textured rendering. */
  scene: THREE.Group;
}

export function loadGlbAsMesh(url: string): Promise<LoadedMesh> {
  return loadGlb(url).then(({ vertices, faces, bbox }) => ({ vertices, faces, bbox }));
}

/**
 * Load a GLB and return both the original scene (for textured rendering)
 * and the extracted vertex/face arrays (for the geometry pipeline that
 * Fast_RNRR will plug into).
 */
export function loadGlb(url: string): Promise<LoadedGlb> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        try {
          const mesh = extractMeshFromScene(gltf.scene);
          resolve({ ...mesh, scene: gltf.scene });
        } catch (err) {
          reject(err);
        }
      },
      undefined,
      (err) => reject(err),
    );
  });
}

export function extractMeshFromScene(scene: THREE.Object3D): LoadedMesh {
  const vertices: Vec3[] = [];
  const faces: Face3[] = [];
  let vertexOffset = 0;

  // Make sure world matrices are up to date
  scene.updateMatrixWorld(true);

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    if (!geom || !geom.attributes.position) return;

    const posAttr = geom.attributes.position as THREE.BufferAttribute;
    const matrix = mesh.matrixWorld;
    const v = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
      vertices.push([v.x, v.y, v.z]);
    }

    const idx = geom.index;
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        faces.push([
          idx.getX(i) + vertexOffset,
          idx.getX(i + 1) + vertexOffset,
          idx.getX(i + 2) + vertexOffset,
        ]);
      }
    } else {
      // Non-indexed geometry: every 3 vertices form a triangle
      for (let i = 0; i < posAttr.count; i += 3) {
        faces.push([i + vertexOffset, i + 1 + vertexOffset, i + 2 + vertexOffset]);
      }
    }

    vertexOffset = vertices.length;
  });

  // Bounding box
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of vertices) {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }

  return { vertices, faces, bbox: { min, max } };
}
