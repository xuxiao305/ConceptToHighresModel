/**
 * Region grow — BFS-based connected-region expansion from a seed vertex.
 *
 * Phase 1 of the semi-automatic alignment plan
 * (see `Document/Design/半自动对齐方案.md`).
 *
 * Stop conditions (all checked simultaneously):
 *   1. BFS frontier becomes empty (no more reachable neighbours)
 *   2. Layer index reaches `maxSteps`
 *   3. Region size reaches `maxVertices`
 *
 * Curvature pruning rejects neighbouring vertices whose normal deviates
 * from the seed normal by more than `curvatureThreshold` radians.
 */

import type { Vec3, MeshAdjacency, MeshRegion, RegionGrowOptions } from './types';

const DEFAULT_MAX_STEPS = 15;
const DEFAULT_MAX_VERTICES = 2000;
const DEFAULT_CURVATURE = Math.PI / 3;

export function growRegion(
  seedVertex: number,
  vertices: Vec3[],
  adjacency: MeshAdjacency,
  options: RegionGrowOptions = {},
): MeshRegion {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES;
  const curvatureThreshold = options.curvatureThreshold ?? DEFAULT_CURVATURE;

  // Always work in canonical (welded) index space so seams don't break BFS.
  const seedCanon = adjacency.weldedIndex[seedVertex] ?? seedVertex;
  const cosThreshold = Math.cos(Math.min(curvatureThreshold, Math.PI));
  const seedNormal = adjacency.vertexNormals[seedCanon];
  const useCurvature = curvatureThreshold < Math.PI - 1e-3 && !!seedNormal;

  const visited = new Set<number>([seedCanon]);
  const vertexLayer = new Map<number, number>([[seedCanon, 0]]);
  let frontier: number[] = [seedCanon];
  let stopReason: MeshRegion['stopReason'] = 'frontier-empty';
  let stepsTaken = 0;

  outer: for (let step = 0; step < maxSteps; step++) {
    if (frontier.length === 0) {
      stopReason = 'frontier-empty';
      break;
    }
    const next: number[] = [];
    const nextLayer = step + 1;
    for (const v of frontier) {
      const neigh = adjacency.vertexNeighbors.get(v);
      if (!neigh) continue;
      for (const n of neigh) {
        if (visited.has(n)) continue;
        if (useCurvature) {
          const nn = adjacency.vertexNormals[n];
          if (nn) {
            const cos =
              seedNormal[0] * nn[0] + seedNormal[1] * nn[1] + seedNormal[2] * nn[2];
            if (cos < cosThreshold) continue;
          }
        }
        visited.add(n);
        vertexLayer.set(n, nextLayer);
        next.push(n);
        if (visited.size >= maxVertices) {
          stopReason = 'max-vertices';
          stepsTaken = step + 1;
          break outer;
        }
      }
    }
    stepsTaken = step + 1;
    if (next.length === 0) {
      stopReason = 'frontier-empty';
      break;
    }
    frontier = next;
    if (step + 1 >= maxSteps) {
      stopReason = 'max-steps';
    }
  }

  // Centroid + bounding radius (in original world coordinates of canonical verts)
  let cx = 0, cy = 0, cz = 0;
  for (const v of visited) {
    const p = vertices[v];
    cx += p[0]; cy += p[1]; cz += p[2];
  }
  const inv = 1 / Math.max(visited.size, 1);
  const centroid: Vec3 = [cx * inv, cy * inv, cz * inv];

  let r2 = 0;
  for (const v of visited) {
    const [x, y, z] = vertices[v];
    const dx = x - centroid[0];
    const dy = y - centroid[1];
    const dz = z - centroid[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  const boundingRadius = Math.sqrt(r2);

  return {
    seedVertex: seedCanon,
    vertices: visited,
    vertexLayer,
    centroid,
    boundingRadius,
    finalSteps: stepsTaken,
    stopReason,
  };
}

/**
 * Convert a region's vertex set to a flat Vec3[] of positions
 * (useful for debug overlays or quick checks).
 */
export function regionPositions(region: MeshRegion, vertices: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const v of region.vertices) out.push(vertices[v]);
  return out;
}
