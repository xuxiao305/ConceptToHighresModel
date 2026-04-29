/**
 * Landmark candidate matcher — Phase 2 of the semi-automatic alignment plan.
 *
 * Strategy:
 *   1. Pick K representative source vertices using BFS-layer FPS
 *      (Farthest Point Sampling, geodesic-ish): ensures coverage of the
 *      region, including the seed.
 *   2. For each representative, compute its descriptor and look for the
 *      target-region vertex whose descriptor has minimum L2 distance.
 *   3. Convert raw distance into confidence via a soft-cap normalization,
 *      and flag suggestAccept when confidence ≥ 0.5.
 *
 * See `Document/Design/半自动对齐方案.md` Phase 2 + 借鉴策略.
 */

import type {
  Vec3,
  MeshAdjacency,
  MeshRegion,
  LandmarkCandidate,
  VertexDescriptor,
} from './types';
import {
  computeRegionDescriptors,
  descriptorDistance,
  type RegionDescriptors,
} from './regionDescriptor';

export interface MatchOptions {
  /** Number of representative source candidates (default 5) */
  numCandidates?: number;
  /**
   * Soft-cap descriptor distance for confidence normalization.
   * confidence = exp(-distance / softCap).
   * Lower softCap → stricter; default 0.6.
   */
  softCap?: number;
  /** Confidence threshold above which suggestAccept = true (default 0.5) */
  acceptThreshold?: number;
}

export interface MatchInput {
  region: MeshRegion;
  vertices: Vec3[];
  adjacency: MeshAdjacency;
}

export function matchRegionCandidates(
  src: MatchInput,
  tar: MatchInput,
  options: MatchOptions = {},
): LandmarkCandidate[] {
  const numCandidates = options.numCandidates ?? 5;
  const softCap = options.softCap ?? 0.6;
  const acceptThreshold = options.acceptThreshold ?? 0.5;

  const srcDesc = computeRegionDescriptors(src.region, src.vertices, src.adjacency);
  const tarDesc = computeRegionDescriptors(tar.region, tar.vertices, tar.adjacency);

  const repSrc = farthestSampleByLayer(src.region, numCandidates);

  // Cache target descriptors as a flat array for the inner loop
  const tarVertices = Array.from(tar.region.vertices);
  const tarDescriptors: VertexDescriptor[] = tarVertices.map(
    (v) => tarDesc.perVertex.get(v) as VertexDescriptor,
  );

  const usedTar = new Set<number>(); // avoid mapping the same target vertex twice

  const candidates: LandmarkCandidate[] = [];
  for (const sv of repSrc) {
    const sd = srcDesc.perVertex.get(sv);
    if (!sd) continue;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < tarDescriptors.length; i++) {
      const tv = tarVertices[i];
      if (usedTar.has(tv)) continue;
      const d = descriptorDistance(sd, tarDescriptors[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) continue;
    const tv = tarVertices[bestIdx];
    usedTar.add(tv);

    const confidence = Math.exp(-bestDist / Math.max(softCap, 1e-6));
    candidates.push({
      srcVertex: sv,
      srcPosition: src.vertices[sv],
      tarVertex: tv,
      tarPosition: tar.vertices[tv],
      confidence,
      descriptorDist: bestDist,
      suggestAccept: confidence >= acceptThreshold,
    });
  }

  // Sort by confidence descending so UI can rank them
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

// ---------------------------------------------------------------------------
// Farthest Point Sampling (BFS-layer based — cheap geodesic proxy)
// ---------------------------------------------------------------------------

/**
 * Pick `k` vertices that are spread across the region using BFS-layer
 * distances as a proxy for geodesic distance.
 *
 * Always includes the seed as the first sample; subsequent samples are
 * chosen to maximize the minimum BFS-layer distance to the existing
 * samples (with the seed acting as the origin).
 */
function farthestSampleByLayer(region: MeshRegion, k: number): number[] {
  const verts = Array.from(region.vertices);
  if (verts.length === 0) return [];
  if (k >= verts.length) return verts;

  const samples: number[] = [region.seedVertex];
  if (k === 1) return samples;

  // For each vertex, the layer (BFS depth from seed)
  const layerOf = (v: number) => region.vertexLayer.get(v) ?? 0;

  // Distance proxy between two region vertices = abs diff of their BFS layers.
  // (True geodesic would be more accurate; this is enough for spreading.)
  while (samples.length < k) {
    let bestV = -1;
    let bestMinDist = -1;
    for (const v of verts) {
      if (samples.includes(v)) continue;
      const lv = layerOf(v);
      let minToSamples = Infinity;
      for (const s of samples) {
        const ds = Math.abs(lv - layerOf(s));
        if (ds < minToSamples) minToSamples = ds;
      }
      if (minToSamples > bestMinDist) {
        bestMinDist = minToSamples;
        bestV = v;
      }
    }
    if (bestV < 0) break;
    samples.push(bestV);
  }

  return samples;
}

// Re-export the descriptor helper so callers only need this file
export type { RegionDescriptors };
