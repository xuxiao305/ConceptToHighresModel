import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ComfyUI server URL — override via VITE_COMFY_URL env var if not running locally on default port.
const COMFY_URL = process.env.VITE_COMFY_URL ?? 'http://127.0.0.1:8188';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Proxy ComfyUI HTTP API & WebSocket through Vite dev server to avoid CORS.
      // Frontend code calls /comfy/... and Vite forwards to the real server.
      '/comfy': {
        target: COMFY_URL,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/comfy/, ''),
      },
    },
  },
});
