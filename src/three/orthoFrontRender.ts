/**
 * Orthographic front-view renderer for the 2D-localization (SAM3) pipeline.
 *
 * Coordinate convention (verified with BlenderToGLBSpaceConfirm.glb):
 *   Blender (Z-up, right-hand)        →   glTF / Three.js (Y-up, right-hand)
 *   character +X (front)              →   world +X
 *   character +Z (head)               →   world +Y
 *   character +Y (left hand)          →   world -Z
 *   character +Y reversed (right hand)→   world +Z
 *
 * The reference image (Bot.png) is taken from the FRONT, with the
 * character's RIGHT arm on the LEFT side of the picture. This means:
 *   - virtual camera sits on +X, looks toward -X
 *   - up = +Y
 *   - image-right (+u) maps to world -Z (character's left side)
 *   - image-down (+v) maps to world -Y (toward feet)
 *
 * This file renders a flat silhouette of a mesh from that camera. The
 * goal is purely to verify alignment with an existing 2D image such as
 * Bot.png — actual mask-to-vertex reprojection is a later step.
 */

import * as THREE from 'three';
import type { Vec3, Face3 } from './types';

export interface OrthoRenderOptions {
  /** Output image width in pixels. Should match the reference image. */
  width: number;
  /** Output image height in pixels. Should match the reference image. */
  height: number;
  /** Extra empty space around the mesh, as a fraction of half-extent. */
  padding?: number;
  /** Extra uniform scale applied AFTER fitting (1 = fit, <1 = shrink). */
  scale?: number;
  /** Horizontal offset in normalized device coords (-1..1, +1 = full image right). */
  offsetX?: number;
  /** Vertical offset in normalized device coords (-1..1, +1 = full image up). */
  offsetY?: number;
  /**
   * Auto-fit the mesh into a target image-space bbox (top-left origin).
   * When provided, `padding`/`scale`/`offsetX`/`offsetY` are ignored
   * and the renderer matches the mesh's projected bbox to this bbox.
   */
  fitToImageBBox?: { x: number; y: number; w: number; h: number };
  /** Mesh fill color for the silhouette. */
  meshColor?: string;
  /** Optional background color. `null` = transparent. */
  background?: string | null;
  /** Override pixel ratio (defaults to 1 for predictable output). */
  pixelRatio?: number;
}

export interface OrthoFrontFrustum {
  /** Mesh bbox center, world space. */
  centerX: number;
  centerY: number;
  centerZ: number;
  /** Half-width of the orthographic frustum (world units, along world Z). */
  halfWidth: number;
  /** Half-height of the orthographic frustum (world units, along world Y). */
  halfHeight: number;
  /** Distance from camera to mesh center along world X. */
  camDist: number;
  /** Output image width in pixels. */
  width: number;
  /** Output image height in pixels. */
  height: number;
}

/**
 * Deterministic mapping from image pixel space → world space, captured
 * from the camera that was actually used to render the silhouette.
 * Used by mask-to-vertex reprojection so the projection used to render
 * is the EXACT same projection used to interpret a mask.
 *
 * Given pixel (u, v) in [0..width) × [0..height) (top-left origin), the
 * inverse projection is:
 *
 *   worldZ = camZ - (u + 0.5 - width/2)  * worldPerPx
 *   worldY = camY + (height/2 - v - 0.5) * worldPerPx
 *
 * The corresponding world-space ray is anchored at
 *   (camX = meshFrontX, worldY, worldZ)
 * with direction (-1, 0, 0).  meshFrontX is chosen safely outside the
 * mesh bbox along +X.
 */
export interface OrthoFrontCamera {
  /** Output image width in pixels. */
  width: number;
  /** Output image height in pixels. */
  height: number;
  /** Camera Y/Z position in world space. */
  camY: number;
  camZ: number;
  /** World units per image pixel (isotropic). */
  worldPerPx: number;
  /** Safe ray origin X (somewhere on +X side of the mesh). */
  meshFrontX: number;
}

/**
 * Compute the orthographic frustum that fits a mesh into a given image
 * size with the requested padding while preserving aspect ratio.
 */
export function computeOrthoFrontFrustum(
  vertices: Vec3[],
  width: number,
  height: number,
  padding = 0.04,
): OrthoFrontFrustum {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) {
    throw new Error('computeOrthoFrontFrustum: empty mesh');
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;

  const meshHeight = maxY - minY;
  const meshWidth = maxZ - minZ;
  const meshDepth = maxX - minX;

  // Fit mesh while preserving image aspect ratio
  const aspect = width / height;
  let halfHeight = meshHeight / 2;
  let halfWidth = halfHeight * aspect;
  if (halfWidth < meshWidth / 2) {
    halfWidth = meshWidth / 2;
    halfHeight = halfWidth / aspect;
  }
  halfHeight *= 1 + padding;
  halfWidth *= 1 + padding;

  const camDist = Math.max(meshDepth * 2, 1.0);

  return {
    centerX,
    centerY,
    centerZ,
    halfWidth,
    halfHeight,
    camDist,
    width,
    height,
  };
}

/**
 * Render a flat silhouette of the mesh from the standard orthographic
 * front view defined above. Returns a PNG data URL only — use
 * `renderOrthoFrontViewWithCamera` if you also need the deterministic
 * pixel↔world mapping (e.g. for mask reprojection).
 */
export function renderOrthoFrontView(
  vertices: Vec3[],
  faces: Face3[],
  options: OrthoRenderOptions,
): string {
  return renderOrthoFrontViewWithCamera(vertices, faces, options).dataUrl;
}

/**
 * Same as `renderOrthoFrontView` but also returns the camera that was
 * actually used (post-fit when `fitToImageBBox` is given). The camera
 * lets downstream code reproject mask pixels into world rays with full
 * fidelity to what was rendered.
 */
export function renderOrthoFrontViewWithCamera(
  vertices: Vec3[],
  faces: Face3[],
  options: OrthoRenderOptions,
): { dataUrl: string; camera: OrthoFrontCamera } {
  const {
    width,
    height,
    padding = 0.04,
    scale = 1,
    offsetX = 0,
    offsetY = 0,
    fitToImageBBox,
    meshColor = '#dddddd',
    background = null,
    pixelRatio = 1,
  } = options;

  // World bbox.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) {
    throw new Error('renderOrthoFrontView: empty mesh');
  }

  const meshCenterX = (minX + maxX) / 2;
  const meshCenterY = (minY + maxY) / 2;
  const meshCenterZ = (minZ + maxZ) / 2;
  const meshHeight = Math.max(maxY - minY, 1e-6);
  const meshWidth = Math.max(maxZ - minZ, 1e-6);
  const meshDepth = Math.max(maxX - minX, 1.0);

  // First-pass camera (or the only pass when no fit bbox is given).
  let halfWidth: number;
  let halfHeight: number;
  let camY: number;
  let camZ: number;

  if (fitToImageBBox) {
    // 只用纵轴（身高）对齐：T-pose mesh 横向跨度=手臂展开（≈1.5×身高），
    // 但 SAM3 SegPack 的 region bbox 通常只覆盖躯干，不含手臂。如果用
    // max(sx, sy) 会让 X 轴主导，把 mesh 在 Y 方向压扁约 30%~40%，反投影
    // 时所有区域会向上移位（头-脚跨度 < fitBBox 高度时纵向居中导致顶部留白）。
    // 改为强制 worldPerPx = meshHeight / fitBBox.h，手臂在水平方向溢出 fit
    // 区域无所谓（没有 region 落在手臂上），反投影逻辑只关心纵向对齐。
    const worldPerPx = meshHeight / fitToImageBBox.h;
    halfWidth = (worldPerPx * width) / 2;
    halfHeight = (worldPerPx * height) / 2;
    // X: do NOT use fitBBox X-center. SAM3 region bboxes can be skewed by
    // asymmetric accessories (e.g. tool pouch on one hip extends the union
    // bbox right by 20+px), but the TPose input image guarantees the body is
    // centered in the canvas. So align mesh anatomical center → image center.
    // Y: use fitBBox Y-center (vertical body span is what we want to fit).
    const fitCenterPxY = fitToImageBBox.y + fitToImageBBox.h / 2;
    const dyPx = fitCenterPxY - height / 2;
    camZ = meshCenterZ;
    camY = meshCenterY + dyPx * worldPerPx;
  } else {
    const aspect = width / height;
    let hH = meshHeight / 2;
    let hW = hH * aspect;
    if (hW < meshWidth / 2) {
      hW = meshWidth / 2;
      hH = hW / aspect;
    }
    hH *= 1 + padding;
    hW *= 1 + padding;
    halfWidth = hW / Math.max(scale, 1e-6);
    halfHeight = hH / Math.max(scale, 1e-6);
    camY = meshCenterY + offsetY * halfHeight;
    camZ = meshCenterZ - offsetX * halfWidth;
  }

  const camDist = Math.max(meshDepth * 2, 1.0);

  // Build the renderer/scene/mesh once, render up to twice.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: background === null,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, background === null ? 0 : 1);

  const scene = new THREE.Scene();
  if (background !== null) {
    scene.background = new THREE.Color(background);
  }

  const geom = new THREE.BufferGeometry();
  const posArr = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    posArr[i * 3] = vertices[i][0];
    posArr[i * 3 + 1] = vertices[i][1];
    posArr[i * 3 + 2] = vertices[i][2];
  }
  geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));

  const idxArr = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    idxArr[i * 3] = faces[i][0];
    idxArr[i * 3 + 1] = faces[i][1];
    idxArr[i * 3 + 2] = faces[i][2];
  }
  geom.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geom.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    color: meshColor,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(
    -halfWidth, halfWidth,
    halfHeight, -halfHeight,
    0.001, camDist * 4,
  );
  const updateCamera = () => {
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.position.set(meshCenterX + camDist, camY, camZ);
    camera.up.set(0, 1, 0);
    camera.lookAt(meshCenterX, camY, camZ);
    camera.updateProjectionMatrix();
  };

  updateCamera();
  renderer.render(scene, camera);

  // Second pass: refit using the actual silhouette of pass 1.
  if (fitToImageBBox) {
    const sil = readSilhouetteBBox(renderer.domElement, width, height);
    if (sil && sil.w > 1 && sil.h > 1) {
      // Where is the silhouette in WORLD space, given the pass-1 camera?
      const worldPerPx1 = (2 * halfHeight) / height;
      const silCenterPxX = sil.x + sil.w / 2;
      const silCenterPxY = sil.y + sil.h / 2;
      // Inverse of the projection used by updateCamera() above.
      // imagePixelX = W/2 + (camZ - worldZ) / worldPerPx
      //   → worldZ = camZ - (imagePixelX - W/2) * worldPerPx
      // imagePixelY = H/2 - (worldY - camY) / worldPerPx
      //   → worldY = camY + (H/2 - imagePixelY) * worldPerPx
      const silWorldZ = camZ - (silCenterPxX - width / 2) * worldPerPx1;
      const silWorldY = camY + (height / 2 - silCenterPxY) * worldPerPx1;
      const silWorldW = sil.w * worldPerPx1;
      const silWorldH = sil.h * worldPerPx1;

      // Pick the world-per-pixel that aligns the silhouette HEIGHT with the
      // target bbox HEIGHT. We deliberately ignore horizontal alignment because
      // the mesh silhouette includes outstretched arms (T-pose) while the SAM3
      // region bbox typically only covers the torso. See pass-1 comment above.
      const syNew = silWorldH / fitToImageBBox.h;
      const worldPerPx2 = syNew;
      halfWidth = (worldPerPx2 * width) / 2;
      halfHeight = (worldPerPx2 * height) / 2;

      const fitCenterPxY = fitToImageBBox.y + fitToImageBBox.h / 2;
      // X: align mesh anatomical center → image center (see pass-1 comment).
      // Y: use silhouette center (head-to-feet span) → fitBBox center.
      camZ = meshCenterZ;
      camY = silWorldY + (fitCenterPxY - height / 2) * worldPerPx2;

      updateCamera();
      renderer.render(scene, camera);
    }
  }

  let dataUrl = '';
  try {
    dataUrl = renderer.domElement.toDataURL('image/png');
  } finally {
    renderer.dispose();
    geom.dispose();
    mat.dispose();
  }

  // worldPerPx is isotropic; recover from the final frustum.
  const worldPerPx = (2 * halfHeight) / height;
  const camera2: OrthoFrontCamera = {
    width,
    height,
    camY,
    camZ,
    worldPerPx,
    meshFrontX: meshCenterX + camDist,
  };
  return { dataUrl, camera: camera2 };
}

/**
 * Find the bbox of the rendered foreground in a WebGL canvas with a
 * transparent clear color. Uses alpha > threshold as the foreground
 * test. Returns null if nothing was drawn.
 */
function readSilhouetteBBox(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  // We render with `preserveDrawingBuffer: true` so a 2D canvas can read
  // pixels back via drawImage. We then sample the alpha channel.
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const threshold = 16;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Convenience: render and return both the data URL and the frustum, so
 * the caller can later reproject pixels back into world space without
 * recomputing the bbox.
 */
export function renderOrthoFrontViewWithFrustum(
  vertices: Vec3[],
  faces: Face3[],
  options: OrthoRenderOptions,
): { dataUrl: string; frustum: OrthoFrontFrustum } {
  const frustum = computeOrthoFrontFrustum(vertices, options.width, options.height, options.padding);
  const dataUrl = renderOrthoFrontView(vertices, faces, options);
  return { dataUrl, frustum };
}

export interface TexturedSnapshotOptions {
  width: number;
  height: number;
  padding?: number;
  background?: string;
  pixelRatio?: number;
}

/**
 * Render a THREE.Group (GLTF scene with original materials/textures)
 * from the orthographic front view with basic lighting.
 *
 * Unlike `renderOrthoFrontViewWithCamera` which uses flat MeshBasicMaterial
 * on raw vertices, this renders the original GLTF scene so textured
 * PBR materials and basic directional+ambient lighting show up.
 */
export function renderTexturedFrontSnapshot(
  scene: THREE.Object3D,
  bbox: { min: Vec3; max: Vec3 },
  options: TexturedSnapshotOptions,
): string {
  const { width, height, padding = 0.08, background = '#2a2a2a', pixelRatio = 1 } = options;

  const minX = bbox.min[0], minY = bbox.min[1], minZ = bbox.min[2];
  const maxX = bbox.max[0], maxY = bbox.max[1], maxZ = bbox.max[2];

  const meshCenterX = (minX + maxX) / 2;
  const meshCenterY = (minY + maxY) / 2;
  const meshCenterZ = (minZ + maxZ) / 2;
  const meshHeight = Math.max(maxY - minY, 1e-6);
  const meshWidth = Math.max(maxZ - minZ, 1e-6);
  const meshDepth = Math.max(maxX - minX, 1.0);

  const aspect = width / height;
  let halfHeight = (meshHeight / 2) * (1 + padding);
  let halfWidth = halfHeight * aspect;
  if (halfWidth < (meshWidth / 2) * (1 + padding)) {
    halfWidth = (meshWidth / 2) * (1 + padding);
    halfHeight = halfWidth / aspect;
  }
  const camDist = Math.max(meshDepth * 2, 1.0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.setClearColor(new THREE.Color(background), 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const renderScene = new THREE.Scene();
  renderScene.background = new THREE.Color(background);

  // Clone the scene so we don't mutate the original
  const cloned = scene.clone(true);
  renderScene.add(cloned);

  // Lighting: key light + fill + ambient for even illumination
  const ambient = new THREE.AmbientLight('#ffffff', 0.6);
  renderScene.add(ambient);

  const keyLight = new THREE.DirectionalLight('#ffffff', 1.2);
  keyLight.position.set(camDist, meshHeight * 0.6, meshWidth * 0.5);
  renderScene.add(keyLight);

  const fillLight = new THREE.DirectionalLight('#8899cc', 0.5);
  fillLight.position.set(camDist * 0.5, -meshHeight * 0.3, -meshWidth * 0.6);
  renderScene.add(fillLight);

  const camera = new THREE.OrthographicCamera(
    -halfWidth, halfWidth,
    halfHeight, -halfHeight,
    0.001, camDist * 4,
  );
  camera.position.set(meshCenterX + camDist, meshCenterY, meshCenterZ);
  camera.up.set(0, 1, 0);
  camera.lookAt(meshCenterX, meshCenterY, meshCenterZ);
  camera.updateProjectionMatrix();

  renderer.render(renderScene, camera);

  let dataUrl = '';
  try {
    dataUrl = renderer.domElement.toDataURL('image/png');
  } finally {
    renderer.dispose();
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ((mesh as any).isMesh) {
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material?.dispose();
        }
      }
    });
  }

  return dataUrl;
}
