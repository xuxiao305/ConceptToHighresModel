/**
 * Public exports for the shared 3D layer.
 *
 * This module is the single import point for any page that needs 3D
 * mesh display, landmark picking, dual viewports, or future Fast_RNRR
 * registration UI. All technology choices (three.js + R3F + drei +
 * zustand) match D:/AI/Prototypes/WrapDeformation for parity.
 */

export type { Vec3, Face3, ViewMode, MeshRole, MeshInfo } from './types';
export type { LandmarkPoint } from './landmarkStore';
export type { CameraState } from './cameraSyncStore';
export type { LoadedMesh, LoadedGlb } from './glbLoader';

export { MeshViewer } from './MeshViewer';
export type { MeshViewerProps } from './MeshViewer';
export { DualViewport } from './DualViewport';
export { LandmarkMarker } from './LandmarkMarker';
export { TexturedSceneViewer } from './TexturedSceneViewer';
export type { TexturedSceneViewerProps } from './TexturedSceneViewer';

export { useLandmarkStore } from './landmarkStore';
export { useCameraSyncStore } from './cameraSyncStore';

export { loadGlbAsMesh, loadGlb, extractMeshFromScene } from './glbLoader';
