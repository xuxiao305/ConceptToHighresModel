# Page3 Pose Proxy Jacket Alignment 开发计划

日期：2026-05-03

## 如果有不清楚的地方就询问我，不要自己现编决定
## 另外open pose在另一个仓库里实现了，开发到这里时，我们再讨论是使用subprocess调用，还是将其搬入到内部

## 1. 背景与目标


当前 Page3 外套对齐已经具备以下基础能力：

- Page1 / Page2 资产链路已经能产出全身粗模、部件图、部件精模。
- Page3 已经能加载 Source 精模和 Target 全身粗模。
- SegFormer / SAM3 mask 已经可以反投影到 Target mesh，得到 Target jacket region。
- 当前外套结构模式可以做几何启发式结构检测，但继续深挖 collar、hem、armpit、裙摆等服装细语义锚点的性价比不高。

新的方向是：

用人体关节驱动的 skeleton proxy 做粗对齐，而不是依赖复杂服装细语义。

核心思路：

- Page1 在 MultiView 四合一图上统一跑 OpenPose
- Page2 每条 extraction pipeline 复用 SmartCrop / split 的真实变换，把全局 joints 映射为该部件自己的 joints
- Page3 加载 Source 精模时读取对应 pipeline joints，并用 joints 定义 capsule 区域，在 Source / Target mesh 上做 PCA 得到稳定的骨架 proxy anchors
- 最后用 SVD 粗对齐，再用 Target jacket region 限制下的 ICP 精修。

---

## 2. 总体流程

整体流程分为九个阶段：

1. 定义数据格式与坐标约定。
2. Page1 生成四合一全局关节数据。
3. Page2 复用 SmartCrop / split 变换生成每条 pipeline 的 part joints。
4. Page3 读取 Source pipeline joints 与 Target full-body joints。
5. 将 2D joints 转换为 3D mesh 上的粗 proxy 区域。
6. 建立 pose-level skeleton proxy anchors。
7. 使用 skeleton proxy anchors 做 SVD 粗对齐。
8. 使用 Target jacket region 做 ICP / refine。
9. 增加 debug、overlay 与 trace。

---

## 3. Phase 1：定义数据格式与坐标约定

### 3.1 全局 joints JSON

全局 joints JSON 来自 Page1 MultiView 四合一图。

需要记录：

- Page1 MultiView 四合一图文件名。
- 原始四合一图尺寸。
- 四视角象限布局。
- OpenPose keypoints。
- 每个 keypoint 的 confidence。
- OpenPose / pose 模型版本。
- 关联的 Page1 multiview 版本。

建议结构包含：

- imageFile。
- imageSize。
- layout。
- views.front。
- views.left。
- views.right。
- views.back。
- keypoints。
- confidence。

### 3.2 Pipeline joints JSON

Pipeline joints JSON 是 Page2 每条 extraction pipeline 自己的关节数据。

需要记录：

- pipeline id。
- pipeline name。
- extraction result 文件。
- processed 2x2 图尺寸。
- split 后四视图 bbox。
- 每个 view 的局部 joints。
- 每个 keypoint 的 confidence。
- 对应 modelFile。

Page3 加载某个 Source 精模时，应通过 pipelineKey 找到这份 joints JSON。

### 3.3 Joint 名称映射

第一阶段优先支持以下 keypoints：

- neck。
- left shoulder。
- right shoulder。
- left elbow。
- right elbow。
- left wrist。
- right wrist。
- left hip。
- right hip。
- pelvis / hip center。
- shoulder center。

其中 shoulder center 可以由 left shoulder 和 right shoulder 计算得到。hip center 可以由 left hip 和 right hip 计算得到。

### 3.4 坐标空间

需要明确四个坐标空间：

- global 2x2 image space：Page1 MultiView 四合一图原始坐标。
- processed 2x2 image space：Page2 SmartCrop / Enlarge 后的四合一图坐标。
- split local view space：Page2 splitMultiView 后每个 view 的局部坐标。
- Page3 mesh projection space：Page3 将 3D mesh 投影到 2D 时使用的坐标空间。

---

## 4. Phase 2：Page1 生成四合一全局关节数据

### 4.1 使用 Page1 MultiView 四合一图作为唯一姿态源

姿态检测只在 Page1 MultiView 节点输出的原始四合一图上运行。

明确不使用：

- TPose 单图。
- Page1 已切分的 front / left / right / back 图。
- Page2 extraction 后的部件图重新跑 OpenPose。

原因是 MultiView 四合一图定义了四个视角在同一张图里的固定布局，适合作为全局姿态坐标源。

### 4.2 新增 OpenPose / Pose worker

新增 OpenPose 或其他 pose estimation worker。

建议沿用当前 SegFormer / RMBG 的 Python subprocess bridge 风格：

- 前端发起请求。
- Vite dev bridge 接收。
- Python worker 执行 pose 检测。
- 输出 joints JSON。
- 可选输出 overlay PNG。

### 4.3 四视角拆分

基于现有 MultiView 2x2 布局，将 OpenPose 输出的 keypoints 分配到四个 view：

- front。
- left。
- right。
- back。

当前阶段 front view 是必需数据。side / back view 可以先保存，但只作为后续深度增强和 debug 数据。

### 4.4 保存全局 joints

将全局 joints JSON 保存到工程目录，并关联当前 page1.multiview 版本。

---

## 5. Phase 3：Page2 复用 SmartCrop / split 变换生成 part joints

### 5.1 扩展 SmartCrop transform metadata

Page2 extraction 当前会对四合一图做 SmartCropAndEnlargeAuto，然后再 splitMultiView。

为了让 joints 与 extraction 图完全一致，需要记录 SmartCrop 的真实变换信息：

- 原始 bbox。
- scale。
- paste offset。
- padding。
- preservePosition。
- uniformScale。
- 输出尺寸。
- 每个 view 的 split bbox。

### 5.2 不能对关节图重新做 SmartCrop

不能把关节画成图，再对关节图重新运行 SmartCrop。

原因是 SmartCrop 根据图像内容检测 bbox。服装 extraction 图和关节图的非背景像素完全不同，重新检测会得到不同 bbox，导致坐标偏移。

正确做法是：

Page2 extraction 图算出 crop / scale / paste / split 参数。关节坐标直接复用这些参数。

### 5.3 坐标流转

坐标流转如下：

1. global 2x2 joints。
2. 应用 SmartCrop transform。
3. 得到 processed 2x2 joints。
4. 应用 splitMultiView 的 view bbox。
5. 得到 front / left / right / back 的局部 joints。

### 5.4 每条 pipeline 单独保存 joints

每条 Page2 extraction pipeline 都要保存自己的 pipeline joints JSON。

原因是不同 pipeline 的 extraction 后处理不同，SmartCrop / split 结果不同，因此同一套全局 joints 映射到不同部件图后的坐标也不同。

### 5.5 Overlay 只作为调试产物

可以保存 overlay PNG，用于人工检查：

- processed 2x2 overlay。
- front split overlay。
- side split overlay。

但核心资产应该是 joint JSON 和 transform metadata，而不是关节图图片。

---

## 6. Phase 4：Page3 读取 Source pipeline joints 与 Target full-body joints

### 6.1 通过 pipelineKey 读取 Source joints

Page3 Gallery 已经知道 Source 模型来自哪个 Page2 pipeline。

后续加载 Source 精模时，使用 pipelineKey 查找对应 pipeline joints JSON。

### 6.2 同时读取 Target full-body joints

Target full-body joints 来自 Page1 MultiView 四合一图。

当前阶段 Page3 只消费 front view。left / right / back 数据先保留，用于未来 depth correction。

### 6.3 缺失时 fallback

如果 joints 缺失、confidence 太低，或者 pipelineKey 对不上：

- 不阻塞基本功能。
- 回退到当前几何 / SegFormer 反投影流程。
- 在 UI / trace 中提示缺失原因。

---

## 7. Phase 5：2D joints 到 3D mesh 的粗 proxy 绑定

### 7.1 不直接用最近表面点作为最终 anchor

2D joint 不直接映射成最近 mesh surface vertex。

原因是最近点容易被以下因素影响：

- 袖口变粗。
- 表面凸起。
- 口袋和装饰。
- 精模与粗模厚度差异。
- 顶点密度不均。

因此 joint 只用来定义局部 capsule 区域，最终 anchor 来自 capsule 内顶点的 PCA skeleton proxy。

### 7.2 构造 capsule 区域

对关键肢段构造 capsule：

- left shoulder 到 left wrist。
- right shoulder 到 right wrist。
- left shoulder 到 left elbow。
- left elbow 到 left wrist。
- right shoulder 到 right elbow。
- right elbow 到 right wrist。
- shoulder center / neck 到 hip center。

每个 capsule 是一段有半径的 3D 区域，用来收集附近 mesh 顶点。

### 7.3 Source 侧 restrict vertices

Source 当前假设是单独 jacket 精模。

因此 Source 侧 restrict vertices 可以默认使用全部 Source 顶点。

### 7.4 Target 侧 restrict vertices

Target 是穿着同一 jacket 的全身粗模。

Target 侧必须优先限制在已反投影的 Target jacket region 内。

这样可以避免 capsule 内混入：

- 手部。
- 裤子。
- 身体。
- 头发。
- 其他非 jacket 顶点。

### 7.5 Capsule 内 PCA

对 capsule 内服装顶点做 PCA，得到：

- 中心点。
- 主轴方向。
- 次轴方向。
- 近端。
- 远端。
- 置信度。
- 使用的顶点数量。

这些结果构成后续 skeleton proxy anchors。

---

## 8. Phase 6：建立 pose-level skeleton proxy anchors

### 8.1 袖子 proxy

左右袖 capsule 内顶点 PCA 后，使用：

- 近端中心。
- 远端中心。
- 轴向中心。
- 主轴方向。

不使用最近表面点作为袖口或肩部 anchor。

这样可以对抗袖口粗细、衣服厚度和表面形态变化。

### 8.2 肩线 proxy

使用 left shoulder 到 right shoulder 区域，或双肩附近 jacket 顶点，做 PCA。

得到：

- 肩线中心。
- 肩线方向。
- 肩宽估计。

### 8.3 躯干 proxy

躯干采用两层结构：

第一层是主 torso axis。

主 torso axis 负责大对齐。上端来自 neck 或 shoulder center，下端来自 hip center 或 jacket region 下部中心。

第二层是左右 torso branches。

左右 branches 可以分别计算 PCA，但只作为：

- 左右检查。
- debug 可视化。
- 低权重辅助。
- 主轴不可靠时的兜底。

不建议让左右 branches 替代主 torso axis 作为 SVD 主约束。

### 8.4 Proxy anchor 输出格式

每个 proxy anchor 建议包含：

- kind。
- position3D。
- direction。
- confidence。
- source joint segment。
- capsule radius。
- vertex count。
- projection / debug info。

---

## 9. Phase 7：SVD 粗对齐

### 9.1 使用稳定 pose-level anchors

SVD 使用少量稳定的大结构 anchors，而不是服装细语义 anchors。

建议对应关系包括：

- Source left sleeve near 对 Target left sleeve near。
- Source left sleeve far 对 Target left sleeve far。
- Source right sleeve near 对 Target right sleeve near。
- Source right sleeve far 对 Target right sleeve far。
- Source shoulder center 对 Target shoulder center。
- Source torso center 对 Target torso center。
- Source torso upper / lower 对 Target torso upper / lower。

### 9.2 不使用服装细语义作为主约束

不把以下点作为大对齐主约束：

- collar。
- hem。
- armpit。
- skirt hem。
- pocket。
- lapel。
- hood。

原因是这些细节可能被 Page2 精修 pipeline 改变。

### 9.3 SVD 输出

SVD / similarity fit 输出：

- 平移。
- 旋转。
- 缩放。
- anchor RMSE。
- 每个 anchor pair 的误差。

### 9.4 异常检查

SVD 后需要检查：

- 左右袖是否反了。
- 肩线方向是否一致。
- 袖长比例是否异常。
- torso axis 是否翻转。
- anchor RMSE 是否过大。
- confidence 是否过低。

异常时可以尝试左右翻转，或提示用户回退手动流程。

---

## 10. Phase 8：Region-limited ICP / refine

### 10.1 SVD 只做大体对齐

SVD 负责把 Source jacket 摆到大致正确的位置、尺度和方向。

它不负责解决：

- 袖口粗细。
- 衣服厚度。
- 领口样式。
- 下摆长度。
- 口袋 / 皱褶。
- 局部布料形态差异。

### 10.2 ICP 限制到 Target jacket region

ICP / refine 必须限制在 Target jacket region 内。

这样可以避免 Source jacket 被吸到：

- 裤子。
- 身体。
- 手部。
- 头部。

### 10.3 低置信度处理

ICP 前检查：

- SVD anchor RMSE。
- proxy anchor confidence。
- capsule 顶点数量。
- Target jacket region 覆盖情况。

如果风险较高，应提示用户或回退当前 jacket-structure / 手动模式。

---

## 11. Phase 9：Debug 与可视化

### 11.1 Page1 debug

显示四合一 OpenPose overlay，验证 global joints 是否准确。

### 11.2 Page2 debug

显示：

- processed 2x2 overlay。
- split front overlay。
- split side overlay。

用于检查 SmartCrop / split 后 joints 是否跟 extraction 图一致。

### 11.3 Page3 debug

显示 Source / Target skeleton proxy：

- capsule。
- PCA 主轴。
- 近端。
- 远端。
- 中心点。
- SVD anchor pairs。
- 每个 anchor 的 confidence。

### 11.4 Alignment trace

trace 中记录：

- pipelineKey。
- joint source。
- capsule 参数。
- PCA 顶点数。
- anchor confidence。
- SVD RMSE。
- ICP RMSE。
- fallback 原因。

---

## 12. Relevant files

- src/services/multiviewSplit.ts
  - 复用 VIEW_ORDER、splitMultiView。
  - 需要扩展 SmartCrop / split 的可重放 transform metadata。

- src/pages/Page1/ConceptToRoughModel.tsx
  - Page1 MultiView 四合一图保存与后续全局 OpenPose joints 生成入口。

- src/pages/Page2/PartPipeline.tsx
  - extraction 后处理主链路。
  - 在 SmartCrop / split 后生成每条 pipeline 的 part joints JSON。

- src/services/projectStore.ts
  - 扩展 PersistedPipeline 或新增索引字段。
  - 关联 pipeline id、resultFile、modelFile、joint JSON。

- src/pages/Page3/ModelAssemble.tsx
  - 通过 pipelineKey 读取 Source joints。
  - 接入 pose proxy SVD + region-limited ICP。

- src/three/maskReproject.ts
  - 可复用 mesh 投影 / 反投影思路。
  - 后续新增 joint / capsule projection 工具。

- src/three/jacketStructure.ts
  - 保留现有几何 jacket 结构检测作为 fallback / debug。
  - 不作为下一阶段主路径。

- src/three/graphMatch.ts
  - 可复用结构 anchor pair 到 SVD 的结果组织。
  - 或新增 pose proxy pair 入口。

- scripts 下新增 OpenPose / Pose worker
  - 建议沿用 SegFormer / RMBG subprocess bridge 模式。

---

## 13. Verification

1. Page1 MultiView 四合一图 OpenPose overlay 与原图人体关键点一致。
2. front view joints 可正确分配到左上象限。
3. Page2 同一 pipeline 的 processed 2x2 overlay 与 split front overlay 中，关节点与 extraction 图位置一致。
4. SmartCrop / split 后无系统性 10% 到 20% 偏移。
5. Page3 加载 Gallery Source 模型后，能通过 pipelineKey 读取对应 part joints JSON。
6. 错 pipeline 不应被误读。
7. Source / Target 的 sleeve capsule 内有足够顶点。
8. PCA 主轴方向符合袖子方向。
9. Target 侧 capsule 只在 jacket region 内取点。
10. SVD 后 Source jacket 的肩线、左右袖轴、torso 主轴与 Target jacket region 大体一致。
11. ICP / refine 后表面贴合改善，且不会吸到裤子、身体、手部区域。
12. side / back joints 缺失时不影响 front-only 主流程。
13. confidence 低时有清晰 fallback。
14. npm run build 通过。

---

## 14. Decisions

- 主线不再深挖服装细语义锚点。
- 不把 collar、hem、armpit、裙摆作为大对齐主约束。
- Page1 MultiView 四合一图是唯一 OpenPose 姿态源。
- 不对 TPose 单图或切分图重复跑姿态。
- Page2 关节流转必须复用 extraction 图实际 SmartCrop / split transform。
- 不能对关节图重新检测裁剪。
- 核心资产是 joint JSON 和 transform metadata。
- overlay PNG 只是调试产物。
- 2D joint 不直接落到最近表面点作为最终 anchor。
- joint 用来定义 capsule。
- 最终 anchor 来自 capsule 顶点 PCA 的骨架 proxy。
- 躯干采用主 torso axis 加左右 branch 辅助的两层结构。
- SVD 主用 torso axis，branches 低权重或 debug。
- Source 当前假设为单独 jacket。
- Target 是穿着同一 jacket 的全身粗模，并已通过 SegFormer / SAM3 反投影得到 Target jacket region。

---

## 15. Further considerations

1. Capsule 半径需要自适应模型尺度，建议以肩宽、袖长、bbox diagonal 共同约束，并输出 debug 可视化。
2. OpenPose 对 side / back view 可能不稳定；先实现 front-only，后续再用 side view 修正深度轴。
3. PCA 需要处理异常：顶点数过少、局部块混入 torso / 手部、主轴方向反转、左右 sleeve 互换。
4. SVD 可加入权重：肩线 / 袖轴远近端高权重，torso branch 低权重，低 confidence joint 降权。
5. 未来如果 Source 不再是单独 jacket，需要额外 Source-side segmentation 或人工确认。
