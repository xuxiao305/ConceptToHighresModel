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
  updateSrcLandmark: (index: number, position: Vec3, vertexIdx?: number) => void;
  updateTarLandmark: (index: number, position: Vec3, vertexIdx?: number) => void;
  removeSrcLandmark: (index: number) => void;
  removeTarLandmark: (index: number) => void;
  clearSrcLandmarks: () => void;
  clearTarLandmarks: () => void;
  clearAll: () => void;
  transformSrcLandmarks: (matrix: number[][]) => void;
  transformTarLandmarks: (matrix: number[][]) => void;

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

  updateSrcLandmark: (index, position, vertexIdx = -1) =>
    set((state) => ({
      srcLandmarks: state.srcLandmarks.map((p) =>
        p.index === index ? { ...p, position, vertexIdx } : p,
      ),
    })),

  updateTarLandmark: (index, position, vertexIdx = -1) =>
    set((state) => ({
      tarLandmarks: state.tarLandmarks.map((p) =>
        p.index === index ? { ...p, position, vertexIdx } : p,
      ),
    })),

  removeSrcLandmark: (index) =>
    set((state) => ({
      srcLandmarks: state.srcLandmarks.filter((p) => p.index !== index),
    })),

  removeTarLandmark: (index) =>
    set((state) => ({
      tarLandmarks: state.tarLandmarks.filter((p) => p.index !== index),
    })),

  clearSrcLandmarks: () => {
    srcCounter = 0;
    set({ srcLandmarks: [] });
  },

  clearTarLandmarks: () => {
    tarCounter = 0;
    set({ tarLandmarks: [] });
  },

  clearAll: () => {
    srcCounter = 0;
    tarCounter = 0;
    set({ srcLandmarks: [], tarLandmarks: [] });
  },

  transformSrcLandmarks: (matrix) =>
    set((state) => ({
      srcLandmarks: state.srcLandmarks.map((p) => {
        const [x, y, z] = p.position;
        const nx = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3];
        const ny = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3];
        const nz = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3];
        return { ...p, position: [nx, ny, nz] };
      }),
    })),

  transformTarLandmarks: (matrix) =>
    set((state) => ({
      tarLandmarks: state.tarLandmarks.map((p) => {
        const [x, y, z] = p.position;
        const nx = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3];
        const ny = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3];
        const nz = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3];
        return { ...p, position: [nx, ny, nz] };
      }),
    })),

  isBalanced: () => {
    const { srcLandmarks, tarLandmarks } = get();
    return srcLandmarks.length === tarLandmarks.length && srcLandmarks.length > 0;
  },

  pairCount: () => {
    const { srcLandmarks, tarLandmarks } = get();
    return Math.min(srcLandmarks.length, tarLandmarks.length);
  },
}));
