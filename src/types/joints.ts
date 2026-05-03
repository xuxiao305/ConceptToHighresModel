/**
 * Joints / Skeleton Proxy Data Types
 *
 * Defines all data formats for the Pose Proxy Jacket Alignment pipeline
 * across Page1 → Page2 → Page3, per the design doc:
 *   Document/Design/Page3_PoseProxy_JacketAlignment_Plan.md
 *
 * Four coordinate spaces:
 *   1. global 2x2 image space    — Page1 MultiView 4-in-1 original coords
 *   2. processed 2x2 image space — Page2 SmartCrop/Enlarge output coords
 *   3. split local view space    — Page2 splitMultiView per-view coords
 *   4. Page3 mesh projection     — 3D mesh → 2D ortho projection space
 */

// ── 2D Keypoint ─────────────────────────────────────────────────────────

/** A single 2D keypoint with pixel coordinates and confidence. */
export interface Joint2D {
  /** Keypoint name (e.g. "neck", "left_shoulder", "right_wrist") */
  name: string;
  /** Pixel X coordinate in the current image space */
  x: number;
  /** Pixel Y coordinate in the current image space */
  y: number;
  /** Confidence [0..1] from the pose estimator */
  confidence: number;
}

// ── Coordinate Space Definitions ────────────────────────────────────────

/** The four views in a 2x2 multi-view layout. */
export type ViewName = 'front' | 'left' | 'back' | 'right';

/** Standard view layout: top-left=front, top-right=left, bottom-left=right, bottom-right=back */
export const VIEW_ORDER: ViewName[] = ['front', 'left', 'back', 'right'];

// ── Global Joints (Page1 output) ────────────────────────────────────────

/** Layout info for the Page1 MultiView 4-in-1 image. */
export interface MultiViewLayout {
  /** Which view occupies each quadrant */
  quadrants: {
    front: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    left: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    back: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    right: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  };
}

/**
 * Global joints JSON produced by Page1 OpenPose on the MultiView 4-in-1 image.
 * Saved to the project directory and associated with a specific page1.multiview version.
 */
export interface GlobalJointsMeta {
  /** Schema version for forward compatibility */
  version: 1;
  /** The MultiView 4-in-1 image filename this data belongs to */
  imageFile: string;
  /** Original 4-in-1 image dimensions */
  imageSize: { width: number; height: number };
  /** Quadrant layout of the 4-in-1 image */
  layout: MultiViewLayout;
  /** Pose model info */
  poseModel: {
    name: string;
    version?: string;
  };
  /** All keypoints detected (in global 2x2 image space) */
  keypoints: Joint2D[];
  /** Per-view keypoints split by quadrant */
  views: {
    front: Joint2D[];
    left: Joint2D[];
    back: Joint2D[];
    right: Joint2D[];
  };
  /** ISO timestamp of generation */
  generatedAt: string;
}

// ── SmartCrop Transform Metadata ────────────────────────────────────────

/**
 * Transform metadata recorded during SmartCropAndEnlargeAuto.
 * Captures the exact transformation applied so joints can be mapped
 * from the global 2x2 space to the processed 2x2 space.
 */
export interface SmartCropTransformMeta {
  /** Original image size (global 2x2) */
  sourceSize: { width: number; height: number };
  /** Output image size (= sourceSize, SmartCrop keeps dimensions) */
  outputSize: { width: number; height: number };
  /** SmartCrop parameters used */
  params: {
    padding: number;
    whiteThreshold: number;
    minArea: number;
    maxObjects: number;
    layout: string;
    uniformScale: boolean;
    preservePosition: boolean;
  };
  /**
   * Per-object bbox in source image coords (after padding applied).
   * For the typical 4-view case, these are 4 bboxes.
   */
  objects: Array<{
    /** Original bbox (end-exclusive) */
    srcBbox: { x0: number; y0: number; x1: number; y1: number };
    /** Padded bbox (end-exclusive) */
    paddedBbox: { x0: number; y0: number; x1: number; y1: number };
    /** Paste offset in output image */
    pasteX: number;
    pasteY: number;
    /** Scale factor applied (src w/h → output w/h) */
    scale: number;
    /** Target width and height in output */
    targetW: number;
    targetH: number;
  }>;
}

// ── Split Multi-View Transform Metadata ─────────────────────────────────

/** BBox info for one view after splitMultiView. */
export interface SplitViewBBox {
  view: ViewName;
  /** Position in the processed 2x2 image (inclusive x0,y0; inclusive x1,y1) */
  quadrant: { x0: number; y0: number; x1: number; y1: number };
  /** Compact bbox of non-white pixels (inclusive) */
  compactBbox: { x0: number; y0: number; x1: number; y1: number };
  /** Padded bbox (inclusive) */
  paddedBbox: { x0: number; y0: number; x1: number; y1: number };
  /** Output slice dimensions */
  sliceSize: { w: number; h: number };
}

/** Full split transform metadata for reproducing coordinate mappings. */
export interface SplitTransformMeta {
  /** Size of the processed 2x2 image that was split */
  sourceSize: { width: number; height: number };
  /** Split parameters */
  params: {
    pad: number;
    whiteThreshold: number;
  };
  /** Per-view bbox info */
  views: SplitViewBBox[];
}

// ── Pipeline Joints (Page2 output) ──────────────────────────────────────

/**
 * Pipeline joints JSON produced by Page2 for each extraction pipeline.
 * Contains joints mapped through SmartCrop → split into each view.
 * Saved alongside the pipeline's extraction result.
 */
export interface PipelineJointsMeta {
  /** Schema version */
  version: 1;
  /** Pipeline identifier */
  pipelineId: string;
  /** Pipeline display name */
  pipelineName: string;
  /** Pipeline mode */
  pipelineMode: 'extraction' | 'multiview';
  /** The extraction result file this joints data corresponds to */
  resultFile: string;
  /** The model file this joints data should pair with (for Page3 lookup) */
  modelFile?: string;
  /** Size of the processed 2x2 image */
  processedSize: { width: number; height: number };
  /** SmartCrop transform metadata used */
  smartCropMeta: SmartCropTransformMeta;
  /** Split transform metadata used */
  splitMeta: SplitTransformMeta;
  /** Per-view joints in split local view space */
  views: {
    front: Joint2D[];
    left: Joint2D[];
    back: Joint2D[];
    right: Joint2D[];
  };
  /** ISO timestamp of generation */
  generatedAt: string;
}

// ── Page1 Splits / Joints (Stage 1: Page1 = sole joints producer) ──────

/**
 * Per-view split record produced by Page1's auto-split after multiview.
 * Records the per-view image file (saved as a SegmentSet) and its bbox in
 * the original 4-in-1 multiview image. Used by Page3 to render src/tar to
 * the same image space as the joints.
 */
export interface Page1ViewSplit {
  view: ViewName;
  /** filename inside the segment set directory, e.g. "front_v0001.png" */
  file: string;
  /** bbox in the global 2x2 multiview image (end-exclusive) */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** size of this slice (pixel) */
  size: { w: number; h: number };
}

export interface Page1SplitsMeta {
  version: 1;
  /** the multiview filename this split was produced from */
  source: string;
  /** the segment set directory name (under page1.multiview node) */
  segmentDir: string;
  /** per-view split info */
  views: Record<ViewName, Page1ViewSplit>;
  generatedAt: string;
}

/**
 * Page1 joints record: holds DWPose result on the 4-in-1 multiview, plus
 * per-view joints already converted into split-local coordinates so that
 * Page3 can consume them directly without any further transform.
 */
export interface Page1ViewJoints {
  view: ViewName;
  /** image space these joint coordinates live in (= split slice size) */
  imageSize: { width: number; height: number };
  /** joints in split-local pixel coordinates */
  joints: Joint2D[];
}

export interface Page1JointsMeta {
  version: 1;
  /** the multiview filename DWPose was run against */
  source: string;
  /** raw global result (joints in 4-in-1 coords, kept for traceability) */
  global: GlobalJointsMeta;
  /** per-view joints in split-local coords (Page3 consumes these) */
  views: Record<ViewName, Page1ViewJoints>;
  generatedAt: string;
}

// ── Joint Name Constants ────────────────────────────────────────────────

/** Primary keypoints supported in Phase 1. */
export const PRIMARY_KEYPOINTS = [
  'neck',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
] as const;

export type PrimaryKeypoint = typeof PRIMARY_KEYPOINTS[number];

/** Computed (derived) keypoints. */
export const DERIVED_KEYPOINTS = [
  'shoulder_center',
  'hip_center',
] as const;

export type DerivedKeypoint = typeof DERIVED_KEYPOINTS[number];

/** All supported keypoint names. */
export type KeypointName = PrimaryKeypoint | DerivedKeypoint;

// ── Joint Lookup Helpers ────────────────────────────────────────────────

/** Find a joint by name in a joints array. */
export function findJoint(joints: Joint2D[], name: string): Joint2D | undefined {
  return joints.find((j) => j.name === name);
}

/** Get joint by name, returning null if not found. */
export function getJointOrNull(joints: Joint2D[], name: string): Joint2D | null {
  return findJoint(joints, name) ?? null;
}

/** Compute shoulder_center as midpoint of left_shoulder and right_shoulder. */
export function computeShoulderCenter(joints: Joint2D[]): Joint2D | null {
  const ls = findJoint(joints, 'left_shoulder');
  const rs = findJoint(joints, 'right_shoulder');
  if (!ls || !rs) return null;
  return {
    name: 'shoulder_center',
    x: (ls.x + rs.x) / 2,
    y: (ls.y + rs.y) / 2,
    confidence: Math.min(ls.confidence, rs.confidence),
  };
}

/** Compute hip_center as midpoint of left_hip and right_hip. */
export function computeHipCenter(joints: Joint2D[]): Joint2D | null {
  const lh = findJoint(joints, 'left_hip');
  const rh = findJoint(joints, 'right_hip');
  if (!lh || !rh) return null;
  return {
    name: 'hip_center',
    x: (lh.x + rh.x) / 2,
    y: (lh.y + rh.y) / 2,
    confidence: Math.min(lh.confidence, rh.confidence),
  };
}

/** Add derived keypoints (shoulder_center, hip_center) to a joints array. */
export function withDerivedKeypoints(joints: Joint2D[]): Joint2D[] {
  const result = [...joints];
  const sc = computeShoulderCenter(joints);
  if (sc) result.push(sc);
  const hc = computeHipCenter(joints);
  if (hc) result.push(hc);
  return result;
}

/** Filter joints to only primary + derived keypoints. */
export function filterKeypoints(joints: Joint2D[]): Joint2D[] {
  const validNames = new Set<string>([...PRIMARY_KEYPOINTS, ...DERIVED_KEYPOINTS]);
  return joints.filter((j) => validNames.has(j.name));
}

// ── Capsule / Segment Definitions ───────────────────────────────────────

/**
 * A limb segment connecting two joints, used to construct a 3D capsule region.
 */
export interface JointSegment {
  /** Human-readable label */
  label: string;
  /** Proximal joint name (closer to body center) */
  proximal: KeypointName;
  /** Distal joint name (farther from body center) */
  distal: KeypointName;
}

/** Standard limb segments used for capsule construction. */
export const LIMB_SEGMENTS: JointSegment[] = [
  { label: 'left_arm', proximal: 'left_shoulder', distal: 'left_wrist' },
  { label: 'right_arm', proximal: 'right_shoulder', distal: 'right_wrist' },
  { label: 'left_upper_arm', proximal: 'left_shoulder', distal: 'left_elbow' },
  { label: 'left_forearm', proximal: 'left_elbow', distal: 'left_wrist' },
  { label: 'right_upper_arm', proximal: 'right_shoulder', distal: 'right_elbow' },
  { label: 'right_forearm', proximal: 'right_elbow', distal: 'right_wrist' },
  { label: 'torso', proximal: 'shoulder_center', distal: 'hip_center' },
  { label: 'torso_neck', proximal: 'neck', distal: 'hip_center' },
];

// ── Fallback Reason ─────────────────────────────────────────────────────

export type FallbackReason =
  | 'no-global-joints'
  | 'no-pipeline-joints'
  | 'pipeline-key-mismatch'
  | 'low-joint-confidence'
  | 'insufficient-capsule-vertices'
  | 'anchor-pair-count-low'
  | 'svd-rmse-high'
  | 'left-right-swapped'
  | 'torso-axis-flipped';

export interface FallbackInfo {
  reason: FallbackReason;
  detail: string;
}

