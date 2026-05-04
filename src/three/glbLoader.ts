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
          // 朝向契约自检：项目约定 +X = 角色正面、+Z = 横向。
          // Trellis2 / 其他 image-to-3d 重建可能输出 +Z = 正面（标准
          // glTF 习惯），需自动旋转 90° 回到契约。检测准则：T-pose
          // 角色横向跨度 ≈ 1.5×身高深度，所以 X-span > Z-span * 1.5
          // 即明显违反契约。容差给到 1.5 防止误判。
          enforceFrontAxisX(gltf.scene);
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

/**
 * 检查 mesh bbox，如果违反 "+X = 角色正面" 契约则原地绕 +Y 旋转 +90°，
 * 让旧 +Z 变成新 +X。同步修改 gltf.scene，保证后续 extract 出的顶点
 * 与显示的 scene 一致。
 *
 * 设计取舍：
 *   - 仅旋转，不平移、不缩放，保持与原 mesh 同心同形。
 *   - 旋转作用在 scene 根 group 上，不直接改 BufferGeometry，
 *     避免破坏材质/UV。
 *   - 阈值 1.5 防止给"非典型 T-pose"模型误旋；可观察控制台日志
 *     做经验调整。
 */
function enforceFrontAxisX(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  let mnX = Infinity, mnZ = Infinity, mxX = -Infinity, mxZ = -Infinity;
  const v = new THREE.Vector3();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const m = mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.x < mnX) mnX = v.x; if (v.x > mxX) mxX = v.x;
      if (v.z < mnZ) mnZ = v.z; if (v.z > mxZ) mxZ = v.z;
    }
  });
  if (!isFinite(mnX)) return;
  const xSpan = mxX - mnX;
  const zSpan = mxZ - mnZ;
  if (xSpan > zSpan * 1.5) {
    // 违反契约：横向在 X，需要绕 Y 转 +90°（+Z → +X，+X → -Z）。
    scene.rotation.y += Math.PI / 2;
    scene.updateMatrixWorld(true);
    // eslint-disable-next-line no-console
    console.warn(
      `[glbLoader] orientation violation: xSpan=${xSpan.toFixed(3)} zSpan=${zSpan.toFixed(3)} ratio=${(xSpan/zSpan).toFixed(2)}, rotated +90° around Y to restore +X=front contract`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[glbLoader] orientation OK: xSpan=${xSpan.toFixed(3)} zSpan=${zSpan.toFixed(3)} ratio=${(xSpan/zSpan).toFixed(2)} (contract: +X=front)`,
    );
  }
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
