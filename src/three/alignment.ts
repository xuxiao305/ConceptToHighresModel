import { Matrix, SingularValueDecomposition, determinant } from 'ml-matrix';
import type { Vec3 } from './types';

export type AlignmentMode = 'rigid' | 'similarity';

export interface AlignmentResult {
  mode: AlignmentMode;
  matrix4x4: number[][];
  transformedVertices: Vec3[];
  rmse: number;
  meanError: number;
  maxError: number;
  scale: number;
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mul3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function norm3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

function centroid(points: Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  let acc: Vec3 = [0, 0, 0];
  for (const p of points) acc = add3(acc, p);
  return mul3(acc, 1 / points.length);
}

function applyRotation(r: number[][], v: Vec3): Vec3 {
  return [
    r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
    r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
    r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
  ];
}

export function applyTransform(v: Vec3, matrix4x4: number[][]): Vec3 {
  return [
    matrix4x4[0][0] * v[0] + matrix4x4[0][1] * v[1] + matrix4x4[0][2] * v[2] + matrix4x4[0][3],
    matrix4x4[1][0] * v[0] + matrix4x4[1][1] * v[1] + matrix4x4[1][2] * v[2] + matrix4x4[1][3],
    matrix4x4[2][0] * v[0] + matrix4x4[2][1] * v[1] + matrix4x4[2][2] * v[2] + matrix4x4[2][3],
  ];
}

export function computeLandmarkAlignment(
  sourcePoints: Vec3[],
  targetPoints: Vec3[],
  mode: AlignmentMode,
): {
  rotation: number[][];
  translation: Vec3;
  scale: number;
  matrix4x4: number[][];
} {
  if (sourcePoints.length !== targetPoints.length || sourcePoints.length < 3) {
    throw new Error('Need at least 3 paired landmarks with equal counts');
  }

  const cSrc = centroid(sourcePoints);
  const cTar = centroid(targetPoints);

  const xs = sourcePoints.map((p) => sub3(p, cSrc));
  const ys = targetPoints.map((p) => sub3(p, cTar));

  const h = Matrix.zeros(3, 3);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        h.set(row, col, h.get(row, col) + x[row] * y[col]);
      }
    }
  }

  const svd = new SingularValueDecomposition(h);
  const u = svd.leftSingularVectors;
  const v = svd.rightSingularVectors;
  const ut = u.transpose();
  const vuT = v.mmul(ut);
  const det = determinant(vuT);
  const sign = det >= 0 ? 1 : -1;
  const signMatrix = Matrix.diag([1, 1, sign]);
  const rotationMatrix = v.mmul(signMatrix).mmul(ut);
  const rotation = rotationMatrix.to2DArray();

  let scale = 1;
  if (mode === 'similarity') {
    const rh = rotationMatrix.mmul(h);
    const num = rh.trace();
    let den = 0;
    for (let i = 0; i < xs.length; i++) den += dot3(xs[i], xs[i]);
    if (Math.abs(den) < 1e-12) {
      throw new Error('Degenerate source landmark set');
    }
    scale = num / den;
  }

  const rcSrc = applyRotation(rotation, cSrc);
  const translation: Vec3 = [
    cTar[0] - scale * rcSrc[0],
    cTar[1] - scale * rcSrc[1],
    cTar[2] - scale * rcSrc[2],
  ];

  const matrix4x4 = [
    [scale * rotation[0][0], scale * rotation[0][1], scale * rotation[0][2], translation[0]],
    [scale * rotation[1][0], scale * rotation[1][1], scale * rotation[1][2], translation[1]],
    [scale * rotation[2][0], scale * rotation[2][1], scale * rotation[2][2], translation[2]],
    [0, 0, 0, 1],
  ];

  return { rotation, translation, scale, matrix4x4 };
}

export function alignSourceMeshByLandmarks(
  sourceVertices: Vec3[],
  sourceLandmarks: Vec3[],
  targetLandmarks: Vec3[],
  mode: AlignmentMode,
): AlignmentResult {
  const { matrix4x4, scale } = computeLandmarkAlignment(sourceLandmarks, targetLandmarks, mode);

  const transformedVertices = sourceVertices.map((v) => applyTransform(v, matrix4x4));

  const errors: number[] = [];
  for (let i = 0; i < sourceLandmarks.length; i++) {
    const rotated = applyRotation(matrix4x4.slice(0, 3).map((row) => row.slice(0, 3)), sourceLandmarks[i]);
    const p: Vec3 = [
      rotated[0] + matrix4x4[0][3],
      rotated[1] + matrix4x4[1][3],
      rotated[2] + matrix4x4[2][3],
    ];
    errors.push(norm3(sub3(p, targetLandmarks[i])));
  }

  const sum = errors.reduce((a, b) => a + b, 0);
  const meanError = errors.length > 0 ? sum / errors.length : 0;
  const rmse = errors.length > 0 ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length) : 0;
  const maxError = errors.length > 0 ? Math.max(...errors) : 0;

  return {
    mode,
    matrix4x4,
    transformedVertices,
    rmse,
    meanError,
    maxError,
    scale,
  };
}
