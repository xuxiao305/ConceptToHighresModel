/**
 * Axial / radial features anchored on a mesh's principal axis.
 *
 * Used to inject "where am I along this part" (axial) and "how far am
 * I from the part's center line" (radial) into a descriptor. These two
 * scalars are extremely effective at breaking the symmetry of mostly-
 * cylindrical parts (arms, legs, cables) where pure local geometric
 * descriptors like FPFH have very low discrimination because every
 * point on the cylinder looks the same.
 *
 * Both values are normalized to [0, 1] using the part's own extent, so
 * the same vertex on Source and Target ends up with comparable values
 * even when the meshes have totally different transforms or scales.
 *
 * PCA axis-direction is sign-ambiguous: the first principal axis can
 * point either way along the part. The matcher must therefore try both
 * conventions on the target side (axial vs 1 - axial) and pick whichever
 * yields more RANSAC inliers; we expose the helpers needed for that.
 */

import { Matrix, EigenvalueDecomposition } from 'ml-matrix';
import type { Vec3 } from './types';

export interface AxialFrame {
  /** Centroid of the vertex set (anchor point of the axis). */
  centroid: Vec3;
  /** Unit-length first principal axis. */
  axis: Vec3;
  /** Min projection on the axis across the vertex set. */
  axialMin: number;
  /** Max projection on the axis across the vertex set. */
  axialMax: number;
  /** Maximum radial distance from the axis across the vertex set. */
  radialMax: number;
}

/**
 * Compute the PCA axis frame from a vertex set.  `verticesSubset` is
 * the index list to use (typically the SAM3-region constraint set on
 * target, or the entire mesh on source).
 */
export function computeAxialFrame(
  vertices: Vec3[],
  verticesSubset: ArrayLike<number>,
): AxialFrame {
  const n = verticesSubset.length;
  if (n === 0) {
    return {
      centroid: [0, 0, 0],
      axis: [1, 0, 0],
      axialMin: 0,
      axialMax: 1,
      radialMax: 1,
    };
  }

  // Centroid
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const v = vertices[verticesSubset[i]];
    cx += v[0]; cy += v[1]; cz += v[2];
  }
  const inv = 1 / n;
  const centroid: Vec3 = [cx * inv, cy * inv, cz * inv];

  // 3x3 covariance matrix (sum of outer products of (p - centroid)).
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const v = vertices[verticesSubset[i]];
    const dx = v[0] - centroid[0];
    const dy = v[1] - centroid[1];
    const dz = v[2] - centroid[2];
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  const cov = new Matrix([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ]);

  // Pull the eigenvector with the largest eigenvalue → principal axis.
  let axis: Vec3 = [1, 0, 0];
  try {
    const evd = new EigenvalueDecomposition(cov);
    const eigvals = evd.realEigenvalues;
    let bestIdx = 0;
    for (let i = 1; i < eigvals.length; i++) {
      if (eigvals[i] > eigvals[bestIdx]) bestIdx = i;
    }
    const evecs = evd.eigenvectorMatrix;
    axis = [
      evecs.get(0, bestIdx),
      evecs.get(1, bestIdx),
      evecs.get(2, bestIdx),
    ];
    const len = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    if (len > 1e-9) {
      axis = [axis[0] / len, axis[1] / len, axis[2] / len];
    } else {
      axis = [1, 0, 0];
    }
  } catch {
    axis = [1, 0, 0];
  }

  // Compute axial range and max radial distance.
  let aMin = Infinity, aMax = -Infinity, rMax = 0;
  for (let i = 0; i < n; i++) {
    const v = vertices[verticesSubset[i]];
    const dx = v[0] - centroid[0];
    const dy = v[1] - centroid[1];
    const dz = v[2] - centroid[2];
    const a = dx * axis[0] + dy * axis[1] + dz * axis[2];
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
    // radial = || (p - centroid) - axis * a ||
    const rx = dx - axis[0] * a;
    const ry = dy - axis[1] * a;
    const rz = dz - axis[2] * a;
    const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (r > rMax) rMax = r;
  }
  if (!isFinite(aMin) || !isFinite(aMax) || aMin === aMax) {
    aMin = 0; aMax = 1;
  }
  if (rMax <= 0) rMax = 1;

  return { centroid, axis, axialMin: aMin, axialMax: aMax, radialMax: rMax };
}

/**
 * Project a vertex into the frame, returning normalized axial and
 * radial coordinates in [0, 1].
 */
export function axialRadialOf(
  vertex: Vec3,
  frame: AxialFrame,
): { axial: number; radial: number } {
  const dx = vertex[0] - frame.centroid[0];
  const dy = vertex[1] - frame.centroid[1];
  const dz = vertex[2] - frame.centroid[2];
  const a = dx * frame.axis[0] + dy * frame.axis[1] + dz * frame.axis[2];
  const rx = dx - frame.axis[0] * a;
  const ry = dy - frame.axis[1] * a;
  const rz = dz - frame.axis[2] * a;
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const axial = (a - frame.axialMin) / (frame.axialMax - frame.axialMin);
  const radial = r / frame.radialMax;
  return {
    axial: Math.max(0, Math.min(1, axial)),
    radial: Math.max(0, Math.min(1, radial)),
  };
}

/**
 * Compute (axial, radial) for a list of vertex indices in batch.
 * Returns a Float32Array of length samples.length * 2 laid out as
 * [a0, r0, a1, r1, ...].
 */
export function computeAxialRadialBatch(
  samples: ArrayLike<number>,
  vertices: Vec3[],
  frame: AxialFrame,
): Float32Array {
  const out = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const ar = axialRadialOf(vertices[samples[i]], frame);
    out[i * 2] = ar.axial;
    out[i * 2 + 1] = ar.radial;
  }
  return out;
}
