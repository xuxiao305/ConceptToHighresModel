# TRELLIS.2 后续开发计划

> 创建于 2026-04-28，对应当前服务部署：丹炉 A30，端口 8766，进程常驻显存约 21GB。
> 本文档记录三个明确的下一步：**前端接入**、**显存空闲卸载**、**参数调优**。

---

## 现状速览

| 项目 | 状态 |
|------|------|
| 服务地址 | `http://apps-sl.danlu.netease.com:44304/` SSH 转发到内网 `127.0.0.1:8766`（仅 ssh 隧道访问，未对外） |
| 模型 | `/project/trellis2/models/TRELLIS.2-4B`（16GB），DINOv3 + RMBG-2.0 本地常驻 |
| 接口 | `GET /health`、`POST /warmup`、`POST /generate`（multipart）、`POST /generate_b64`（JSON） |
| 性能 | 冷启动 328s（warmup 157 + gen 143 + bake 28），热推理 60s（gen 29 + bake 29）|
| 输出 | 带 PBR 贴图的 GLB，默认 200k 面、2048 纹理 |

服务端兼容补丁见 [trellis2_server.py](../scripts/danlu/trellis2/trellis2_server.py) 顶部三段 shim。

---

## 任务一：前端接入 `trellis2.ts` 服务

### 目标
在 [src/services/](../src/services) 下新增 `trellis2.ts`，把 TRELLIS.2 作为 Tripo 之外的第二条「图生 3D」管线，让 [Page1/ConceptToRoughModel.tsx](../src/pages/Page1/ConceptToRoughModel.tsx) 或 [Page2/HighresModel.tsx](../src/pages/Page2/HighresModel.tsx) 可以二选一调用。

### 接入难点
TRELLIS.2 服务跑在丹炉内网，浏览器**不能直连** `127.0.0.1:8766`。三种方案：

1. **SSH 端口转发（开发期最快）**
   - 本地起 `ssh -L 8766:127.0.0.1:8766 root@apps-sl.danlu.netease.com -p 44304`
   - Vite 代理：在 [vite.config.ts](../vite.config.ts) 加 `/trellis2` → `http://127.0.0.1:8766`
   - 优点：零额外开发；缺点：每次开发要手动起隧道

2. **走雷火 AI 网关**（推荐，对齐 Tripo 模式）
   - 参考 [tripo.ts](../src/services/tripo.ts) 的 `BASE = '/tripo'` + `VITE_TRIPO_TOKEN` 模式
   - 需要先和雷火网关团队申请「自托管 HTTP 上游」配置
   - 优点：无需手动隧道，鉴权统一
   - 缺点：流程长

3. **在丹炉跑一个 Caddy/Nginx 反向代理 + 简单 Token**（折中）
   - 暴露在丹炉 ingress 上，加 `Authorization: Bearer <token>`
   - 前端 `VITE_TRELLIS2_BASE` + `VITE_TRELLIS2_TOKEN`

**推荐先做方案 1 跑通，再迁移到方案 2。**

### `trellis2.ts` 接口设计草案

```ts
export interface Trellis2GenerateParams {
  /** 1-50，控制稀疏结构采样步数；默认 12，质量优先用 20 */
  sparse_structure_steps?: number;
  /** 1-50，SLat 采样步数；默认 12 */
  slat_steps?: number;
  /** 0-20，CFG 强度；默认 3.0 */
  cfg_strength?: number;
  /** 目标面数；默认 200_000 */
  decimation_target?: number;
  /** 纹理分辨率；512/1024/2048/4096，默认 2048 */
  texture_size?: 512 | 1024 | 2048 | 4096;
  /** 是否重拓扑；默认 true */
  remesh?: boolean;
  /** 随机种子；不传则后端随机 */
  seed?: number;
}

export interface Trellis2Result {
  /** GLB 文件 ArrayBuffer */
  glb: ArrayBuffer;
  seed: number;
  elapsed_gen_sec: number;
  elapsed_bake_sec: number;
  elapsed_total_sec: number;
  glb_bytes: number;
}

export class Trellis2Service {
  /** 健康检查 */
  health(): Promise<{ status: string; model_loaded: boolean }>;

  /** 强制预热（首次调用前可主动调，避免业务请求阻塞 ~150s） */
  warmup(timeoutMs?: number): Promise<void>;

  /** 生成 GLB；推荐用 multipart，避免 base64 膨胀 33% */
  generate(image: Blob, params?: Trellis2GenerateParams): Promise<Trellis2Result>;
}
```

### 对接点
- [Page1/ConceptToRoughModel.tsx](../src/pages/Page1/ConceptToRoughModel.tsx)：在「概念图 → 粗模」节点旁加「引擎」开关（Tripo / TRELLIS.2）
- 结果落到 [Projects/<name>/page1_concept_to_rough/02_rough/](../Projects)，命名 `trellis2_<timestamp>.glb` 或 `tripo_<timestamp>.glb`
- 复用 [projectStore.ts](../src/services/projectStore.ts) 写入 index.json

### 验收标准
- [ ] 前端可触发生成，进度条显示「连接 / 生成中（预计 60-180s）」
- [ ] 失败回包能展示后端 `detail` 错误信息
- [ ] 生成成功后自动落盘到项目目录并刷新画面
- [ ] 支持取消（`AbortController`）

---

## 任务二：显存空闲卸载

### 痛点
当前 server 进程一旦 warmup 就一直占用 21GB 显存（GPU 0），即使没人调。
丹炉两张 A30 共用，长期占用会挤压 Tripo / qwen-edit。

### 设计
在 [trellis2_server.py](../scripts/danlu/trellis2/trellis2_server.py) 加：

1. **空闲计时器**：每次 `/generate` 完成时记录 `_last_used_ts = time.time()`
2. **后台任务**：FastAPI `lifespan` 启动 `asyncio` 协程，每 60s 检查 `now - _last_used_ts > IDLE_TIMEOUT_SEC`（建议 600s 即 10 分钟）
3. **卸载逻辑**：
   ```python
   def unload_pipeline():
       global _pipe
       if _pipe is None:
           return
       _pipe.cpu()      # 把所有子模块挪回 CPU
       del _pipe
       _pipe = None
       gc.collect()
       torch.cuda.empty_cache()
       torch.cuda.ipc_collect()
       LOG.info("pipeline unloaded due to idle")
   ```
4. **下次请求自动重新 load**：`/generate` 已经走 `load_pipeline()`，无需改动调用侧

### 配置
- 环境变量 `TRELLIS2_IDLE_TIMEOUT_SEC`（默认 600，0 = 永不卸载，保留旧行为）
- 在 [run_server.sh](../scripts/danlu/trellis2/run_server.sh) 默认设 `export TRELLIS2_IDLE_TIMEOUT_SEC=600`

### 注意事项
- `pipe.cpu()` 对 TRELLIS.2 是否完整释放显存需验证（部分 Trellis 子模块可能没实现 `.to('cpu')`），不行就 `del _pipe` + `cuda.empty_cache()` 兜底
- 卸载后再 load 仍需 ~150s，要在 `/health` 返回当前是否 loaded，前端可提前调 `/warmup`

### 验收
- 10 分钟无请求后 `nvidia-smi` 显示 GPU 0 释放至 < 2GB
- 再次调 `/generate` 能正常返回（自动重新 load）

---

## 任务三：参数调优实验

### 目的
当前默认 `steps=12, cfg=3.0` 是「速度优先」档；需要对比高质量档的视觉差异和耗时，决定前端要不要暴露「质量预设」。

### 实验矩阵

| 预设 | sparse_steps | slat_steps | cfg | decimation | texture | 预期热推理耗时 |
|------|-------------|-----------|-----|-----------|---------|------|
| Draft | 6 | 6 | 2.0 | 100k | 1024 | ~20s |
| Default（当前）| 12 | 12 | 3.0 | 200k | 2048 | ~60s |
| HighQ | 20 | 20 | 5.0 | 400k | 2048 | ~120s |
| Ultra | 30 | 30 | 7.5 | 800k | 4096 | ~250s |

### 测试集
- [Projects/GirlOrangeJacket/page1_concept_to_rough/01_concept/20260427_172536_907.png](../Projects/GirlOrangeJacket/page1_concept_to_rough/01_concept)（人物，已验证）
- 找 1 张硬表面（机械/道具）
- 找 1 张毛绒/有机生物

### 评估维度
- 几何细节（手指、五官、布料褶皱）
- 贴图清晰度
- 重拓扑后的多边形分布
- 总耗时

### 输出物
- 一组对比 GLB 放在 `Projects/_benchmarks/trellis2/<preset>/<image>.glb`
- 在 [Document/](.) 加 `trellis2_quality_benchmark.md` 记录截图 + 主观评分

---

## 优先级与节奏建议

1. **先做任务一方案 1**（SSH 隧道 + Vite 代理 + `trellis2.ts` MVP），让流程闭环可用 → 1 天
2. **任务三 Default vs HighQ 对比**，决定要不要给用户暴露质量档 → 半天
3. **任务二空闲卸载**，缓解显存占用 → 半天
4. **任务一方案 2**（雷火网关接入）按团队节奏推进

---

## 相关文件索引
- 服务端：[scripts/danlu/trellis2/trellis2_server.py](../scripts/danlu/trellis2/trellis2_server.py)
- 启动脚本：[scripts/danlu/trellis2/run_server.sh](../scripts/danlu/trellis2/run_server.sh)
- 重启工具：[scripts/danlu/trellis2/_restart.sh](../scripts/danlu/trellis2/_restart.sh)
- 测试脚本：[scripts/danlu/trellis2/_remote_generate.sh](../scripts/danlu/trellis2/_remote_generate.sh)、[_gen_only.sh](../scripts/danlu/trellis2/_gen_only.sh)
- pipeline 路径补丁：[scripts/danlu/trellis2/_patch_pipeline.sh](../scripts/danlu/trellis2/_patch_pipeline.sh)
- 已有同类前端服务参考：[src/services/tripo.ts](../src/services/tripo.ts)、[src/services/qwenEdit.ts](../src/services/qwenEdit.ts)
