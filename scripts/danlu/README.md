# Qwen-Image-Edit on DanLu — Quick Start

部署目标：在丹炉 A30 24GB 上用 diffusers 加载 `Qwen/Qwen-Image-Edit-2511`，通过
FastAPI 暴露 HTTP 接口；本地通过 SSH 端口转发调用。

## 服务器端

| 路径 | 说明 |
|---|---|
| `/project/qwen_edit/models/Qwen-Image-Edit-2511/` | 模型权重（~50GB）|
| `/project/qwen_edit/qwen_edit_server.py` | FastAPI 服务 |
| `/project/qwen_edit/run_server.sh` | 启动脚本 |
| `/project/qwen_edit/logs/` | 下载/服务日志 |
| conda env `qwen_edit` | python 3.11 + torch 2.4+cu121 + diffusers + fastapi |

### 启动服务

```bash
ssh -i C:\tmp\DanLu_key -p 44304 root@apps-sl.danlu.netease.com
bash /project/qwen_edit/run_server.sh --bg     # 后台
# 或前台调试：
# bash /project/qwen_edit/run_server.sh
tail -f /project/qwen_edit/logs/server.out
```

服务监听 `127.0.0.1:8765`。冷启动（首次模型加载）需 3-5 分钟。

## 本地调用

### 1. 起 SSH 端口转发（保持窗口开着）

```powershell
ssh -i C:\tmp\DanLu_key -p 44304 -L 8765:127.0.0.1:8765 root@apps-sl.danlu.netease.com
```

### 2. CLI 测试（Python）

```powershell
pip install requests pillow
python scripts\danlu\qwen_edit_client.py `
  --image input.png `
  --prompt "Convert to a cyberpunk neon style" `
  --steps 40 --cfg 4.0 --warmup `
  --out output.png
```

第一次加 `--warmup` 触发模型加载（耗时 3-5 分钟）。之后每次推理大约
60-180 秒（A30 + CPU offload）。

### 3. 浏览器/前端调用

代码：[src/services/qwenEdit.ts](../../src/services/qwenEdit.ts)

```ts
import { editImage, warmup, getHealth } from './services/qwenEdit';

const health = await getHealth();         // GET /qwen/health
if (!health.modelLoaded) await warmup();   // POST /qwen/warmup

const result = await editImage(file, {
  prompt: 'Convert to a cyberpunk neon style',
  steps: 40,
  cfg: 4.0,
});
imgEl.src = result.imageUrl;
console.log(result.meta);                  // { seed, steps, elapsedSec, ... }
```

Vite 代理见 [vite.config.ts](../../vite.config.ts) `'/qwen'` 分支。

## 常用排错

| 现象 | 处理 |
|---|---|
| `connect ECONNREFUSED 127.0.0.1:8765` | SSH 端口转发没开，或丹炉端服务没起 |
| `OOM` (HTTP 507) | 降 steps，或调小 width/height（默认会保留输入尺寸）|
| 卡在 warmup | 模型首次加载需要 3-5 分钟，看 `logs/server.out` 里的进度 |
| `Import "diffusers" could not be resolved` | 这是本地 lint，不影响——该脚本只在服务器跑 |

## 重新部署 / 升级

```bash
# 同步脚本
scp -i C:\tmp\DanLu_key -P 44304 \
  scripts\danlu\qwen_edit_server.py scripts\danlu\run_server.sh \
  root@apps-sl.danlu.netease.com:/project/qwen_edit/
```
