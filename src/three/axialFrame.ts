/**
 * Axial / radial / azimuth features anchored on a mesh's principal axis.
 *
 * Used to inject "where am I along this part" (axial), "how far am I
 * from the part's center line" (radial), and "which side of the part am
 * I on" (azimuth = cos θ, sin θ in the cross-section plane) into a
 * descriptor.  These features are decisive on near-cylindrical parts
 * (arms, legs, cables) where pure local geometric descriptors like FPFH
 * have very low discrimination because every point on the cylinder
 * looks the same locally.
 *
 * axial / radial are normalized to [0, 1] using the part's own extent.
 * Azimuth is dimensionless. All values are computed against a Source
 * frame and a Target frame independently, so the same vertex on Source
 * and Target ends up with comparable values regardless of transform.
 *
 * Sign / orientation ambiguity:
 *   - axis sign: the principal eigenvector can point either way along
 *     the part. The matcher tries both (axial vs 1 - axial).
 *   - azimuth sign: axis2 has an arbitrary orientation around `axis`,
 *     and axis3 = axis × axis2 inherits that ambiguity. The matcher
 *     tries the four combinations (cos θ, sin θ) vs (cos θ, -sin θ) vs
 *     (-cos θ, sin θ) vs (-cos θ, -sin θ) and picks the one with the
 *     highest RANSAC inlier count.
 */

import { Matrix, EigenvalueDecomposition } from 'ml-matrix';
import type { Vec3 } from './types';

export interface AxialFrame {
  /** Centroid of the vertex set (anchor point of the axis). */
  centroid: Vec3;
  /** Unit-length first principal axis. */
  axis: Vec3;
  /**
   * Unit-length 2nd principal axis (largest variance perpendicular to
   * `axis`). Together with `axis3` defines the cross-section basis used
   * for azimuthal angle (cos θ, sin θ) features.
   */
  axis2: Vec3;
  /** Unit-length 3rd principal axis. Equals `axis × axis2` (right-handed). */
  axis3: Vec3;
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
      axis2: [0, 1, 0],
      axis3: [0, 0, 1],
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

  // Pull eigenvectors. axis = largest-eigenvalue dir (length).  axis2 =
  // second-largest (cross-section "width" direction).  axis3 = axis ×
  // axis2 (right-handed) so the (axis2, axis3) plane is exactly the
  // cross-section perpendicular to axis.
  let axis: Vec3 = [1, 0, 0];
  let axis2: Vec3 = [0, 1, 0];
  try {
    const evd = new EigenvalueDecomposition(cov);
    const eigvals = evd.realEigenvalues;
    // Sort eigenvalue indices in descending order.
    const order = [0, 1, 2].sort((a, b) => eigvals[b] - eigvals[a]);
    const evecs = evd.eigenvectorMatrix;
    const colTo = (col: number): Vec3 => [
      evecs.get(0, col),
      evecs.get(1, col),
      evecs.get(2, col),
    ];
    const norm = (v: Vec3): Vec3 => {
      const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      return len > 1e-9 ? [v[0] / len, v[1] / len, v[2] / len] : v;
    };
    axis = norm(colTo(order[0]));
    axis2 = norm(colTo(order[1]));
    // Re-orthogonalize axis2 against axis (numerical safety).
    const dot = axis[0] * axis2[0] + axis[1] * axis2[1] + axis[2] * axis2[2];
    axis2 = norm([
      axis2[0] - axis[0] * dot,
      axis2[1] - axis[1] * dot,
      axis2[2] - axis[2] * dot,
    ]);
  } catch {
    axis = [1, 0, 0];
    axis2 = [0, 1, 0];
  }
  // axis3 = axis × axis2 (right-handed cross-section basis).
  const axis3: Vec3 = [
    axis[1] * axis2[2] - axis[2] * axis2[1],
    axis[2] * axis2[0] - axis[0] * axis2[2],
    axis[0] * axis2[1] - axis[1] * axis2[0],
  ];

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

  return { centroid, axis, axis2, axis3, axialMin: aMin, axialMax: aMax, radialMax: rMax };
}

/**
 * Project a vertex into the frame, returning normalized axial / radial
 * scalars plus the azimuth angle around `axis` expressed as (cos θ,
 * sin θ).  θ is measured from `axis2` toward `axis3` in the cross-
 * section plane and is the key feature for resolving "elbow points
 * outward vs backward" type confusions on cylindrical parts.
 */
export function axialRadialOf(
  vertex: Vec3,
  frame: AxialFrame,
): { axial: number; radial: number; cosAz: number; sinAz: number } {
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
  // Azimuth: project the radial vector onto (axis2, axis3).
  let cosAz = 0;
  let sinAz = 0;
  if (r > 1e-9) {
    const u =
      (rx * frame.axis2[0] + ry * frame.axis2[1] + rz * frame.axis2[2]) / r;
    const v =
      (rx * frame.axis3[0] + ry * frame.axis3[1] + rz * frame.axis3[2]) / r;
    cosAz = u;
    sinAz = v;
  }
  return {
    axial: Math.max(0, Math.min(1, axial)),
    radial: Math.max(0, Math.min(1, radial)),
    cosAz,
    sinAz,
  };
}

/**
 * Compute (axial, radial, cosAz, sinAz) for a list of vertex indices in
 * batch.  Returns a Float32Array of length samples.length * 4 laid out
 * as [a0, r0, c0, s0, a1, r1, c1, s1, ...].
 */
export function computeAxialRadialBatch(
  samples: ArrayLike<number>,
  vertices: Vec3[],
  frame: AxialFrame,
): Float32Array {
  const out = new Float32Array(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    const ar = axialRadialOf(vertices[samples[i]], frame);
    out[i * 4] = ar.axial;
    out[i * 4 + 1] = ar.radial;
    out[i * 4 + 2] = ar.cosAz;
    out[i * 4 + 3] = ar.sinAz;
  }
  return out;
}
