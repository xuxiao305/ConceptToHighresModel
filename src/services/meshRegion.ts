/**
 * Pure helpers for building MeshRegion objects from various inputs.
 *
 * Extracted from V1 ModelAssemble.tsx (buildTarRegionFromSet, L1570-L1593).
 * Used by both V1 and V2 to convert a SAM3 mask reprojection set
 * (vertex indices) into a synthetic MeshRegion that the partial-match
 * pipeline can consume.
 *
 * No React, no I/O, no logging — safe to call from any module.
 */

import type { MeshRegion, Vec3 } from '../three';

/**
 * Build a synthetic MeshRegion from a flat vertex index set.
 *
 * The returned region is missing real BFS layer info because a
 * reprojected pixel-region is not BFS-derived; downstream consumers
 * (partial-match, ICP) only read centroid + boundingRadius + vertices,
 * so seedVertex / vertexLayer / finalSteps / stopReason are cosmetic.
 *
 * Returns null when the set is empty.
 */
export function buildMeshRegionFromVertexSet(
  vertices: Vec3[],
  set: Set<number>,
): MeshRegion | null {
  if (set.size === 0) return null;

  let cx = 0, cy = 0, cz = 0;
  for (const idx of set) {
    const v = vertices[idx];
    cx += v[0]; cy += v[1]; cz += v[2];
  }
  const inv = 1 / set.size;
  const centroid: Vec3 = [cx * inv, cy * inv, cz * inv];

  let r2max = 0;
  for (const idx of set) {
    const v = vertices[idx];
    const dx = v[0] - centroid[0];
    const dy = v[1] - centroid[1];
    const dz = v[2] - centroid[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2max) r2max = d2;
  }
  const boundingRadius = Math.sqrt(r2max);

  const seedVertex = set.values().next().value as number;
  return {
    seedVertex,
    vertices: new Set(set),
    vertexLayer: new Map(),
    centroid,
    boundingRadius,
    finalSteps: 0,
    stopReason: 'frontier-empty',
  };
}
