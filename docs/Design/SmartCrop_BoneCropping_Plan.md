# SmartCrop 骨骼裁剪 — 开发计划

> **日期**：2026-05-05
> **状态**：草案
> **目标**：Page3 姿势代理对齐使用**仅夹克骨骼**作为源网格（而非全身骨骼），方法是在运行时将 Page2 的 SmartCrop/Split 变换参数应用到 Page1 的全局关节点上。

---

## 1. 概述

### 问题

Page3 对齐目前将**相同的 Page1 全身关节点**同时喂给 `buildSkeletonProxy(src)` 和 `buildSkeletonProxy(tar)`。当源网格是仅夹克模型（无腿部）时，hip_center 的 2D→3D 投影会落在夹克下摆处，将所有躯干/颈部锚点压缩成一个紧密的簇。

### 解决方案

使用 Page2 夹克提取中已持久化的 `SmartCropTransformMeta` + `SplitTransformMeta`，**将 Page1 的全局关节点裁剪为仅夹克的逐视图关节点**，然后在 Page3 中将这些作为 `srcJoints` 输入。目标网格仍使用全身关节点。**零额外图片存储**——仅使用已有的裁剪/分割元数据。

---

## 2. 数据流

### 2.1 当前（有问题的）流程

```
Page1 DWPose
  │
  ▼
GlobalJointsMeta（四合一坐标，逐视图象限）
  │
  ▼ globalJointsToPage1Views(splits)
Page1JointsMeta.views.front  ← 全身关节点，分割局部坐标
  │
  ├──→ Page3 collectJoints.srcJointsRaw  ← 同样全身（对夹克是错的）
  └──→ Page3 collectJoints.tarJointsRaw  ← 全身（正确）
```

### 2.2 目标（正确的）流程

```
Page1 DWPose
  │
  ▼
GlobalJointsMeta（四合一坐标，逐视图象限）
  │
  ├──────────────────────────────────────┐
  │                                      │
  ▼ globalJointsToPage1Views()           ▼ transformJointsBySmartCrop()
Page1JointsMeta.views.front              PipelineJointsMeta.views.front
  （全身，分割局部）                       （仅夹克，分割局部）
  │                                      │
  ▼                                      ▼
Page3 collectJoints.tarJointsRaw         Page3 collectJoints.srcJointsRaw
  （全身 → 正确）                          （仅夹克 → 现在正确了）
```

### 2.3 变换链详解

```
GlobalJointsMeta.keypoints（四合一图像空间）
  │
  │  对每个 SmartCrop 对象 i（对应一个视图）：
  │    1. 过滤：保留 (x,y) 落在 object.paddedBbox 内的关节点
  │    2. 映射：x' = (x - object.pasteX) / object.scale
  │              y' = (y - object.pasteY) / object.scale
  │       → 关节点现在处于"处理后 2x2"图像空间
  │
  ▼
  │  对每个 SplitTransformMeta.views[viewName]：
  │    3. 过滤：保留 (x',y') 落在 view.paddedBbox 内的关节点
  │    4. 偏移：x" = x' - view.paddedBbox.x0
  │               y" = y' - view.paddedBbox.y0
  │       → 关节点现在处于逐视图分割局部空间
  │
  ▼
{ front: Joint2D[], left: Joint2D[], back: Joint2D[], right: Joint2D[] }
```

### 2.4 SmartCrop 对象 → 视图映射

SmartCrop 对象按行优先排序（左上→右上→左下→右下）。标准四视图布局为：

| SmartCrop 索引 | 象限      | 视图   |
|---------------|-----------|--------|
| 0             | 左上      | front  |
| 1             | 右上      | left   |
| 2             | 左下      | right  |
| 3             | 右下      | back   |

为增强鲁棒性，我们**从 `SplitTransformMeta.views[].quadrant` 推导映射**，而非假设顺序。将每个 SmartCrop 对象的 `paddedBbox` 中心与分割视图象限比较，以确定其属于哪个视图。

> **注意**：象限布局定义在 `MultiViewLayout`（`joints.ts` 第 47-52 行）。Page1 使用：front=左上，left=右上，back=右下，right=左下。SmartCrop 在相同的四合一输入上操作，因此对象顺序按位置对应。

---

## 3. 函数规格

### 3.1 `transformJointsBySmartCrop()` — 新增

**文件**：`src/services/dwpose.ts`（与现有 `globalJointsToPage1Views` 并列）

```
输入：
  globalJoints  : GlobalJointsMeta        — Page1 DWPose 原始输出
  smartCropMeta : SmartCropTransformMeta  — 来自 Page2 提取
  splitMeta     : SplitTransformMeta      — 来自 Page2 提取

输出：
  Record<ViewName, Joint2D[]>  — 逐视图仅夹克关节点，分割局部坐标

行为：
  1. 使用象限重叠将 SmartCrop 对象映射到视图名称
  2. 对每个对象/视图：
     a. 将 globalJoints.views[viewName] 过滤到 object.paddedBbox 内的关节点
     b. 应用 paste+scale 变换 → 处理后 2x2 坐标
  3. 对每个分割视图：
     a. 将处理后关节点过滤到 view.paddedBbox 内的关节点
     b. 偏移 -paddedBbox.x0, -paddedBbox.y0 → 分割局部坐标
  4. 返回逐视图数组（若该视图无关节点则为空数组）
```

### 3.2 `loadPipelineSmartCropJoints()` — 新增

**文件**：`src/pages/Page3/ModelAssemble.tsx`（或 `src/services/` 下的辅助文件）

```
输入：
  project       : ProjectHandle
  srcModelFile  : string  — 源网格的 GLB 文件名

输出：
  PipelineJointsMeta | null  — 或拆分为 { smartCropMeta, splitMeta }

行为：
  1. loadPipelines() → 查找 modelFile === srcModelFile 的 pipeline
  2. 若找到且有 smartCropMeta 和 splitMeta：
     a. 读取 project.meta.page1.joints.global
     b. 调用 transformJointsBySmartCrop(global, smartCropMeta, splitMeta)
     c. 将结果作为 PipelineJointsMeta.views 返回
  3. 若未找到，返回 null → 回退到全身关节点
```

### 3.3 Page3 消费端变更

**文件**：`src/pages/Page3/ModelAssemble.tsx`

```
变更：
  1. refreshAssets()：加载 srcMesh 后，同时解析 pipeline 关节点
     → 存储为状态：pipelineJoints | null

  2. AlignStrategyContext：添加 hasPipelineJoints 布尔值

  3. handleRunPoseProxyStepwise() + handleRerunPoseProxyStep()：
     srcJointsRaw = pipelineJoints?.views.front?.joints ?? front.joints
     （若 pipeline 关节点不可用则回退到全身）

  4. collectJoints() 调用：srcJointsRaw 使用 pipeline 关节点（仅夹克）；
     tarJointsRaw 保持为 front.joints（全身）
```

---

## 4. 现有基础设施（无需变更）

以下组件**已就位**，**零修改**：

| 组件 | 状态 | 详情 |
|------|------|------|
| `SmartCropTransformMeta` 类型 | ✅ | `joints.ts:88-122` |
| `SplitTransformMeta` 类型 | ✅ | `joints.ts:144-156` |
| `PipelineJointsMeta` 类型 | ✅ | `joints.ts:160-183` — 字段匹配需求 |
| `PersistedPipeline.smartCropMeta` | ✅ | 已通过 `toPersisted()` 持久化 |
| `PersistedPipeline.splitMeta` | ✅ | 已通过 `toPersisted()` 持久化 |
| `PersistedPipeline.jointsMeta` | ✅ | 已持久化/恢复（字段未使用） |
| `smartCropAndEnlargeAutoWithMeta()` | ✅ | 已返回 `SmartCropTransformMeta` |
| `splitMultiViewWithMeta()` | ✅ | 已返回 `SplitTransformMeta` |
| `loadPipelines()` / `savePipelines()` | ✅ | projectStore.ts:822-855 |
| `globalJointsToPage1Views()` | ✅ | dwpose.ts:256 — 参考实现 |

---

## 5. 开发步骤

### 步骤 1：实现 `transformJointsBySmartCrop()`

**文件**：`src/services/dwpose.ts`
**预估**：约 70 行

- 在 `globalJointsToPage1Views()` 后添加函数（约第 290 行）
- 复用相同的 `filter + offset` 模式
- 处理边界情况：对象内无关节点、无对象、空 bbox
- 从模块导出

### 步骤 2：添加 Page3 pipeline 关节点查找

**文件**：`src/pages/Page3/ModelAssemble.tsx`
**预估**：约 50 行

- 在 `refreshAssets()` 中，识别 src mesh 后，调用 `loadPipelines()` + 查找匹配的 pipeline
- 从 pipeline 中提取 `smartCropMeta` + `splitMeta`（或计算 `PipelineJointsMeta`）
- 将结果存储在新状态中：`[pipelineJoints, setPipelineJoints]`
- 在 `AlignStrategyContext` 中添加就绪指示器

### 步骤 3：将 pipeline 关节点接入姿势代理

**文件**：`src/pages/Page3/ModelAssemble.tsx`
**预估**：约 20 行

- 在 `handleRunPoseProxyStepwise()` 和 `handleRerunPoseProxyStep()` 中：
  - `srcJointsRaw = pipelineJoints?.views.front ?? front.joints`
  - `tarJointsRaw = front.joints`（不变）
- 两个函数已接收 `front.joints`——改动最小

### 步骤 4：端到端测试

**文件**：使用现有项目（GirlOrangeJacket）测试
**预估**：约 30 分钟

- 运行 Page1 → Page2 夹克提取 → Page3 对齐
- 验证 src 骨骼代理锚点正确分布（无 hip_center 在下摆处）
- 验证对齐 RMSE 改善
- 测试回退：pipeline 无 smartCropMeta → 使用全身关节点（无崩溃）

---

## 6. 变更文件汇总

| 文件 | 变更 | 行数 |
|------|------|------|
| `src/services/dwpose.ts` | 添加 `transformJointsBySmartCrop()` | +70 |
| `src/pages/Page3/ModelAssemble.tsx` | Pipeline 关节点查找 + 接入姿势代理 | +70 |
| **合计** | | **约 140** |

无需变更：
- `src/types/joints.ts`（类型已完备）
- `src/services/projectStore.ts`（持久化已完备）
- `src/pages/Page2/PartPipeline.tsx`（元数据已捕获）
- `src/three/skeletonProxy.ts`（消费 Joint2D[]，与来源无关）

---

## 7. 验证清单

- [ ] `transformJointsBySmartCrop()` 返回 4 个视图，关节点数量正确
- [ ] 仅夹克关节点排除 hip/knee/ankle（夹克下摆以下）
- [ ] 仅夹克关节点包含 neck/shoulders/elbows/wrists
- [ ] Front 视图关节点（分割局部坐标）与提取结果上的骨骼叠加匹配
- [ ] 回退：pipeline 无 SmartCropMeta → 全身关节点（现有行为）
- [ ] Page3 `AlignStrategyContext.hasPipelineJoints` 正确亮起
- [ ] 姿势代理使用 pipeline 关节点无错误运行
- [ ] 对齐 RMSE 相比全身关节点基线有所改善
- [ ] 无回归：目标侧仍正确使用全身关节点
- [ ] 项目目录中无额外文件产生

