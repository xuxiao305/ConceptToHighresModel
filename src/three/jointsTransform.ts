/**
 * jointsTransform.ts
 *
 * Coordinate transform functions for mapping 2D joints through the
 * SmartCrop → processed 2x2 → split per-view pipeline.
 *
 * Coordinate spaces:
 *   A) Global 2x2 image — Page1 MultiView 4-in-1 original coords
 *   B) Processed 2x2 image — After SmartCropAndEnlargeAuto (same dimensions)
 *   C) View-local — After splitMultiView per-view slice
 */

import type { ViewName } from '../services/multiviewSplit';
import type {
  Joint2D,
  SmartCropTransformMeta,
  SplitTransformMeta,
  SplitViewBBox,
} from '../types/joints';

// ── Object ↔ View matching ─────────────────────────────────────────────

/**
 * Match SmartCrop objects to views by checking which quadrant each
 * object's paddedBbox center falls in.
 *
 * Returns a Map from ViewName to the object index in smartCropMeta.objects,
 * or undefined if no object falls in that quadrant.
 */
export function matchObjectsToViews(
  smartCropMeta: SmartCropTransformMeta,
): Map<ViewName, number> {
  const { width: W, height: H } = smartCropMeta.sourceSize;
  const halfW = W / 2;
  const halfH = H / 2;

  const viewByQuadrant = (cx: number, cy: number): ViewName | null => {
    if (cx < halfW && cy < halfH) return 'front';
    if (cx >= halfW && cy < halfH) return 'left';
    if (cx < halfW && cy >= halfH) return 'right';
    if (cx >= halfW && cy >= halfH) return 'back';
    return null;
  };

  const map = new Map<ViewName, number>();
  for (let i = 0; i < smartCropMeta.objects.length; i++) {
    const obj = smartCropMeta.objects[i];
    const cx = (obj.paddedBbox.x0 + obj.paddedBbox.x1) / 2;
    const cy = (obj.paddedBbox.y0 + obj.paddedBbox.y1) / 2;
    const view = viewByQuadrant(cx, cy);
    if (view) map.set(view, i);
  }
  return map;
}

/**
 * Find the object index for a given view, using quadrant matching.
 * Returns -1 if no matching object found.
 */
function findObjectForView(
  viewName: ViewName,
  smartCropMeta: SmartCropTransformMeta,
): number {
  const map = matchObjectsToViews(smartCropMeta);
  return map.get(viewName) ?? -1;
}

// ── Single-joint transforms ─────────────────────────────────────────────

/**
 * Map a single joint from global 2x2 space to processed 2x2 space.
 *
 * Uses the SmartCrop object corresponding to `viewName` (matched by
 * quadrant). The joint's coordinates are transformed by the same
 * crop/scale/paste operation that SmartCrop applied to that object.
 *
 * If no matching object is found for the view, the joint is returned
 * with confidence set to 0 (caller should check).
 */
export function globalToProcessed(
  joint: Joint2D,
  viewName: ViewName,
  smartCropMeta: SmartCropTransformMeta,
): Joint2D {
  const objIdx = findObjectForView(viewName, smartCropMeta);
  if (objIdx < 0) {
    return { ...joint, confidence: 0 };
  }
  const obj = smartCropMeta.objects[objIdx];

  // The SmartCrop extracted the paddedBbox region, scaled it by `scale`,
  // and pasted it at (pasteX, pasteY).
  const px = (joint.x - obj.paddedBbox.x0) * obj.scale + obj.pasteX;
  const py = (joint.y - obj.paddedBbox.y0) * obj.scale + obj.pasteY;

  // Clamp to output bounds
  const clampedX = Math.max(0, Math.min(smartCropMeta.outputSize.width - 1, Math.round(px)));
  const clampedY = Math.max(0, Math.min(smartCropMeta.outputSize.height - 1, Math.round(py)));

  return {
    name: joint.name,
    x: clampedX,
    y: clampedY,
    confidence: joint.confidence,
  };
}

/**
 * Map a single joint from processed 2x2 space to a view's local
 * pixel coordinates.
 *
 * The view's paddedBbox defines the crop region in the processed 2x2
 * image. The joint is translated so that (0,0) = top-left of the
 * view's output slice.
 */
export function processedToView(
  joint: Joint2D,
  viewBBox: SplitViewBBox,
): Joint2D {
  const localX = joint.x - viewBBox.paddedBbox.x0;
  const localY = joint.y - viewBBox.paddedBbox.y0;

  return {
    name: joint.name,
    x: Math.max(0, Math.min(viewBBox.sliceSize.w - 1, Math.round(localX))),
    y: Math.max(0, Math.min(viewBBox.sliceSize.h - 1, Math.round(localY))),
    confidence: joint.confidence,
  };
}

/**
 * Composite: global 2x2 → processed 2x2 → view-local.
 *
 * Convenience that chains globalToProcessed then processedToView.
 */
export function globalToView(
  joint: Joint2D,
  viewName: ViewName,
  smartCropMeta: SmartCropTransformMeta,
  splitMeta: SplitTransformMeta,
): Joint2D {
  const processed = globalToProcessed(joint, viewName, smartCropMeta);
  if (processed.confidence === 0) return processed;

  const viewBBox = splitMeta.views.find((v) => v.view === viewName);
  if (!viewBBox) {
    return { ...processed, confidence: 0 };
  }
  return processedToView(processed, viewBBox);
}

// ── Batch transforms ────────────────────────────────────────────────────

/**
 * Map all joints for all views from global 2x2 to processed 2x2 space.
 */
export function globalJointsToProcessed(
  globalViews: Record<ViewName, Joint2D[]>,
  smartCropMeta: SmartCropTransformMeta,
): Record<ViewName, Joint2D[]> {
  const result: Record<ViewName, Joint2D[]> = {
    front: [],
    left: [],
    back: [],
    right: [],
  };
  for (const view of ['front', 'left', 'back', 'right'] as ViewName[]) {
    const joints = globalViews[view] ?? [];
    result[view] = joints.map((j) => globalToProcessed(j, view, smartCropMeta));
  }
  return result;
}

/**
 * Map processed 2x2 joints to view-local coords for all views.
 */
export function processedJointsToViews(
  processed: Record<ViewName, Joint2D[]>,
  splitMeta: SplitTransformMeta,
): Record<ViewName, Joint2D[]> {
  const result: Record<ViewName, Joint2D[]> = {
    front: [],
    left: [],
    back: [],
    right: [],
  };
  for (const view of ['front', 'left', 'back', 'right'] as ViewName[]) {
    const viewBBox = splitMeta.views.find((v) => v.view === view);
    if (!viewBBox) {
      result[view] = processed[view].map((j) => ({ ...j, confidence: 0 }));
      continue;
    }
    result[view] = processed[view].map((j) => processedToView(j, viewBBox));
  }
  return result;
}

/**
 * Full batch transform: global 2x2 → view-local for all views.
 */
export function globalJointsToViews(
  globalViews: Record<ViewName, Joint2D[]>,
  smartCropMeta: SmartCropTransformMeta,
  splitMeta: SplitTransformMeta,
): Record<ViewName, Joint2D[]> {
  const processed = globalJointsToProcessed(globalViews, smartCropMeta);
  return processedJointsToViews(processed, splitMeta);
}

// ── View-space joint → 3D mesh projection ───────────────────────────────

/**
 * Normalize a view-local joint to [0,1] UV coordinates within the
 * view's slice dimensions.
 *
 * This is useful for projecting joints onto a 3D mesh using the
 * same camera parameters that generated the multi-view image.
 */
export function jointToViewUV(
  joint: Joint2D,
  viewBBox: SplitViewBBox,
): { u: number; v: number } {
  return {
    u: joint.x / viewBBox.sliceSize.w,
    v: joint.y / viewBBox.sliceSize.h,
  };
}
