/**
 * Global (whole-mesh) landmark-candidate matcher.
 *
 * Use case: source/target meshes are roughly the same shape (e.g. two
 * versions of the same character with slightly different topology) but
 * differ by a global transform.  We don't need a region — instead we
 * pick salient + spatially-spread anchors on each mesh and pair them
 * by descriptor similarity.
 *
 * Algorithm:
 *   1. Saliency on each mesh
 *   2. Top-N salient pool → spatial FPS down to K samples
 *   3. Multi-scale curvature descriptors per sample
 *   4. Mutual-nearest-neighbour matching (best-of-both-sides) for
 *      robustness — only keep pairs that prefer each other
 *   5. Sort by confidence; flag suggestAccept ≥ threshold
 */

import type { Vec3, MeshAdjacency, LandmarkCandidate } from './types';
import {
  bboxDiagonal,
  computeMultiScaleCurvature,
  computeVertexSaliency,
  farthestPointSample,
  pickSalientCandidates,
} from './meshFeatures';

export interface GlobalMatchOptions {
  /** Salient pool size before FPS (default 400) */
  saliencyPool?: number;
  /** Final FPS sample count per mesh (default 60) */
  numSamples?: number;
  /** Curvature ring count (default 3) */
  rings?: number;
  /** softCap for confidence = exp(-d / softCap) (default 0.4) */
  softCap?: number;
  /** Confidence threshold for suggestAccept (default 0.55) */
  acceptThreshold?: number;
  /** Require mutual nearest neighbour to keep the pair (default true) */
  requireMutual?: boolean;
  /** Minimum saliency value to enter the pool (default 0.05 rad) */
  minSaliency?: number;
}

export function matchGlobalCandidates(
  src: { vertices: Vec3[]; adjacency: MeshAdjacency },
  tar: { vertices: Vec3[]; adjacency: MeshAdjacency },
  options: GlobalMatchOptions = {},
): LandmarkCandidate[] {
  const saliencyPool = options.saliencyPool ?? 400;
  const numSamples = options.numSamples ?? 60;
  const rings = options.rings ?? 3;
  const softCap = options.softCap ?? 0.4;
  const acceptThreshold = options.acceptThreshold ?? 0.55;
  const requireMutual = options.requireMutual ?? true;
  const minSaliency = options.minSaliency ?? 0.05;

  // 1+2: salient pool → FPS
  const srcSaliency = computeVertexSaliency(src.adjacency);
  const tarSaliency = computeVertexSaliency(tar.adjacency);
  const srcPool = pickSalientCandidates(srcSaliency, saliencyPool, minSaliency);
  const tarPool = pickSalientCandidates(tarSaliency, saliencyPool, minSaliency);
  if (srcPool.length === 0 || tarPool.length === 0) return [];

  const srcSamples = farthestPointSample(src.vertices, srcPool, numSamples);
  const tarSamples = farthestPointSample(tar.vertices, tarPool, numSamples);

  // 3: multi-scale descriptors
  const srcDesc = computeMultiScaleCurvature(srcSamples, src.adjacency, rings);
  const tarDesc = computeMultiScaleCurvature(tarSamples, tar.adjacency, rings);

  // Scale-normalize the geometric component (not used in distance directly,
  // but we keep the diagonals around for future weighting if needed).
  const _srcDiag = bboxDiagonal(src.vertices);
  const _tarDiag = bboxDiagonal(tar.vertices);
  void _srcDiag; void _tarDiag;

  // 4: pairwise distance matrix + mutual-NN matching
  const ns = srcSamples.length;
  const nt = tarSamples.length;
  if (ns === 0 || nt === 0) return [];

  const dist = new Float32Array(ns * nt);
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nt; j++) {
      let acc = 0;
      for (let r = 0; r < rings; r++) {
        const a = srcDesc[i * rings + r];
        const b = tarDesc[j * rings + r];
        const d = a - b;
        acc += d * d;
      }
      dist[i * nt + j] = acc;
    }
  }

  // For each src, best tar; for each tar, best src
  const srcToBestTar = new Int32Array(ns);
  const srcToBestDist = new Float32Array(ns);
  for (let i = 0; i < ns; i++) {
    let bj = -1, bd = Infinity;
    for (let j = 0; j < nt; j++) {
      const d = dist[i * nt + j];
      if (d < bd) { bd = d; bj = j; }
    }
    srcToBestTar[i] = bj;
    srcToBestDist[i] = bd;
  }
  const tarToBestSrc = new Int32Array(nt);
  for (let j = 0; j < nt; j++) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < ns; i++) {
      const d = dist[i * nt + j];
      if (d < bd) { bd = d; bi = i; }
    }
    tarToBestSrc[j] = bi;
  }

  // 5: assemble output (only mutual matches if required)
  const out: LandmarkCandidate[] = [];
  const usedTar = new Set<number>();
  for (let i = 0; i < ns; i++) {
    const j = srcToBestTar[i];
    if (j < 0) continue;
    if (requireMutual && tarToBestSrc[j] !== i) continue;
    if (usedTar.has(j)) continue;
    usedTar.add(j);
    const d = srcToBestDist[i];
    const confidence = Math.exp(-d / Math.max(softCap, 1e-6));
    const sv = srcSamples[i];
    const tv = tarSamples[j];
    out.push({
      srcVertex: sv,
      srcPosition: src.vertices[sv],
      tarVertex: tv,
      tarPosition: tar.vertices[tv],
      confidence,
      descriptorDist: Math.sqrt(d),
      suggestAccept: confidence >= acceptThreshold,
    });
  }

  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}
