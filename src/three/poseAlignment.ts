/**
 * poseAlignment.ts
 *
 * SVD coarse alignment using skeleton proxy anchors from Source and
 * Target meshes. Pairs anchors by kind, applies optional per-kind weights,
 * runs similarity/rigid SVD fit, and returns the alignment result.
 */

import { computeLandmarkAlignment, applyTransform } from './alignment';
import type { AlignmentMode } from './alignment';
import type { Vec3 } from './types';
import type {
  SkeletonProxyResult,
  ProxyAnchor,
  PoseAlignmentOptions,
  PoseAlignmentResult,
} from './types';

// ── Anchor pairing ──────────────────────────────────────────────────────

interface AnchorPair {
  kind: string;
  source: Vec3;
  target: Vec3;
  weight: number;
  confidence: number;
}

/**
 * Extract anchor pairs from Source and Target skeleton proxies.
 * Matches anchors by their `kind` field and applies weights.
 */
function pairAnchors(
  sourceProxy: SkeletonProxyResult,
  targetProxy: SkeletonProxyResult,
  anchorWeights?: Record<string, number>,
): AnchorPair[] {
  const pairs: AnchorPair[] = [];

  // Collect all named anchors from both sides
  const sourceMap = collectNamedAnchors(sourceProxy);
  const targetMap = collectNamedAnchors(targetProxy);

  // Default weights for anchor kinds
  const defaultWeights: Record<string, number> = {
    torso_axis: 1.0,
    shoulder_line: 0.8,
    left_sleeve_near: 1.0,
    left_sleeve_far: 1.0,
    right_sleeve_near: 1.0,
    right_sleeve_far: 1.0,
    left_upper_arm: 0.9,
    left_forearm: 0.7,
    right_upper_arm: 0.9,
    right_forearm: 0.7,
  };

  for (const [kind, srcAnchor] of sourceMap) {
    const tgtAnchor = targetMap.get(kind);
    if (!tgtAnchor) continue;

    const weight = anchorWeights?.[kind]
      ?? defaultWeights[kind]
      ?? 1.0;

    const confidence = Math.min(srcAnchor.confidence, tgtAnchor.confidence);
    if (confidence <= 0) continue;

    pairs.push({
      kind,
      source: srcAnchor.position,
      target: tgtAnchor.position,
      weight: weight * confidence,
      confidence,
    });
  }

  return pairs;
}

/**
 * Collect named anchors from a SkeletonProxyResult into a Map.
 * Includes the top-level named fields and all entries in the anchors array.
 */
function collectNamedAnchors(
  proxy: SkeletonProxyResult,
): Map<string, ProxyAnchor> {
  const map = new Map<string, ProxyAnchor>();

  const add = (name: string, a: ProxyAnchor | undefined) => {
    if (a) map.set(name, a);
  };

  add('torso_axis', proxy.torsoAxis);
  add('shoulder_line', proxy.shoulderLine);
  add('left_sleeve_near', proxy.leftSleeveNear);
  add('left_sleeve_far', proxy.leftSleeveFar);
  add('right_sleeve_near', proxy.rightSleeveNear);
  add('right_sleeve_far', proxy.rightSleeveFar);

  for (const a of proxy.anchors) {
    // Don't overwrite top-level named anchors
    if (!map.has(a.kind)) {
      map.set(a.kind, a);
    }
  }

  return map;
}

// ── Anomaly checks ──────────────────────────────────────────────────────

function checkLeftRightSwap(
  pairs: AnchorPair[],
): boolean {
  const leftNear = pairs.find((p) => p.kind === 'left_sleeve_near');
  const rightNear = pairs.find((p) => p.kind === 'right_sleeve_near');
  if (!leftNear || !rightNear) return false;

  // If the "left" sleeve anchor in source is closer to the
  // "right" sleeve anchor in target than to its own counterpart,
  // we might have a swap.
  const dxCorrect = leftNear.source[0] - leftNear.target[0];
  const dyCorrect = leftNear.source[1] - leftNear.target[1];
  const dzCorrect = leftNear.source[2] - leftNear.target[2];
  const distCorrect = Math.sqrt(dxCorrect * dxCorrect + dyCorrect * dyCorrect + dzCorrect * dzCorrect);

  const dxSwap = leftNear.source[0] - rightNear.target[0];
  const dySwap = leftNear.source[1] - rightNear.target[1];
  const dzSwap = leftNear.source[2] - rightNear.target[2];
  const distSwap = Math.sqrt(dxSwap * dxSwap + dySwap * dySwap + dzSwap * dzSwap);

  return distSwap < distCorrect * 0.7;
}

// ── Weighted SVD ────────────────────────────────────────────────────────

/**
 * Run weighted SVD similarity/rigid fit using anchor pairs.
 *
 * Weight is applied by duplicating landmarks proportionally
 * (scaled so that weight=1.0 → 1 copy).
 */
function weightedSVD(
  pairs: AnchorPair[],
  mode: AlignmentMode,
): ReturnType<typeof computeLandmarkAlignment> {
  if (pairs.length < 3) {
    throw new Error(`Need at least 3 anchor pairs, got ${pairs.length}`);
  }

  // Expand landmark lists by weight
  const srcLandmarks: Vec3[] = [];
  const tgtLandmarks: Vec3[] = [];

  // Find max weight for normalization
  const maxWeight = Math.max(...pairs.map((p) => p.weight), 1e-6);

  for (const pair of pairs) {
    // Scale copies: weight 1.0 = 1 copy, weight 0.3 = 1 copy (floor)
    const copies = Math.max(1, Math.round(pair.weight / maxWeight));
    for (let i = 0; i < copies; i++) {
      srcLandmarks.push([...pair.source] as Vec3);
      tgtLandmarks.push([...pair.target] as Vec3);
    }
  }

  return computeLandmarkAlignment(srcLandmarks, tgtLandmarks, mode);
}

// ── Error computation ───────────────────────────────────────────────────

function bboxDiagonal(proxy: SkeletonProxyResult): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const allPositions: Vec3[] = [];
  for (const a of proxy.anchors) allPositions.push(a.position);
  if (proxy.shoulderLine) allPositions.push(proxy.shoulderLine.position);
  if (proxy.torsoAxis) allPositions.push(proxy.torsoAxis.position);
  if (proxy.leftSleeveNear) allPositions.push(proxy.leftSleeveNear.nearPosition, proxy.leftSleeveNear.farPosition);
  if (proxy.rightSleeveNear) allPositions.push(proxy.rightSleeveNear.nearPosition, proxy.rightSleeveNear.farPosition);

  for (const [x, y, z] of allPositions) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) return 1;
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeAnchorError(
  src: Vec3,
  tgt: Vec3,
  matrix4x4: number[][],
): number {
  const transformed = applyTransform(src, matrix4x4);
  const dx = transformed[0] - tgt[0];
  const dy = transformed[1] - tgt[1];
  const dz = transformed[2] - tgt[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Main ────────────────────────────────────────────────────────────────

/**
 * Run pose-based skeleton proxy alignment.
 *
 * Pairs skeleton proxy anchors from Source and Target meshes by kind,
 * applies per-kind weight overrides, and runs SVD similarity/rigid fit.
 *
 * @param sourceProxy - Source mesh skeleton proxy
 * @param targetProxy - Target mesh skeleton proxy
 * @param options - Alignment options
 * @returns PoseAlignmentResult with transform matrix and diagnostics
 */
export function computePoseAlignment(
  sourceProxy: SkeletonProxyResult,
  targetProxy: SkeletonProxyResult,
  options: PoseAlignmentOptions = {},
): PoseAlignmentResult {
  const {
    svdMode = 'similarity',
    anchorWeights,
  } = options;

  const warnings: string[] = [];

  // Pair anchors
  const pairs = pairAnchors(sourceProxy, targetProxy, anchorWeights);

  // Check for left/right swap
  const swapped = checkLeftRightSwap(pairs);
  if (swapped) {
    warnings.push('Possible left/right sleeve swap detected');
  }

  // Filter to high-confidence pairs
  const confidentPairs = pairs.filter((p) => p.weight > 0.1);
  if (confidentPairs.length < 3) {
    warnings.push(
      `Only ${confidentPairs.length} confident anchor pairs (need ≥3); ` +
      `using all ${pairs.length} pairs`,
    );
  }
  const usePairs = confidentPairs.length >= 3 ? confidentPairs : pairs;

  if (usePairs.length < 3) {
    return {
      matrix4x4: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      svdRmse: Infinity,
      scale: 1,
      anchorPairCount: usePairs.length,
      anchorErrors: [],
      sourceProxy,
      targetProxy,
      warnings: [...warnings, `Insufficient anchor pairs: ${usePairs.length}`],
      reliable: false,
    };
  }

  // Run SVD
  const { matrix4x4, scale } = weightedSVD(usePairs, svdMode);

  // Compute per-anchor errors
  const anchorErrors = usePairs.map((p) => ({
    kind: p.kind,
    error: computeAnchorError(p.source, p.target, matrix4x4),
    confidence: p.confidence,
    weight: p.weight,
  }));

  // RMSE
  const mse = anchorErrors.reduce((sum, e) => sum + e.error * e.error, 0) / anchorErrors.length;
  const rmse = Math.sqrt(mse);

  // Reliability check
  const meshDiag = bboxDiagonal(sourceProxy);
  const reliable = rmse < meshDiag * 0.15
    && anchorErrors.length >= 3
    && anchorErrors.every((e) => e.confidence > 0.3);

  return {
    matrix4x4,
    svdRmse: rmse,
    scale,
    anchorPairCount: usePairs.length,
    anchorErrors,
    sourceProxy,
    targetProxy,
    warnings,
    reliable,
  };
}
