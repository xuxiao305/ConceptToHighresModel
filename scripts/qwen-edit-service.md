# Qwen-Image-Edit 服务（已迁出）

本工程不再内置 Qwen-Image-Edit 的服务端代码。出图能力由独立工程
**QwenEditService** 提供，本工程仅保留前端 HTTP 客户端
([src/services/qwenEdit.ts](../src/services/qwenEdit.ts))。

## 仓库

- GitHub: <https://github.com/xuxiao305/qwen-edit-service>
- 本地路径: `D:\AI\Services\QwenEditService`

## 关键事实

- 模型: `Qwen/Qwen-Image-Edit-2511` (bf16, 完整非量化)
- 部署: 丹炉 2× NVIDIA A30 24GB, 双卡分片
- 监听: `127.0.0.1:8765` (FastAPI)
- 单图 768px / 20 steps ≈ 3-4 分钟

## 启动 / 停止 (在 QwenEditService 工程目录操作)

```powershell
# 1) 起 SSH 端口转发，保持窗口
pwsh D:\AI\Services\QwenEditService\deploy\ssh_tunnel.ps1

# 2) 服务端拉起 (远程)
ssh -i C:\tmp\DanLu_key -p 44304 root@apps-sl.danlu.netease.com `
  "bash /project/qwen_edit_service/deploy/_remote_restart.sh"

# 3) 本地冒烟测试
cd D:\AI\Services\QwenEditService
python tests\smoke_test.py --warmup
```

## 本工程的接入

- Vite 开发代理: [vite.config.ts](../vite.config.ts) 中的 `/qwen` → `http://127.0.0.1:8765`
- 前端调用: [src/services/qwenEdit.ts](../src/services/qwenEdit.ts) 暴露 `runQwenEdit()`

## 历史

迁移前（2026-04-26 之前）服务端代码位于 `scripts/danlu/qwen_edit_*.py` 等，
采用单卡 + `enable_sequential_cpu_offload()` 方案，单图约 12 分钟。
迁移后改为双卡 bf16 分片（loader v3.4 文档见新工程的 `server/loader.py`），
质量与原型一致，速度提升 ~3.5×。
