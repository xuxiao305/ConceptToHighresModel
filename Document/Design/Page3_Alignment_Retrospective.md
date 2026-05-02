# 功能开发复盘：Page3 SAM3 引导的部件自动对齐

## 1. 一句话总结

这次 Page3 对齐功能的核心，是把“用户在 2D 正视图里确认的 SAM3 分割区域”转换成 3D 目标模型上的可靠顶点区域，再用 partial-match 自动找候选 landmark 点对，用 SVD 给出粗对齐，最后用限制在目标区域内的 ICP 做表面精修，把高清部件自动贴到目标角色对应部位上。

最新调试结论是：三大步拆开执行后，`Step 1 RANSAC → Step 2 SVD → Step 3 region-restricted ICP` 的链路非常有效。此前自动流程效果差，不是因为 ICP 没跑，而是因为自动流程用 sparse landmark RMSE 当裁判，把已经明显改善表面贴合的 ICP 结果错误地否决，回退到了 SVD。

最终完整 sweep 里表现最好的配置是：

| 排名 | 配置 | RMSE | scale | 匹配点数 |
|---:|---|---:|---:|---:|
| 1 | 显著点+src25+topK8 | 0.886 | 0.548 | 25 |
| 2 | 显著点+seedW2+topK8 | 1.067 | 0.554 | 20 |
| 3 | 显著点+topK8 | 1.107 | 0.547 | 20 |

相比原始默认 `RMSE=2.385`，第一名误差降到了约 37%，视觉效果也明显更稳。

后续手动三步和自动流程复查发现：如果在 SVD 后继续执行限制在 SAM3 目标区域内的 ICP，表面贴合会进一步显著改善。一次成功基线中，Step 1 得到 `25/25` 个 RANSAC 内点，SVD landmark RMSE 约 `1.256`，ICP surface RMSE 下降到约 `0.070`，视觉上几乎完全贴合。

---

## 2. 功能目标与最终效果

### 功能目标

Page3 的目标是：把一个单独生成的高清部件模型，比如手臂、外套、护甲等，自动对齐到完整角色模型的对应区域。

这个过程不是简单地把两个完整模型对齐，而是“局部对整体”的匹配：

- Source：一个单独部件，高精度手臂模型。
- Target：完整角色模型。
- 用户通过 SAM3 mask 指定 Target 上的大致目标区域。
- 系统自动在这个区域里找几何对应关系。
- 最后输出一个 source → target 的变换矩阵。

### 最终效果

目前已经做到：

- 能使用 SAM3 分割 mask 反投影到 3D 顶点。
- 能覆盖前后表面，不再只拿正面顶点。
- 能通过显著点过滤减少错误候选。
- 能把加载分割包后的 Target 正视图渲染、mask 反投影和 Target 区域定位自动串起来。
- 能将对齐调试拆成三大步：`Step 1 RANSAC 生成候选对`、`Step 2 Landmark SVD`、`Step 3 ICP refine`。
- 能在自动对齐里正确采用有效的 ICP surface-fit 结果，而不是被 sparse landmark RMSE 误导回 SVD。
- 能自动跑参数 sweep，并渲染正视图 + 侧视图对比。
- Page3 生产默认参数已经同步到当前较优组合，并把 ICP 作为最终精修关键步骤。

主要相关文件：

- `src/pages/Page3/ModelAssemble.tsx`
- `src/three/maskReproject.ts`
- `src/three/partialMatch.ts`
- `test_align_e2e.html`

---

## 3. 开发过程中使用的技术栈

### 3.1 React + TypeScript + Vite

负责内容：

- Page3 UI。
- 参数面板。
- SAM3 重投影按钮。
- 自动对齐入口。
- E2E 测试页面。

直白理解：React 负责界面，TypeScript 负责把数据结构和函数接口管严一点，Vite 负责快速运行网页测试。

在本功能中的作用：

- Page3 真正的生产逻辑在 `src/pages/Page3/ModelAssemble.tsx`。
- 浏览器 E2E 测试在 `test_align_e2e.html`，直接调用生产 TypeScript 模块，避免测试脚本和真实 UI 逻辑脱节。

如果不用它：容易出现“测试脚本跑出来不错，但真实页面不一样”的问题。之前确实遇到过这个问题，所以后来改成浏览器端真实 WebGL + 生产模块测试。

### 3.2 Three.js + GLB 加载

负责内容：

- 读取 GLB。
- 提取顶点和三角面。
- 渲染目标模型正视图。
- 渲染最终对齐预览。

直白理解：Three.js 是这个功能里的“3D 眼睛”和“模型读取器”。它既能把模型显示出来，也能把模型顶点拿出来做数学计算。

在本功能中的作用：

- GLB 加载和顶点抽取在 `src/three/glbLoader.ts`。
- 正交正视图渲染在 `src/three/orthoFrontRender.ts`。
- E2E 页面最后用 Three.js 渲染正视图和侧视图，方便肉眼判断对齐是否合理。

### 3.3 WebGL 正视图渲染 + silhouette refit

负责内容：

- 把 3D 目标模型渲染成和 SAM3 参考图相同尺寸的正视图。
- 计算一个能把 2D mask 坐标映射回 3D 世界坐标的相机参数。

直白理解：可以把它理解成“先给 3D 模型拍一张标准证件照”。SAM3 mask 是画在参考图上的，3D 模型也必须用同样的相机逻辑拍成 2D，两个坐标系才能对得上。

关键约定：

- 角色正面：世界 +X。
- 相机站在 +X 看向 -X。
- 头顶方向：世界 +Y。
- 图像横向大致对应世界 Z 方向。

这部分避免了 Blender / glTF / Three.js 坐标系混乱导致的错判。

### 3.4 SAM3 mask 反投影

负责内容：把 2D 分割 mask 中的 RightArm / Body / LeftArm 像素，映射到 Target mesh 的顶点集合上。

实现位置：`src/three/maskReproject.ts`

直白理解：2D mask 是一张“彩色贴纸”，反投影就是把贴纸上的颜色重新贴回 3D 模型顶点上。

本次关键改动：

1. 增加 `maskDilatePx`：mask 向外扩一点，补偿图像边缘和模型轮廓之间的小误差。
2. 增加 `projectionMode`：
   - `front`：只取每个像素最前面的顶点。
   - `through`：穿透模型，把落在 mask 区域里的前后顶点都纳入。

最终使用：

- Page3：`projectionMode='through'`, `splatRadiusPx=1`, `maskDilatePx=2`
- E2E：`projectionMode='through'`, `splatRadiusPx=2`, `maskDilatePx=2`

### 3.5 局部匹配：partial-to-whole matching

负责内容：

- Source 是单独手臂。
- Target 是完整角色。
- 系统需要在 Target 的 SAM3 区域里找到与 Source 对应的一组 landmark。

实现位置：`src/three/partialMatch.ts`

直白理解：它像是在完整角色身上找“这条手臂应该贴在哪里”。不是全身对全身，而是一个部件去完整模型里找最像自己的区域。

主要步骤：

1. 在 Source / Target 上通过 saliency + FPS 选采样点。
2. 为每个采样点计算几何描述子，当前默认使用 FPFH。
3. 每个 Source 点保留 top-K 个可能 Target 点。
4. 用 RANSAC 不断随机抽 3 对候选点，估一个临时 similarity transform。
5. 检查其他候选点在这个 transform 下是否也能对上。
6. 保留内点最多的一轮。
7. 输出这批 RANSAC inlier pairs，作为 Step 2 的自动候选 landmark 点对。

### 3.6 显著点筛选

负责内容：从大量 target 候选顶点中挑更有辨识度的点。

直白理解：如果把目标区域里所有点都拿来匹配，就像在一堆“平滑圆柱面点”里找特征，很容易混。显著点筛选就是优先挑边缘、转折、曲率变化大的点，因为这些点更像“指纹”。

本次关键改动：

- 增加 `tarConstraintUseSaliency`。
- 当 SAM3 区域很大时，不直接对整个区域 FPS 采样，而是先在区域内挑显著点，再采样。

效果非常明显。完整 sweep 第一名就是使用该策略的：

- `显著点+src25+topK8`
- `RMSE=0.886`
- `scale=0.548`
- `pairs=25`

### 3.7 SVD 粗对齐 + ICP 精修

负责内容：

- SVD：根据 landmark 点对计算 source 到 target 的变换。
- ICP：尝试进一步细化几何对齐。

相关文件：

- `src/three/alignment.ts`
- `src/three/icpRefine.ts`

直白理解：

- SVD 像“用几颗钉子把部件钉到目标位置”。
- ICP 像“钉好之后，再让表面互相贴近一点”。

本次重要结论：

- SVD 优化的是 Step 1 输出的 sparse landmark pairs，所以 sparse landmark RMSE 天然更偏向 SVD。
- ICP 优化的是 source 表面到 target region 表面的 dense surface fit，所以不能只用 sparse landmark RMSE 否决 ICP。
- 对局部部件贴整身模型，ICP 必须限制在 SAM3 目标区域内，否则可能被全身其他最近表面吸走。
- 自动流程应优先采用有效的 region-restricted ICP 结果，判断依据应看 surface RMSE、pairsKept、target region 是否有效，而不是只看 landmark RMSE。

---

## 4. 关键技术要点白话讲解

### 4.1 为什么一开始绿色区域看起来像碎片？

问题现象：Page3 里绿色/高亮区域看起来像顶点错乱、碎片飞散。

初步猜测：

- 可能是顶点 index 错。
- 可能是 GLB primitive offset 错。
- 可能是 Blender → glTF 坐标转换错。

验证后结论：

- 顶点 index 合法。
- GLB 只有一个 mesh / primitive，不存在 offset 错。
- Three.js 和离线顶点坐标一致。
- 真正问题更多是可视化方式和旧反投影逻辑造成的误导。

经验：看到 3D 点云“碎”，不能第一时间认定顶点错。要先查 index、mesh primitive、坐标系、相机和渲染方式。

### 4.2 为什么要做 through projection？

原始逻辑：每个 mask 像素只取最前面的 vertex，也就是 `front` 模式。

问题：手臂是有体积的，mask 画的是整个轮廓，但 `front` 模式只拿到正面皮肤，背面顶点全丢了。这样 target 区域太薄，匹配时会缺少完整 3D 信息。

改法：使用 `through` 模式，只要一个顶点投影到 mask 区域内，就归入该 region，不再做前后深度剔除。

结果：

- RightArm 顶点数从约一万级提升到七八万级。
- 区域覆盖更完整。
- 肉眼看反投影更接近真实手臂体积。

副作用：

- target 候选区域变大。
- 匹配难度上升。
- 必须再用显著点筛选降低噪声。

### 4.3 为什么 through projection 后还需要显著点？

through projection 解决的是“覆盖不够”的问题，但它也带来了新问题：覆盖太多以后，候选点里有大量平滑表面点、背面点和几何相似点。

直白理解：原来是“找人时只看到了半张脸”；through 后变成“整个人都看到了，但人群也变多了”；显著点筛选就是优先找眼睛、鼻梁、衣服边缘这些更有辨识度的位置。

所以最后稳定组合是：

- `through` 保证区域完整。
- `maskDilatePx=2` 修补边缘。
- `tarConstraintUseSaliency=true` 控制候选质量。
- `src25 + topK8` 提高匹配稳定性。

### 4.4 三大步到底分别做什么？

后续调试中，把自动对齐拆成三大步后，问题边界变得非常清楚。

Step 1 是“自动找可靠点对”。它内部包含：

1. saliency + FPS 出采样点。saliency 负责优先找局部曲率或法线变化明显的点；FPS 负责让这些点撒得更均匀。
2. FPFH 给每个采样点计算局部结构描述，可以理解为“局部几何指纹”。
3. 每个 Source 采样点在 Target 采样点里找 top-K 个最像的候选。
4. RANSAC 反复随机抽 3 对候选点，估一个临时 transform。
5. 检查其他候选点在这个 transform 下是否也能对上。
6. 最后保留内点最多的一轮，并把这些内点输出成候选 landmark pairs。

Step 2 是“用点对求粗对齐”。它不再做 saliency、FPS、FPFH、Top-K 或 RANSAC，只拿 Step 1 输出的候选点对做 Similarity SVD，得到一个 source → target 的初始矩阵。

Step 3 是“表面精修”。它从 Step 2 的矩阵出发，用 ICP 在目标区域内找最近邻，让 source 表面进一步贴到 target region 表面。

这次手动三步验证非常关键：Step 1 找到 `25/25` 个 RANSAC 内点，Step 2 已经给出不错的粗对齐，Step 3 的 ICP 又把 surface RMSE 从约 `0.273` 持续降到约 `0.070`，视觉上几乎完全贴合。

### 4.5 为什么不能用 sparse landmark RMSE 否决 ICP？

自动流程一开始有个隐藏问题：它在 SVD 和 ICP 之间二选一时，用的是 Step 1 那批 sparse landmark pairs 的 RMSE。

这听起来公平，其实不公平。原因是：

- SVD 本来就是为了让这批 sparse landmark pairs 尽量靠近而计算出来的。
- ICP 的目标不是继续照顾这 25 个 sparse 点，而是让整个 source 表面贴合 target region 表面。

所以 SVD 在 sparse landmark RMSE 上天然占便宜。ICP 可能让这 25 个点稍微离远一点，但让整体表面贴得更准。

一次自动对齐日志正好暴露了这个问题：ICP 的 surface RMSE 已经很好，约 `0.093`，但 sparse landmark RMSE 比 SVD 大，于是旧逻辑把最终方法选回了 SVD。视觉上就像“ICP 没发挥作用”。

修正后的原则是：

- SVD 用 sparse landmark RMSE 判断是否粗对齐合理。
- ICP 用 surface RMSE、pairsKept、是否限制在正确 target region 来判断是否有效。
- 不能用 SVD 最擅长的 sparse landmark RMSE 当唯一裁判来否决 ICP。

---

## 5. 调试过程与参数说明

| 参数 | 出现位置 | 直白含义 | 调大/调小的效果 | 本次结论 |
|---|---|---|---|---|
| `projectionMode` | `maskReproject.ts` | mask 投影到 3D 顶点的方式 | `front` 只取正面；`through` 覆盖前后全部 | 最终选 `through` |
| `maskDilatePx` | `maskReproject.ts` | mask 边缘外扩像素 | 调大能补边缘，但太大会串到邻近区域 | 最终选 2 |
| `splatRadiusPx` | `maskReproject.ts` | 顶点查找附近像素的半径 | 调大可容错，但可能误分配 | Page3 用 1，E2E 用 2 |
| `numSrcSamples` | `partialMatch.ts` | Source 上采多少个点 | 更多点更稳但更慢，也可能引入噪声 | 最佳为 25 |
| `numTarSamples` | `partialMatch.ts` | Target 上采多少个点 | 更多点覆盖更密但耗时变高 | 当前 80 足够，100/120 未明显更好 |
| `topK` | `partialMatch.ts` | 每个 source 点保留几个候选 target 点 | 调大增加容错，但也增加错误组合 | 8 最稳，10 在某些轮次不稳定 |
| `tarConstraintUseSaliency` | `partialMatch.ts` | 是否只在 SAM3 区域内取显著点 | 开启后减少平滑面干扰 | 必须开启 |
| `tarSeedWeight` | `partialMatch.ts` | 目标 seed 的吸引权重 | 调大更贴近 seed，但可能过拟合 | 默认 5；测试中 2/10 都可作为对照 |
| `axialWeight` | `partialMatch.ts` | 轴向/径向特征权重 | 用来打破手臂这种圆柱体的方向歧义 | 默认 5，单独降到 3 效果不好 |
| `iterations` | `partialMatch.ts` | RANSAC 尝试次数 | 更多更可能找到好组合，但更慢 | 600 已够；1200 没明显收益 |
| `inlierThreshold` | `partialMatch.ts` | 判断匹配点是否一致的距离阈值 | 太小容易失败，太大容易接受错误点 | 5% 比 8% 更稳 |
| `icpMaxIterations` | `icpRefine.ts` / Page3 | ICP 最大迭代次数 | 更多轮能继续贴合，但耗时略增 | 当前 30 轮有效，成功案例跑满 30 轮仍在改善 |
| `icpSampleCount` | `icpRefine.ts` / Page3 | ICP 每轮采样的 Source 点数 | 更多点更稳但更慢 | 当前 400 点足够，成功案例 kept 约 360–388 |
| `icpRejectMultiplier` | `icpRefine.ts` / Page3 | ICP 离群点拒绝强度 | 越小越严格，越大越宽松 | 当前 2.5 稳定 |
| `icpConvergenceImprovement` | `icpRefine.ts` / Page3 | ICP 收敛阈值 | 越小越不容易提前停 | 当前 0.005，成功案例因持续改善跑到 max-iterations |
| `tarRestrictVertices` | `icpRefine.ts` | ICP 最近邻搜索限制区域 | 开启后只吸附到 SAM3 目标区域，避免跑到身体其他部位 | 对局部部件必须传入 target region |

---

## 6. 主要问题与解决思路

### 阶段 1：排查“顶点错乱”

问题现象：绿色区域看起来碎片化。

验证方式：

- 检查 GLB 顶点数量和 index。
- 检查 primitive 数量。
- 检查 Three.js 与原始顶点空间。
- 对照 Blender/glTF 坐标约定。

结论：不是顶点错乱，而是旧可视化和反投影逻辑造成误判。

### 阶段 2：重建可信 E2E 测试

问题现象：离线测试结果和用户真实 UI 流程不一致。

解决方式：删除旧测试，建立 `test_align_e2e.html`，直接在浏览器里跑真实生产模块：

- GLB 加载。
- WebGL 正视图渲染。
- SAM3 mask 反投影。
- 部分匹配。
- SVD / ICP 对比。
- 3D 结果渲染。

结论：测试必须贴近生产链路，否则很容易优化错方向。

### 阶段 3：修复 mask 只投影正面的问题

问题现象：SAM3 区域看似正确，但实际只拿到了前表面顶点。

解决方式：

- 增加 `projectionMode='through'`
- 增加 `maskDilatePx=2`

结果：RightArm 区域覆盖完整很多，视觉上更接近真实手臂体积。

### 阶段 4：through 后匹配变难

问题现象：区域完整了，但 target 候选太大，RMSE 一度变差。

解决方式：

- 增加 `tarConstraintUseSaliency`
- 只在 SAM3 区域内挑高显著性点
- 避免 raw FPS 过度采到平滑面和背面噪声

结果：完整 sweep 第一名降到 `RMSE=0.886`。

### 阶段 5：调试体验优化

问题现象：

- 完整 24 组 sweep 太慢。
- 页面运行时主线程被占用，看起来像卡住。
- 一开始没有图片，用户不知道是否正常。
- 只看正视图不够确认深度方向。

解决方式：

- 默认 FAST 4 组。
- 完整测试通过 `mode=full` 手动启用。
- 每跑完 4 组渲染临时前 4 名。
- 增加侧视图渲染。

最终效果：用户可以边跑边看，不用等 24 组全部结束。

### 阶段 6：把对齐拆成三大步调试

问题现象：自动对齐效果不稳定时，很难判断是 partial-match、SVD 还是 ICP 哪一步出了问题。

解决方式：把高级面板整理成更明确的三步：

- `Step 1 · RANSAC 生成候选对`
- `Step 2 · Landmark SVD 对齐`
- `Step 3 · ICP refine`

同时把原来的“调试快照”改成“诊断：预览采样点 / Top-K”，明确它只看 saliency / FPS / Top-K，不进入 Step 2。

结果：用户可以先看采样是否合理，再看 RANSAC 内点，再看 SVD 粗对齐，最后看 ICP 精修。一次成功日志中，Step 1 得到 `25` 对候选且 `bestInlierCount=25`，说明 RANSAC 找到了一组非常稳定的对应关系。

### 阶段 7：修正自动流程错误选择 SVD 的问题

问题现象：手动三步里 ICP 后几乎完全贴合，但自动对齐看起来像只做了 SVD。

验证方式：对比自动日志，发现自动流程里 ICP 实际已经跑出很好结果：surface RMSE 约 `0.093`，但最终 `finalMethod` 仍然是 `SVD`。

根因：自动流程用 sparse landmark RMSE 比较 SVD 和 ICP。SVD 在这组 landmark RMSE 上天然占优，而 ICP 优化的是 surface fit，因此被错误否决。

解决方式：

- 自动 ICP 与手动 Step 3 一样传入 `tarRestrictVertices`，只在 SAM3 目标区域内找最近邻。
- 自动流程不再用 sparse landmark RMSE 否决 ICP。
- 只要 ICP 的 surface RMSE 有效、迭代保留点数足够，就采用 ICP 结果。

结果：自动对齐能正确使用 ICP matrix，视觉效果与手动三步接近，最终贴合明显改善。

---

## 7. 当前推荐默认配置

Page3 当前推荐默认：

| 项 | 值 |
|---|---:|
| `projectionMode` | `through` |
| `maskDilatePx` | 2 |
| `splatRadiusPx` | 1 |
| `numSrcSamples` | 25 |
| `numTarSamples` | 80 |
| `topK` | 8 |
| `iterations` | 600 |
| `inlierThreshold` | 0.05 |
| `tarSeedWeight` | 5 |
| `tarConstraintUseSaliency` | true |
| `axialWeight` | 5 |
| `icpMaxIterations` | 30 |
| `icpSampleCount` | 400 |
| `icpRejectMultiplier` | 2.5 |
| `icpConvergenceImprovement` | 0.005 |
| ICP target restriction | 使用 SAM3 target region |

这组配置的取舍是：

- 不追求最多点数，而是追求“点够用且稳定”。
- 不盲目加大 target 采样，因为 through 区域太大时，更多 target 点不一定更好。
- 用显著点控制候选质量，比单纯加采样数量更有效。
- SVD 只负责粗对齐，最终贴合质量主要依赖 region-restricted ICP。
- 自动流程必须优先采用有效 ICP surface-fit 结果，不能只用 sparse landmark RMSE 做二选一。

---

## 8. 经验教训

1. **先确认坐标和数据，再谈算法。** 3D 问题很容易被误判成“顶点错乱”，但这次真正问题在投影和可视化链路。
2. **测试必须复刻真实 UI 流程。** 旧离线测试漏掉了 WebGL silhouette refit 和三图对照逻辑，导致结论偏离真实使用效果。
3. **覆盖完整不等于匹配更好。** through projection 让区域更完整，但也引入更多候选噪声。必须再加显著点筛选。
4. **不同阶段的 RMSE 不能混用。** sparse landmark RMSE 适合看 SVD 的点对拟合；ICP surface RMSE 才适合看表面贴合。用 sparse landmark RMSE 否决 ICP 会把好结果误杀。
5. **ICP 不是可有可无的验证步骤。** 在局部部件对齐里，SVD 给出初始姿态，ICP 才是最终贴合的关键。
6. **局部 ICP 必须有目标区域限制。** 对 partial-to-whole 场景，如果 ICP 在全身 Target 上找最近邻，很容易被无关身体表面吸走。
7. **慢测试要有阶段反馈。** 24 组 sweep 每组几十秒，如果没有中间预览，用户会以为页面卡死。

---

## 9. 后续建议

1. **保留当前三步主线，不要再频繁改核心链路。** 当前 `Step 1 RANSAC → Step 2 SVD → Step 3 region-restricted ICP` 已经成为稳定基线。
2. **把这次成功日志作为 golden baseline。** 关键指标包括 `RANSAC inliers=25/25`、`SVD RMSE≈1.256`、`ICP surface RMSE≈0.070`、`tarRestrictVertices≈75863`。
3. **下一步可以做多部件验证。** 目前主要验证 RightArm，后面应该用外套、左臂、腿部等不同形态测试泛化性。
4. **探索减面 proxy 对齐。** 可以先离线减面，把低面数代理模型用于 Step 1/2/3，得到 transform 后再应用回原始高精模型。若效果更稳，再考虑内置减面流程。
5. **减少 WebGL context 警告。** 完整 sweep 多次刷新预览时会出现 “Too many active WebGL contexts”。后续可以在重绘前主动 dispose 旧 renderer。
6. **把 E2E 结果导出成 JSON。** 目前结果主要在页面 log 中。后续可以加一个“导出 sweep 结果”按钮，方便记录不同版本表现。
7. **长期方向：多视角 mask。** 当前是单正视图 through projection。后续如果有侧视/背视 mask，可以进一步减少误投影，提高复杂部件匹配质量。
