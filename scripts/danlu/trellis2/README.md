# TRELLIS.2-4B on DanLu — Quick Start

部署目标：在丹炉 A30 24GB 上加载 `microsoft/TRELLIS.2-4B`，通过 FastAPI 暴露
**image → GLB** 接口，作为 Tripo 之外的第二个建模后端。

## 一、首次部署（按顺序执行）

### 1. 同步脚本到丹炉

在 WSL2 里：

```bash
cp /mnt/d/AI/PrivateKeys/DanLu/xuxiao02_rsa /tmp/DanLu_key
chmod 600 /tmp/DanLu_key

ssh -i /tmp/DanLu_key -p 44304 -o StrictHostKeyChecking=no \
  root@apps-sl.danlu.netease.com "mkdir -p /project/trellis2"

scp -i /tmp/DanLu_key -P 44304 \
  scripts/danlu/trellis2/setup_env.sh \
  scripts/danlu/trellis2/download_trellis2.sh \
  scripts/danlu/trellis2/trellis2_server.py \
  scripts/danlu/trellis2/run_server.sh \
  root@apps-sl.danlu.netease.com:/project/trellis2/
```

### 2. 后台下载模型权重（约 16 GB）

```bash
ssh -i /tmp/DanLu_key -p 44304 root@apps-sl.danlu.netease.com \
  "nohup bash /project/trellis2/download_trellis2.sh \
   > /project/trellis2/logs/download.out 2>&1 < /dev/null & disown; \
   sleep 2; tail -n 5 /project/trellis2/logs/download.log"
```

进度查询：

```bash
ssh -i /tmp/DanLu_key -p 44304 root@apps-sl.danlu.netease.com \
  "tail -f /project/trellis2/logs/download.log"
```

### 3. 后台安装 conda 环境（编译 CUDA 扩展，约 30-50 分钟）

```bash
ssh -i /tmp/DanLu_key -p 44304 root@apps-sl.danlu.netease.com \
  "nohup bash /project/trellis2/setup_env.sh \
   > /project/trellis2/logs/setup.out 2>&1 < /dev/null & disown"
```

`setup_env.sh` 会：
1. 创建 conda 环境 `trellis2`（Python 3.11）
2. 通过上海交大镜像装 torch 2.6.0+cu124、torchvision 0.21.0+cu124
3. 通过 ghproxy 镜像 `git clone --recursive https://github.com/microsoft/TRELLIS.2`
4. 调用 TRELLIS.2 官方 `setup.sh` 编译并安装：
   - `--basic`（依赖）
   - `--flash-attn`、`--nvdiffrast`、`--nvdiffrec`
   - `--cumesh`、`--o-voxel`、`--flexgemm`（CUDA 扩展）
5. 装 FastAPI 服务依赖

进度查询：`tail -f /project/trellis2/logs/setup.log`

### 4. 启动服务

```bash
ssh -i /tmp/DanLu_key -p 44304 root@apps-sl.danlu.netease.com
bash /project/trellis2/run_server.sh --bg     # 后台
# 或前台调试： bash /project/trellis2/run_server.sh
tail -f /project/trellis2/logs/server.out
```

服务监听 `127.0.0.1:8766`。冷启动（首次模型加载）需 1-3 分钟。

---

## 二、本地调用

### 1. 起 SSH 端口转发（保持窗口开着）

```powershell
ssh -i C:\tmp\DanLu_key -p 44304 -L 8766:127.0.0.1:8766 root@apps-sl.danlu.netease.com
```

### 2. CLI 测试

```powershell
pip install requests
python scripts\danlu\trellis2\trellis2_client.py `
  --image input.png `
  --out output.glb `
  --warmup
```

第一次加 `--warmup` 触发模型加载。之后每次推理大约 30-90 秒（A30，512³，
默认 12 步）。

### 3. 前端调用

代码：[../../src/services/trellis2.ts](../../../src/services/trellis2.ts)

```ts
import { generateModel, warmup, getHealth } from './services/trellis2';

const health = await getHealth();
if (!health.modelLoaded) await warmup();

const result = await generateModel(file, {
  sparseStructureSteps: 12,
  slatSteps: 12,
  cfg: 3.0,
  decimationTarget: 200_000,
  textureSize: 2048,
});
viewer.load(result.glbUrl);
console.log(result.meta);
// → { seed, elapsedGenSec, elapsedBakeSec, glbBytes, ... }
```

Vite 代理见 `vite.config.ts` `'/trellis'` 分支。

---

## 三、服务器端目录约定

| 路径 | 说明 |
|---|---|
| `/project/trellis2/models/TRELLIS.2-4B/` | 模型权重（~16GB） |
| `/project/trellis2/TRELLIS.2/` | 上游代码（git submodule + 编译产物） |
| `/project/trellis2/trellis2_server.py` | FastAPI 服务 |
| `/project/trellis2/run_server.sh` | 启动脚本 |
| `/project/trellis2/logs/` | 下载/安装/服务日志 |
| conda env `trellis2` | python 3.11 + torch 2.6+cu124 + trellis2 + fastapi |

---

## 四、HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 健康检查，返回模型/显存状态 |
| POST | `/warmup` | 强制加载模型（阻塞至完成） |
| POST | `/generate_b64` | JSON in，JSON out（含 `glb_b64`） |
| POST | `/generate` | multipart：`image` + `payload`，返回 `model/gltf-binary` |

`generate_b64` 请求体：

```json
{
  "image_b64": "...",
  "sparse_structure_steps": 12,
  "slat_steps": 12,
  "cfg_strength": 3.0,
  "seed": 42,
  "decimation_target": 200000,
  "texture_size": 2048,
  "remesh": true,
  "simplify_cap": 8000000
}
```

---

## 五、常用排错

| 现象 | 处理 |
|---|---|
| `connect ECONNREFUSED 127.0.0.1:8766` | SSH 端口转发没开，或丹炉端服务没起 |
| `OOM` (HTTP 507) | 降低 `slat_steps` / `decimation_target` / `texture_size` |
| `flash_attn` 编译失败 | 检查 `CUDA_HOME` 是否指向 12.4；可在 `setup_env.sh` 中改用 `xformers` 后端，并在 `run_server.sh` 加 `export ATTN_BACKEND=xformers` |
| `o_voxel` import 失败 | 检查 `setup.sh` 是否带 `--o-voxel`；`pip show o-voxel` 应有版本 |
| 卡在 warmup | 模型首次加载 1-3 分钟，看 `logs/server.out` |
| `Import "trellis2" could not be resolved` | 本地 lint 提示，不影响——脚本只在服务器跑 |

---

## 六、与 Tripo 的关系

| 维度 | Tripo | TRELLIS.2 |
|---|---|---|
| 部署 | 雷火云端 SaaS | 自部署在丹炉 |
| 输入 | image | image |
| 输出 | GLB（PBR 可选） | GLB（自带 PBR） |
| 速度 | 30-90s | 30-90s（A30） |
| 质量 | 通用更稳 | 拓扑更干净，材质更细 |
| 配额 | 受配额限制 | 仅受 GPU 占用限制 |

服务层互为备选：未来在 Rough Model 节点加一个 backend 选择器，复用相同的
`{ image → glbUrl }` 抽象。
