# Page3 Pose Proxy 服装对齐 — 架构 Review 最终报告

> **日期**: 2026-05-03  
> **审查范围**: Page3 Pose Proxy Jacket Alignment 全链路（设计计划 + Phase 8 handoff + 代码实现）  
> **前置纠正**: OpenPose 是初期选型，当前实现统一使用 **DWPose**。文档中残留的 OpenPose 字样仅属于历史措辞/文档债，不再构成架构选型风险。

---

## 1. 总体判断

当前实现主线是合理的：

```
DWPose → GlobalJointsMeta → PipelineJointsMeta
       → buildSkeletonProxy() → PCA anchors
       → computePoseAlignment() → SVD 初对齐
       → region-limited icpRefine()
```

Page3 消费侧基本已落地，DWPose 服务、joints 类型系统、skeleton proxy、pose alignment、ICP refine 等模块均已就位。

**但不能视为"可合并到 main 的完成态"。建议定位为：**

> **Phase 8 已完成 Page3 原型接入，尚未完成端到端可用闭环。应先补齐 Page1/Page2 joints 生产链路和 source camera 一致性，再进入质量调优。**

---

## 2. 当前代码实现链路

### 2.1 DWPose 服务层

| 模块 | 文件 | 职责 |
|---|---|---|
| 前端服务 | `src/services/dwpose.ts` | `detectPoses()` 调 `/api/dwpose`；`cocoPoseToJoint2D()` 单视图转换 |
| Vite bridge | `vite.config.ts` L64-L91, L201-L206 | spawn `D:\AI\Prototypes\DWPose\pose_worker.py`（YOLOX + RTMPose ONNX，DirectML GPU） |
| Worker | `D:\AI\Prototypes\DWPose\pose_worker.py` | 接收 base64 图像，返回 COCO-18 keypoints（pixel 坐标） |

### 2.2 Joints 数据模型

| 类型 | 文件 | 说明 |
|---|---|---|
| `Joint2D` | `src/types/joints.ts` L16-L26 | 单个 2D keypoint（name, x, y, confidence） |
| `GlobalJointsMeta` | `src/types/joints.ts` L54-L85 | Page1 输出：MultiView 4-in-1 图上的 DWPose 结果（global 2x2 空间） |
| `PipelineJointsMeta` | `src/types/joints.ts` L158-L183 | Page2 输出：经过 SmartCrop + split 转换的 per-view joints（view-local 空间） |
| 坐标转换 | `src/three/jointsTransform.ts` | 4 层空间映射：global 2x2 → processed 2x2 → split view-local → mesh projection |

### 2.3 生产函数（定义存在，调用待接入）

| 函数 | 文件 | 职责 | 当前调用状态 |
|---|---|---|---|
| `detectAndConvertToGlobalJoints()` | `src/services/dwpose.ts` L229 | Page1 入口：调 DWPose + 拆成 4 视图 | 🟡 未找到 Page1 调用点 |
| `generatePipelineJoints()` | `src/services/jointsGeneration.ts` | Page2 入口：GlobalJoints → PipelineJoints | 🟡 未找到 Page2 调用点 |
| `getPipelineJoints()` | `src/services/projectStore.ts` L626 | Page3 读取 jointsMeta | ✅ 被 Page3 消费 |

### 2.4 Page3 Pose Proxy 集成

| 路径 | 位置 | 行为 |
|---|---|---|
| 自动对齐 | `ModelAssemble.tsx` L2664-L2806 | 读取 pipeline joints → DWPose on target ortho render → `buildSkeletonProxy()` ×2 → `computePoseAlignment()` → 转 `LandmarkCandidate[]` |
| 公共 refine | `ModelAssemble.tsx` L2928-L2948 | `alignSourceMeshByLandmarks()` → `icpRefine()` with `tarRestrictVertices: workingTarRegion?.vertices` |
| 手动 Step 1 | `ModelAssemble.tsx` L912-L920 | 降级为 surface RANSAC，提示"仅支持一键自动对齐" |

### 2.5 几何核心

| 模块 | 文件 | 关键逻辑 |
|---|---|---|
| Skeleton Proxy | `src/three/skeletonProxy.ts` L106-L300+ | `jointsToSeeds3D()` (K=3 最近投影点) → `buildCapsule()` → `pcaProxyAnchor()` → `buildSkeletonProxy()` |
| Pose Alignment | `src/three/poseAlignment.ts` L70-L260+ | `pairAnchors()` → `checkLeftRightSwap()` → `weightedSVD()` → `computePoseAlignment()` |

---

## 3. 风险列表（按优先级）

### P0 — 阻塞：必须先处理才能合并

#### P0-1 Page1/Page2 joints 生产链路未闭环

**证据**: `detectAndConvertToGlobalJoints()` 和 `generatePipelineJoints()` 在当前 workspace 搜索结果中仅作为定义存在，未找到 Page1/Page2 业务调用点。Page3 通过 `getPipelineJoints()` 消费，但上游未保证数据一定生成。

**影响**: 用户选择 Gallery source model 后，`jointsMeta` 为空，Pose Proxy 直接报错"源模型缺少关节点数据"。

**修改方案**:
1. Page1 MultiView 生成完成后调用 `detectAndConvertToGlobalJoints()`，持久化 `GlobalJointsMeta`。
2. Page2 每条 pipeline 在 SmartCrop + split 完成后调用 `generatePipelineJoints()`，写入 `PersistedPipeline.jointsMeta`。
3. Page2 UI 显示 joints 状态：未生成 / 运行中 / 已生成 / DWPose 失败 / 坐标转换失败。
4. Page3 Pose Proxy 按钮仅在绑定 pipeline 且有 `jointsMeta.views.front` 时启用。

**验收标准**: 新建项目后完整跑通 Page1 → Page2 → Page3 joints 链路。

---

#### P0-2 Source joints 与 source mesh camera 坐标系不一致

**证据**: Page3 中 source proxy 构建时会重新从 `splitMeta` 拿 `sliceSize` 调用 `renderOrthoFrontViewWithCamera()` 生成新的 `srcCamera`（`ModelAssemble.tsx` L2722-L2744）。source joints 来自 Page2 split-local 坐标，与这个新 camera 未必对应。

**影响**: `buildSkeletonProxy()` 把 2D joints 投到错误的 3D 顶点 → capsule 端点偏移 → PCA anchor 错位 → SVD 初始矩阵错误 → ICP 在错误初值上局部收敛。

**修改方案**:
1. Page2 生成 GLB/多视图时同步保存真实的正交相机参数。
2. `PipelineJointsMeta` 增加 `viewCameras.front` 或 `sourceProjectionMeta`。
3. Page3 构建 source proxy 时使用 Page2 保存的 camera。
4. camera 缺失时直接 abort，不 fallback 到 512×512。

**验收标准**: source joints overlay 到 source mesh front render 上，肩/肘/腕位置肉眼一致。`srcCamera.source === 'pipeline-meta'`。

---

### P1 — 必须：合并前必须修的重大正确性问题

#### P1-1 `2D joint → 最近 K=3 顶点` 污染 capsule 端点种子

**证据**: `jointsToSeeds3D()` 在 `skeletonProxy.ts` L106-L156 中取离 joint 投影最近的 K=3 个顶点的 3D centroid。袖口、口袋、装饰等表面点可能被选中，导致 capsule 方向偏移。

**区别说明**: 这不是严格违反 Plan 第 7.1 节的"禁止用最近表面点做最终 anchor"——最终 anchor 确实来自 PCA。但种子错误会传导给 capsule → PCA，是**事实上的精度风险**。

**修改方案**:
1. K 从 3 提升到 20~32。
2. 对近邻做基于法线/连通性的离群过滤。
3. 第一次用宽半径建 capsule。
4. PCA 得主轴后沿主轴重新收紧 capsule。
5. 第二次 PCA 输出最终 anchor。

**验收标准**: trace 输出每个 joint seed 的候选数、剔除数、最终 seed distance。

---

#### P1-2 Weighted SVD 实际退化为无权 SVD

**证据**: `weightedSVD()` 在 `poseAlignment.ts` L150-L172 中使用 `Math.max(1, Math.round(pair.weight / maxWeight))` 复制 landmark pair。权重 0.1 和 0.95 都只复制 1 次——加权变成了无权。Plan 第 9 节"torso axis 权重大、branches 权重低"的策略无法生效。

**修改方案**: 改为真正的加权 SVD：

$$
c_s = \frac{\sum w_i s_i}{\sum w_i}, \quad
c_t = \frac{\sum w_i t_i}{\sum w_i}
$$

$$
H = \sum w_i (s_i - c_s)(t_i - c_t)^T
$$

scale 用 weighted RMS。不再复制点。

**验收标准**: 单测验证降低 sleeve 权重后，SVD 结果更接近 torso/shoulder。

---

#### P1-3 `LandmarkCandidate` 使用虚拟顶点索引 -1，语义污染

**证据**: Page3 Pose Proxy 将 anchor pairs 转成 `LandmarkCandidate[]` 并写 `srcVertex: -1`、`tarVertex: -1`、`descriptorDist: 0`（`ModelAssemble.tsx` L2774-L2788）。后续公共流程仍把它当 landmark pairs 继续跑。

**影响**: `LandmarkCandidate` 原本表示真实 mesh vertex 对；Pose Proxy anchor 是抽象 PCA 点。后续 debug 面板、trace 反查、数组索引可能因 -1 出错。

**修改方案**（推荐干净方案）:
1. 新增 `PoseAnchorPair` 类型。
2. `PartialMatchResult` 增加 `pairKind: 'mesh-landmark' | 'pose-anchor'`。
3. 下游 SVD/ICP 只消费 `srcPosition` / `tarPosition`。
4. UI 根据 `pairKind` 分别显示。

**验收标准**: 不再出现 `srcVertex=-1` / `tarVertex=-1`。

---

#### P1-4 `frontViewMeta` 缺失时 fallback 到 512×512 会静默放大错误

**证据**: `ModelAssemble.tsx` L2722-L2724 中 `srcViewW = frontViewMeta?.sliceSize.w ?? 512`。

**影响**: `splitMeta.views.front` 缺失时不报错，继续用 512×512 构建 camera。错误不会被用户感知。

**修改方案**: `frontViewMeta` 缺失时直接 abort，错误提示"jointsMeta 缺少 front view split metadata，无法使用 Pose Proxy"。

**验收标准**: 不允许任何 source camera 使用 magic fallback。

---

#### P1-5 DWPose 坐标协议 pixel / normalized 注释冲突

**证据**: `src/services/dwpose.ts` 注释中有 normalized 表述，但转换逻辑按 pixel 坐标处理。

**影响**: 如果 worker 输出 normalized 坐标，前端静默生成错误 joints。

**修改方案**:
1. `DwposeResponse` 增加 `coordSpace: 'pixel' | 'normalized'`。
2. `detectPoses()` 返回后做 sanity check（坐标 > 1 或超出 image bounds）。
3. 统一注释为 DWPose pixel coordinate。

**验收标准**: 注释、类型、实际逻辑三方一致。

---

### P2 — 建议：跑通后增强鲁棒性

| 编号 | 问题 | 位置 | 修改方向 |
|---|---|---|---|
| P2-1 | 左右袖 swap 只 warning 不自修 | `poseAlignment.ts` L113-L132 | 检测 swap 后构造两套 pair 分别跑 SVD，选 RMSE 更优者；diagnostics 标记 `leftRightSwapped: true` |
| P2-2 | Capsule confidence 顶点数因子过早饱和 | `skeletonProxy.ts` L240 | 改 `min(1, n/5)` 为 `min(1, log10(n+1)/2)` 等平滑函数；增加 `vertexAdequacy` 独立字段 |
| P2-3 | sleeve far fallback 可能导致矩阵秩退化 | `poseAlignment.ts` L80-L107 | far 缺失时用 `near.position + near.direction * extent` 合成分离点，而非直接复制 near |
| P2-4 | 手动 Pose Proxy 静默降级为 RANSAC | `ModelAssemble.tsx` L912-L920 | 禁用按钮 + tooltip 说明"仅支持一键自动对齐"，不自动 fallback（用户已确认此策略） |
| P2-5 | Target DWPose 对 mesh render 图鲁棒性不足 | `ModelAssemble.tsx` L2694-L2713 | 固定 render 风格；DWPose 后做 neck/shoulder/hip 质量门槛；保存 overlay debug 图 |
| P2-6 | `minJointConfidence` 阈值固定不可调 | `skeletonProxy.ts` | 暴露为 `buildSkeletonProxy()` 选项；trace 输出每个被跳过 joint 的 confidence |

---

### P3 — 已验证 / 降级 / 文档项

| 编号 | 问题 | 结论 |
|---|---|---|
| P3-1 | ICP target region 约束 | ✅ 已验证存在：`icpRefine()` 已传 `tarRestrictVertices: workingTarRegion?.vertices`（`ModelAssemble.tsx` L2938-L2948）。建议补 trace `icpConstraintSize`。原风险降级。 |
| P3-2 | DWPose 采用 subprocess bridge | ✅ 架构决策正确，与项目其他 AI 能力接入方式一致。需要补 `.env.example` 和 `/api/dwpose/health`。 |
| P3-3 | OpenPose 历史措辞 | 实现是 DWPose，文档注释残留 OpenPose。统一替换为 DWPose 或中性"pose estimator"。 |
| P3-4 | bboxDiagonal 重复实现 | `skeletonProxy.ts` 和 `poseAlignment.ts` 各有实现，应与 `index.ts` 已 export 的工具函数统一。 |
| P3-5 | 错误退出代码重复 | 5+ 处 `setPartialLoading(false); setAligning(false); return;` 三连，建议抽取 `bailPoseProxy(message)` helper。 |
| P3-6 | Phase 9 可视化推迟 | 在 trace 中先落 JSON（capsule proximal3D/distal3D/radius、anchor 主轴向量等），方便后续脱机可视化。 |

---

## 4. 修复路线图

### 第一阶段：端到端闭环（单独 PR）

> 目标：一个测试项目能从 Page1 到 Page3 完整拿到 `PipelineJointsMeta.views.front`

- [ ] Page1 接入 `detectAndConvertToGlobalJoints()`
- [ ] Page2 接入 `generatePipelineJoints()`
- [ ] pipeline 写入 `jointsMeta`
- [ ] Page3 Pose Proxy 按钮仅在有 joints 时启用
- [ ] 失败时禁用按钮，不自动 fallback

### 第二阶段：几何正确性（与第一阶段可同 PR 或紧接）

> 目标：source joints 能准确 overlay 到 source mesh front view

- [ ] 保存并复用 source projection camera（P0-2）
- [ ] 移除 512×512 fallback（P1-4）
- [ ] 修复 weighted SVD（P1-2）
- [ ] 修复 LandmarkCandidate -1 语义污染（P1-3）
- [ ] DWPose pixel/normalized 坐标 sanity check（P1-5）
- [ ] 稳健 seed 替代 K=3 最近点（P1-1）

### 第三阶段：鲁棒性提升

> 目标：左右袖不反、capsule 不受稀疏顶点影响、DWPose 失败能定位

- [ ] 左右袖 swap 自动双解比较（P2-1）
- [ ] capsule confidence 顶点数因子改造（P2-2）
- [ ] sleeve far fallback 空间分离（P2-3）
- [ ] 手动 Pose Proxy 禁用 + tooltip（P2-4）
- [ ] target DWPose overlay debug + 质量门槛（P2-5）
- [ ] `minJointConfidence` 参数化 + trace（P2-6）

### 第四阶段：文档与可维护性

- [ ] 清除 OpenPose 残留注释，统一为 DWPose
- [ ] `.env.example` 补 DWPose 配置
- [ ] `/api/dwpose/health`
- [ ] `bailPoseProxy(message)` helper
- [ ] bboxDiagonal 去重
- [ ] Phase 9 可视化面板

---

## 5. 合并建议

**不建议**把当前 Phase 8 作为"完成态"直接合并到 main。

可接受的合并方式：

| 方式 | 条件 |
|---|---|
| **推荐** | 先完成 P0 + P1（第一、二阶段），再合并 |
| **临时** | 若必须先合并，Pose Proxy 必须默认隐藏或 feature flag 关闭，标注"实验功能" |

**最终 gate**:
- P0 全部完成：**必须**
- P1 全部完成：**必须**
- P2 可排后续质量 PR
- P3 可随手清理或建 issue
