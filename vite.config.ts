import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // ComfyUI server URL — kept as fallback proxy in case any future workflow
  // needs ComfyUI again. The current pipeline talks to Leihuo directly.
  const COMFY_URL = env.VITE_COMFY_URL ?? 'http://127.0.0.1:8188';
  const COMFY_USER = env.VITE_COMFY_USER ?? '';

  // Qwen-Image-Edit FastAPI server (DanLu A30 instance via SSH `-L 8765:127.0.0.1:8765`).
  const QWEN_URL = env.VITE_QWEN_URL ?? 'http://127.0.0.1:8765';

  // TRELLIS.2 image-to-3D FastAPI server (DanLu A30 via SSH `-L 8766:127.0.0.1:8766`).
  const TRELLIS2_URL = env.VITE_TRELLIS2_URL ?? 'http://127.0.0.1:8766';

  // Leihuo (Netease) AI gateway — OpenAI-compatible Chat Completions endpoint.
  const LEIHUO_URL = env.VITE_LEIHUO_BASE ?? 'https://ai.leihuo.netease.com';

  // Tripo AI 3D model generation — image → GLB/FBX.
  const TRIPO_URL = env.VITE_TRIPO_BASE ?? 'https://ai.leihuo.netease.com';

  return {
    plugins: [react()],
    server: {
      // Listen on IPv4 explicitly to avoid Edge multipart upload bugs over IPv6/::1
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      open: true,
      proxy: {
        // Leihuo AI gateway — used for Concept→T-Pose, T-Pose→Multi-View image gen.
        '/leihuo': {
          target: LEIHUO_URL,
          changeOrigin: true,
          timeout: 600_000,
          proxyTimeout: 600_000,
          rewrite: (path) => path.replace(/^\/leihuo/, ''),
          configure: (proxy) => {
            proxy.on('error', (err, req) => {
              // eslint-disable-next-line no-console
              console.error('[vite-proxy /leihuo]', req.method, req.url, '→', err.message);
            });
          },
        },
        // ComfyUI proxy (currently unused — kept for future workflows).
        '/comfy': {
          target: COMFY_URL,
          changeOrigin: true,
          ws: true,
          timeout: 600_000,
          proxyTimeout: 600_000,
          rewrite: (path) => path.replace(/^\/comfy/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('origin', COMFY_URL);
              proxyReq.setHeader('referer', COMFY_URL + '/');
              if (COMFY_USER) proxyReq.setHeader('comfy-user', COMFY_USER);
            });
            proxy.on('error', (err, req) => {
              // eslint-disable-next-line no-console
              console.error('[vite-proxy /comfy]', req.method, req.url, '→', err.message);
            });
          },
        },
        // Qwen-Image-Edit server. Long timeout because /warmup can take minutes
        // (model is ~50GB streaming from disk) and inference 60-180s per image.
        '/qwen': {
          target: QWEN_URL,
          changeOrigin: true,
          timeout: 1_800_000,
          proxyTimeout: 1_800_000,
          rewrite: (path) => path.replace(/^\/qwen/, ''),
          configure: (proxy) => {
            proxy.on('error', (err, req) => {
              // eslint-disable-next-line no-console
              console.error('[vite-proxy /qwen]', req.method, req.url, '→', err.message);
            RELLIS.2 image-to-3D server. Long timeout — first run can take
        // 1-3 minutes (model load) plus 30-60s per generation on A30.
        '/trellis': {
          target: TRELLIS2_URL,
          changeOrigin: true,
          timeout: 1_800_000,
          proxyTimeout: 1_800_000,
          rewrite: (path) => path.replace(/^\/trellis/, ''),
          configure: (proxy) => {
            proxy.on('error', (err, req) => {
              // eslint-disable-next-line no-console
              console.error('[vite-proxy /trellis]', req.method, req.url, '→', err.message);
            });
          },
        },
        // T});
          },
        },
        // Tripo AI — used by Rough Model node (image → GLB).
        '/tripo': {
          target: TRIPO_URL,
          changeOrigin: true,
          timeout: 600_000,
          proxyTimeout: 600_000,
          rewrite: (path) => path.replace(/^\/tripo/, ''),
          configure: (proxy) => {
            proxy.on('error', (err, req) => {
              // eslint-disable-next-line no-console
              console.error('[vite-proxy /tripo]', req.method, req.url, '→', err.message);
            });
          },
        },
      },
    },
  };
});
