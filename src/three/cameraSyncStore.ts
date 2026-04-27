/**
 * Camera sync store — shared camera state for synchronized viewports.
 *
 * Verbatim port from D:/AI/Prototypes/WrapDeformation/frontend/src/stores/cameraSyncStore.ts
 * Used by `MeshViewer` when `cameraSyncId` is provided.
 */

import { create } from 'zustand';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom: number;
}

interface CameraSyncState {
  syncEnabled: boolean;
  cameraState: CameraState | null;
  lastUpdater: string | null;

  setSyncEnabled: (enabled: boolean) => void;
  updateCamera: (updater: string, state: CameraState) => void;
  getCameraState: (requester: string) => CameraState | null;
}

export const useCameraSyncStore = create<CameraSyncState>((set, get) => ({
  syncEnabled: false,
  cameraState: null,
  lastUpdater: null,

  setSyncEnabled: (enabled) => set({ syncEnabled: enabled }),

  updateCamera: (updater, state) => {
    const { syncEnabled } = get();
    if (!syncEnabled) return;
    set({ cameraState: state, lastUpdater: updater });
  },

  getCameraState: (requester) => {
    const { syncEnabled, cameraState, lastUpdater } = get();
    if (!syncEnabled || !cameraState || lastUpdater === requester) return null;
    return cameraState;
  },
}));
