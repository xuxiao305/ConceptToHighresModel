/**
 * skeletonProxy.ts
 *
 * Builds a skeleton proxy from 2D joints projected onto a 3D mesh.
 * For each limb segment, creates a capsule region, collects nearby
 * mesh vertices, and runs PCA to produce stable pose-level anchors.
 *
 * Pipeline:
 *   1. Project 2D joints → 3D seed points (nearest mesh vertices)
 *   2. Construct 3D capsules around limb segments
 *   3. Collect mesh vertices inside each capsule
 *   4. PCA on capsule vertices → ProxyAnchor
 *   5. Assemble SkeletonProxyResult
 */

import { Matrix, SingularValueDecomposition } from 'ml-matrix';
import type { Vec3 } from './types';
import type {
  CapsuleRegion3D,
  ProxyAnchor,
  SkeletonProxyResult,
  SkeletonProxyOptions,
} from './types';
import type { OrthoFrontCamera } from './orthoFrontRender';
import { projectVerticesToImage } from './maskReproject';
import type { Joint2D } from '../types/joints';
import { findJoint, LIMB_SEGMENTS } from '../types/joints';

// ── 3D Math Helpers ────────────────────────────────────────────────────

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function mul3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  if (l < 1e-12) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

function centroid3(points: Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  let acc: Vec3 = [0, 0, 0];
  for (const p of points) acc = add3(acc, p);
  return mul3(acc, 1 / points.length);
}

/** Squared distance from point p to the line segment a→b. */
function pointToSegmentSqDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub3(b, a);
  const ap = sub3(p, a);
  const abLenSq = dot3(ab, ab);
  if (abLenSq < 1e-12) return dot3(ap, ap);
  let t = dot3(ap, ab) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  const closest = add3(a, mul3(ab, t));
  const diff = sub3(p, closest);
  return dot3(diff, diff);
}

/** BBox diagonal of an array of Vec3. */
function bboxDiagonal(positions: Vec3[]): number {
  if (positions.length === 0) return 1;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of positions) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── 2D Joint → 3D Seed Projection ──────────────────────────────────────

/**
 * Project 2D view-local joints to approximate 3D seeds by finding
 * the nearest mesh vertices (in projected 2D space) and averaging
 * their 3D positions.
 *
 * Returns a Map from joint name → 3D seed position, or undefined
 * if the joint is not found or has no nearby vertices.
 */
export function jointsToSeeds3D(
  joints: Joint2D[],
  positions: Vec3[],
  camera: OrthoFrontCamera,
  restrictVertices?: Set<number>,
  kNearest = 3,
): Map<string, Vec3> {
  const seeds = new Map<string, Vec3>();

  // Project all mesh vertices to 2D image space
  const proj = projectVerticesToImage(positions, camera);

  for (const joint of joints) {
    if (joint.confidence === 0) continue;

    // Find K nearest projected vertices
    interface Candidate {
      idx: number;
      distSq: number;
    }
    const candidates: Candidate[] = [];

    for (let i = 0; i < positions.length; i++) {
      if (restrictVertices && !restrictVertices.has(i)) continue;
      const ui = proj[i * 2];
      const vi = proj[i * 2 + 1];
      if (!isFinite(ui) || !isFinite(vi)) continue;
      const du = ui - joint.x;
      const dv = vi - joint.y;
      const distSq = du * du + dv * dv;

      // Keep top-K
      if (candidates.length < kNearest) {
        candidates.push({ idx: i, distSq });
        candidates.sort((a, b) => a.distSq - b.distSq);
      } else if (distSq < candidates[candidates.length - 1].distSq) {
        candidates[candidates.length - 1] = { idx: i, distSq };
        candidates.sort((a, b) => a.distSq - b.distSq);
      }
    }

    if (candidates.length === 0) continue;

    // Average the 3D positions of nearest vertices
    const seedPos = centroid3(candidates.map((c) => positions[c.idx]));
    seeds.set(joint.name, seedPos);
  }

  return seeds;
}

// ── Capsule Construction ────────────────────────────────────────────────

/**
 * Create a CapsuleRegion3D for a limb segment.
 *
 * Collects mesh vertices whose distance to the line segment connecting
 * the two 3D seed points is less than `radius`.
 */
function buildCapsule(
  proximal3D: Vec3,
  distal3D: Vec3,
  label: string,
  radius: number,
  positions: Vec3[],
  proximalConfidence: number,
  distalConfidence: number,
  restrictVertices?: Set<number>,
): CapsuleRegion3D {
  const direction = normalize3(sub3(distal3D, proximal3D));
  const halfLength = len3(sub3(distal3D, proximal3D)) / 2;
  const center = add3(proximal3D, mul3(direction, halfLength));

  const radiusSq = radius * radius;
  const vertices = new Set<number>();

  for (let i = 0; i < positions.length; i++) {
    if (restrictVertices && !restrictVertices.has(i)) continue;
    const distSq = pointToSegmentSqDist(positions[i], proximal3D, distal3D);
    if (distSq <= radiusSq) {
      vertices.add(i);
    }
  }

  const confidence = Math.min(proximalConfidence, distalConfidence)
    * Math.min(1, vertices.size / 5);

  return {
    label,
    proximal3D: [...proximal3D] as Vec3,
    distal3D: [...distal3D] as Vec3,
    center: [...center] as Vec3,
    direction: [...direction] as Vec3,
    halfLength,
    radius,
    vertices,
    vertexCount: vertices.size,
    confidence,
  };
}

// ── PCA on Capsule Vertices → ProxyAnchor ───────────────────────────────

/**
 * Run PCA on a set of vertex positions and produce a ProxyAnchor.
 */
function pcaProxyAnchor(
  positions: Vec3[],
  vertexIndices: Set<number>,
  kind: string,
  sourceSegment: string,
  capsuleRadius: number,
  confidence: number,
): ProxyAnchor | null {
  const pts = Array.from(vertexIndices).map((i) => positions[i]);
  if (pts.length < 3) return null;

  const c = centroid3(pts);

  // Build 3×3 covariance matrix
  const cov = Matrix.zeros(3, 3);
  for (const p of pts) {
    const d0 = p[0] - c[0];
    const d1 = p[1] - c[1];
    const d2 = p[2] - c[2];
    cov.set(0, 0, cov.get(0, 0) + d0 * d0);
    cov.set(0, 1, cov.get(0, 1) + d0 * d1);
    cov.set(0, 2, cov.get(0, 2) + d0 * d2);
    cov.set(1, 1, cov.get(1, 1) + d1 * d1);
    cov.set(1, 2, cov.get(1, 2) + d1 * d2);
    cov.set(2, 2, cov.get(2, 2) + d2 * d2);
  }
  // Symmetrize
  cov.set(1, 0, cov.get(0, 1));
  cov.set(2, 0, cov.get(0, 2));
  cov.set(2, 1, cov.get(1, 2));
  cov.mul(1 / pts.length);

  // SVD
  const svd = new SingularValueDecomposition(cov);

  // Primary axis = first eigenvector (largest eigenvalue)
  // ml-matrix SVD exposes U, V, s as own properties but TypeScript types
  // don't declare them; access via type assertion.
  const svdAny = svd as unknown as { U: Matrix; V: Matrix; s: Float64Array };
  const eigVecs = svdAny.U;
  const primaryAxis: Vec3 = [eigVecs.get(0, 0), eigVecs.get(1, 0), eigVecs.get(2, 0)];
  const secondaryAxis: Vec3 = [eigVecs.get(0, 1), eigVecs.get(1, 1), eigVecs.get(2, 1)];

  // Project vertices onto primary axis to get extent
  let extentMin = Infinity;
  let extentMax = -Infinity;
  for (const p of pts) {
    const proj = dot3(sub3(p, c), primaryAxis);
    if (proj < extentMin) extentMin = proj;
    if (proj > extentMax) extentMax = proj;
  }

  const nearPosition = add3(c, mul3(primaryAxis, extentMin));
  const farPosition = add3(c, mul3(primaryAxis, extentMax));

  return {
    kind,
    position: [...c] as Vec3,
    direction: [...primaryAxis] as Vec3,
    secondaryDirection: [...secondaryAxis] as Vec3,
    confidence,
    sourceSegment,
    capsuleRadius,
    vertexCount: pts.length,
    extentMin,
    extentMax,
    nearPosition: [...nearPosition] as Vec3,
    farPosition: [...farPosition] as Vec3,
  };
}

// ── Main: Build Skeleton Proxy ──────────────────────────────────────────

/**
 * Build a skeleton proxy from 2D joints and a 3D mesh.
 *
 * @param positions   - All mesh vertex positions (Vec3[])
 * @param joints      - View-local Joint2D[] for one view
 * @param camera      - OrthoFrontCamera used to render/align the view
 * @param options     - Optional tuning parameters
 * @param restrictVertices - Optional vertex set to restrict capsule collection.
 *                           If omitted, all vertices are eligible.
 * @returns SkeletonProxyResult with capsules, anchors, and named proxy anchors
 */
export function buildSkeletonProxy(
  positions: Vec3[],
  joints: Joint2D[],
  camera: OrthoFrontCamera,
  options: SkeletonProxyOptions = {},
  restrictVertices?: Set<number>,
): SkeletonProxyResult {
  const {
    capsuleRadiusFraction = 0.08,
    minCapsuleVertices = 10,
    minJointConfidence = 0.3,
  } = options;

  const warnings: string[] = [];
  const meshDiag = bboxDiagonal(positions);
  const capsuleRadius = meshDiag * capsuleRadiusFraction;

  // Step 1: Project joints → 3D seeds
  const seeds = jointsToSeeds3D(joints, positions, camera, restrictVertices, 3);

  // Step 2: Build capsules for each limb segment
  const capsules: CapsuleRegion3D[] = [];
  for (const seg of LIMB_SEGMENTS) {
    const prox = seeds.get(seg.proximal);
    const dist = seeds.get(seg.distal);
    if (!prox || !dist) continue;

    const jProx = findJoint(joints, seg.proximal);
    const jDist = findJoint(joints, seg.distal);
    const confProx = jProx?.confidence ?? 0;
    const confDist = jDist?.confidence ?? 0;
    if (confProx < minJointConfidence || confDist < minJointConfidence) continue;

    const capsule = buildCapsule(
      prox, dist, seg.label, capsuleRadius, positions,
      confProx, confDist, restrictVertices,
    );

    if (capsule.vertexCount < minCapsuleVertices) {
      warnings.push(`Capsule "${seg.label}" has only ${capsule.vertexCount} vertices (min ${minCapsuleVertices})`);
    }
    capsules.push(capsule);
  }

  // Step 3: PCA on each capsule → ProxyAnchor
  const anchors: ProxyAnchor[] = [];
  for (const cap of capsules) {
    const anchor = pcaProxyAnchor(
      positions, cap.vertices, cap.label, cap.label,
      cap.radius, cap.confidence,
    );
    if (anchor) {
      anchors.push(anchor);
    }
  }

  // Step 4: Build named proxy anchors
  const findAnchorBySegment = (label: string) =>
    anchors.find((a) => a.sourceSegment === label);

  // Shoulder line
  let shoulderLine: ProxyAnchor | undefined;
  const lsSeed = seeds.get('left_shoulder');
  const rsSeed = seeds.get('right_shoulder');
  if (lsSeed && rsSeed) {
    const shoulderMid = mul3(add3(lsSeed, rsSeed), 0.5);
    const shoulderDir = normalize3(sub3(rsSeed, lsSeed));
    const lj = findJoint(joints, 'left_shoulder');
    const rj = findJoint(joints, 'right_shoulder');
    const conf = Math.min(lj?.confidence ?? 0, rj?.confidence ?? 0);
    shoulderLine = {
      kind: 'shoulder_line',
      position: shoulderMid,
      direction: shoulderDir,
      secondaryDirection: [0, 0, 0],
      confidence: conf,
      sourceSegment: 'shoulder_line',
      capsuleRadius,
      vertexCount: 0,
      extentMin: 0,
      extentMax: len3(sub3(rsSeed, lsSeed)) / 2,
      nearPosition: lsSeed,
      farPosition: rsSeed,
    };
  }

  // Torso axis
  let torsoAxis: ProxyAnchor | undefined;
  const torsoCapsule = capsules.find((c) => c.label === 'torso');
  if (torsoCapsule && torsoCapsule.vertexCount >= minCapsuleVertices) {
    const ta = pcaProxyAnchor(
      positions, torsoCapsule.vertices, 'torso_axis', 'torso',
      capsuleRadius, torsoCapsule.confidence,
    );
    if (ta) torsoAxis = ta;
  }

  // Sleeve near/far
  const leftSleeveNear = findAnchorBySegment('left_upper_arm') ??
    (capsules.find((c) => c.label === 'left_arm')
      ? pcaProxyAnchor(
          positions,
          capsules.find((c) => c.label === 'left_arm')!.vertices,
          'left_sleeve_near', 'left_arm', capsuleRadius,
          capsules.find((c) => c.label === 'left_arm')!.confidence,
        )
      : undefined);

  const leftSleeveFar = findAnchorBySegment('left_forearm') ?? leftSleeveNear;

  const rightSleeveNear = findAnchorBySegment('right_upper_arm') ??
    (capsules.find((c) => c.label === 'right_arm')
      ? pcaProxyAnchor(
          positions,
          capsules.find((c) => c.label === 'right_arm')!.vertices,
          'right_sleeve_near', 'right_arm', capsuleRadius,
          capsules.find((c) => c.label === 'right_arm')!.confidence,
        )
      : undefined);

  const rightSleeveFar = findAnchorBySegment('right_forearm') ?? rightSleeveNear;

  // Total capsule vertex count (union of all capsules)
  const allCapsuleVerts = new Set<number>();
  for (const cap of capsules) {
    for (const vi of cap.vertices) allCapsuleVerts.add(vi);
  }

  return {
    anchors,
    jointSeeds: seeds,
    capsules,
    shoulderLine,
    torsoAxis,
    leftSleeveNear: leftSleeveNear ?? undefined,
    leftSleeveFar: leftSleeveFar ?? undefined,
    rightSleeveNear: rightSleeveNear ?? undefined,
    rightSleeveFar: rightSleeveFar ?? undefined,
    totalCapsuleVertices: allCapsuleVerts.size,
    warnings,
  };
}
