# Page3 Partial-match：Saliency / FPFH 讨论备忘

日期：2026-05-02

本文记录 Page3 对齐流程中 `partial-match` 的当前逻辑、潜在弱点，以及后续可改进方向。

---

## 1. 当前 partial-match 的大致流程

当前 Step 1 `Partial-match 查找候选` 本质上不是最终对齐，而是自动寻找一组可用于后续 SVD 的候选对应点。

流程可概括为：

```text
Saliency 选点
  ↓
FPS 空间采样
  ↓
Descriptor 计算（FPFH 或 curvature descriptor）
  ↓
Top-K 候选匹配
  ↓
RANSAC 筛出自洽候选对
  ↓
输出候选 pairs 给 Step 2 Landmark SVD
```

其中：

- `saliency`：决定哪些点值得进入候选池。
- `FPS`：从候选池里挑空间分布更均匀的一批点。
- `FPFH / curvature descriptor`：描述采样点附近的局部形状。
- `Top-K`：为每个 Source 采样点在 Target 上寻找若干相似候选点。
- `RANSAC`：从候选关系中筛出整体几何自洽的一组匹配。

---

## 2. “调试快照（看选点）”的含义

`调试快照（看选点）` 不是正式对齐步骤，而是 Partial-match 的诊断预览。

它只运行前半段：

```text
Saliency → FPS → Top-K 候选预览
```

不运行：

```text
RANSAC / SVD / ICP
```

用途：

- 查看 Source 上选点是否合理。
- 查看 Target 上选点是否落在正确区域。
- 查看 SAM3 反投影出来的 `tarRegion` 是否有效约束了 Target 候选区域。
- 排查为什么 partial-match 找不到候选。
- 辅助调整 `Source Samples`、`Target Samples`、`topK`、`descriptor`、`seed weight` 等参数。

建议后续 UI 文案改为：

```text
诊断：预览采样点 / Top-K
```

并在 tooltip 中说明：

```text
仅用于调参诊断：预览 Saliency、FPS 和 Top-K 候选，不生成候选对，不进入 Step 2。
```

---

## 3. 当前 saliency 的真实含义

当前 `saliency` 基本等价于一个简化的离散曲率指标。

计算逻辑：

```text
对每个顶点 v：
  查看 v 的 1-ring 邻接顶点
  比较 v 的 normal 与邻接点 normal 的夹角
  平均夹角越大，saliency 越高
```

因此它更准确地说是：

```text
1-ring normal deflection based curvature proxy
```

即：基于 1-ring 法线偏转的曲率代理值。

它擅长发现：

- 硬边；
- 折角；
- 尖点；
- 局部凹凸；
- 袖口边缘；
- 衣服褶皱；
- 肘部 / 肩部等局部转折。

它不擅长直接发现：

- 大范围 T 字结构；
- 整体姿态；
- 长距离拓扑关系；
- 平滑但语义重要的凸起；
- 低频大结构；
- “这是袖子和躯干的交界”这种语义结构。

---

## 4. 当前流程的核心弱点

当前流程较依赖 `saliency` 和 `FPFH` 的配合。隐含假设是：

```text
高曲率点附近通常也有有意义、可匹配、独特的局部结构。
```

但在当前模型精度和模型风格下，这个假设不一定成立。

典型问题：

1. 有些高 saliency 点只是拓扑噪声、硬法线、UV seam 或无意义折边。
2. 有些真正有意义的结构可能曲率不高。
3. 如果结构没有进入 saliency 候选池，后续 FPFH 再强也无法使用它。
4. FPFH 是 descriptor，只能描述已经被采到的点，不能补救第一步漏掉的点。

典型例子：手臂上的半球凸起。

```text
半球整体是独特结构，
但如果表面平滑、拓扑均匀，
单个顶点的 1-ring normal 变化可能并不突出，
因此 saliency 分数可能不高，
进而被第一阶段漏掉。
```

这说明：

```text
高 saliency ≠ 好匹配点
低 saliency ≠ 没有结构意义
```

当前 `saliency` 是第一道门，存在 recall 风险。

---

## 5. 多尺度 saliency 的注意点

直觉上可以考虑多尺度 saliency，但如果只是扩大半径后继续平均曲率 / normal deflection，会有信号稀释问题。

例如：

```text
小半径：
  能看到局部凸起或折边。

大半径：
  邻域中混入大量平滑背景面。
  少量结构信号被平均掉。
```

所以不建议简单做：

```text
large_saliency = 大半径内平均曲率
```

更合理的多尺度策略是让不同尺度看不同类型的显著性：

### 5.1 小尺度：曲率 / 折边

继续使用 1-ring normal deflection，用于找：

- 硬边；
- 尖角；
- 局部褶皱；
- 袖口边界。

### 5.2 中尺度：normal variance / normal spread

看邻域内法线方向的扩散程度。

直觉：

- 平面：normal 集中，方差低。
- 圆柱：normal 主要沿一个方向变化，中等。
- 半球 / 凸起：normal 向多个方向扩散，方差高。

这比单纯平均曲率更适合发现圆润凸起。

### 5.3 大尺度：protrusion / residual

看区域是否从周围基底表面“鼓出来”。

可考虑：

```text
拟合局部平面 / 局部二次面
计算中心点或 patch 相对基面的高度残差
```

适合发现：

- 平滑半球；
- 低频凸起；
- 装饰件；
- 大尺度形状偏离。

### 5.4 多尺度组合方式

不要简单平均各尺度结果，建议使用：

```text
saliency = max(
  small_scale_edge_score,
  mid_scale_normal_variance,
  large_scale_shape_residual
)
```

或加权组合：

```text
saliency = w1 * small_edge
         + w2 * mid_normal_variance
         + w3 * large_residual
```

---

## 6. 能否用 FPFH 替代 saliency？

可以让 FPFH 参与“找有意义的点”，但不建议直接一比一替代 saliency。

更准确的做法是引入：

```text
FPFH distinctiveness / descriptor uniqueness
```

即：不是问“这个点曲率高不高”，而是问：

```text
这个点的 FPFH 描述子在模型内部是否少见、独特、可区分？
```

一种可行定义：

```text
distinctiveness(point) = 平均距离到同模型内 k 个最近 FPFH 邻居
```

如果某个点的 FPFH 和很多点都相似：

```text
最近邻距离小 → 不独特 → 分数低
```

如果某个点的 FPFH 很少见：

```text
最近邻距离大 → 独特 → 分数高
```

也可以考虑 source-target mutual distinctiveness：

```text
一个点不仅要在自己模型里独特，
还要在对方模型里有明确匹配。
```

例如使用 top1 / top2 距离差：

```text
match clarity = top2_distance - top1_distance
```

如果 top1 很近、top2 明显远，则说明匹配更明确。

---

## 7. 为什么不能只靠 FPFH？

FPFH 也有局限：

1. 对重复平滑结构仍然会混淆，例如手臂圆柱、腿圆柱、平滑布料。
2. FPFH 计算成本高于 saliency。
3. 如果对所有顶点计算 FPFH 并做内部 kNN，性能开销较大。
4. FPFH 仍然是局部描述子，不一定能理解大尺度语义结构。

因此更稳的方向不是：

```text
saliency → FPFH 完全替代
```

而是：

```text
saliency + uniform FPS + FPFH distinctiveness + region-aware sampling
```

---

## 8. 建议的后续改进方向

### 8.1 Target 有 SAM3 region 时，优先 region FPS

当前如果有 `tarRegion`，最符合用户意图的是：

```text
Target region 就是目标区域。
```

因此 Target 端不应过度依赖 saliency。建议：

```text
Target region → FPS
```

而不是：

```text
Target region → saliency filter → FPS
```

这样可以避免 region 内低曲率但重要的结构被筛掉。

### 8.2 Source 端引入混合采样

Source 端也不应只从 high-saliency 点中采样。建议：

```text
Source candidate pool =
  saliency top points
  + whole-source uniform FPS points
  + FPFH-distinctive points
```

第一版可采用比例混合：

```text
50% saliency
30% uniform FPS
20% FPFH distinctive
```

具体比例后续调参。

### 8.3 Candidate pool 改为 combined score

长期方案可以将候选池选择改为综合评分：

```text
combinedScore =
  w1 * curvatureSaliency
+ w2 * fpfhDistinctiveness
+ w3 * regionCoverage
+ w4 * sourceTargetMatchClarity
+ w5 * protrusionScore
```

然后从高分点中再做 FPS，确保空间分布。

### 8.4 新增采样模式

可以在 UI 中新增采样模式：

```text
Sampling Mode:
- Saliency
- Mixed
- FPFH distinctiveness
```

推荐默认：

```text
Mixed
```

因为它对低曲率结构、平滑凸起、模型精度不足等情况更稳。

---

## 9. 当前优先级建议

建议按以下顺序推进：

1. **Target 有 SAM3 region 时，直接从 region 做 FPS**，不要再强制 saliency filter。
2. **Source 端加入 uniform FPS 混合采样**，避免低曲率结构完全漏采。
3. **加入 FPFH distinctiveness 作为额外候选来源**。
4. **考虑多尺度 normal variance / protrusion residual**，用于补足圆润凸起和大尺度结构。
5. **UI 上将“调试快照”改名为“诊断：预览采样点 / Top-K”**，减少和正式 Step 1 的概念重叠。

---

## 10. 一句话总结

当前 partial-match 的核心风险是：

```text
用 1-ring 曲率 saliency 作为第一道门，
可能漏掉低曲率但结构重要的匹配 anchor。
```

后续更稳的方向是：

```text
从纯 saliency-driven 采样，
升级为 saliency + uniform + region-aware + FPFH-distinctiveness 的混合采样。
```
