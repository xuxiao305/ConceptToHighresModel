# Page3 对齐操作优化计划

## 1. 优化目标

当前 Page3 对齐流程已经在技术上跑通，但 GUI 仍然偏“调试工具形态”：用户需要手动加载参考图、mask、segmentation.json，手动反投影，再手动选择区域、部分匹配、执行对齐。

本轮优化目标是：

> 将 Page3 对齐从“多步骤调试流程”简化为“目标区域确认 + 一键自动对齐”的产品型流程。

普通用户只需要关心三件事：

1. 要对齐哪个 Source 部件；
2. 要贴到 Target 的哪个区域；
3. 最终结果是否接受。

其余参数和中间步骤默认自动化，保留到“高级调试”中。

---

## 2. 当前对齐流程中的可简化步骤

当前完整流程大致是：

1. 加载 Source 部件模型；
2. 加载 Target 完整模型；
3. 加载参考图；
4. 加载 segmentation.json；
5. 加载 segmentation mask；
6. 三图叠加确认；
7. 反投影 mask 到 Target 顶点；
8. 选择目标区域，例如 RightArm；
9. 部分匹配查找；
10. 执行 SVD / ICP 对齐；
11. 查看结果并接受。

其中 3～10 大部分都可以自动化。

建议最终压缩成：

1. 选择 Source 部件；
2. 选择 Target 模型；
3. 加载或自动识别 SAM3 分割包；
4. 确认目标区域；
5. 点击“一键自动对齐”；
6. 查看结果并接受 / 撤销。

---

## 3. 可以固定的默认参数

这些参数已经通过完整 E2E sweep 得到较稳定组合，普通 GUI 不需要默认展示。

| 参数 | 建议值 | GUI 处理方式 | 说明 |
|---|---:|---|---|
| `projectionMode` | `through` | 固定，不展示 | mask 穿透投影到前后所有顶点 |
| `maskDilatePx` | 2 | 固定，不展示 | 补偿 mask 边缘和模型轮廓的小偏差 |
| `splatRadiusPx` | 1 | 固定，不展示 | Page3 生产默认顶点像素容错半径 |
| `descriptor` | `fpfh` | 默认固定，高级设置可切换 | 当前主线使用 FPFH 描述子 |
| `tarConstraintUseSaliency` | true | 固定，不展示 | 在 SAM3 区域内优先采显著点 |
| `numSrcSamples` | 25 | 固定，不展示 | 完整 sweep 当前最优组合 |
| `numTarSamples` | 80 | 固定，不展示 | 当前足够，继续加大收益不明显 |
| `topK` | 8 | 固定，不展示 | 兼顾容错和错误候选控制 |
| `iterations` | 600 | 固定，不展示 | RANSAC 当前足够，1200 收益不明显 |
| `inlierThreshold` | 0.05 | 固定，不展示 | 5% source bbox，对本 case 更稳 |
| `tarSeedWeight` | 5 | 固定，不展示 | seed 区域软约束权重 |
| `axialWeight` | 5 | 固定，不展示 | PCA 轴向/径向特征权重 |
| ICP `rejectMultiplier` | 2.5 | 固定，不展示 | 当前 ICP 稳定默认 |
| ICP `firstIterMode` | `similarity` | 固定，不展示 | 第一轮允许缩放 |
| ICP `subsequentMode` | `rigid` | 固定，不展示 | 后续只做刚体细化 |

完整 sweep 当前最佳配置：

| 配置 | RMSE | scale | pairs |
|---|---:|---:|---:|
| `显著点+src25+topK8` | 0.886 | 0.548 | 25 |

因此 Page3 普通流程建议固定为：

```text
through + dilate 2 + FPFH + saliency + src25 + tar80 + topK8 + axial5
```

---

## 4. 自动化加载与识别

### 4.1 SAM3 分割包自动加载

用户不应该分别加载：

- 参考图；
- segmentation mask；
- segmentation.json。

建议用户只选择一个 `segmentation.json` 或分割包目录，系统根据 JSON 自动找到：

```text
segmentation.json
	├─ image: Bot.png
	└─ mask_png: segmentation_mask.png
```

GUI 显示：

```text
已加载 SAM3 分割包
参考图：Bot.png
Mask：segmentation_mask.png
检测到区域：RightArm / Body / LeftArm
```

### 4.2 目标区域自动推荐

如果 Source 部件名、文件名或 pipeline metadata 能推断语义，则自动推荐目标区域。

| Source 信息包含 | 推荐区域 |
|---|---|
| `right arm`, `rightarm`, `arm_hires` | `RightArm` |
| `left arm`, `leftarm` | `LeftArm` |
| `body`, `torso` | `Body` |
| `jacket`, `coat` | `Body` 或后续专用 `Jacket` |

注意：Left / Right 可能存在观察者视角和角色语义差异，因此自动推荐不能完全锁死。

GUI 建议：

```text
目标区域：RightArm  [可修改]
系统推荐：RightArm，置信度：高
```

### 4.3 反投影自动执行

当以下条件满足时自动执行反投影：

- Target GLB 已加载；
- 参考图已加载；
- mask 已加载；
- segmentation.json 已加载；
- 目标区域已选择。

内部自动执行：

```text
WebGL 正视图渲染
→ silhouette refit
→ mask through 反投影
→ 生成 target region vertices
```

GUI 只显示结果摘要：

```text
已定位目标区域：RightArm
顶点数：77748
[查看区域]
```

---

## 5. 一键自动对齐流程

建议将以下按钮或操作合并：

- 反投影 mask 到顶点；
- 选择 target seed；
- 部分匹配查找；
- 执行 SVD 对齐；
- ICP refine；
- SVD / ICP 结果比较。

普通用户只看到一个主按钮：

```text
[自动对齐到目标区域]
```

内部流程：

1. 检查 Source / Target / SAM3 分割包是否齐全；
2. 自动渲染 Target 正视图；
3. 自动反投影 mask 到 Target 顶点；
4. 根据目标区域得到 `tarConstraintVertices`；
5. 执行 `matchPartialToWhole()`；
6. 执行 `alignSourceMeshByLandmarks()`；
7. 执行 `icpRefine()`；
8. 在同一组 landmark pairs 上比较 SVD 和 ICP RMSE；
9. 自动选择更优结果；
10. 更新 3D 预览，但不自动最终接受。

完成后显示：

```text
自动对齐完成
目标区域：RightArm
匹配点：25
RMSE：0.886
Scale：0.548
方法：SVD

[接受对齐] [撤销] [重新匹配] [查看调试]
```

---

## 6. 普通模式与高级调试模式

### 6.1 普通模式

面向美术、TA、日常操作用户。

只保留：

- Source 部件选择；
- Target 模型选择；
- SAM3 分割包状态；
- 目标区域下拉；
- 自动对齐按钮；
- 结果质量面板；
- 接受 / 撤销 / 重新匹配。

普通模式流程：

```text
加载 Source 部件
→ 加载 Target 模型
→ 加载 SAM3 分割包
→ 确认目标区域
→ 自动对齐
→ 接受 / 撤销
```

### 6.2 高级调试模式

面向开发者和需要调参的技术用户。

放到折叠面板：

```text
[显示高级参数]
```

高级模式保留：

- `projectionMode`；
- `maskDilatePx`；
- `splatRadiusPx`；
- `descriptor`：FPFH / curvature；
- `numSrcSamples`；
- `numTarSamples`；
- `topK`；
- `iterations`；
- `inlierThreshold`；
- `tarSeedWeight`；
- `axialWeight`；
- saliency / FPS / top-K debug 可视化；
- E2E sweep 入口。

---

## 7. 结果质量面板设计

自动对齐完成后，建议在右侧面板或弹出区域显示质量摘要。

示例：

```text
对齐质量：良好
目标区域：RightArm
匹配点：25
RMSE：0.886
Scale：0.548
最终方法：SVD
耗时：25.9s
```

质量等级可以先用简单规则：

| 条件 | 等级 |
|---|---|
| `RMSE < 1.0` 且 `pairs >= 20` | 良好 |
| `RMSE < 1.8` 且 `pairs >= 15` | 可用 |
| 其他 | 需要检查 |

按钮：

```text
[接受对齐] [撤销] [重新匹配] [查看正/侧视图] [高级调试]
```

---

## 8. 不建议完全自动化的部分

### 8.1 目标区域不建议完全锁死

原因：

- Left / Right 可能是观察者视角，也可能是角色语义视角；
- SAM3 label 可能不稳定；
- Source 名称不一定规范。

建议：自动推荐，但允许用户确认和修改。

### 8.2 最终结果不建议自动接受

对齐是 3D 视觉结果，数值低不一定每次都符合美术判断。

建议：自动应用到预览层，但最终需要用户点击：

```text
[接受对齐]
```

### 8.3 参数 sweep 不进入普通流程

sweep 是开发调试工具，不应成为日常操作的一部分。

普通流程只跑当前推荐默认配置。

---

## 9. 后续 VFH 方向

VFH 不建议替代当前 PCA 轴向/径向点级特征，但可以作为替代或补充 SAM3 目标区域定位的一层。

更合理的定位：

- SAM3：基于图像语义找到目标区域；
- VFH：基于 3D 几何形状找到与 Source 整体形状相似的 target candidate region；
- FPFH + PCA：在候选区域内部做点级精匹配。

建议后续做成三档模式：

### A. SAM3 模式

当前生产主线，最稳。

### B. VFH 自动模式

不加载 SAM3，直接从 Target 几何中搜索候选区域。适合做 fallback，但可能误选左右臂或相似部件。

### C. SAM3 + VFH 混合模式

SAM3 先给大区域，VFH 在该区域内部再筛更像 Source 的子区域，最后交给当前 FPFH + PCA + RANSAC 流程。

这是后续最值得探索的方向。

---

## 10. 实施优先级

### P0：一键化主流程

把“反投影 → seed → 部分匹配 → 对齐 → ICP 比较”合成一个按钮。

交付结果：

```text
[自动对齐到目标区域]
```

### P1：SAM3 分割包自动加载

只让用户选择 `segmentation.json` 或分割包目录，自动加载参考图和 mask。

### P2：目标区域自动推荐 + 可修改

根据 Source 名称、部件 metadata 或上游 pipeline 信息推荐目标区域。

### P3：普通 / 高级模式切换

默认隐藏所有调试参数，只保留核心操作。

### P4：结果质量面板

自动对齐完成后显示匹配点、RMSE、scale、最终方法、质量评级。

### P5：VFH fallback / 混合模式探索

作为后续增强，不影响当前 SAM3 主线。

---

## 11. 最终期望 GUI

普通用户看到的 Page3 对齐区域应接近：

```text
Source 部件：arm_hires.glb
Target 模型：bot.glb

SAM3 分割包：已加载
检测到区域：RightArm / Body / LeftArm
目标区域：[RightArm ▼]

[自动对齐到目标区域]

结果：良好
匹配点：25
RMSE：0.886
Scale：0.548

[接受对齐] [撤销] [重新匹配]
[显示高级参数]
```

这样用户不再需要理解：

- mask 如何反投影；
- `through` / `front` 的区别；
- FPFH / curvature 差异；
- PCA axial/radial；
- RANSAC / SVD / ICP 细节。

但开发调试能力仍然保留在高级模式中。
