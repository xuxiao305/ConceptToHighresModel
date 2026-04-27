/**
 * Landmark store — manages two independent landmark lists (source / target).
 *
 * Adapted from D:/AI/Prototypes/WrapDeformation/frontend/src/stores/landmarkStore.ts
 * The shape of `LandmarkPoint` is preserved exactly so future Fast_RNRR
 * landmark-pair payloads ({ src_idx, tar_idx }) can be assembled trivially.
 */

import { create } from 'zustand';
import type { Vec3 } from './types';

export interface LandmarkPoint {
  /** Sequential index starting from 1 (display order) */
  index: number;
  /** Vertex index in the mesh (-1 if external/imported) */
  vertexIdx: number;
  /** 3D position of the vertex */
  position: Vec3;
}

interface LandmarkState {
  srcLandmarks: LandmarkPoint[];
  tarLandmarks: LandmarkPoint[];

  addSrcLandmark: (vertexIdx: number, position: Vec3) => void;
  addTarLandmark: (vertexIdx: number, position: Vec3) => void;
  removeSrcLandmark: (index: number) => void;
  removeTarLandmark: (index: number) => void;
  clearAll: () => void;

  isBalanced: () => boolean;
  pairCount: () => number;
}

let srcCounter = 0;
let tarCounter = 0;

export const useLandmarkStore = create<LandmarkState>((set, get) => ({
  srcLandmarks: [],
  tarLandmarks: [],

  addSrcLandmark: (vertexIdx, position) => {
    srcCounter++;
    set((state) => ({
      srcLandmarks: [...state.srcLandmarks, { index: srcCounter, vertexIdx, position }],
    }));
  },

  addTarLandmark: (vertexIdx, position) => {
    tarCounter++;
    set((state) => ({
      tarLandmarks: [...state.tarLandmarks, { index: tarCounter, vertexIdx, position }],
    }));
  },

  removeSrcLandmark: (index) =>
    set((state) => ({
      srcLandmarks: state.srcLandmarks.filter((p) => p.index !== index),
    })),

  removeTarLandmark: (index) =>
    set((state) => ({
      tarLandmarks: state.tarLandmarks.filter((p) => p.index !== index),
    })),

  clearAll: () => {
    srcCounter = 0;
    tarCounter = 0;
    set({ srcLandmarks: [], tarLandmarks: [] });
  },

  isBalanced: () => {
    const { srcLandmarks, tarLandmarks } = get();
    return srcLandmarks.length === tarLandmarks.length && srcLandmarks.length > 0;
  },

  pairCount: () => {
    const { srcLandmarks, tarLandmarks } = get();
    return Math.min(srcLandmarks.length, tarLandmarks.length);
  },
}));
