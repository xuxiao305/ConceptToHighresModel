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
