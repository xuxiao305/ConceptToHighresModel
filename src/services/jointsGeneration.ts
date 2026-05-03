/**
 * jointsGeneration.ts
 *
 * Generates PipelineJointsMeta by mapping global joints through
 * SmartCrop and split transform metadata.
 *
 * This is called during Page2 extraction, after SmartCrop and split
 * have produced their metadata. If global OpenPose joints are available,
 * they are transformed to per-view pipeline joints and stored.
 */

import type {
  GlobalJointsMeta,
  PipelineJointsMeta,
  SmartCropTransformMeta,
  SplitTransformMeta,
} from '../types/joints';
import { withDerivedKeypoints } from '../types/joints';
import { globalJointsToViews } from '../three/jointsTransform';
import type { PersistedPipeline } from './projectStore';

/**
 * Generate PipelineJointsMeta from global joints and transform metadata.
 *
 * @param globalJoints - Global joints from Page1 (4 views in 2x2 image)
 * @param pipeline - The PersistedPipeline to associate joints with
 * @param smartCropMeta - SmartCrop transform metadata from extraction
 * @param splitMeta - Split transform metadata from extraction
 * @param processedSize - Size of the processed 2x2 image
 * @returns PipelineJointsMeta ready to be stored on the pipeline
 */
export function generatePipelineJoints(
  globalJoints: GlobalJointsMeta,
  pipeline: PersistedPipeline,
  smartCropMeta: SmartCropTransformMeta,
  splitMeta: SplitTransformMeta,
  processedSize: { width: number; height: number },
): PipelineJointsMeta {
  // Enrich global joints with derived keypoints (shoulder_center, hip_center)
  const viewsWithDerived = {
    front: withDerivedKeypoints(globalJoints.views.front),
    left: withDerivedKeypoints(globalJoints.views.left),
    back: withDerivedKeypoints(globalJoints.views.back),
    right: withDerivedKeypoints(globalJoints.views.right),
  };

  // Transform global joints to view-local coords through both transforms
  const viewJoints = globalJointsToViews(viewsWithDerived, smartCropMeta, splitMeta);

  return {
    version: 1,
    pipelineId: pipeline.id ?? 'unknown',
    pipelineName: pipeline.name,
    pipelineMode: pipeline.mode,
    resultFile: pipeline.resultFile ?? '',
    modelFile: pipeline.modelFile ?? undefined,
    processedSize,
    smartCropMeta,
    splitMeta,
    views: viewJoints,
    generatedAt: new Date().toISOString(),
  };
}
