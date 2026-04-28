# Qwen 开发整理清单（2026-04-28）

## 项目架构总览

本项目的 Qwen-Image-Edit 集成采用**客户端/服务端分离模式**：  
- **服务端**：独立工程 `D:\AI\Services\QwenEditService`（FastAPI + diffusers）  
- **前端客户端**：本工程内的 HTTP 客户端 + 业务流程 + ComfyUI 工作流文件  
- **部署**：DanLu GPU 主机（丹炉 A30 × 2，端口 8765）  

---

## 1️⃣ 前端服务层（HTTP 客户端）

### 文件：`src/services/qwenEdit.ts`
**角色**：Qwen-Image-Edit FastAPI 服务的 TypeScript 客户端。

#### 关键接口

| 接口/函数 | 用途 | 参数 |
|---------|------|-----|
| `QwenEditParams` | 编辑请求参数 | `prompt` / `negativePrompt` / `steps` / `cfg` / `seed` / `width` / `height` |
| `QwenEditResult` | 编辑返回结果 | `imageUrl`（blob URL）/ `blob`（PNG 字节）/ `meta`（seed/steps/cfg/时间/管线类）|
| `QwenHealth` | 健康检查返回 | `status` / `modelLoaded` / `pipelineClass` / `modelPath` / `device` / `gpuName` / `gpuCount` |
| `getHealth()` | 检查服务状态 | — | 返回 `QwenHealth` |
| `warmup()` | 触发模型加载 | — | 异步等待管线就绪 |
| `editImage(image, params)` | **核心编辑函数** | 图像文件/Blob + QwenEditParams | 返回 `QwenEditResult` |

#### 通信细节
- **协议**：HTTP POST（JSON body），使用 base64 编码图像数据  
- **路由映射**：Vite 代理 `/qwen` → `http://127.0.0.1:8765`（SSH 隧道后端）  
- **关键端点**：
  - `POST /health` — 服务健康检查  
  - `POST /warmup` — 加载模型  
  - `POST /edit_b64` — 执行编辑（base64 JSON 格式）  

#### 代码示例
```typescript
// 单个视角编辑
const result = await editImage(imageBlob, {
  prompt: 'Rotate the camera 45 degrees to the right.',
  negativePrompt: '',
  steps: 4,
  cfg: 1,
  seed: 405868421823137,
});
// result.imageUrl ← 可绑定到 <img src>
// result.blob ← 原始 PNG 字节
```

---

## 2️⃣ 业务流程层（工作流编排）

### 文件：`src/services/workflows.ts`

**角色**：高级工作流运行器，编排多个 AI 服务（Leihuo + Qwen）。

#### 导出函数

| 函数 | 功能 | 输入 | 输出 |
|-----|------|------|------|
| `runConceptToTPose()` | 概念图 → T-Pose | 用户上传图	| blob URL |
| `runTPoseMultiView()` | T-Pose → 4 视角多视图 | T-Pose 图 | blob URL |
| **`runQwenMultiView()`** | **概念图 → 8 视角** | 概念图 | `QwenViewResult[]` |

#### Qwen 多视角流程详解

**函数签名**：
```typescript
export async function runQwenMultiView(
  image: File | Blob,
  opts: RunOptions & { onEach?: (view: QwenViewResult) => void } = {},
): Promise<QwenViewResult[]>
```

**8 个预定义视角**（与 ComfyUI 工作流对齐）：

| 序号 | key | label | prompt | seed |
|-----|-----|-------|--------|------|
| 1 | `close_up` | Close Up | " Turn the camera to a close-up.\n" | 1106429432136498 |
| 2 | `wide_shot` | Wide Shot | "Turn the camera to a wide-angle lens.\n" | 864993937066247 |
| 3 | `45_right` | 45° Right | "Rotate the camera 45 degrees to the right.\n" | 405868421823137 |
| 4 | `90_right` | 90° Right | "Rotate the camera 90 degrees to the right.\n" | 507933693362283 |
| 5 | `aerial_view` | Aerial View | "Turn the camera to an aerial view." | 757958372345700 |
| 6 | `low_angle` | Low Angle | "Turn the camera to a low-angle view." | 495293742630408 |
| 7 | `45_left` | 45° Left | "Rotate the camera 45 degrees to the left." | 941061162245235 |
| 8 | `90_left` | 90° Left | "Rotate the camera 90 degrees to the left." | 202646758175812 |

**执行流程**：
1. 调用 `scaleToMegapixels(image, 1)` — 预处理，匹配 ComfyUI 的 `ImageScaleToTotalPixels` 行为
2. 循环遍历 8 个视角，逐个调用 `editImage()`
   - params：`steps=4`, `cfg=1`, `seed=预定义值`
   - `onEach()` 回调递增式返回结果（支持 UI 逐步显示）
3. 返回 `QwenViewResult[]` 数组

**导出类型**：
```typescript
export interface QwenViewResult {
  key: string;        // 视角 ID（e.g. "45_right"）
  label: string;      // 显示标签（e.g. "45° Right"）
  imageUrl: string;   // blob URL
  blob: Blob;         // PNG 字节
}
```

---

## 3️⃣ ComfyUI 工作流文件

### 文件：`ComfyuiWorkflow/Qwen_MultiView.json`

**角色**：ComfyUI 节点图定义，完整的 Qwen 多角度渲染管线。

#### 工作流结构

**节点层级**（简化表示）：
```
LoadImage (node 25)
  ↓
[8 个平行分支，每个分支对应一个视角]

每个分支：
  ├─ PrimitiveStringMultiline (66-73) — 视角提示词
  ├─ ImageScaleToTotalPixels — 1MP 预处理
  ├─ TextEncodeQwenImageEditPlus — 编码提示词
  ├─ VAEEncode — 图像编码
  ├─ KSampler — 采样（seed / steps / cfg）
  ├─ VAEDecode — 解码
  ├─ SaveImage — 保存输出
  └─ PreviewImage — 预览显示

模型加载节点（所有分支共用）：
  ├─ UNETLoader (48:12) → qwen_image_edit_2509_fp8_e4m3fn.safetensors
  ├─ CLIPLoader (48:10) → qwen_2.5_vl_7b_fp8_scaled.safetensors
  ├─ VAELoader (48:9) → qwen_image_vae.safetensors
  ├─ LoraLoaderModelOnly (48:20) → Qwen-Edit-2509-Multiple-angles.safetensors (多角度 LoRA)
  ├─ LoraLoaderModelOnly (48:26) → Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors (Lightning 4-step)
  ├─ ModelSamplingAuraFlow (shift=3) — 模型采样配置
  └─ CFGNorm (strength=1) — 分类器自由引导归一化
```

#### 模型资源清单

**模型文件位置**：`/project/qwen_edit/comfyui_models/`

| 模型类型 | 文件名 | 大小 | 路径 | 来源 |
|---------|--------|------|------|------|
| UNet (扩散) | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | 20.4 GB | `diffusion_models/` | Lightx2v/Qwen-Image-Lightning |
| CLIP (文本编码) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | 9.4 GB | `text_encoders/` | Comfy-Org/Qwen-Image_ComfyUI |
| VAE | `qwen_image_vae.safetensors` | ~0.5 GB | `vae/` | Comfy-Org/Qwen-Image_ComfyUI |

**LoRA 文件位置**：`/project/qwen_edit/loras/`

| LoRA 名称 | 大小 | 用途 | 来源 |
|---------|------|------|------|
| `Qwen-Edit-2509-Multiple-angles.safetensors` | ~300 MB | 多角度变换能力 | dx8152/Qwen-Edit-2509-Multiple-angles |
| `Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors` | ~850 MB | 4 步快速推理 | lightx2v/Qwen-Image-Lightning |

#### 核心参数

每个 KSampler 节点配置：
- **steps**：4（Lightning 4-step）
- **cfg**：1（无分类器自由引导）
- **sampler_name**：euler
- **scheduler**：simple
- **denoise**：1.0
- **seed**：预定义（与前端 `workflows.ts` 中的 QWEN_VIEWS 对齐）

---

## 4️⃣ 构建与部署配置

### 文件：`vite.config.ts`

**Qwen 相关配置**：
```typescript
// 第 13 行
const QWEN_URL = env.VITE_QWEN_URL ?? 'http://127.0.0.1:8765';

// 第 67-78 行
'/qwen': {
  target: QWEN_URL,
  changeOrigin: true,
  timeout: 1_800_000,      // 30 分钟（/warmup 和推理可能很长）
  proxyTimeout: 1_800_000,
  rewrite: (path) => path.replace(/^\/qwen/, ''),
  configure: (proxy) => { /* 错误日志处理 */ },
},
```

**环境变量**：
- `VITE_QWEN_URL`（可选）：覆盖默认 `http://127.0.0.1:8765`

### 文件：`.env.qwen.example`
```env
# 本地前端 → Qwen-Image-Edit（DanLu）配置
VITE_QWEN_URL=http://127.0.0.1:8765
```

---

## 5️⃣ 后端服务（QwenEditService）

**位置**：`D:\AI\Services\QwenEditService`（独立工程）

### 核心模块

#### `server/qwen_edit_server.py`
- **框架**：FastAPI
- **模型**：`Qwen/Qwen-Image-Edit-2511` (bf16, 完整精度，非量化)
- **推理管线**：`QwenImageEditPlusPipeline` (diffusers)
- **GPU 分配**：双 GPU 分片（per-GPU ~22 GB VRAM）

**主要端点**：
| 路由 | 方法 | 功能 | 超时 |
|------|------|------|------|
| `/health` | POST | 返回服务状态 / 模型加载状况 | 5s |
| `/warmup` | POST | 加载模型到 GPU（首次启动） | 可能数分钟 |
| `/edit_b64` | POST | 执行编辑（base64 JSON） | 180s（可配置） |

**EditRequest 参数**：
```python
class EditRequest(BaseModel):
    image_b64: str           # base64 编码的输入图
    prompt: str              # 编辑指令
    negative_prompt: str     # 负面提示（默认 " "）
    num_inference_steps: int # 推理步数（默认 40，Lightning 模式 4）
    true_cfg_scale: float    # 分类器自由引导强度（默认 4.0）
    seed: Optional[int]      # 随机种子
    width: Optional[int]     # 输出宽度（可选）
    height: Optional[int]    # 输出高度（可选）
    lora_scale: float        # LoRA 混合强度（可选，新增）
```

**EditResponse 返回**：
```python
class EditResponse(BaseModel):
    image_b64: str           # base64 编码的输出 PNG
    seed: int
    elapsed_sec: float
    pipeline_class: str
    meta: dict               # 其他元数据
```

#### `server/loader.py`
- **职责**：双 GPU 模型加载与推理优化
- **关键类**：`QwenModelLoader`
  - 加载 `Qwen2_5_VLForConditionalGeneration`（文本编码器，~14 GB）
  - 加载 `QwenImageTransformer2DModel`（扩散 UNet，~15 GB）
  - 加载 `AutoencoderKLQwenImage`（VAE，~2 GB）
  - 支持动态 CPU 卸载（`QWEN_EDIT_OFFLOAD_DIR`）

**LoRA 支持**：
- 环境变量：`QWEN_EDIT_LORA_PATHS`（逗号分隔的 `.safetensors` 文件路径）
- 在推理前 `set_adapters(lora_scale, lora_scale, ...)` 动态加载
- 返回 `/health` 中的 `active_loras` 列表

---

## 6️⃣ 部署与资源管理

### 文件：`deploy/` 目录（QwenEditService）

#### `deploy/download_model.sh`
- 下载基础模型 `Qwen/Qwen-Image-Edit-2511` 到 `/project/qwen_edit/models/`
- 支持 HuggingFace 官方或镜像源（`HF_ENDPOINT=https://hf-mirror.com`）

#### `deploy/download_lora.sh`
- 下载 3 个 LoRA 文件到 `/project/qwen_edit/loras/`：
  1. `qwen-image-edit-2511-multiple-angles-lora.safetensors`（fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA）
  2. `Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors`（lightx2v/Qwen-Image-Lightning）
  3. `Qwen-Edit-2509-Multiple-angles.safetensors`（dx8152/Qwen-Edit-2509-Multiple-angles）

#### `deploy/download_fp8_comfyui.sh`
- 下载 ComfyUI 格式的 FP8 模型（仅用于直接 ComfyUI 执行，QwenEditService 不使用）
- 输出到 `/project/qwen_edit/comfyui_models/`：
  - `diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors`
  - `text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`
  - `vae/qwen_image_vae.safetensors`

#### `deploy/setup_env.sh`
- 创建 conda 环境 `qwen_edit`（Python 3.11）
- 安装依赖：diffusers / transformers / torch 等

#### `deploy/ssh_tunnel.ps1`
- PowerShell 脚本，建立 SSH 端口转发：
  ```powershell
  ssh -i "path/to/key" -p 44304 -L 8765:127.0.0.1:8765 root@apps-sl.danlu.netease.com
  ```

---

## 7️⃣ ComfyUI 模型路径映射

### 文件：`ComfyuiWorkflow/extra_model_paths.danlu.yaml`

**用途**：当在 DanLu 上运行 ComfyUI 时，指定 FP8 模型与 LoRA 的查找路径。

```yaml
qwen_danlu:
  base_path: /project/qwen_edit/comfyui_models
  diffusion_models: qwen_edit/comfyui_models/diffusion_models
  text_encoders: qwen_edit/comfyui_models/text_encoders
  vae: qwen_edit/comfyui_models/vae
  loras: qwen_edit/loras
```

**应用方式**：
```bash
# 在 ComfyUI 主目录
cp extra_model_paths.danlu.yaml extra_model_paths.yaml
# 或在启动时指定：
python main.py --extra-model-paths-config extra_model_paths.danlu.yaml
```

---

## 8️⃣ 页面集成（现已移除）

### 文件：`src/pages/Page1/ConceptToRoughModel.tsx`（历史记录）

**之前的集成**（已在 aec4e29 提交中回滚）：
- Qwen 状态管理：`qwenViews` / `qwenRunning`
- Qwen 回调：`runQwenViews()`
- UI 调试面板（显示 8 个视角输出缩略图）

**当前状态**：已移除 Qwen UI，保留后端 `runQwenMultiView()` 函数以备后用。

---

## 9️⃣ 环境变量总览

### QwenEditService 环境变量（服务端）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `QWEN_EDIT_MODEL_PATH` | `/project/qwen_edit/models/Qwen-Image-Edit-2511` | 模型目录 |
| `QWEN_EDIT_HOST` | `127.0.0.1` | 绑定地址 |
| `QWEN_EDIT_PORT` | `8765` | 绑定端口 |
| `QWEN_EDIT_GPU_MEM_GIB` | `22` | 单 GPU 最大内存（GB） |
| `QWEN_EDIT_EAGER_LOAD` | `0` | 启动时立即加载模型（1） vs 延迟加载（0） |
| `QWEN_EDIT_DEFAULT_STEPS` | `40` | 推理步数默认值 |
| `QWEN_EDIT_LORA_PATHS` | `""` | LoRA 文件路径（逗号分隔） |
| `QWEN_EDIT_OFFLOAD_DIR` | `/tmp/qwen_edit_offload` | CPU 卸载目录 |

### 前端环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `VITE_QWEN_URL` | `http://127.0.0.1:8765` | Qwen 服务 URL |
| `VITE_COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI URL（备用） |
| `VITE_TRELLIS2_URL` | `http://127.0.0.1:8766` | Trellis.2 URL（备用） |

---

## 🔟 执行流程示例

### 场景：生成 8 视角多视图

**前端调用链**：
```typescript
1. 用户选择概念图上传
   ↓
2. 触发 onConceptChange() → saveAsset("concept")
   ↓
3. 用户点击 "Qwen 多角度重绘" 按钮
   ↓
4. runQwenViews()
   ├─ getHealth() — 检查服务是否就绪
   ├─ warmup() — 如需加载模型
   ├─ runQwenMultiView(conceptBlob, { onStatus, onEach })
   │  └─ 循环 8 个视角
   │     ├─ editImage(scaledBlob, { prompt, seed, steps=4, cfg=1 })
   │     │  ├─ scaleToMegapixels() — 预处理到 1MP
   │     │  ├─ fileToBase64() — 编码图像
   │     │  ├─ POST /qwen/edit_b64
   │     │  └─ onEach(QwenViewResult)
   │     └─ accumulate results[]
   ├─ onStatus('Qwen 多角度重绘完成')
   └─ return QwenViewResult[]
```

**服务端处理**（`/edit_b64`）：
```python
1. Receive EditRequest { image_b64, prompt, seed, steps=4, cfg=1, ... }
   ↓
2. Decode image_b64 → numpy array
   ↓
3. QwenModelLoader.infer()
   ├─ Processor: image + prompt → embeddings
   ├─ TextEncodeQwenImageEditPlus: encode prompt
   ├─ ImageScaleToTotalPixels(megapixels=1)
   ├─ VAEEncode: latents
   ├─ KSampler: denoise with seed
   ├─ VAEDecode: pixels
   └─ Cleanup: unload LoRA if needed
   ↓
4. Encode output PNG → base64
   ↓
5. Return EditResponse { image_b64, seed, elapsed_sec, ... }
```

---

## 📋 快速参考

### API 调用示例

#### 健康检查
```bash
curl -X POST http://127.0.0.1:8765/health
```

#### 模型预热
```bash
curl -X POST http://127.0.0.1:8765/warmup
```

#### 单个图像编辑
```bash
curl -X POST http://127.0.0.1:8765/edit_b64 \
  -H "Content-Type: application/json" \
  -d '{
    "image_b64": "<base64 PNG>",
    "prompt": "Rotate the camera 45 degrees to the right.",
    "negative_prompt": "",
    "num_inference_steps": 4,
    "true_cfg_scale": 1,
    "seed": 405868421823137
  }'
```

### TypeScript 使用示例

```typescript
import { editImage, getHealth, warmup } from './services/qwenEdit';
import { runQwenMultiView } from './services/workflows';

// 检查服务
const health = await getHealth();
console.log('Qwen 服务就绪:', health.modelLoaded);

// 预热模型
await warmup();

// 调用多视角生成
const views = await runQwenMultiView(conceptImageBlob, {
  onStatus: (msg) => console.log(msg),
  onEach: (view) => console.log(`生成 ${view.label}：${view.imageUrl}`),
});

// 遍历结果
views.forEach((v) => {
  console.log(`${v.key}: ${v.label}`);
  // 绑定到 UI：<img src={v.imageUrl} />
});
```

---

## 🎯 关键设计决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 服务端位置 | 独立工程 QwenEditService | 模型巨大（~50GB），不适宜内嵌；管理独立 |
| 推理框架 | diffusers (bf16) vs ComfyUI | diffusers 便于 API 集成；ComfyUI 用于一次性工作流定义 |
| 图像传输 | base64 JSON | SSH 隧道无法用 multipart；JSON 体积大但稳定 |
| 前端集成 | Vite 代理 `/qwen` | 浏览器同源策略；代理简化错误处理 |
| 参数对齐 | 前端 `QWEN_VIEWS` ↔ 后端工作流 | 确保 prompt/seed 一致；便于 ComfyUI 迁移 |
| LoRA 管理 | 环境变量 + `/health` 上报 | 启动时灵活加载；便于多个 LoRA 并行测试 |

---

## 📁 文件结构速查

```
ConceptToHighresModel/
├── src/
│   ├── services/
│   │   ├── qwenEdit.ts              ← HTTP 客户端（核心接口）
│   │   └── workflows.ts              ← 高级工作流（runQwenMultiView）
│   └── pages/Page1/
│       └── ConceptToRoughModel.tsx   ← 页面（已移除 UI，保留调用）
├── ComfyuiWorkflow/
│   ├── Qwen_MultiView.json           ← 8 视角工作流定义
│   ├── extra_model_paths.danlu.yaml  ← ComfyUI 模型路径（准备用）
│   └── apply_extra_model_paths_danlu.sh
├── vite.config.ts                    ← `/qwen` 代理配置
├── .env.qwen.example                 ← 环境变量示例
└── scripts/
    └── qwen-edit-service.md          ← 服务文档

QwenEditService/                       ← 独立工程
├── server/
│   ├── qwen_edit_server.py           ← FastAPI 主服务
│   └── loader.py                      ← 双 GPU 推理引擎
├── clients/
│   ├── typescript/qwenEdit.ts        ← （此处是副本）
│   └── python/qwen_edit_client.py
└── deploy/
    ├── setup_env.sh
    ├── download_model.sh
    ├── download_lora.sh
    ├── download_fp8_comfyui.sh
    └── ssh_tunnel.ps1
```

---

## 🔗 相关链接

- **QwenEditService 工程**：`D:\AI\Services\QwenEditService`
- **模型资源**：
  - Qwen/Qwen-Image-Edit-2511 → HuggingFace  
  - Qwen-Edit-2509-Multiple-angles.safetensors → dx8152/  
  - Qwen-Image-Edit-Lightning LoRA → lightx2v/
- **ComfyUI 自定义节点**：ComfyUI-Qwen（集成 TextEncodeQwenImageEditPlus 等）

---

**更新时间**：2026-04-28  
**编制者**：GitHub Copilot  
**状态**：✅ 完成，前端 UI 已移除，后端函数保留备用
