/**
 * dwpose.ts
 *
 * Frontend service for DWPose body pose estimation.
 * Calls the /api/dwpose bridge (pose_worker.py via Vite dev plugin)
 * and converts raw COCO-18 keypoints to our GlobalJointsMeta format.
 *
 * COCO body keypoint indices (18 points):
 *   0:Nose  1:Neck  2:R_Shoulder  3:R_Elbow  4:R_Wrist
 *   5:L_Shoulder  6:L_Elbow  7:L_Wrist
 *   8:R_Hip  9:R_Knee  10:R_Ankle
 *   11:L_Hip  12:L_Knee  13:L_Ankle
 *   14:R_Eye  15:L_Eye  16:R_Ear  17:L_Ear
 */

import type { Joint2D, GlobalJointsMeta, MultiViewLayout, ViewName } from '../types/joints';

// ── Raw DWPose API types ────────────────────────────────────────────────

interface DwposeKeypoint {
  x: number; // pixel coordinate in original image
  y: number; // pixel coordinate in original image
  score: number;
  id: number;
}

interface DwposePose {
  body: Array<DwposeKeypoint | null>; // 18 elements, some may be null
  left_hand?: DwposeKeypoint[];
  right_hand?: DwposeKeypoint[];
  face?: DwposeKeypoint[];
}

interface DwposeResponse {
  imageSize: { width: number; height: number };
  poses: DwposePose[];
}

interface DwposeApiResult {
  ok: true;
  json: DwposeResponse;
  overlayBase64?: string;
}

interface DwposeApiError {
  ok: false;
  error: string;
}

// ── COCO index → Joint2D name ───────────────────────────────────────────

const COCO_TO_JOINT: Record<number, string> = {
  1: 'neck',
  2: 'right_shoulder',
  5: 'left_shoulder',
  3: 'right_elbow',
  6: 'left_elbow',
  4: 'right_wrist',
  7: 'left_wrist',
  8: 'right_hip',
  11: 'left_hip',
};

// ── API call ────────────────────────────────────────────────────────────

export interface DetectPosesOptions {
  /** Detection confidence threshold (default 0.4) */
  detThr?: number;
  /** NMS IoU threshold (default 0.45) */
  nmsThr?: number;
  /** Include hand keypoints (default true) */
  includeHand?: boolean;
  /** Include face keypoints (default true) */
  includeFace?: boolean;
}

export interface DetectPosesResult {
  /** Raw DWPose response (COCO format, normalized coords) */
  raw: DwposeResponse;
  /** Base64 overlay image (skeleton drawn on black background) */
  overlayBase64?: string;
}

/**
 * Run DWPose pose estimation on an image.
 *
 * @param imageBase64 - Base64 data URI of the input image
 * @param opts - Detection options
 * @returns Raw DWPose response with normalized COCO keypoints
 */
export async function detectPoses(
  imageBase64: string,
  opts: DetectPosesOptions = {},
): Promise<DetectPosesResult> {
  const resp = await fetch('/api/dwpose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64,
      detThr: opts.detThr ?? 0.4,
      nmsThr: opts.nmsThr ?? 0.45,
      includeHand: opts.includeHand ?? true,
      includeFace: opts.includeFace ?? true,
    }),
  });

  const data: DwposeApiResult | DwposeApiError = await resp.json();
  if (!data.ok) {
    throw new Error(data.error);
  }

  return {
    raw: data.json,
    overlayBase64: data.overlayBase64,
  };
}

// ── Conversion: DWPose → GlobalJointsMeta ───────────────────────────────

/** Default 2x2 multi-view layout matching the TPoseMultiView workflow. */
const DEFAULT_LAYOUT: MultiViewLayout = {
  quadrants: {
    front: 'top-left',
    left: 'top-right',
    right: 'bottom-left',
    back: 'bottom-right',
  },
};

/**
 * Convert raw DWPose output to our GlobalJointsMeta format.
 *
 * Steps:
 *   1. Take the first detected person (highest confidence).
 *   2. Denormalize keypoints from [0,1] to pixel coordinates.
 *   3. Assign each keypoint to the correct multi-view quadrant.
 *   4. Map COCO indices to our Joint2D names.
 *
 * @param raw - Raw DWPose response
 * @param imageFile - Filename of the source image
 * @returns GlobalJointsMeta ready for persistence
 */
export function convertToGlobalJoints(
  raw: DwposeResponse,
  imageFile: string,
): GlobalJointsMeta {
  const { width: W, height: H } = raw.imageSize;
  const halfW = W / 2;
  const halfH = H / 2;

  // Initialize empty view buckets
  const views: Record<ViewName, Joint2D[]> = {
    front: [],
    left: [],
    back: [],
    right: [],
  };

  // Quadrant assignment (matches multi-view 2x2 layout):
  //   TL=front, TR=left, BL=right, BR=back
  // (ViewOrder: front, left, back, right)
  function viewForPixel(x: number, y: number): ViewName {
    if (x < halfW && y < halfH) return 'front';
    if (x >= halfW && y < halfH) return 'left';
    if (x < halfW && y >= halfH) return 'right';
    return 'back';
  }

  // Use the first (highest-confidence) person
  const pose = raw.poses[0];
  if (!pose) {
    return {
      version: 1 as const,
      imageFile,
      imageSize: { width: W, height: H },
      layout: DEFAULT_LAYOUT,
      poseModel: { name: 'DWPose' },
      keypoints: [],
      views: { front: [], left: [], back: [], right: [] },
      generatedAt: new Date().toISOString(),
    };
  }

  // Collect all keypoints for the flat list
  const allKeypoints: Joint2D[] = [];

  for (const [cocoIdxStr, jointName] of Object.entries(COCO_TO_JOINT)) {
    const cocoIdx = Number(cocoIdxStr);
    const kp = pose.body[cocoIdx];

    // Skip missing or zero-confidence keypoints
    if (!kp || kp.score <= 0) continue;

    // DWPose keypoints are already in pixel coordinates
    // (the pose_estimator._postprocess denormalizes from [0,1] to image pixels)
    const px = Math.round(kp.x);
    const py = Math.round(kp.y);

    const view = viewForPixel(px, py);
    const joint: Joint2D = {
      name: jointName,
      x: px,
      y: py,
      confidence: kp.score,
    };

    allKeypoints.push(joint);
    views[view].push(joint);
  }

  return {
    version: 1 as const,
    imageFile,
    imageSize: { width: W, height: H },
    layout: DEFAULT_LAYOUT,
    poseModel: { name: 'DWPose' },
    keypoints: allKeypoints,
    views,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Full pipeline: detect poses on an image and convert to GlobalJointsMeta.
 *
 * This is the main entry point for Page1 — feed the MultiView 2x2 composite
 * image and get back GlobalJointsMeta ready for Page2 transform pipeline.
 */
export async function detectAndConvertToGlobalJoints(
  imageBase64: string,
  imageFile: string,
  opts: DetectPosesOptions = {},
): Promise<{ joints: GlobalJointsMeta; overlayBase64?: string }> {
  const result = await detectPoses(imageBase64, opts);
  const joints = convertToGlobalJoints(result.raw, imageFile);
  return { joints, overlayBase64: result.overlayBase64 };
}
// ── Single-view COCO → Joint2D[] ───────────────────────────────────────

/**
 * Convert a single COCO pose (from a single-view render) to Joint2D[].
 * No quadrant splitting — all joints are assigned to a single view.
 * Useful for skeleton proxy where we run DWPose on an ortho render
 * of a single mesh.
 *
 * @param pose - A single DWPose person
 * @param imageSize - The image dimensions (for reference, not used for denorm)
 * @returns Array of named Joint2D with COCO keypoints
 */
export function cocoPoseToJoint2D(
  pose: DwposePose,
  _imageSize: { width: number; height: number },
): Joint2D[] {
  const joints: Joint2D[] = [];

  for (const [cocoIdxStr, jointName] of Object.entries(COCO_TO_JOINT)) {
    const cocoIdx = Number(cocoIdxStr);
    const kp = pose.body[cocoIdx];

    if (!kp || kp.score <= 0) continue;

    joints.push({
      name: jointName,
      x: Math.round(kp.x),
      y: Math.round(kp.y),
      confidence: kp.score,
    });
  }

  return joints;
}