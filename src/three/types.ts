/**
 * Shared 3D types — used across MeshViewer / LandmarkMarker / stores.
 *
 * Aligned with D:/AI/Prototypes/WrapDeformation/frontend/src/types/index.ts
 * so future Fast_RNRR backend integration can land without type churn.
 */

/** 3D vertex as [x, y, z] */
export type Vec3 = [number, number, number];

/** Triangle face as [i, j, k] */
export type Face3 = [number, number, number];

/** View modes for mesh rendering */
export type ViewMode = 'solid' | 'wireframe' | 'solid+wireframe';

/** Mesh role — affects dynamic vertex update behavior */
export type MeshRole = 'source' | 'target' | 'result';

/** Bounding-box info parsed from GLB or computed from vertices */
export interface MeshInfo {
  n_vertices: number;
  n_faces: number;
  bbox_min: Vec3;
  bbox_max: Vec3;
  bbox_range: Vec3;
}

/**
 * Mesh adjacency / topology cache.
 *
 * Built once per mesh load and reused across all region-grow / descriptor /
 * candidate-matching queries.  See `半自动对齐方案.md` Phase 1.
 */
export interface MeshAdjacency {
  /** vertex index → set of neighboring vertex indices (1-ring) */
  vertexNeighbors: Map<number, Set<number>>;
  /** vertex index → list of face indices that contain it */
  vertexFaces: Map<number, number[]>;
  /** Per-vertex normal (averaged from incident face normals); pre-computed for curvature pruning */
  vertexNormals: Vec3[];
  /**
   * Optional welding map for analysis only — original vertex index →
   * canonical (deduplicated) vertex index.  Useful when GLB has many
   * coincident seam vertices.  Identity mapping if welding is disabled.
   */
  weldedIndex: Int32Array;
}

/**
 * Region-grow options for `growRegion()`.
 */
export interface RegionGrowOptions {
  /** Maximum BFS layers from the seed (default 15) */
  maxSteps?: number;
  /** Maximum number of vertices in the region (default 2000) */
  maxVertices?: number;
  /**
   * Maximum allowed normal deflection (radians) between seed normal and
   * candidate vertex normal.  Vertices whose normal deviates more are
   * rejected (default Math.PI / 3 ≈ 60°).  Set to `Math.PI` to disable
   * curvature pruning.
   */
  curvatureThreshold?: number;
}

/**
 * Result of a region-grow query.
 */
export interface MeshRegion {
  /** Vertex index used as the BFS root */
  seedVertex: number;
  /** All vertices that belong to the region (includes the seed) */
  vertices: Set<number>;
  /** vertex index → BFS layer (0 = seed, 1 = 1-ring, ...) */
  vertexLayer: Map<number, number>;
  /** Geometric centroid (simple mean of region vertex positions) */
  centroid: Vec3;
  /** Bounding-sphere radius around the centroid (for normalization) */
  boundingRadius: number;
  /** Layer index (BFS depth) at which growth stopped — useful for diagnostics */
  finalSteps: number;
  /** Why the BFS stopped (for debugging / UI hint) */
  stopReason: 'frontier-empty' | 'max-steps' | 'max-vertices';
}

/**
 * Per-vertex descriptor used for matching candidates between two regions.
 * All components are designed to be roughly rotation/scale invariant.
 *
 * See `Document/Design/半自动对齐方案.md` Phase 2.
 */
export interface VertexDescriptor {
  /** Region-relative vertex index this descriptor describes */
  vertex: number;
  /** Distance from region centroid, divided by boundingRadius (0..1) */
  radialNormalized: number;
  /** Cosine between vertex normal and region average normal (-1..1) */
  cosToRegionNormal: number;
  /** Cosine between vertex normal and seed normal (-1..1) */
  cosToSeedNormal: number;
  /** BFS layer (0 = seed) divided by max layer in this region (0..1) */
  layerNormalized: number;
  /** 1-ring local curvature: avg normal deflection to neighbours, in [0..π] / π */
  localCurvature: number;
}

/**
 * Auto-matching result: a suggested landmark pair between source / target regions.
 */
export interface LandmarkCandidate {
  /** Vertex index in source mesh */
  srcVertex: number;
  /** 3D position of source vertex */
  srcPosition: Vec3;
  /** Vertex index in target mesh */
  tarVertex: number;
  /** 3D position of target vertex */
  tarPosition: Vec3;
  /** Confidence in [0..1] — 1 = strongest match */
  confidence: number;
  /** Raw descriptor distance (for debugging / sorting) */
  descriptorDist: number;
  /** Whether the system recommends auto-accept (confidence ≥ 0.5) */
  suggestAccept: boolean;
}

// ── Pose Proxy / Skeleton Types ─────────────────────────────────────────
// See Document/Design/Page3_PoseProxy_JacketAlignment_Plan.md

/**
 * A 3D capsule region defined by segment endpoints projected onto mesh space.
 * Used to collect vertices near a limb segment for PCA-based proxy anchors.
 */
export interface CapsuleRegion3D {
  /** Human-readable segment label */
  label: string;
  /** Proximal endpoint in 3D mesh space */
  proximal3D: Vec3;
  /** Distal endpoint in 3D mesh space */
  distal3D: Vec3;
  /** Capsule center */
  center: Vec3;
  /** Unit direction vector (proximal → distal) */
  direction: Vec3;
  /** Half-length of the capsule */
  halfLength: number;
  /** Radius of the capsule */
  radius: number;
  /** Vertex indices inside the capsule */
  vertices: Set<number>;
  /** Number of vertices in the capsule */
  vertexCount: number;
  /** Confidence derived from joint confidences and vertex count */
  confidence: number;
}

/**
 * A skeleton proxy anchor produced by PCA on capsule-region vertices.
 * These are the "stable pose-level anchors" used for SVD coarse alignment.
 */
export interface ProxyAnchor {
  /** Anchor kind label (e.g. "left_sleeve_near", "torso_axis") */
  kind: string;
  /** 3D position (PCA centroid of capsule vertices) */
  position: Vec3;
  /** Primary axis direction (unit vector) */
  direction: Vec3;
  /** Secondary axis direction (unit vector) */
  secondaryDirection: Vec3;
  /** Confidence [0..1] */
  confidence: number;
  /** Which segment label this anchor derives from */
  sourceSegment: string;
  /** Capsule radius used */
  capsuleRadius: number;
  /** Number of vertices used in PCA */
  vertexCount: number;
  /** Extent of vertex projections along primary axis */
  extentMin: number;
  extentMax: number;
  /** Near-end position along the primary axis (proximal side) */
  nearPosition: Vec3;
  /** Far-end position along the primary axis (distal side) */
  farPosition: Vec3;
}

/**
 * Full skeleton proxy result for a mesh.
 * Contains all capsule regions, computed anchors, and metadata.
 */
export interface SkeletonProxyResult {
  /** All computed proxy anchors */
  anchors: ProxyAnchor[];
  /** 2D joint names projected back to approximate 3D mesh seed points */
  jointSeeds: Map<string, Vec3>;
  /** Per-segment capsule regions */
  capsules: CapsuleRegion3D[];
  /** Shoulder line anchor (left→right shoulder direction) */
  shoulderLine?: ProxyAnchor;
  /** Main torso axis anchor */
  torsoAxis?: ProxyAnchor;
  /** Left sleeve near-end anchor (shoulder side) */
  leftSleeveNear?: ProxyAnchor;
  /** Left sleeve far-end anchor (wrist side) */
  leftSleeveFar?: ProxyAnchor;
  /** Right sleeve near-end anchor (shoulder side) */
  rightSleeveNear?: ProxyAnchor;
  /** Right sleeve far-end anchor (wrist side) */
  rightSleeveFar?: ProxyAnchor;
  /** Total mesh vertices used across all capsules */
  totalCapsuleVertices: number;
  /** Warnings (e.g. low vertex count, low confidence) */
  warnings: string[];
}

/** Options for skeleton proxy construction. */
export interface SkeletonProxyOptions {
  /** Capsule radius as fraction of mesh bbox diagonal (default 0.08) */
  capsuleRadiusFraction?: number;
  /** Minimum vertex count in a capsule to trust it (default 10) */
  minCapsuleVertices?: number;
  /** Minimum joint confidence to use (default 0.3) */
  minJointConfidence?: number;
}

/** Options for pose-based alignment. */
export interface PoseAlignmentOptions {
  /** Capsule radius fraction (default 0.08) */
  capsuleRadiusFraction?: number;
  /** Minimum capsule vertex count (default 10) */
  minCapsuleVertices?: number;
  /** Minimum joint confidence (default 0.3) */
  minJointConfidence?: number;
  /** SVD mode (default 'similarity') */
  svdMode?: 'rigid' | 'similarity';
  /** Per-anchor-kind weight overrides */
  anchorWeights?: Record<string, number>;
  /** Whether to run ICP refine after SVD (default true) */
  runIcp?: boolean;
}

/** Result of pose-based skeleton proxy alignment. */
export interface PoseAlignmentResult {
  /** 4x4 similarity transform matrix (source → target) */
  matrix4x4: number[][];
  /** SVD alignment RMSE across anchor pairs */
  svdRmse: number;
  /** Number of anchor pairs used in SVD */
  anchorPairCount: number;
  /** Per-anchor-pair error breakdown */
  anchorErrors: Array<{
    kind: string;
    error: number;
    confidence: number;
  }>;
  /** Scale factor from SVD */
  scale: number;
  /** Source skeleton proxy result */
  sourceProxy: SkeletonProxyResult;
  /** Target skeleton proxy result */
  targetProxy: SkeletonProxyResult;
  /** ICP refinement result (if runIcp was true) */
  icpResult?: {
    rmse: number;
    iterations: number;
    pairsKept: number;
    stopReason: string;
  };
  /** Warnings encountered during alignment */
  warnings: string[];
  /** Whether the alignment is considered reliable enough for auto-accept */
  reliable: boolean;
}
