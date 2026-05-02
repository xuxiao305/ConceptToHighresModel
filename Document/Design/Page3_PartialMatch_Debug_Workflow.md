# Page3 Partial-match Debug Workflow 设计备忘

日期：2026-05-02

本文记录 Page3 对齐流程中 `partial-match` 的逐步 debug 设计方案，目标是让用户能够清楚地区分：

```text
采样预览 → RANSAC 生成候选 → SVD 初始对齐 → ICP 精修
```

避免当前 UI 中 `调试快照`、`Step 1 Partial-match`、`候选匹配面板`之间概念重叠造成误解。

---

## 1. 当前问题

当前高级参数面板中有：

```text
Step 1 · Partial-match 查找候选
调试快照（看选点）
Step 2 · Landmark SVD
Step 3 · ICP refine
```

补充：当前代码里 Step 2 / Step 3 按钮实际存在，但它们位于右侧高级区靠后的独立面板 `Landmark SVD / ICP 手动对齐` 中，并且此前默认折叠，因此用户很容易误以为没有这两个步骤。该面板应改为更明显的标题，例如 `Step 2/3 · Landmark SVD / ICP 手动对齐`，并默认展开。

实际代码中，`Step 1 · Partial-match 查找候选` 已经执行完整 partial-match，包括：

```text
Saliency 选点
  ↓
FPS 采样
  ↓
Descriptor / Top-K 候选
  ↓
RANSAC 筛选
  ↓
输出候选 pairs
```

但是 UI 上用户主要能看到的是：

```text
Saliency 池
FPS 采样
Top-K 候选集合
```

这些来自 `调试快照` 的可视化层。

RANSAC 实际已经运行，但没有作为一个显式 debug 阶段展示出来。结果只隐含体现在：

```text
候选匹配面板中的 candidates
```

这导致用户容易误解为：

```text
我运行了 Step 1，但好像只看到了 saliency / FPS / top-K，
还没有执行 RANSAC，也没有执行 ICP。
```

其中 ICP 不属于 Step 1，本来就是 Step 3；但 RANSAC 属于 Step 1，却没有被清楚展示。

---

## 2. 当前真实执行关系

### 2.1 调试快照

当前 `调试快照（看选点）` 做的是：

```text
Saliency → FPS → Top-K 预览
```

它不执行：

```text
RANSAC
SVD
ICP
```

它的用途是诊断：

- Source 上显著点是否合理；
- Target 上采样点是否落在正确区域；
- SAM3 反投影 region 是否约束了 Target 采样；
- Top-K 候选是否集中在目标区域；
- 参数调整后采样分布是否改善。

### 2.2 Step 1 Partial-match

当前 `Step 1 · Partial-match 查找候选` 实际执行：

```text
Saliency → FPS → Descriptor → Top-K → RANSAC → final pairs
```

它会生成候选匹配对，写入 `candidates`，供 Step 2 使用。

### 2.3 Step 2 Landmark SVD

Step 2 使用：

```text
手动 landmarks
或 accepted candidates
或 Step 1 输出的 partial candidates
```

执行 similarity SVD，得到初始 transform。

### 2.4 Step 3 ICP refine

Step 3 以 Step 2 的 transform 为初始姿态，执行 ICP 微调。

ICP 不属于 Step 1。

---

## 3. 目标交互模型

希望用户可以按清晰的阶段逐步执行：

```text
1A. 诊断预览采样点 / Top-K
1B. RANSAC 生成候选对
2.  Landmark SVD 初始对齐
3.  ICP refine 精修
```

这四个动作中：

- 1A 是 debug-only，不影响正式候选。
- 1B 是 Step 1 的正式输出，生成 candidates。
- 2 生成初始 transform。
- 3 在初始 transform 上做最近邻 refine。

---

## 4. 建议 UI 拆分

### 4.1 Step 1 面板重命名

当前：

```text
Step 1 · Partial-match 查找候选
```

建议调整为：

```text
Step 1 · Partial-match / RANSAC
```

或：

```text
Step 1 · RANSAC 生成候选对
```

这样用户能明确 Step 1 的关键输出是 RANSAC 筛选后的候选对。

---

### 4.2 调试快照按钮弱化并改名

当前按钮：

```text
调试快照（看选点）
```

建议改为：

```text
诊断：预览采样点 / Top-K
```

Tooltip：

```text
仅用于调参诊断：预览 Saliency、FPS 和 Top-K 候选，不生成候选对，不进入 Step 2。
```

按钮样式建议：

- 使用 secondary / ghost 样式；
- 放在 Step 1 主按钮下方；
- 不与正式 Step 1 按钮同等视觉权重。

---

### 4.3 Step 1 主按钮改名

当前：

```text
Step 1 · Partial-match 查找候选
```

建议：

```text
Step 1 · RANSAC 生成候选对
```

或：

```text
Step 1 · Partial-match + RANSAC
```

Tooltip：

```text
执行完整 partial-match：采样、descriptor top-K、RANSAC 筛选，并生成供 Step 2 使用的候选对应点。
```

---

### 4.4 候选匹配面板改名

当前：

```text
候选匹配 (Phase 2)
```

这个名字容易误解，因为现在 Step 2 已经是 Landmark SVD。

建议改为：

```text
RANSAC 候选对
```

或：

```text
Step 1 输出：候选匹配对
```

说明文字建议：

```text
这里显示 Step 1 RANSAC 筛选后的 source ↔ target 对应点。
可以手动接受 / 拒绝；接受后用于 Step 2 Landmark SVD。
```

---

## 5. Step 1 Debug 信息展示

Step 1 完成后，建议在面板中显式显示 RANSAC 统计信息。

建议字段：

```text
RANSAC 结果
- Source samples: N
- Target samples: M
- Top-K: K
- Iterations: I
- Best inliers: B
- Final pairs: P
- Threshold: T
- RMSE: R
```

当前 `matchPartialToWhole()` 已经返回：

```text
pairs
matrix4x4
rmse
thresholdUsed
iterationsRun
rawSrcSamples
rawTarSamples
bestInlierCount
```

因此 UI 可以直接展示这些信息。

---

## 6. 3D 可视化建议

### 6.1 诊断预览层

用于显示：

```text
Saliency 池
FPS 采样点
Top-K 候选集合
```

颜色建议保持当前逻辑：

```text
暗色：saliency 池
亮色：FPS 采样
品红：Top-K target 候选集合
```

### 6.2 RANSAC 输出层

新增或强化显示：

```text
RANSAC inlier source points
RANSAC inlier target points
```

建议在 Step 1 完成后，默认突出显示 final pairs，而不是继续突出 Top-K debug 点。

可选显示方式：

- Source candidate 点高亮；
- Target candidate 点高亮；
- 中央候选列表同步 hover / select；
- 点击候选 pair 时在两个视图中同时高亮该 pair。

---

## 7. 推荐交互流程

用户逐步 debug 时：

### 7.1 先看采样是否合理

点击：

```text
诊断：预览采样点 / Top-K
```

观察：

- Source saliency 是否落在合理结构上；
- Source FPS 是否覆盖整个部件；
- Target FPS 是否落在 SAM3 region 内；
- Top-K 是否集中在目标区域，还是跑到腿 / 躯干等错误区域。

### 7.2 再生成正式候选

点击：

```text
Step 1 · RANSAC 生成候选对
```

观察：

- best inliers 是否足够；
- final pairs 数量是否足够；
- RMSE 是否合理；
- 候选列表是否大致对应正确。

### 7.3 审阅候选

在：

```text
RANSAC 候选对
```

中：

- 全部接受；
- 或逐个接受 / 拒绝；
- 低 confidence 的候选可人工剔除。

### 7.4 执行 Step 2

点击：

```text
Step 2 · Landmark SVD
```

得到初始 transform。

### 7.5 执行 Step 3

点击：

```text
Step 3 · ICP refine
```

在 Step 2 结果基础上微调。

---

## 8. 状态文案建议

### 8.1 诊断预览完成

```text
采样诊断完成：Saliency src=400 tar=800，FPS src=25 tar=80，Top-K=8。
该结果仅用于可视化，不会进入 Step 2。
```

### 8.2 Step 1 成功

```text
Step 1 完成：RANSAC 找到 12 个 inliers，输出 10 对候选，RMSE=0.034，threshold=0.05。
请在“RANSAC 候选对”中审阅后执行 Step 2。
```

### 8.3 Step 1 失败

```text
Step 1 失败：RANSAC inliers=2，低于 minInliers=4。
可尝试增加 topK / iterations / threshold，或检查采样诊断中的 Target 候选是否落在正确区域。
```

---

## 9. 实现建议

### 9.1 最小改动版

不重构算法，只改 UI 和文案：

1. `调试快照（看选点）` 改名为 `诊断：预览采样点 / Top-K`。
2. `Step 1 · Partial-match 查找候选` 改名为 `Step 1 · RANSAC 生成候选对`。
3. `候选匹配 (Phase 2)` 改名为 `RANSAC 候选对`。
4. Step 1 成功状态文案中明确显示 `RANSAC`、`bestInlierCount`、`pairs`、`rmse`。
5. Step 1 结果区域增加 RANSAC summary。

### 9.2 中等改动版

在最小改动基础上：

1. 新增 `partialMatchSummary` state 保存 Step 1 统计。
2. Step 1 完成后显示 RANSAC summary card。
3. 3D 视图默认高亮 final candidate pairs。
4. Debug top-K layer 与 final pairs layer 可分别开关。

### 9.3 长期改动版

进一步将 partial-match pipeline 拆成可单步执行：

```text
computeSamplingDebug()
computeTopKDebug()
runRansacFromTopK()
```

这样可以真正做到：

```text
1A 采样
1B top-K
1C RANSAC
```

但这需要重构 `partialMatch.ts`，把当前内部 `runMatchingTail()` 的中间数据结构暴露出来。

---

## 10. 推荐优先级

建议先做最小改动版：

```text
改名 + 文案 + RANSAC summary
```

原因：

- 当前算法已经跑了 RANSAC；
- 用户困惑主要来自 UI 表达；
- 不需要先重构算法；
- 可以快速提升 debug 可理解性。

之后再考虑中等改动：

```text
final pairs 高亮 / top-K 与 RANSAC layers 分离
```

最后再考虑长期重构：

```text
真正单步执行 sampling → topK → RANSAC
```

---

## 11. 一句话总结

当前 Step 1 已经包含 RANSAC，但 UI 没有把 RANSAC 作为显式阶段展示，导致用户误以为只执行了 saliency / FPS / top-K。

建议把 Step 1 debug flow 调整为：

```text
诊断：预览采样点 / Top-K
Step 1：RANSAC 生成候选对
Step 2：Landmark SVD
Step 3：ICP refine
```

并新增 RANSAC summary 与候选对可视化，使三大步可以真正被逐步理解和调试。
