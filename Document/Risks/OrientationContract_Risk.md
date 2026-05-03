# 项目重大风险：朝向契约（Orientation Contract）

**记录日期**：2026-05-03  
**严重程度**：🔴 高 — 一旦破坏会导致整条 Pose Proxy 链失效，且无运行时检测  
**当前状态**：未采取防御措施，依赖上下游"约定俗成"  
**关联模块**：Page1 MultiView · Page2 抽取/SmartCrop/重建 · Page3 Pose Proxy

---

## 1. 风险陈述

> **整条 Pose Proxy 对齐链（以及未来基于 2D-3D 投影的任何对齐策略）建立在一个隐式契约上：从 Page1 概念图到 Page3 Source mesh 的 ortho 正视渲染，"正面朝向"必须始终保持一致，任何环节的图像旋转或 mesh 朝向变化都会让契约破裂，下游静默失败。**

这个契约从来没有被显式写入文档，也没有任何运行时校验机制。

---

## 2. 契约链路（Front-Facing Invariant）

```
Page1 全身 T-Pose 概念图 (正面朝前)
        ↓ MultiView ComfyUI 节点
Page1 4合1 (front 必须 = 概念图朝向)
        ↓ Page2 BananaPro / SAM3 抽取
Page2 4合1 extraction (前向不变)
        ↓ SmartCrop (只缩放+平移，不旋转 ✓)
Page2 4合1 processed
        ↓ splitMultiView (按象限切，不旋转 ✓)
Page2 part front 视图
        ↓ Trellis2 / image-to-3d 重建
Source mesh (朝向必须 = part front 视图朝向)
        ↓ Page3 ortho 正视投影
2D 渲染 → DWPose 检测 → joints 对齐
```

---

## 3. 高风险环节

| 环节 | 旋转/朝向风险 | 当前防御 |
|---|---|---|
| ComfyUI MultiView 节点 | 各视角朝向由训练 prompt 决定，输出顺序固定 | 无主动校验，依赖节点本身 |
| BananaPro 抽取 | ⚠️ Prompt 措辞可能诱发模型旋转图（如 "orthographic view of jacket"）| 无 |
| SAM3 抽取 | ✓ 只输出 mask，安全 | — |
| RMBG | ✓ 只去背景，安全 | — |
| SmartCrop | ✓ 只缩放+平移，安全 | — |
| splitMultiView | ✓ 按象限切，安全 | — |
| **Trellis2 / image-to-3d 重建** | 🔴 mesh 在世界坐标可能整体绕 Y 翻转 180°、绕 X 翻倒；无机制保证"重建出的 mesh 用 ortho 正视渲染 = 输入 front 视图" | 无 |
| Page3 ortho 渲染 | ✓ 用户/代码指定朝向，安全 | — |

---

## 4. 失败表征（用户视角）

契约破坏后用户实际看到的现象：

- DWPose 在 Page3 source mesh 渲染上检测到 0 关节点
- 报错文案模糊："缺少关节点数据" / "Pose Proxy 未能检测到人体关键点"
- 用户无从判断是数据缺失、模型问题、还是朝向错位
- 切换到 Limb / Surface 兜底也可能因为坐标系混乱而表现异常
- 用户怀疑算法 bug，但实际是**上游某次重建/抽取破坏了朝向**

---

## 5. 根本原因

| 维度 | 说明 |
|---|---|
| 设计哲学 | 老方案是"严格保持朝向一致 → 关节直接可用"。这个设计本身没问题——多视图重建确实建立在朝向一致前提下 |
| 真正缺失 | 缺少**运行时检测**：哪一步破坏了契约不可知；缺少 **UI 暴露**：用户不知道存在这个隐式假设 |
| 文档缺位 | 没有任何文档把"朝向必须保持一致"写进开发须知 |

---

## 6. 已识别但未实施的防御措施

> 这些措施暂时**不实施**，待重构主线完成后再补。本文档仅记录方案，避免遗忘。

### 6.1 Page1 朝向校验
- DWPose 跑完 4 张图后检查 front 视图能否检测到正面人体（neck + shoulders + hips 正向）
- 检查 left/right 视图关节布局是否符合"侧身"特征
- 不符合时在 UI 标 ⚠️

### 6.2 Page2 高模 ortho 自检
- 高模生成完成后，把新 mesh 用 ortho 正视渲染一次
- 跑 DWPose，与 Page1 front joints 大致比对方向
- 不一致时标 ⚠️ "mesh 朝向异常，Pose Proxy 不可用"

### 6.3 GUI 主动暴露契约
- Pose Proxy 策略卡的"前置数据"清单里显式列：
  - "Source mesh 朝向 = Page1 概念图朝向"（✓/⚠️）
  - "Target mesh 朝向 = Page1 概念图朝向"（✓/⚠️）
- 让用户对这个隐式假设有意识

### 6.4 失败兜底
- 检测到朝向破坏时不报"DWPose 0 关节点"，而是给清晰路径：
  - "Source mesh 朝向异常，建议改用 Limb 或 Surface 模式"
- 自动高亮可用的兜底策略卡

---

## 7. 与重构主计划的关系

| 主计划阶段 | 与本风险的关系 |
|---|---|
| Stage 1 Page1 加 DWPose | 自然产生"4 视图关节是否正常"信号，可作为 6.1 的实现底座 |
| Stage 6 Page3 GUI 落地 | 实现 6.3 的最佳时机（策略卡前置数据列表） |
| 独立加项 | 6.2 的高模 ortho 自检需要新加 verifyMeshOrientation() 工具 |

**结论**：防御措施天然契合重构计划，不需要单独立项；但要在对应阶段补上，避免"重构完了风险还在"。

---

## 8. 检查清单（开发期间随时核对）

- [ ] BananaPro / SAM3 prompt 文案中没有诱发旋转的措辞（"orthographic view"、"flat lay"、"top-down" 等）
- [ ] 任何新增的图像处理步骤明确声明"是否旋转图像"
- [ ] Trellis2 / 任何新替换的 image-to-3d 模型在 PR 中标注其输出朝向规范
- [ ] 朝向相关的 mesh 后处理（如 normalizeOrientation()、autoAlignAxis()）都不能默认开启，避免悄悄旋转
- [ ] 任何"看起来无害"的 image transform（gamma 调整、边缘 padding）确认不动几何

---

## 9. 决策记录

- **2026-05-03**：风险被识别。决定不立即实施防御措施，先完成重构主计划（refactor_master_plan.md）。本文档作为长期跟踪资产，主计划相关阶段完成后回头补 6.1-6.4。

---

## 10. 修改记录

| 日期 | 修改内容 |
|---|---|
| 2026-05-03 | 创建文档，记录初版风险和防御方案 |
