/// <reference types="node" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // ComfyUI server URL — kept as fallback proxy in case any future workflow
  // needs ComfyUI again. The current pipeline talks to Leihuo directly.
  const COMFY_URL = env.VITE_COMFY_URL ?? 'http://127.0.0.1:8188';
  const COMFY_USER = env.VITE_COMFY_USER ?? '';

  // TRELLIS.2 image-to-3D FastAPI server (DanLu A30 via SSH `-L 8766:127.0.0.1:8766`).
  const TRELLIS2_URL = env.VITE_TRELLIS2_URL ?? 'http://127.0.0.1:8766';

  // Leihuo (Netease) AI gateway — OpenAI-compatible Chat Completions endpoint.
  const LEIHUO_URL = env.VITE_LEIHUO_BASE ?? 'https://ai.leihuo.netease.com';

  // Tripo AI 3D model generation — image → GLB/FBX.
  const TRIPO_URL = env.VITE_TRIPO_BASE ?? 'https://ai.leihuo.netease.com';

  // SAM3 standalone app (D:\AI\Prototypes\SAM3_Segment) — used by Page2
  // Extraction node's "SAM3 cutting" mode. The bridge (sam3ExtractPlugin)
  // spawns the GUI app with --image / --export-dir / --auto-exit-on-export
  // so the user can do interactive segmentation in a native window and the
  // browser receives the resulting mask + JSON when they hit "导出 JSON".
  const SAM3_PYTHON =
    env.VITE_SAM3_PYTHON ?? 'D:\\AI\\Prototypes\\SAM3_Segment\\.venv\\python.exe';
  const SAM3_PROJECT_DIR =
    env.VITE_SAM3_PROJECT_DIR ?? 'D:\\AI\\Prototypes\\SAM3_Segment';

  // RMBG-2.0 worker (D:\AI\Prototypes\ConceptToHighresModel\scripts\rmbg\rmbg_worker.py) —
  // Page2 “Jacket Extract” uses this to white-out Banana Pro's near-white
  // background before SmartCropAndEnlargeAuto. We reuse ComfyUI Easy Install's
  // embedded Python (which already has torch + transformers + the RMBG-2.0
  // weights cached at <ComfyUI>/models/RMBG/RMBG-2.0).
  const RMBG_PYTHON =
    env.VITE_RMBG_PYTHON ?? 'D:\\AI\\ComfyUI-Easy-Install\\python_embeded\\python.exe';
  const RMBG_WORKER =
    env.VITE_RMBG_WORKER ??
    path.join(process.cwd(), 'scripts', 'rmbg', 'rmbg_worker.py');
  const RMBG_MODEL_DIR =
    env.VITE_RMBG_MODEL_DIR ??
    'D:\\AI\\ComfyUI-Easy-Install\\ComfyUI\\models\\RMBG\\RMBG-2.0';

  return {
    plugins: [
      react(),
      sam3ExtractPlugin({ python: SAM3_PYTHON, projectDir: SAM3_PROJECT_DIR }),
      rmbgPlugin({ python: RMBG_PYTHON, worker: RMBG_WORKER, modelDir: RMBG_MODEL_DIR }),
    ],
    // Allow the test_align_e2e.html page to be served as a second entry.
    appType: 'mpa',
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
        // TRELLIS.2 image-to-3D server. Long timeout — first run can take
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

// ============================================================================
// SAM3 bridge plugin
// ============================================================================
//
// Exposes a single dev-server endpoint:
//
//   POST /api/sam3-extract
//     Content-Type: application/json
//     Body: { imageBase64: "data:image/png;base64,..." }
//
//     Behaviour:
//       1. Writes the image to a fresh temp directory.
//       2. Spawns `<python> <projectDir>/sam3_app/main.py --image <tmp>/in.png
//                  --export-dir <tmp> --export-basename segmentation
//                  --auto-exit-on-export`
//          The SAM3 GUI opens with the image preloaded; the user does point
//          clicks and hits "导出 JSON". The window closes automatically once
//          the export lands.
//       3. After the python process exits, reads `<tmp>/segmentation.json` and
//          `<tmp>/segmentation_mask.png` and returns them as a single JSON
//          payload to the browser.
//
//     Response shape:
//       { ok: true,  json: <ExportData>, maskBase64: "data:image/png;..." }
//       { ok: false, error: <string>,  cancelled?: boolean }
//
// Notes:
//   * This runs inside the Vite dev server's own Node process — no extra
//     Python services to manage.
//   * The plugin is dev-only (`apply: 'serve'`); production builds skip it.
//
interface Sam3PluginOptions {
  python: string;
  projectDir: string;
}

// ============================================================================
// RMBG bridge plugin
// ============================================================================
//
// Exposes a single dev-server endpoint:
//
//   POST /api/rmbg
//     Content-Type: application/json
//     Body: {
//       imageBase64: "data:image/png;base64,...",
//       processRes?: number,        // default 1024 (matches workflow)
//       sensitivity?: number,       // default 1.0
//       maskBlur?: number,          // default 0
//       maskOffset?: number,        // default 0
//       backgroundColor?: string,   // default "#ffffff"
//     }
//
//     Spawns scripts/rmbg/rmbg_worker.py once per call (the RMBG-2.0 model is
//     reloaded each time — a few seconds on warm disk cache, ~10s cold; not
//     worth the long-lived-process complexity for the current usage volume).
//
//     Response shape:
//       { ok: true,  imageBase64: "data:image/png;base64,..." }
//       { ok: false, error: <string> }
//
interface RmbgPluginOptions {
  python: string;
  worker: string;
  modelDir: string;
}

function rmbgPlugin(opts: RmbgPluginOptions): Plugin {
  return {
    name: 'rmbg-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/rmbg', async (req, res, next) => {
        if (req.method !== 'POST') return next();

        const sendJson = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };

        let body = '';
        try {
          for await (const chunk of req) body += chunk;
        } catch (err) {
          return sendJson(400, { ok: false, error: `读取请求体失败：${(err as Error).message}` });
        }

        let parsed: {
          imageBase64?: string;
          processRes?: number;
          sensitivity?: number;
          maskBlur?: number;
          maskOffset?: number;
          backgroundColor?: string;
        };
        try {
          parsed = JSON.parse(body);
          if (!parsed.imageBase64) throw new Error('缺少 imageBase64 字段');
        } catch (err) {
          return sendJson(400, { ok: false, error: `请求体不合法：${(err as Error).message}` });
        }

        const m = /^data:image\/[^;]+;base64,(.+)$/.exec(parsed.imageBase64!);
        const pureB64 = m ? m[1] : parsed.imageBase64!;

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmbg-bridge-'));
        const inputPath = path.join(tmpDir, 'in.png');
        const outputPath = path.join(tmpDir, 'out.png');

        try {
          await fs.writeFile(inputPath, Buffer.from(pureB64, 'base64'));

          const args = [
            opts.worker,
            '--input', inputPath,
            '--output', outputPath,
            '--model-dir', opts.modelDir,
            '--process-res', String(parsed.processRes ?? 1024),
            '--sensitivity', String(parsed.sensitivity ?? 1.0),
            '--mask-blur', String(parsed.maskBlur ?? 0),
            '--mask-offset', String(parsed.maskOffset ?? 0),
            '--background-color', parsed.backgroundColor ?? '#ffffff',
          ];
          // eslint-disable-next-line no-console
          console.log('[rmbg-bridge] spawn:', opts.python, args.join(' '));

          const child = spawn(opts.python, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });

          let stderr = '';
          let stdout = '';
          child.stderr.on('data', (d) => {
            const text = d.toString();
            stderr += text;
            process.stderr.write(`[rmbg-bridge] ${text}`);
          });
          child.stdout.on('data', (d) => {
            const text = d.toString();
            stdout += text;
            process.stdout.write(`[rmbg-bridge] ${text}`);
          });

          const exitCode: number = await new Promise((resolve) => {
            child.on('exit', (code) => resolve(code ?? -1));
            child.on('error', () => resolve(-1));
          });

          if (exitCode !== 0) {
            return sendJson(500, {
              ok: false,
              error: `RMBG 进程退出码 ${exitCode}\n${stderr.slice(-2000)}`,
            });
          }

          let outExists = true;
          try { await fs.access(outputPath); } catch { outExists = false; }
          if (!outExists) {
            return sendJson(500, {
              ok: false,
              error: `RMBG 未产生输出文件\n${stderr.slice(-1000)}`,
            });
          }
          // Touch stdout so the variable is meaningfully observable in dev logs.
          void stdout;

          const buf = await fs.readFile(outputPath);
          return sendJson(200, {
            ok: true,
            imageBase64: `data:image/png;base64,${buf.toString('base64')}`,
          });
        } catch (err) {
          return sendJson(500, {
            ok: false,
            error: `RMBG 桥接异常：${(err as Error).message}`,
          });
        } finally {
          fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    },
  };
}

function sam3ExtractPlugin(opts: Sam3PluginOptions): Plugin {
  return {
    name: 'sam3-extract-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/sam3-extract', async (req, res, next) => {
        if (req.method !== 'POST') return next();

        const sendJson = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };

        // ── 1. Parse the JSON body ───────────────────────────────────────
        let body = '';
        try {
          for await (const chunk of req) body += chunk;
        } catch (err) {
          return sendJson(400, { ok: false, error: `读取请求体失败：${(err as Error).message}` });
        }

        let imageBase64: string;
        try {
          const parsed = JSON.parse(body) as { imageBase64?: string };
          if (!parsed.imageBase64) throw new Error('缺少 imageBase64 字段');
          imageBase64 = parsed.imageBase64;
        } catch (err) {
          return sendJson(400, { ok: false, error: `请求体不合法：${(err as Error).message}` });
        }

        // Strip the data-URL prefix if present.
        const m = /^data:image\/[^;]+;base64,(.+)$/.exec(imageBase64);
        const pureB64 = m ? m[1] : imageBase64;

        // ── 2. Write image to a fresh temp dir ───────────────────────────
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sam3-bridge-'));
        const inputPath = path.join(tmpDir, 'in.png');
        const jsonPath = path.join(tmpDir, 'segmentation.json');
        const maskPath = path.join(tmpDir, 'segmentation_mask.png');

        try {
          await fs.writeFile(inputPath, Buffer.from(pureB64, 'base64'));

          // ── 3. Spawn the SAM3 GUI ─────────────────────────────────────
          // NB: invoke the script DIRECTLY (not `-m sam3_app.main`) — the
          // SAM3_Segment venv's sys.path doesn't include the project root,
          // so module-mode resolution fails. main.py has its own bootstrap
          // that adds the parent dir to sys.path before any imports.
          const mainScript = path.join(opts.projectDir, 'sam3_app', 'main.py');
          const args = [
            mainScript,
            '--image', inputPath,
            '--export-dir', tmpDir,
            '--export-basename', 'segmentation',
            '--auto-exit-on-export',
          ];
          // eslint-disable-next-line no-console
          console.log('[sam3-bridge] spawn:', opts.python, args.join(' '));

          const child = spawn(opts.python, args, {
            cwd: opts.projectDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false,
          });

          let stderr = '';
          child.stderr.on('data', (d) => {
            const text = d.toString();
            stderr += text;
            // Forward stderr to vite's console for debugging.
            process.stderr.write(`[sam3-bridge] ${text}`);
          });
          child.stdout.on('data', (d) => {
            process.stdout.write(`[sam3-bridge] ${d.toString()}`);
          });

          const exitCode: number = await new Promise((resolve) => {
            child.on('exit', (code) => resolve(code ?? -1));
            child.on('error', () => resolve(-1));
          });

          if (exitCode !== 0) {
            return sendJson(500, {
              ok: false,
              error: `SAM3 进程退出码 ${exitCode}\n${stderr.slice(-2000)}`,
            });
          }

          // ── 4. Read back results ──────────────────────────────────────
          let jsonExists = true;
          try {
            await fs.access(jsonPath);
          } catch {
            jsonExists = false;
          }
          if (!jsonExists) {
            // User closed the window without exporting — treat as cancellation.
            return sendJson(200, {
              ok: false,
              cancelled: true,
              error: '用户在 SAM3 窗口中未导出即关闭',
            });
          }

          const [jsonText, maskBuf] = await Promise.all([
            fs.readFile(jsonPath, 'utf8'),
            fs.readFile(maskPath),
          ]);

          return sendJson(200, {
            ok: true,
            json: JSON.parse(jsonText),
            maskBase64: `data:image/png;base64,${maskBuf.toString('base64')}`,
          });
        } catch (err) {
          return sendJson(500, {
            ok: false,
            error: `SAM3 桥接异常：${(err as Error).message}`,
          });
        } finally {
          // Clean up the temp dir (fire-and-forget; don't block the response).
          fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    },
  };
}
