/**
 * Public exports for the shared 3D layer.
 *
 * This module is the single import point for any page that needs 3D
 * mesh display, landmark picking, dual viewports, or future Fast_RNRR
 * registration UI. All technology choices (three.js + R3F + drei +
 * zustand) match D:/AI/Prototypes/WrapDeformation for parity.
 */

export type { Vec3, Face3, ViewMode, MeshRole, MeshInfo, MeshAdjacency, MeshRegion, RegionGrowOptions, VertexDescriptor, LandmarkCandidate } from './types';
export type {
  GarmentRegionLabel,
  GarmentSemanticRegion,
  StructureAnchor,
  StructureEdge,
  StructureGraph,
  JacketStructureOptions,
  GraphMatchOptions,
} from './types';
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

export { buildMeshAdjacency } from './meshAdjacency';
export { growRegion, regionPositions } from './regionGrow';
export { computeRegionDescriptors, descriptorDistance } from './regionDescriptor';
export type { RegionDescriptors } from './regionDescriptor';
export { matchRegionCandidates } from './landmarkCandidates';
export type { MatchOptions, MatchInput } from './landmarkCandidates';
export {
  computeVertexSaliency,
  pickSalientCandidates,
  farthestPointSample,
  computeMultiScaleCurvature,
  bboxDiagonal,
} from './meshFeatures';
export { matchGlobalCandidates } from './globalCandidates';
export type { GlobalMatchOptions } from './globalCandidates';
export { ransacFilterCandidates } from './ransacAlign';
export type { RansacOptions, RansacResult } from './ransacAlign';
export { matchPartialToWhole, computePartialDebug } from './partialMatch';
export type {
  PartialMatchOptions,
  PartialMatchResult,
  PartialMatchTimingReport,
  PartialMatchAxialTrialTiming,
  PartialDebugResult,
} from './partialMatch';
export { matchLimbStructureToWhole } from './limbStructureMatch';
export type {
  LimbStructureMatchOptions,
  LimbStructureMatchResult,
  LimbAnchorSet,
  AnchorPoint,
} from './limbStructureMatch';
export { computeFPFH, computeMultiScaleFPFH, FPFH_DIM } from './fpfh';
export {
  computeOrthoFrontFrustum,
  renderOrthoFrontView,
  renderOrthoFrontViewWithFrustum,
} from './orthoFrontRender';
export type { OrthoFrontFrustum, OrthoRenderOptions } from './orthoFrontRender';
export { renderOrthoFrontViewWithCamera, renderTexturedFrontSnapshot } from './orthoFrontRender';
export type { OrthoFrontCamera, TexturedSnapshotOptions } from './orthoFrontRender';
export {
  projectVerticesToImage,
  buildFrontVertexMap,
  loadMaskGray,
  reprojectMaskToVertices,
} from './maskReproject';
export type {
  MaskReprojectionResult,
  MaskReprojectionOptions,
} from './maskReproject';
export { extractImageSubjectBBox } from './imageSubjectBBox';
export type { SubjectBBox, ExtractOptions as SubjectExtractOptions } from './imageSubjectBBox';
export { icpRefine } from './icpRefine';
export type { IcpOptions, IcpResult, IcpIteration } from './icpRefine';
export { detectJacketStructure, splitGarmentByBBox } from './jacketStructure';
export type { JacketStructureInput, JacketStructureResult } from './jacketStructure';
export { matchStructureGraphs } from './graphMatch';
export type { GraphMatchResult } from './graphMatch';

export type {
  CapsuleRegion3D,
  ProxyAnchor,
  SkeletonProxyResult,
  SkeletonProxyOptions,
  PoseAlignmentOptions,
  PoseAlignmentResult,
} from './types';

export {
  matchObjectsToViews,
  globalToProcessed,
  processedToView,
  globalToView,
  globalJointsToProcessed,
  processedJointsToViews,
  globalJointsToViews,
  jointToViewUV,
} from './jointsTransform';

export { buildSkeletonProxy } from './skeletonProxy';

export { computePoseAlignment } from './poseAlignment';
