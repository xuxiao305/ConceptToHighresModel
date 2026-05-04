/**
 * Vec3[] / Face3[] → GLB Blob exporter.
 *
 * Counterpart to glbLoader.ts. Wraps three.js GLTFExporter so callers
 * (V2 Page3 export) don't have to touch THREE directly.
 *
 * Output is a single-mesh, no-material, no-UV binary GLB suitable for
 * persisting an aligned source mesh back to the project file system.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Vec3, Face3 } from './types';

export function exportMeshAsGlb(vertices: Vec3[], faces: Face3[]): Promise<Blob> {
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    pos[i * 3] = vertices[i][0];
    pos[i * 3 + 1] = vertices[i][1];
    pos[i * 3 + 2] = vertices[i][2];
  }
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    idx[i * 3] = faces[i][0];
    idx[i * 3 + 1] = faces[i][1];
    idx[i * 3 + 2] = faces[i][2];
  }
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xcccccc }));
  const scene = new THREE.Scene();
  scene.add(mesh);

  return new Promise<Blob>((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Blob([result], { type: 'model/gltf-binary' }));
        } else {
          reject(new Error('GLTFExporter returned JSON; expected binary'));
        }
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}
