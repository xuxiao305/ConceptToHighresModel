/**
 * Region descriptor — Phase 2 (lite version) of the semi-automatic alignment plan.
 *
 * For every vertex inside a region we compute a small, scale-invariant,
 * roughly rotation-invariant feature vector that the candidate matcher
 * can compare across source and target regions.
 *
 * Channels (5D, see `Document/Design/半自动对齐方案.md`):
 *   - radialNormalized   : how far from region centroid (0..1)
 *   - cosToRegionNormal  : alignment with region average normal
 *   - cosToSeedNormal    : alignment with seed normal
 *   - layerNormalized    : geodesic-ish ring distance from seed (0..1)
 *   - localCurvature     : avg normal-deflection to 1-ring neighbours (0..1)
 *
 * Notes: full HKS/WKS spectra (Functional Map style) is intentionally
 * deferred — see the design doc § "借鉴策略".
 */

import type {
  Vec3,
  MeshAdjacency,
  MeshRegion,
  VertexDescriptor,
} from './types';

export interface RegionDescriptors {
  /** Average normal of all region vertices (unit) */
  regionNormal: Vec3;
  /** vertex index → descriptor */
  perVertex: Map<number, VertexDescriptor>;
}

export function computeRegionDescriptors(
  region: MeshRegion,
  vertices: Vec3[],
  adjacency: MeshAdjacency,
): RegionDescriptors {
  const regionNormal = averageRegionNormal(region, adjacency);
  const seedNormal = adjacency.vertexNormals[region.seedVertex] ?? regionNormal;

  let maxLayer = 0;
  for (const l of region.vertexLayer.values()) if (l > maxLayer) maxLayer = l;
  const layerInv = maxLayer > 0 ? 1 / maxLayer : 1;
  const radiusInv = region.boundingRadius > 1e-9 ? 1 / region.boundingRadius : 1;

  const perVertex = new Map<number, VertexDescriptor>();

  for (const v of region.vertices) {
    const p = vertices[v];
    const dx = p[0] - region.centroid[0];
    const dy = p[1] - region.centroid[1];
    const dz = p[2] - region.centroid[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const radial = clamp01(dist * radiusInv);

    const n = adjacency.vertexNormals[v] ?? [0, 1, 0];
    const cosRegion = clampUnit(
      n[0] * regionNormal[0] + n[1] * regionNormal[1] + n[2] * regionNormal[2],
    );
    const cosSeed = clampUnit(
      n[0] * seedNormal[0] + n[1] * seedNormal[1] + n[2] * seedNormal[2],
    );

    const layer = region.vertexLayer.get(v) ?? 0;
    const layerNorm = clamp01(layer * layerInv);

    const localCurv = localCurvatureFor(v, n, region, adjacency);

    perVertex.set(v, {
      vertex: v,
      radialNormalized: radial,
      cosToRegionNormal: cosRegion,
      cosToSeedNormal: cosSeed,
      layerNormalized: layerNorm,
      localCurvature: localCurv,
    });
  }

  return { regionNormal, perVertex };
}

/**
 * Squared L2 distance between two vertex descriptors.
 * All channels are roughly in [-1..1] or [0..1], so unweighted L2 is fine.
 *
 * Weights down-weight the global "where in the region" channels and
 * emphasize local shape signals.
 */
export function descriptorDistance(
  a: VertexDescriptor,
  b: VertexDescriptor,
): number {
  const wRadial = 1.0;
  const wRegion = 1.5;
  const wSeed = 1.5;
  const wLayer = 0.6;
  const wCurv = 2.0;

  const dRadial = a.radialNormalized - b.radialNormalized;
  const dRegion = a.cosToRegionNormal - b.cosToRegionNormal;
  const dSeed = a.cosToSeedNormal - b.cosToSeedNormal;
  const dLayer = a.layerNormalized - b.layerNormalized;
  const dCurv = a.localCurvature - b.localCurvature;

  return (
    wRadial * dRadial * dRadial +
    wRegion * dRegion * dRegion +
    wSeed * dSeed * dSeed +
    wLayer * dLayer * dLayer +
    wCurv * dCurv * dCurv
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function averageRegionNormal(
  region: MeshRegion,
  adjacency: MeshAdjacency,
): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (const v of region.vertices) {
    const n = adjacency.vertexNormals[v];
    if (!n) continue;
    nx += n[0]; ny += n[1]; nz += n[2];
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function localCurvatureFor(
  v: number,
  vNormal: Vec3,
  region: MeshRegion,
  adjacency: MeshAdjacency,
): number {
  const neigh = adjacency.vertexNeighbors.get(v);
  if (!neigh || neigh.size === 0) return 0;

  let count = 0;
  let sumDeflection = 0;
  for (const m of neigh) {
    if (!region.vertices.has(m)) continue; // restrict to region
    const nm = adjacency.vertexNormals[m];
    if (!nm) continue;
    const cos = clampUnit(
      vNormal[0] * nm[0] + vNormal[1] * nm[1] + vNormal[2] * nm[2],
    );
    sumDeflection += Math.acos(cos); // 0..π
    count++;
  }
  if (count === 0) return 0;
  // Normalize to 0..1 (π = π so /π)
  return clamp01(sumDeflection / count / Math.PI);
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampUnit(x: number) {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
