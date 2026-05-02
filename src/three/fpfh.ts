/**
 * FPFH — Fast Point Feature Histograms (Rusu et al. 2009), optimized.
 *
 * Performance-critical design choices:
 *
 *   - Spatial hash replaces BFS for radius queries.
 *     BFS on a dense mesh traverses thousands of edges per query and
 *     recurses into neighbor SPFHs — O(K²) total which blocks the UI.
 *     Spatial hash does O(27 * avg_cell_density) per query → 100-1000×
 *     faster on character meshes.
 *
 *   - Simplified FPFH (SPFH only, no weighted neighbor accumulation).
 *     True FPFH calls bfsRadius for every neighbor of every seed to get
 *     the neighbor's own SPFH.  For 200 seeds × 100 neighbors that's
 *     20 000 additional radius queries — prohibitive.  SPFH alone gives
 *     ~80% of the discriminative power and runs in O(N×K).
 *
 * SPFH per point:
 *   For each vertex m within radius of seed s, build a Darboux frame
 *   and compute three angular features α, φ, θ binned into `subdivisions`
 *   (default 11) bins each → 33-dim vector.
 */

import type { Vec3, MeshAdjacency } from './types';

export const FPFH_DIM = 33; // 3 channels × 11 bins (at default subdivisions)

export interface FPFHTimingEvent {
  label?: string;
  scaleIndex: number;
  radius: number;
  seedCount: number;
  vertexCount: number;
  subdivisions: number;
  spatialHashMs: number;
  fpfhSpfhMs: number;
}

interface FPFHTimingOptions {
  label?: string;
  onTiming?: (event: FPFHTimingEvent) => void;
}

const nowMs = () => performance.now();

// ---------------------------------------------------------------------------
// Spatial hash (replaces BFS for radius queries)
// ---------------------------------------------------------------------------

interface SpatialHash {
  cells: Map<string, number[]>;
  cellSize: number;
  vertices: Vec3[];
}

function buildSpatialHash(vertices: Vec3[], cellSize: number): SpatialHash {
  const cs = Math.max(cellSize, 1e-9);
  const cells = new Map<string, number[]>();
  for (let i = 0; i < vertices.length; i++) {
    const [x, y, z] = vertices[i];
    const key = `${Math.floor(x / cs)},${Math.floor(y / cs)},${Math.floor(z / cs)}`;
    let cell = cells.get(key);
    if (!cell) { cell = []; cells.set(key, cell); }
    cell.push(i);
  }
  return { cells, cellSize: cs, vertices };
}

function queryRadius(hash: SpatialHash, pos: Vec3, radius: number): number[] {
  const { cells, cellSize, vertices } = hash;
  const r2 = radius * radius;
  const cx = Math.floor(pos[0] / cellSize);
  const cy = Math.floor(pos[1] / cellSize);
  const cz = Math.floor(pos[2] / cellSize);
  const span = Math.ceil(radius / cellSize);
  const result: number[] = [];
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      for (let dz = -span; dz <= span; dz++) {
        const cell = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!cell) continue;
        for (const idx of cell) {
          const [vx, vy, vz] = vertices[idx];
          const ddx = vx - pos[0], ddy = vy - pos[1], ddz = vz - pos[2];
          if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) result.push(idx);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// SPFH batch computation (spatial hash based)
// ---------------------------------------------------------------------------

function computeSPFHBatch(
  seedIndices: number[],
  vertices: Vec3[],
  normals: Vec3[],
  hash: SpatialHash,
  radius: number,
  subdivisions: number,
): Float32Array {
  const dim = subdivisions * 3;
  const out = new Float32Array(seedIndices.length * dim);

  for (let si = 0; si < seedIndices.length; si++) {
    const seed = seedIndices[si];
    const sp = vertices[seed];
    const sn = normals[seed];
    if (!sp || !sn) continue;

    const neighs = queryRadius(hash, sp, radius);
    if (neighs.length === 0) continue;

    const base = si * dim;

    for (const m of neighs) {
      if (m === seed) continue;
      const mp = vertices[m];
      const mn = normals[m];
      if (!mp || !mn) continue;

      let dx = mp[0] - sp[0], dy = mp[1] - sp[1], dz = mp[2] - sp[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-12) continue;
      dx /= dist; dy /= dist; dz /= dist;

      // Darboux frame
      let vx = dy * sn[2] - dz * sn[1];
      let vy = dz * sn[0] - dx * sn[2];
      let vz = dx * sn[1] - dy * sn[0];
      const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vlen < 1e-12) continue;
      vx /= vlen; vy /= vlen; vz /= vlen;

      const wx = sn[1] * vz - sn[2] * vy;
      const wy = sn[2] * vx - sn[0] * vz;
      const wz = sn[0] * vy - sn[1] * vx;

      const alpha = clampUnit(vx * mn[0] + vy * mn[1] + vz * mn[2]);
      const phi   = clampUnit(sn[0] * dx + sn[1] * dy + sn[2] * dz);
      const theta = Math.atan2(
        wx * mn[0] + wy * mn[1] + wz * mn[2],
        sn[0] * mn[0] + sn[1] * mn[1] + sn[2] * mn[2],
      );

      out[base + clampBin(((alpha + 1) / 2) * subdivisions, subdivisions)]++;
      out[base + subdivisions + clampBin(((phi + 1) / 2) * subdivisions, subdivisions)]++;
      out[base + 2 * subdivisions + clampBin(((theta + Math.PI) / (2 * Math.PI)) * subdivisions, subdivisions)]++;
    }

    // L1-normalise each sub-histogram
    for (let block = 0; block < 3; block++) {
      let sum = 0;
      for (let b = 0; b < subdivisions; b++) sum += out[base + block * subdivisions + b];
      if (sum > 0) {
        const inv = 1 / sum;
        for (let b = 0; b < subdivisions; b++) out[base + block * subdivisions + b] *= inv;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute FPFH (simplified) for `seedIndices`.
 * Builds a spatial hash for O(1) radius queries — fast on dense meshes.
 */
export function computeFPFH(
  seedIndices: number[],
  vertices: Vec3[],
  adjacency: MeshAdjacency,
  radius: number,
  subdivisions = 11,
  timing?: FPFHTimingOptions,
): Float32Array {
  const hashT0 = nowMs();
  const hash = buildSpatialHash(vertices, radius / 2);
  const spatialHashMs = nowMs() - hashT0;
  const spfhT0 = nowMs();
  const out = computeSPFHBatch(seedIndices, vertices, adjacency.vertexNormals, hash, radius, subdivisions);
  const fpfhSpfhMs = nowMs() - spfhT0;
  timing?.onTiming?.({
    label: timing.label,
    scaleIndex: 0,
    radius,
    seedCount: seedIndices.length,
    vertexCount: vertices.length,
    subdivisions,
    spatialHashMs,
    fpfhSpfhMs,
  });
  return out;
}

/**
 * Multi-scale FPFH: stack descriptors at multiple radii.
 * Output dim = radiusList.length × (subdivisions × 3).
 */
export function computeMultiScaleFPFH(
  seedIndices: number[],
  vertices: Vec3[],
  adjacency: MeshAdjacency,
  radiusList: number[],
  subdivisions = 11,
  timing?: FPFHTimingOptions,
): Float32Array {
  const dimPerScale = subdivisions * 3;
  const totalDim = radiusList.length * dimPerScale;
  const out = new Float32Array(seedIndices.length * totalDim);
  const normals = adjacency.vertexNormals;

  for (let ri = 0; ri < radiusList.length; ri++) {
    const radius = radiusList[ri];
    const hashT0 = nowMs();
    const hash = buildSpatialHash(vertices, radius / 2);
    const spatialHashMs = nowMs() - hashT0;
    const spfhT0 = nowMs();
    const part = computeSPFHBatch(seedIndices, vertices, normals, hash, radius, subdivisions);
    const fpfhSpfhMs = nowMs() - spfhT0;
    timing?.onTiming?.({
      label: timing.label,
      scaleIndex: ri,
      radius,
      seedCount: seedIndices.length,
      vertexCount: vertices.length,
      subdivisions,
      spatialHashMs,
      fpfhSpfhMs,
    });
    for (let si = 0; si < seedIndices.length; si++) {
      const baseOut = si * totalDim + ri * dimPerScale;
      const basePart = si * dimPerScale;
      for (let d = 0; d < dimPerScale; d++) out[baseOut + d] = part[basePart + d];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampBin(v: number, max: number): number {
  const b = Math.floor(v);
  return b < 0 ? 0 : b >= max ? max - 1 : b;
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
