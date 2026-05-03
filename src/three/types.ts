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

// ── Garment / Jacket Structure Types ──────────────────────────────────────

/** Semantic region labels for a jacket/garment */
export type GarmentRegionLabel =
  | 'torso'
  | 'left_sleeve'
  | 'right_sleeve'
  | 'collar'
  | 'left_cuff'
  | 'right_cuff'
  | 'hem';

/** A mesh region with a semantic label */
export interface GarmentSemanticRegion {
  label: GarmentRegionLabel;
  vertices: Set<number>;
  centroid: Vec3;
  bbox: { min: Vec3; max: Vec3 };
}

/** A semantically meaningful anchor point on a garment */
export interface StructureAnchor {
  kind:
    | 'collar_center'
    | 'left_shoulder'
    | 'right_shoulder'
    | 'left_cuff'
    | 'right_cuff'
    | 'hem_center'
    | 'left_armpit'
    | 'right_armpit';
  vertex: number;
  position: Vec3;
  confidence: number;
}

/** An edge in the structure graph connecting two anchors */
export interface StructureEdge {
  from: string;
  to: string;
}

/** A structure graph representing the garment's geometric topology */
export interface StructureGraph {
  anchors: StructureAnchor[];
  edges: StructureEdge[];
  anchorRegionMap: Map<string, GarmentRegionLabel>;
}

/** Options for jacket structure detection */
export interface JacketStructureOptions {
  /**
   * Which axis of the torso PCA is considered "up" (vertical).
   * 0 = X, 1 = Y, 2 = Z. Default: auto-detect by picking the axis
   * most aligned with world Y.
   */
  verticalAxis?: number;
  /**
   * Endpoint search fraction of sleeve axis length. Default: 0.06.
   */
  cuffFraction?: number;
  /**
   * Shoulder search fraction around the torso-sleeve junction. Default: 0.15.
   */
  shoulderFraction?: number;
}

/** Options for structure graph matching */
export interface GraphMatchOptions {
  /** Alignment mode. Default: 'similarity'. */
  mode?: 'rigid' | 'similarity' | 'affine';
  /** Minimum number of matched anchor pairs to proceed. Default: 4. */
  minPairs?: number;
  /** Max RMSE (in model-space units) to consider a match valid. */
  maxRmse?: number;
}