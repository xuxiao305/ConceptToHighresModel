/**
 * Phase A1 — Pose Proxy 真分步。
 *
 * 把原 runPoseProxy() 单函数拆成 5 个独立步骤，每步有明确的
 * 输入/输出类型，便于 ModelAssemble 逐步跟踪、缓存、重跑。
 *
 * 设计约束：
 *   - 每步函数是**纯函数**（除 renderSrcOrtho 依赖 DOM canvas），
 *     不接触 React state。
 *   - 步骤间通过类型化的 StepResult 传递数据，ModelAssemble
 *     将它们存入 poseProxyState 对应槽位。
 *   - 旧 runPoseProxy() 在 A6 阶段改为 thin wrapper，
 *     行为与当前完全一致。
 */

import type { Vec3, LandmarkCandidate } from '../../three';
import type { AlignmentMode, AlignmentResult } from '../../three/alignment';
import type { OrthoFrontCamera } from '../../three';
import type { Joint2D } from '../../types/joints';
import type { SkeletonProxyResult, PoseAlignmentResult } from '../../three/types';
import type { Face3 } from '../../three';
import {
  alignSourceMeshByLandmarks,
  applyTransform,
} from '../../three/alignment';
import {
  icpRefine,
  jointsToSeeds3D,
  bboxDiagonal,
} from '../../three';
import { renderOrthoFrontViewWithCamera } from '../../three/orthoFrontRender';

// ── 共享类型 ──────────────────────────────────────────────────────────

/** ICP 配置（与 runners.ts DEFAULT_ICP 一致） */
export interface IcpConfig {
  maxIterations: number;
  sampleCount: number;
  rejectMultiplier: number;
  convergenceImprovement: number;
}

export const DEFAULT_ICP_CONFIG: IcpConfig = {
  maxIterations: 30,
  sampleCount: 400,
  rejectMultiplier: 2.5,
  convergenceImprovement: 0.005,
};

/** 每步通用运行选项 */
export interface StepOptions {
  seed?: number;
  alignmentMode?: AlignmentMode;
  icp?: Partial<IcpConfig>;
}

// ── Step 1: collectJoints ────────────────────────────────────────────

export interface CollectJointsInput {
  /** Page1 front joints (raw, split-local 坐标) */
  srcJointsRaw: Joint2D[];
  /** Same as srcJointsRaw — tar joints share the same DWPose output */
  tarJointsRaw: Joint2D[];
  /** SAM3 ortho camera (用于缩放 tar joints 到 tarCamera 分辨率) */
  tarCamera: OrthoFrontCamera;
  /** Page1 front image size (用于计算缩放比) */
  page1Size: { width: number; height: number };
}

export interface CollectJointsOutput {
  srcJoints: Joint2D[];
  tarJoints: Joint2D[];
}

/**
 * Step 1: 收集源/目标关节。
 * srcJoints 原样保留；tarJoints 按 tarCamera / page1Size 缩放。
 */
export function collectJoints(input: CollectJointsInput): CollectJointsOutput {
  const { srcJointsRaw, tarJointsRaw, tarCamera, page1Size } = input;
  const sx = tarCamera.width / Math.max(1, page1Size.width);
  const sy = tarCamera.height / Math.max(1, page1Size.height);
  const tarJoints: Joint2D[] = tarJointsRaw.map((j) => ({
    ...j,
    x: Math.round(j.x * sx),
    y: Math.round(j.y * sy),
  }));
  return { srcJoints: srcJointsRaw, tarJoints };
}

// ── Step 2: renderSrcOrtho ───────────────────────────────────────────

export interface RenderSrcOrthoInput {
  srcVertices: Vec3[];
  srcFaces: Face3[];
  page1Size: { width: number; height: number };
}

export interface RenderSrcOrthoOutput {
  srcCamera: OrthoFrontCamera;
  /** Data URL of the rendered image (可留空/仅用于调试) */
  srcOrthoDataUrl: string | null;
}

/**
 * Step 2: 渲染 Source mesh 正交前视图，获取 srcCamera。
 * 依赖 DOM canvas (通过 renderOrthoFrontViewWithCamera)。
 */
export function renderSrcOrtho(input: RenderSrcOrthoInput): RenderSrcOrthoOutput {
  const { srcVertices, srcFaces, page1Size } = input;
  const result = renderOrthoFrontViewWithCamera(srcVertices, srcFaces, {
    width: page1Size.width,
    height: page1Size.height,
    background: null,
    meshColor: '#dddddd',
  });
  return {
    srcCamera: result.camera,
    srcOrthoDataUrl: result.dataUrl ?? null,
  };
}

// ── Step 3: buildProxies ────────────────────────────────────────────

export interface BuildProxiesInput {
  srcVertices: Vec3[];
  tarVertices: Vec3[];
  srcJoints: Joint2D[];
  tarJoints: Joint2D[];
  srcCamera: OrthoFrontCamera;
  tarCamera: OrthoFrontCamera;
  tarConstraintVertices?: Set<number>;
}

export interface BuildProxiesOutput {
  srcProxy: SkeletonProxyResult;
  tarProxy: SkeletonProxyResult;
  /** Stub — not computed in pure seed mode */
  poseAlign: PoseAlignmentResult;
  /** 配对后的关节种子候选项（所有同名关节） */
  pairs: LandmarkCandidate[];
}

function findJointConfidence(joints: Joint2D[], name: string): number {
  return joints.find((j) => j.name === name)?.confidence ?? 0;
}

/**
 * Step 3: 纯种子模式 — 直接将 2D 关节反投影为 3D 种子点，
 * 按同名关节配对作为 LandmarkCandidate，跳过 capsule/PCA/anchor。
 */
export function buildProxies(input: BuildProxiesInput): BuildProxiesOutput {
  const { srcVertices, tarVertices, srcJoints, tarJoints, srcCamera, tarCamera } = input;

  // Per-mesh search radius (3% of bbox diagonal → stable midline centroid)
  const srcDiag = bboxDiagonal(srcVertices);
  const tarDiag = bboxDiagonal(tarVertices);
  const searchRadiusFrac = 0.03;

  // Direct joint → 3D seed projection (pure, no capsule/PCA)
  const srcSeeds = jointsToSeeds3D(srcJoints, srcVertices, srcCamera, srcDiag * searchRadiusFrac);
  const tarSeeds = jointsToSeeds3D(tarJoints, tarVertices, tarCamera, tarDiag * searchRadiusFrac);

  // Minimal proxy shells — only jointSeeds are real
  const srcProxy: SkeletonProxyResult = {
    anchors: [],
    jointSeeds: srcSeeds,
    capsules: [],
    totalCapsuleVertices: 0,
    warnings: [],
  };
  const tarProxy: SkeletonProxyResult = {
    anchors: [],
    jointSeeds: tarSeeds,
    capsules: [],
    totalCapsuleVertices: 0,
    warnings: [],
  };

  // Pair ALL matching joint name seeds as landmark candidates
  const pairs: LandmarkCandidate[] = [];
  for (const [name, srcPos] of srcSeeds) {
    const tarPos = tarSeeds.get(name);
    if (!tarPos) continue;
    const confidence = Math.min(
      findJointConfidence(srcJoints, name),
      findJointConfidence(tarJoints, name),
    );
    if (confidence <= 0) continue;
    pairs.push({
      srcVertex: -1,
      srcPosition: srcPos,
      tarVertex: -1,
      tarPosition: tarPos,
      confidence: Math.min(1, Math.max(0.45, confidence)),
      descriptorDist: 0,
      suggestAccept: confidence >= 0.35,
    });
  }

  // Stub pose alignment — not computed in pure seed mode
  const poseAlign: PoseAlignmentResult = {
    matrix4x4: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    svdRmse: 0,
    anchorPairCount: 0,
    anchorErrors: [],
    scale: 1,
    sourceProxy: srcProxy,
    targetProxy: tarProxy,
    warnings: [],
    reliable: false,
  };

  return { srcProxy, tarProxy, poseAlign, pairs };
}

// ── Step 4: solveSvd ────────────────────────────────────────────────

export interface SolveSvdInput {
  srcVertices: Vec3[];
  tarVertices: Vec3[];
  pairs: LandmarkCandidate[];
  alignmentMode?: AlignmentMode;
}

export interface SolveSvdOutput {
  lmFitMatrix: number[][];
  lmFitRmse: number;
  /** Full alignment result (transformed vertices etc.) for immediate preview. */
  result: AlignmentResult;
}

/**
 * Step 4: SVD landmark fit（稀疏锚点对齐）。
 * 仅做 SVD，不跑 ICP。
 */
export function solveSvd(input: SolveSvdInput): SolveSvdOutput {
  const { srcVertices, pairs, alignmentMode } = input;
  if (pairs.length < 3) {
    throw new Error(`solveSvd: need ≥3 pairs, got ${pairs.length}`);
  }
  const mode = alignmentMode ?? 'similarity';
  const lmFit = alignSourceMeshByLandmarks(
    srcVertices,
    pairs.map((p) => p.srcPosition),
    pairs.map((p) => p.tarPosition),
    mode,
  );

  // 计算 landmark RMSE
  let s = 0;
  for (const p of pairs) {
    const t = applyTransform(p.srcPosition, lmFit.matrix4x4);
    const dx = t[0] - p.tarPosition[0];
    const dy = t[1] - p.tarPosition[1];
    const dz = t[2] - p.tarPosition[2];
    s += dx * dx + dy * dy + dz * dz;
  }
  const lmFitRmse = Math.sqrt(s / pairs.length);

  return { lmFitMatrix: lmFit.matrix4x4, lmFitRmse, result: lmFit };
}

// ── Step 5: solveIcp ────────────────────────────────────────────────

export interface SolveIcpInput {
  srcVertices: Vec3[];
  tarVertices: Vec3[];
  lmFitMatrix: number[][];
  pairs: LandmarkCandidate[];
  icpCfg?: Partial<IcpConfig>;
  tarConstraintVertices?: Set<number>;
  alignmentMode?: AlignmentMode;
  seed?: number;
}

export interface SolveIcpOutput {
  finalMatrix: number[][];
  icpRmse: number;
  method: 'ICP' | 'SVD';
  result: AlignmentResult;
}

/**
 * Step 5: ICP 精修 + choose ICP vs SVD + build AlignmentResult。
 * 整合了原 finalizeWithIcp 逻辑。
 */
export function solveIcp(input: SolveIcpInput): SolveIcpOutput {
  const {
    srcVertices, tarVertices, lmFitMatrix, pairs,
    icpCfg: icpOverrides, tarConstraintVertices,
    alignmentMode, seed,
  } = input;
  const mode = alignmentMode ?? 'similarity';
  const icpCfg = { ...DEFAULT_ICP_CONFIG, ...(icpOverrides ?? {}) };

  if (pairs.length < 3) {
    throw new Error(`solveIcp: need ≥3 pairs, got ${pairs.length}`);
  }

  // ICP refine, restricted to target SAM3 region.
  const icp = icpRefine(srcVertices, tarVertices, lmFitMatrix, {
    maxIterations: icpCfg.maxIterations,
    sampleCount: icpCfg.sampleCount,
    rejectMultiplier: icpCfg.rejectMultiplier,
    convergenceImprovement: icpCfg.convergenceImprovement,
    firstIterMode: mode,
    subsequentMode: mode,
    seed,
    tarRestrictVertices: tarConstraintVertices,
  });

  // Choose ICP vs SVD using V1's predicate.
  const bestIcpIter = icp.iterations[icp.bestIteration];
  const minIcpPairsKept = Math.min(30, Math.max(6, Math.floor(icpCfg.sampleCount * 0.1)));
  const useIcp = Number.isFinite(icp.rmse)
    && icp.iterations.length > 0
    && !!bestIcpIter
    && bestIcpIter.pairsKept >= minIcpPairsKept;
  const finalMatrix = useIcp ? icp.matrix4x4 : lmFitMatrix;

  // Compute landmark RMSE under lmFit (for trace / comparison).
  let s = 0;
  for (const p of pairs) {
    const t = applyTransform(p.srcPosition, lmFitMatrix);
    const dx = t[0] - p.tarPosition[0];
    const dy = t[1] - p.tarPosition[1];
    const dz = t[2] - p.tarPosition[2];
    s += dx * dx + dy * dy + dz * dz;
  }
  const lmFitLandmarkRmse = Math.sqrt(s / pairs.length);

  const finalRmse = useIcp ? icp.rmse : lmFitLandmarkRmse;

  // Build AlignmentResult.
  const transformedVertices = srcVertices.map((v) => applyTransform(v, finalMatrix));
  const alignedSrcLandmarks = pairs.map((p) => applyTransform(p.srcPosition, finalMatrix));
  const targetLandmarks = pairs.map((p) => p.tarPosition);

  let sum = 0;
  let maxErr = 0;
  for (let i = 0; i < pairs.length; i++) {
    const a = alignedSrcLandmarks[i];
    const b = targetLandmarks[i];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    const e = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sum += e;
    if (e > maxErr) maxErr = e;
  }
  const meanError = pairs.length > 0 ? sum / pairs.length : 0;

  // Compute scale from matrix.
  const sx = Math.sqrt(finalMatrix[0][0] ** 2 + finalMatrix[1][0] ** 2 + finalMatrix[2][0] ** 2);
  const sy = Math.sqrt(finalMatrix[0][1] ** 2 + finalMatrix[1][1] ** 2 + finalMatrix[2][1] ** 2);
  const sz = Math.sqrt(finalMatrix[0][2] ** 2 + finalMatrix[1][2] ** 2 + finalMatrix[2][2] ** 2);
  const scale = (sx + sy + sz) / 3;

  const result: AlignmentResult = {
    mode,
    matrix4x4: finalMatrix,
    transformedVertices,
    alignedSrcLandmarks,
    targetLandmarks,
    rmse: finalRmse,
    meanError,
    maxError: maxErr,
    scale,
  };

  return {
    finalMatrix,
    icpRmse: icp.rmse,
    method: useIcp ? 'ICP' : 'SVD',
    result,
  };
}
