# Trellis2 Integration Summary — April 28, 2026

## 1. Overview
TRELLIS.2 is integrated as an alternative to Tripo AI for rough model generation (node 3 in Page1 pipeline). Both single-image and multi-view workflows are supported.

---

## 2. File Locations

### Frontend Files
- **Service Client**: [src/services/trellis2.ts](src/services/trellis2.ts) — HTTP API wrapper
- **UI Component**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx) (lines 43-1300)
- **Proxy Config**: [vite.config.ts](vite.config.ts) (lines 66-86)
- **Planning Doc**: [Document/Trellis2_后续开发计划.md](Document/Trellis2_后续开发计划.md)

### Server-Side Files (DanLu A30 GPU)
Referenced but not in this repo:
- `scripts/danlu/trellis2/trellis2_server.py` — FastAPI server
- `scripts/danlu/trellis2/run_server.sh` — Startup script
- Server runs on DanLu internal network at `http://127.0.0.1:8766` (SSH tunnel required)

---

## 3. Trellis2Service API Methods

### File: [src/services/trellis2.ts](src/services/trellis2.ts)

#### Constants
```typescript
export const TRELLIS2_DEFAULTS = {
  sparseStructureSteps: 12,
  slatSteps: 12,
  cfg: 3.0,
  decimationTarget: 200_000,
  textureSize: 2048,
  remesh: true,
  simplifyCap: 8_000_000,
};
```

#### Main Methods

**1. `getHealth(): Promise<Trellis2Health>`**
- Checks server status and GPU availability
- Returns: `{ status, modelLoaded, modelPath, device, gpuName, gpuCount, gpuMemFreeGb, gpuMemTotalGb }`
- Endpoint: `GET /health`

**2. `warmup(): Promise<void>`**
- Preloads model onto GPU (avoids slow startup on first request)
- Typical duration: 1-3 minutes (first run), 0 (cached)
- Endpoint: `POST /warmup`

**3. `generateModel(image: File | Blob, params?: Trellis2Params): Promise<Trellis2Result>`**
- Generates 3D GLB model from single image
- Transport: Base64 JSON (works behind SSH tunnel)
- Returns: `{ glbUrl, blob, meta: { seed, sparseStructureSteps, slatSteps, cfgStrength, decimationTarget, textureSize, elapsedGenSec, elapsedBakeSec, elapsedTotalSec, glbBytes } }`
- Endpoint: `POST /generate_b64`

#### Parameter Types

**`Trellis2Params` Interface**
```typescript
export interface Trellis2Params {
  sparseStructureSteps?: number;      // 8-16 typical, controls geometry detail
  slatSteps?: number;                 // 8-16 typical, controls texture detail
  cfg?: number;                       // Classifier-free guidance, default 3.0
  seed?: number;                      // For deterministic results
  decimationTarget?: number;          // Target face count, default 200_000
  textureSize?: number;               // 512/1024/2048/4096, default 2048
  remesh?: boolean;                   // Pre-bake remeshing, default true
  simplifyCap?: number;               // Hard simplify limit, default 8_000_000
}
```

**`Trellis2Result` Interface**
```typescript
export interface Trellis2Result {
  glbUrl: string;                     // Blob URL for viewer
  blob: Blob;                         // Raw GLB bytes
  meta: {
    seed: number;
    sparseStructureSteps: number;
    slatSteps: number;
    cfgStrength: number;
    decimationTarget: number;
    textureSize: number;
    elapsedGenSec: number;            // Generation time
    elapsedBakeSec: number;           // Baking/texture time
    elapsedTotalSec: number;
    glbBytes: number;
  };
}
```

---

## 4. Rough Model Generation Workflow

### Pipeline Node Configuration
**File**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L1-50)

```typescript
const NODES: NodeConfig[] = [
  { id: 'concept', title: 'Concept', display: 'image' },
  { id: 'tpose', title: 'T Pose', display: 'image' },
  { id: 'multiview', title: 'Multi-View', display: 'multiview' },
  { id: 'rough', title: 'Rough Model', display: '3d' },     // ← Node 3 (Image → GLB)
  { id: 'rigging', title: 'Rough Model Rigging', display: '3d' },  // ← Node 4 (Skeleton binding)
];
```

### Backend Selection UI
**Lines**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L43-1290)

```typescript
type RoughBackend = 'tripo' | 'trellis2';

// Backend selection stored in localStorage
const ROUGH_BACKEND_LS_KEY = 'page1.rough.backend';
const [roughBackend, setRoughBackend] = useState<RoughBackend>(loadRoughBackend);

// Trellis2 parameters stored in localStorage
const TRELLIS2_PARAMS_LS_KEY = 'page1.rough.trellis2Params';
const [trellis2Params, setTrellis2Params] = useState<Trellis2Params>(loadTrellis2Params);
```

**Backend Selection UI** (RoughBackendPanel):
- Dropdown to select: "Tripo (multi-view)" vs "TRELLIS.2 (single-view)"
- When Trellis2 selected:
  - Expandable parameter panel showing:
    - SS steps (sparse structure): 1-50
    - SLat steps (shape+texture): 1-50
    - CFG strength: numeric input
    - Seed: numeric input
    - Decimation target: numeric input
    - Texture size: numeric input
  - "Warmup" button to preload model (1-3 min)
  - "Expand/Hide Parameters" toggle

### Input Image Selection
**Lines**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L479-560)

```
Multi-View Image (PNG) → Split into 4 views (front/left/back/right)
  ↓
TRELLIS.2: Prioritize split 'front' view if available, otherwise use full Multi-View image
Tripo: Use multi-view inputs if available, otherwise single image
```

### Generation Flow
**Function**: `runRoughModel()` (lines 461-645)

```
1. ✓ Load latest Multi-View image
2. ✓ Try to split into 4 views (front/left/back/right)
3. ✓ SELECT BACKEND:
   
   IF backend === 'trellis2':
     1. Use split 'front' view OR fallback to full Multi-View image
     2. Health check: GET /health (verify model loaded)
     3. Generate: POST /generate_b64 with params
     4. Save result to projectStore (page1.rough)
     5. Update viewer
   
   ELSE (Tripo):
     1. Use multi-view inputs if available
     2. Call runMultiViewToModel() or runImageToModel()
     3. Save result to projectStore (page1.rough)
     4. Update viewer

4. ✓ Persist to project: Projects/<name>/page1_concept_to_rough/02_rough/
   - Filename: `trellis2_<timestamp>.glb` or `tripo_<timestamp>.glb`
   - Saved via projectStore.saveAsset('page1.rough', blob, 'glb', label)

5. ✓ Create preview URL: URL.createObjectURL(blob)
6. ✓ Show success message with timing info
```

### Key Code Snippet
**Lines**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L535-580)

```typescript
if (backend === 'trellis2') {
  // TRELLIS.2 single-image path
  const inputBlob = multiInputs?.front ?? await (await fetch(mvUrl)).blob();
  const sourceLabel = multiInputs?.front ? 'front view' : 'Multi-View full image';
  
  try {
    // Health check
    const health = await getTrellis2Health();
    if (!health.modelLoaded) {
      throw new Error('TRELLIS.2 model not loaded');
    }
    
    // Generate GLB
    const t2Result = await runTrellis2(inputBlob, trellis2Params);
    blob = t2Result.blob;
    saveLabel = `trellis2 seed=${t2Result.meta.seed} gen=${t2Result.meta.elapsedGenSec}s bake=${t2Result.meta.elapsedBakeSec}s`;
  } catch (e) {
    throw new Error(`TRELLIS.2 service unreachable: ${e.message} (check SSH tunnel)...`);
  }
} else {
  // Tripo multi-view path
  const tripoResult = multiInputs
    ? await runMultiViewToModel(multiInputs, { onStatus, signal })
    : await runImageToModel(await (await fetch(mvUrl)).blob(), { onStatus, signal });
  blob = tripoResult.blob;
}

// Persist to project
const v = await saveAsset('page1.rough', blob, 'glb', saveLabel);
```

---

## 5. Infrastructure & Setup

### Network Architecture
```
Browser (http://localhost:5173)
    ↓ Vite Proxy (/trellis → http://127.0.0.1:8766)
    ↓ SSH Tunnel (localhost:8766)
    ↓ SSH Server (apps-sl.danlu.netease.com:44304)
    ↓ Internal Network
    ↓ DanLu A30 GPU (FastAPI Server port 8766)
```

### Environment Variables
**File**: [vite.config.ts](vite.config.ts#L11-12)

```typescript
const TRELLIS2_URL = env.VITE_TRELLIS2_URL ?? 'http://127.0.0.1:8766';
```

Can be overridden in `.env.local`:
```
VITE_TRELLIS2_URL=http://127.0.0.1:8766
```

### Vite Proxy Configuration
**File**: [vite.config.ts](vite.config.ts#L66-86)

```typescript
'/trellis': {
  target: TRELLIS2_URL,
  changeOrigin: true,
  timeout: 1_800_000,       // 30 minutes for full pipeline
  proxyTimeout: 1_800_000,
  rewrite: (path) => path.replace(/^\/trellis/, ''),
  configure: (proxy) => {
    proxy.on('error', (err, req) => {
      console.error('[vite-proxy /trellis]', req.method, req.url, '→', err.message);
    });
  },
},
```

### SSH Tunnel Command
```bash
ssh -i C:/tmp/DanLu_key -p 44304 -L 8766:127.0.0.1:8766 root@apps-sl.danlu.netease.com
```

Or via PowerShell (from workspace):
```powershell
ssh -i "D:\AI\PrivateKeys\DanLu\xuxiao02_rsa" -p 44304 -N -L 8766:127.0.0.1:8766 root@apps-sl.danlu.netease.com
```

---

## 6. Performance Characteristics

### Timing Breakdown (on A30)
| Stage | First Run | Cached |
|-------|-----------|--------|
| Model Load (warmup) | 157s | 0s |
| Generation (sparse + shape) | 29s | similar |
| Baking (texture + export) | 29s | similar |
| **Total** | **~6-8 min** | **60-90s** |

### Quality Settings
| Parameter | Min | Default | Max | Impact |
|-----------|-----|---------|-----|--------|
| Sparse Structure Steps | 1 | 12 | 50 | Geometry detail |
| SLat Steps | 1 | 12 | 50 | Texture detail |
| CFG Strength | 0 | 3.0 | 20 | Adherence to input |
| Texture Size | 512 | 2048 | 4096 | PBR texture quality |
| Decimation Target | | 200k | | Face count in output |

### Output Format
- **Type**: GLB (PBR textured 3D model)
- **Texture**: Baked Albedo, Normal, Roughness, Metallic
- **Faces**: Configurable, default 200k—400k typical
- **Supported Viewers**: Three.js, Babylon.js, Cesium GltfLoader

---

## 7. UI Components & State Management

### State Variables
**File**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L109-120)

```typescript
// Backend selection
const [roughBackend, setRoughBackend] = useState<RoughBackend>(loadRoughBackend);

// Trellis2-specific parameters
const [trellis2Params, setTrellis2Params] = useState<Trellis2Params>(loadTrellis2Params);

// UI state
const [showTrellis2Params, setShowTrellis2Params] = useState(false);

// Both persisted to localStorage automatically
useEffect(() => {
  localStorage.setItem(ROUGH_BACKEND_LS_KEY, roughBackend);
}, [roughBackend]);

useEffect(() => {
  localStorage.setItem(TRELLIS2_PARAMS_LS_KEY, JSON.stringify(trellis2Params));
}, [trellis2Params]);
```

### RoughBackendPanel Component
**Lines**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L1128-1290)

Props:
- `backend: RoughBackend` — Current backend selection
- `trellis2Params: Trellis2Params` — Parameter values
- `expanded: boolean` — Parameter panel visibility
- `onChangeBackend(b)` — Backend selection callback
- `onChangeTrellis2Params(p)` — Parameter update callback
- `onToggleExpanded()` — Toggle parameter visibility
- `onWarmup()` — Trigger model preload
- `disabled?: boolean` — Disable during generation

UI Elements:
1. Backend dropdown (Tripo / TRELLIS.2)
2. When TRELLIS.2 selected:
   - "Expand/Hide Parameters ▼/▲" button
   - "Warmup" button (preload model)
   - If expanded:
     - SS steps input (1-50)
     - SLat steps input (1-50)
     - CFG strength input
     - Seed input
     - Decimation target input
     - Texture size input

---

## 8. Error Handling & Recovery

### Common Errors & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `TRELLIS.2 service unreachable` | SSH tunnel not running | Start tunnel: `ssh -L 8766:127.0.0.1:8766 ...` |
| `model not loaded` | Model not in GPU memory | Click "Warmup" button to preload (1-3 min) |
| `POST /generate_b64 failed: 500` | Server error (check logs) | Contact server admin, check `/project/trellis2/logs/` |
| `timeout: 1_800_000ms exceeded` | Generation took >30 min | Reduce steps or decimation target |
| `Connection refused: 127.0.0.1:8766` | Vite proxy misconfigured | Verify SSH tunnel and vite.config.ts |

### Error Reporting
**File**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L630-645)

Errors are displayed in UI with:
- Error message (red text in node card)
- Task ID (for Tripo failures)
- Auto-retry capability via re-running node

---

## 9. Rigging & Related Components

### Node 4: Rough Model Rigging
**Current Status**: PLACEHOLDER (mock runner)

**File**: [src/pages/Page1/ConceptToRoughModel.tsx](src/pages/Page1/ConceptToRoughModel.tsx#L645-655)

```typescript
// ---- Mock runner for nodes 3..4 (Rough Model / Rigging) -----------------
const runMockNode = useCallback(
  (idx: number): Promise<boolean> => {
    setNodeState(idx, 'running');
    onStatusChange(`正在运行：${NODES[idx].title}（mock）`, 'info');
    return new Promise<boolean>((resolve) => {
      window.setTimeout(() => {
        setStates((prev) => {
          const next = [...prev];
          next[idx] = 'complete';
          if (idx + 1 < next.length && next[idx + 1] === 'idle') {
            next[idx + 1] = 'ready';
          }
          return next;
        });
        onStatusChange(`${NODES[idx].title} 已完成（mock）`, 'success');
        resolve(true);
      }, 2000);
    });
  },
  [onStatusChange, setNodeState]
);
```

**Node Definition**:
```typescript
{ id: 'rigging', title: 'Rough Model Rigging', display: '3d', description: '骨骼绑定' }
```

### Rigging References in Project
- **Project Key**: `page1.rigging`
- **Node Index**: 4 (last in Page1 pipeline)
- **Expected Workflow**: Rough GLB → Skeleton/Bone rigging → Rigged GLB
- **Current Implementation**: Mock only (2-second delay)

### Future Rigging Implementation Considerations
1. Input: GLB from node 3 (Rough Model)
2. Service: Could use Mixamo API or custom rigging engine
3. Output: GLB with armature/skeleton
4. Integration point: To be defined

---

## 10. Project Storage

### Asset Naming Convention
**File**: [src/services/projectStore.ts](src/services/projectStore.ts)

Assets are saved with descriptive labels:
- **Tripo**: `tripo task <task_id>`
- **TRELLIS.2**: `trellis2 seed=<seed> gen=<gen_sec>s bake=<bake_sec>s`

### Directory Structure
```
Projects/<project_name>/
  page1_concept_to_rough/
    01_concept/
      index.json
      <concept_image>.png (v0001, v0002, ...)
    02_rough/
      index.json
      trellis2_<timestamp>.glb (v0001, v0002, ...)
      tripo_<timestamp>.glb (v0001, v0002, ...)
    02_tpose/
      index.json
      <tpose_image>.png (v0001, v0002, ...)
    03_multiview/
      index.json
      <base>_v0001/
        front_v0001.png
        left_v0001.png
        back_v0001.png
        right_v0001.png
        segments.json
    04_rough/ (alternative naming)
```

---

## 11. Integration Testing Checklist

- [ ] SSH tunnel running: `ssh -L 8766:127.0.0.1:8766 root@apps-sl.danlu.netease.com -p 44304`
- [ ] Vite dev server running: `npm run dev` (http://localhost:5173)
- [ ] Health check passes: GET `http://localhost:5173/trellis/health`
- [ ] Warmup completes: POST `http://localhost:5173/trellis/warmup` (~2-3 min)
- [ ] Single-image generation: Upload concept → T-Pose → Multi-View → Run Rough Model (Trellis2, 60-90s)
- [ ] Multi-view generation: Verify front/left/back/right split from Multi-View image
- [ ] Parameters persist: Reload page, verify backend and params retained in localStorage
- [ ] Error recovery: Kill SSH tunnel, verify error message appears, restart tunnel, retry succeeds
- [ ] Project persistence: Verify GLB saved to `Projects/<name>/page1_concept_to_rough/02_rough/`
- [ ] History tracking: Verify multiple Trellis2/Tripo runs appear in history dropdown

---

## 12. Related Services & APIs

### Companion Services
- **Tripo AI**: [src/services/tripo.ts](src/services/tripo.ts) — Image-to-GLB (multi-view capable)
- **ComfyUI**: [src/services/comfyui.ts](src/services/comfyui.ts) — Workflow orchestration (T-Pose, Multi-View)
- **Project Store**: [src/services/projectStore.ts](src/services/projectStore.ts) — Asset persistence

### Workflow Context
This is **Page 1** (Concept → Rough Model) in the 3D asset pipeline:
- **Page 1**: Concept → T-Pose → Multi-View → Rough Model → [Rigging] ← Trellis2 used here
- **Page 2**: Rough Model → Part isolation → High-res model (per-part)
- **Page 3**: Multi-part assembly → Final rigged character

---

## 13. Documentation & References

- **Server Setup**: [scripts/danlu/trellis2/run_server.sh](../scripts/danlu/trellis2/run_server.sh)
- **Dynamic Planning**: [Document/Trellis2_后续开发计划.md](Document/Trellis2_后续开发计划.md)
- **MCP Capabilities**: [Document/danqingyue_mcp.md](Document/danqingyue_mcp.md) — Trellis2 MCP info
- **Architecture Docs**: [QWEN_CODEBASE_INVENTORY.md](QWEN_CODEBASE_INVENTORY.md)
- **Models Used**: Trellis.2-4B (16GB), runs on DanLu A30
