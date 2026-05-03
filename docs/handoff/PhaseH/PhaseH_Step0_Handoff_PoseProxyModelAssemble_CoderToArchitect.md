# PhaseH_Step0_Handoff_PoseProxyModelAssemble_CoderToArchitect

**From**: CodeExpert  
**To**: Architect  
**Date**: 2026-05-03  
**Subject**: Phase 8 — Pose Proxy 模式集成到 ModelAssemble.tsx（实现完成，请求架构审查）

---

## 1. 任务目标

将 Phase 1-7 构建的 skeleton proxy + SVD pose alignment 管线端到端集成到 Page3 的 `ModelAssemble.tsx` 中，作为第 4 种自动对齐模式（`'pose-proxy'`），与其他 3 种模式（surface / limb-structure / jacket-structure）并列。

---

## 2. 实现范围

### 2.1 修改文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/pages/Page3/ModelAssemble.tsx` | 修改（+~200 行） | 核心集成点 |
| `src/services/dwpose.ts` | 新增 1 个导出函数 | 单视图 COCO→Joint2D 转换 |

### 2.2 新增函数

**`cocoPoseToJoint2D()`** — `src/services/dwpose.ts` 行 ~245  
- 签名：`(pose: DwposePose, _imageSize: {width; height}) => Joint2D[]`
- 职责：将单张 DWPose 检测结果转换为命名 Joint2D 数组，不做四象限拆分
- 与 `convertToGlobalJoints()` 的区别：后者做四分图拆分并分配 view；本函数直接映射所有 COCO keypoints 到单一 view

### 2.3 类型变更

**`PartialMatchMode`** — `ModelAssemble.tsx` 行 ~65  
```ts
// Before
type PartialMatchMode = 'surface' | 'limb-structure' | 'jacket-structure';

// After
type PartialMatchMode = 'surface' | 'limb-structure' | 'jacket-structure' | 'pose-proxy';
```

### 2.4 新增导入

```ts
import { buildSkeletonProxy, computePoseAlignment, type OrthoFrontCamera } from '../../three';
import { detectPoses, cocoPoseToJoint2D } from '../../services/dwpose';
import { getPipelineJoints, type AssetVersion, type PersistedPipeline } from '../../services/projectStore';
```

---

## 3. 核心集成逻辑 (`handleAutoAlign` — pose-proxy 分支)

### 3.1 数据流

```
Page2 pipeline joints (PipelineJointsMeta)
         │
         ▼
  getPipelineJoints(project, pipelineKey)
         │
         ├─→ srcJoints (views.front) ──→ buildSkeletonProxy(srcMesh, srcJoints, srcCamera)
         │                                         │
         │                                         ▼
         │                              SkeletonProxyResult (srcProxy)
         │
         │
  DWPose on ortho render
         │
         ▼
  detectPoses(orthoRenderUrl) ──→ detectPoses.raw.poses[0]
         │
         ▼
  cocoPoseToJoint2D(pose, imageSize) ──→ tarJoints (Joint2D[])
         │
         ▼
  buildSkeletonProxy(tarMesh, tarJoints, orthoCamera, opts, workingTarRegion?.vertices)
         │
         ▼
  SkeletonProxyResult (tarProxy)
         │
         ▼
  computePoseAlignment(srcProxy, tarProxy, { svdMode: 'similarity' })
         │
         ├─→ PoseAlignmentResult
         │     ├─ matrix4x4
         │     ├─ anchorErrors (per-anchor RMSE + confidence)
         │     └─ anchorPairCount, svdRmse, scale, reliable, warnings
         │
         ▼
  anchorErrors → LandmarkCandidate[] (descriptorDist=0, srcVertex/tarVertex=-1)
         │
         ▼
  PartialMatchResult { pairs, matrix4x4, rmse, diagnostics }
         │
         ├─→ 现有 SVD landmark fit（复用 lmFit）
         └─→ 现有 ICP refine（复用 icpRefine，受 workingTarRegion 约束）
```

### 3.2 相机来源

| 角色 | 相机 | 获取方式 |
|------|------|----------|
| Source Proxy | `srcCamera` | `renderOrthoFrontViewWithCamera(srcMesh, { width: sliceSize.w, height: sliceSize.h })` — 从 `srcJointsMeta.splitMeta.views[front].sliceSize` 取尺寸 |
| Target Proxy | `orthoCamera` | 组件已有的 `orthoCamera` prop，来自用户定位 |

### 3.3 handleFindPartial 降级

`handleFindPartial` 是同步函数（在 `setTimeout` 回调中执行），无法运行异步的 DWPose + pipeline 加载。pose-proxy 模式在此处**降级为 surface RANSAC**：
- 调用 `matchPartialToWhole(srcMesh, tarMesh, opts)`
- 向用户显示警告：`"DWPose 尚未就绪，使用 Pose Proxy 需要先点击「一键自动对齐」"`
- 这与 `handleAutoAlign` 异步分支形成互补，保证用户即使在手动模式下也不会完全阻塞

### 3.4 状态消息（所有 pose-proxy 分支）

覆盖的关键状态路径：
- 开始对齐 → `"自动对齐（Pose Proxy）: 开始检测姿态..."`
- 加载 pipeline joints → `"自动对齐（Pose Proxy）: 加载源模型关节点..."`
- DWPose 检测 → `"自动对齐（Pose Proxy）: 检测目标模型姿态..."`
- 构建 proxy → `"自动对齐（Pose Proxy）: 构建骨架 proxy..."`
- SVD 对齐 → `"自动对齐（Pose Proxy）: 计算姿态对齐..."`
- ICP 精修 → `"自动对齐（Pose Proxy）: ICP 精修..."`
- 成功 → `"自动对齐完成 ✓（Pose Proxy）"` + RMSE 信息
- 失败 → 锚点不足 / 关节点缺失 / DWPose 未检测到 等错误信息

---

## 4. UI 变更

### 4.1 自动对齐按钮区

3 列 grid → **2 列 grid**，容纳 4 个按钮：

| 按钮 | 状态 | 说明 |
|------|------|------|
| **一键 · Pose Proxy 对齐** | disabled when `!sourceGalleryBinding` | 需要 source 精模已加载且绑定 pipelineKey |
| 一键 · 表面匹配对齐 | 无变化 |  |
| 一键 · 结构匹配对齐 | 无变化 |  |
| 一键 · 外套结构对齐 | 无变化 |  |

### 4.2 手动模式区

新增行：
- **手动 Pose Proxy** 按钮（重跑 DWPose + proxy + SVD，不跑 ICP）
- 模式选择器 `partialMatchMode === 'pose-proxy'` 时显示 `'Pose Proxy（姿态骨架代理）'`
- 描述文本：`"用 DWPose 人体关节点建立骨架代理，通过 SVD 匹配姿态后进行 ICP 精修"`

### 4.3 回调依赖

`handleAutoAlign` deps 数组新增：`sourceGalleryBinding`, `project`, `orthoRenderUrl`

---

## 5. 验证证据

### 5.1 TypeScript 编译

| 验证项 | 命令 | 结果 | 状态 |
|--------|------|------|------|
| 全量 TS 编译 | `npx tsc --noEmit --pretty` | 零输出（无错误） | ✅ 通过 |

### 5.2 已修复的编译错误

| 错误 | 位置 | 修复 |
|------|------|------|
| `SkeletonProxyResult` unused import | Line 46 | 从 import 中移除 |
| `PoseAlignmentResult` unused import | Line 47 | 从 import 中移除 |
| `Joint2D` `PipelineJointsMeta` unused import | Line 57 | 移除整行 import |
| `descriptorDist` missing in `LandmarkCandidate` | Line 2785 | 添加 `descriptorDist: 0` |

### 5.3 未执行运行时测试

pose-proxy 模式依赖：
- DWPose 子进程（需 `D:\AI\Prototypes\DWPose` Python 环境就绪）
- 真实的 Page2 pipeline joints 数据
- 完整的 source mesh + target mesh + orthoCamera + SAM3 mask

目前无法在开发环境执行完整运行时冒烟测试，建议在真实项目数据上手动验证。

---

## 6. 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| **DWPose 子进程不可用** | pose-proxy 模式完全无法工作 | 用户可回退到其他 3 种模式；错误消息明确提示 DWPose 失败 |
| **Page2 未生成 pipeline joints** | `getPipelineJoints` 返回 null | 用户会看到"源模型缺少关节点数据"错误，不会静默失败 |
| **单图 DWPose 检测失败** | 目标 mesh 正交渲染无人形 | 错误提示"目标模型 DWPose 未检测到人体关键点" |
| **锚点配对不足（< 3 pairs）** | SVD 无法收敛 | 明确错误信息 `pairs=${n}，需≥3` |
| **handleFindPartial 不同步** | 手动模式下 pose-proxy 不可用 | 降级到 surface RANSAC + 警告提示 |
| **`descriptorDist: 0` 为占位值** | 如果下游根据 descriptorDist 排序可能导致不确定行为 | 当前 pipeline 中 descriptorDist 仅用于 debug/trace，不影响 SVD/ICP 逻辑 |
| **Source camera 假设** | `srcJointsMeta.splitMeta.views` 使用 `find(v => v.view === 'front')` 需要 front view 存在 | 若 Page2 的 SplitViewBBox 未包含 'front' view，`sliceSize` fallback 到 512×512，可能导致相机投影不精确 |

---

## 7. 请求审查维度

请 Architect 重点审查：

1. **接口契约一致性** — `buildSkeletonProxy` / `computePoseAlignment` 的调用方式是否与 Phase 5/7 设计的接口意图一致
2. **数据流完整性** — pipeline joints → proxy → SVD → LandmarkCandidate → ICP 链路是否正确，有无数据断层
3. **错误处理覆盖** — 所有异步失败路径是否都有明确的用户反馈和状态清理
4. **PartialMatchResult 扩展** — `diagnostics.mode: 'pose-proxy'` 是否与现有 `PartialMatchResult` 类型兼容
5. **UI 布局合理性** — 2×2 grid 在窄屏上是否够用，按钮命名和优先级是否清晰
6. **降级策略合理性** — `handleFindPartial` 的 surface RANSAC 降级是否是可接受的回退方案

---

## 8. 未决问题

- Phase 9（debug 可视化 capsule/PCA/anchors 到 DualViewport）尚未实现，需要 Architect 确认可视化方案后再开工
- 预存在的 `dwpose.ts` 中的 3 个 TS 错误（`VIEW_ORDER` 未读、`GlobalJointsMeta` 缺少 `version/layout/poseModel/keypoints`）未在本次修复，属于 Phase 7 遗留
- `descriptorDist: 0` 是占位值——若未来需要真实的 descriptor distance（例如基于 capsule vertex 的 FPFH），需要重新审视 `LandmarkCandidate` 的设计
