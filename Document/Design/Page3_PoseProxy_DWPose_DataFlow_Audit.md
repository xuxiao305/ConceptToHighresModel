# Page3 Pose Proxy / DWPose 数据流审计

> 目的：把 Page1 → Page2 → Page3 中与 DWPose、MultiView、Joints、Pose Proxy 对齐有关的数据流完整梳理出来，明确“当前代码实际在做什么”和“期望设计应该是什么”。

## 0. 一句话结论

你指出的是对的：**按期望设计，DWPose 的 Source 输入应来自 Page2 MultiView 正视图，Target 输入应来自 Page1 MultiView 正视图，不应该是 Page3 里渲染出来的灰色网格图。**

当前代码的实际情况是：

- Source 侧没有在 Page3 重新对 Page2 正视图跑 DWPose，而是读取 Page2 Pipeline 已持久化的 `jointsMeta.views.front`。
- Target 侧在 Page3 对 `orthoRenderUrl` 跑 DWPose，而 `orthoRenderUrl` 是目标 3D mesh 的灰色正交渲染图。
- 所以这次“目标模型 DWPose 未检测到人体关键点”的报错，本质上暴露的是：**当前 Target DWPose 输入源错位，DWPose 被喂了灰色 mesh render，而不是 Page1 MultiView front image。**

---

## 1. 期望设计流向

按这次讨论确认，Pose Proxy 应该以“真实图像视图”作为 DWPose 输入：

```text
Source 侧：Page2 MultiView / front image
  → DWPose
  → Source 2D joints
  → 映射到 Source 3D mesh / proxy anchors

Target 侧：Page1 MultiView / front image
  → DWPose
  → Target 2D joints
  → 映射到 Target 3D mesh / proxy anchors

Source proxy anchors + Target proxy anchors
  → computePoseAlignment
  → Page3 garment/part alignment
```

这里有一个后续实现必须补齐的关键点：DWPose 给的是 2D 图像关节点，Pose Proxy 最终要在 3D mesh 上找点，所以还需要定义“真实 front image 的 2D 坐标如何映射到对应 3D mesh 投影空间”。当前代码用灰色 mesh render 的 camera 来解决这个映射问题，但这也导致 Target DWPose 输入变成了灰色 mesh 图。

---

## 2. 当前代码实际流向总览

当前 Page3 Pose Proxy 的实际路径是：

```text
Source GLB：Page2 Mesh Gallery 选中的 highres GLB
Source joints：读取 Page2 pipeline.jointsMeta.views.front
Source camera：对 Source GLB 做灰色正交 front render 得到 camera

Target GLB：Page1 rough / demo / 手动加载的 target GLB
Target image：对 Target GLB 做灰色正交 front render 得到 orthoRenderUrl
Target joints：对 orthoRenderUrl 跑 DWPose

Source joints + Source camera + Source mesh
  → buildSkeletonProxy(source)

Target joints + Target camera + Target mesh
  → buildSkeletonProxy(target)

sourceProxy + targetProxy
  → computePoseAlignment
```

也就是说：

- Source 的 DWPose 输入不是 Page2 正视图，而是“之前 Page2 阶段已生成/映射好的 joints”。
- Target 的 DWPose 输入是 Page3 生成的灰色 mesh 图。

---

## 3. Page1 数据流：MultiView 和原始人体 joints 的来源

### 3.1 Page1 生成 MultiView

Page1 负责从概念图/粗模流程中生成并保存 `page1.multiview`：

```text
Page1 MultiView 2x2 图
  → saveAsset('page1.multiview')
  → saveSegments('page1.multiview')
      front / left / back / right
```

相关文件：

- `src/pages/Page1/ConceptToRoughModel.tsx`
- `src/services/projectStore.ts`
- `src/services/multiviewSplit.ts`

### 3.2 Page2 的 Generate Joint Info 实际从 Page1 MultiView 跑 DWPose

Page2 `HighresModel` 里的 `Generate Joint Info` 当前会：

1. 读取最新 `page1.multiview`。
2. 将完整 2x2 MultiView 图转成 base64。
3. 调用 `detectAndConvertToGlobalJoints(...)`。
4. DWPose 在完整 2x2 图上检测人体。
5. `convertToGlobalJoints(...)` 把检测结果分配到 front / left / back / right 四个 view。
6. 对每条 Page2 Pipeline，结合 SmartCrop/Split 元数据生成 pipeline-local joints。

关键代码位置：

- `src/pages/Page2/HighresModel.tsx`：`handleGenerateJoints`
- `src/services/dwpose.ts`：`detectAndConvertToGlobalJoints(...)`
- `src/services/dwpose.ts`：`convertToGlobalJoints(...)`
- `src/services/jointsGeneration.ts`：`generatePipelineJoints(...)`

当前这一段可以理解为：**Page1 MultiView 是全局人体姿态来源；Page2 Pipeline 的 joints 是从 Page1 全局 joints 映射而来。**

---

## 4. Page2 数据流：Source 侧的实际 joints 来源

### 4.1 Page2 Pipeline 图像资产

Page2 的每条 Pipeline 会保存：

```text
page2.extraction：部件/服装提取后的 2x2 图
page2.modify：高清化/重绘后的 2x2 图
page2.highres：由 front 或 multiview 输入生成的 GLB
```

其中 `page2.extraction` 和 `page2.modify` 都会被切成：

```text
front / left / back / right
```

相关代码：

- `src/pages/Page2/PartPipeline.tsx`
- `src/services/multiviewSplit.ts`
- `src/services/projectStore.ts`

### 4.2 Page2 Pipeline jointsMeta

Page2 `Generate Joint Info` 会把 joints 挂到每条 Pipeline 上：

```text
pipeline.jointsMeta.views.front
pipeline.jointsMeta.views.left
pipeline.jointsMeta.views.back
pipeline.jointsMeta.views.right
```

这些 joints 不是在 Page3 现场对 Page2 front 图重新跑 DWPose 得到的，而是：

```text
Page1 MultiView 2x2 DWPose 结果
  → global joints
  → SmartCrop transform
  → Split transform
  → Pipeline-local view joints
  → 存入 pipeline.jointsMeta
```

所以当前 Source 侧的“joints 来源”是合理可复用的缓存，但它不等同于“Page3 对 Page2 front image 重新跑了一次 DWPose”。

---

## 5. Page3 当前 Pose Proxy 数据流

### 5.1 Source 侧当前实际流向

当前 Page3 只有当 Source GLB 来自 Mesh Gallery，并且带有 `pipelineKey` 时，Pose Proxy 才能使用 Source joints：

```text
Page3 Source Mesh Gallery 选择 GLB
  → sourceGalleryBinding.pipelineKey
  → getPipelineJoints(project, pipelineKey)
  → srcJointsMeta.views.front
```

然后为了把 2D joints 投到 Source mesh 上，当前代码又做了一次 Source mesh 灰色正交渲染：

```text
Source mesh vertices/faces
  → renderOrthoFrontViewWithCamera(...)
  → srcCamera

srcJointsMeta.views.front + srcCamera + Source mesh
  → buildSkeletonProxy(source)
```

注意：Source 侧的灰色 render 当前主要用于拿 camera/projection，不是用于 DWPose 检测。

相关文件：

- `src/pages/Page3/ModelAssemble.tsx`
- `src/services/projectStore.ts`
- `src/three/orthoFrontRender.ts`
- `src/three/skeletonProxy.ts`

### 5.2 Target 侧当前实际流向

Target 侧当前是问题核心：

```text
Target mesh vertices/faces
  → renderOrthoFrontViewWithCamera(... meshColor '#dddddd' ...)
  → orthoRenderUrl
  → detectPoses(orthoRenderUrl)
  → cocoPoseToJoint2D(...)
  → target joints
```

也就是 DWPose 的 Target 输入当前不是 Page1 MultiView front 图，而是 Page3 的 Target mesh 灰色正交渲染图。

这解释了报错：

```text
目标模型 DWPose 未检测到人体关键点，无法使用 Pose Proxy
```

DWPose/YOLOX 本来更适合检测真实人像/图像人体，灰色 mesh silhouette 很容易检测不到。

---

## 6. 当前实现和期望设计的偏差

| 项目 | 期望设计 | 当前代码实际行为 | 风险 |
|---|---|---|---|
| Source DWPose 输入 | Page2 MultiView front image | Page3 不重新跑；读取 `pipeline.jointsMeta.views.front` | 如果缓存 joints 和当前 Page2 front 图/GLB 不一致，会错位 |
| Target DWPose 输入 | Page1 MultiView front image | Page3 对灰色 Target mesh render 跑 DWPose | DWPose 检测失败；即使检测到也不是原始真实图姿态 |
| 2D→3D 映射 | 应定义真实 front image 到 mesh 投影的关系 | 当前依赖灰色 mesh render camera | camera 空间和真实图像空间可能不一致 |
| 错误定位 | 应提示缺 Page1/Page2 front 图或 joints 映射失败 | 当前提示“目标模型 DWPose 未检测到人体关键点” | 用户会误以为模型/姿态本身坏了 |

---

## 7. 关于我刚才的 detThr 修改

我前一步把问题理解成“DWPose 必须在灰色 mesh render 上检测，所以应该降低 detThr”。这个判断现在看是不对的。

更准确的说法是：

- `detThr: 0.15` 可能提高灰色 mesh render 被检测到的概率。
- 但这只是让当前错位流程更容易跑通，并没有修正输入源。
- 如果目标设计是使用 Page1/Page2 真实 MultiView front image，那么这个阈值修改不是根因修复。

建议后续处理：

1. 保留失败 trace 可以帮助诊断。
2. 移除“灰色 mesh render 需要低阈值”的设计性注释。
3. 在修正数据流前，不应把降低阈值当作正式方案。

---

## 8. 建议的正确修复方向

### 方案 A：最贴合当前讨论的修复

让 Page3 Pose Proxy 明确使用持久化的真实 front view 图像：

```text
Source：读取对应 Page2 pipeline 的 front segment
Target：读取 Page1 multiview 的 front segment
```

然后：

```text
Source front image → DWPose → Source joints
Target front image → DWPose → Target joints
```

优点：符合直觉和本次确认的设计。

难点：需要解决真实图片坐标到 3D mesh 投影坐标的映射。

### 方案 B：复用 Page2 已生成 joints，但修正 Target

Source 侧继续使用 `pipeline.jointsMeta.views.front`，因为它已经是 Page2 Pipeline-local front joints。

Target 侧改为读取 Page1 MultiView front image，或者直接复用 Page1 global front joints。

```text
Source：pipeline.jointsMeta.views.front
Target：Page1 global joints front 或 Page1 front image DWPose
```

优点：改动较小，避免 Page3 重复跑 Source DWPose。

难点：仍需定义 Target front joints 和 Target mesh 的 2D→3D 映射。

### 方案 C：把灰色 mesh render 只保留为“投影参考”，不再作为 DWPose 输入

这可能是最稳的工程结构：

```text
真实 front image
  → DWPose 得到 joints

mesh grey ortho render
  → 只提供 camera / projection / silhouette correspondence

joints + camera + mesh
  → skeleton proxy
```

换句话说，灰色 render 可以继续存在，但它的角色应从“DWPose 输入图”降级为“2D→3D 投影辅助”。

---

## 9. 下一步需要确认的问题

1. Source 侧是否必须在 Page3 对 Page2 front image 重新跑 DWPose？
   - 如果不是，是否接受继续复用 `pipeline.jointsMeta.views.front`？

2. Target 侧是：
   - 对 Page1 front image 重新跑 DWPose，还是
   - 复用 Page1 `globalJoints.views.front`？

3. Page3 里的 Target GLB 一定对应 Page1 rough model 吗？
   - 如果用户手动加载任意 Target GLB，则 Page1 front joints 和这个 GLB 可能不匹配。

4. 真实 front image 的坐标和 mesh render camera 的坐标如何对齐？
   - 是否用同尺寸 render？
   - 是否用 bbox / mask / subject bounds 做归一化？
   - 是否沿用 Page2 SmartCrop/Split metadata？

5. 如果 Source/Target 缺少 front image 或 jointsMeta，UI 应该报什么错？
   - 当前报错偏向“DWPose 没检测到”，但真实问题可能是“数据源未绑定”。

---

## 10. 推荐短期改动清单

短期先做三步，不急着大改：

1. 在 Page3 Pose Proxy 诊断日志里打印实际输入来源：
   - Source joints 来源：`pipeline.jointsMeta.views.front` / Page2 front DWPose
   - Target DWPose 输入：Page1 front / grey render

2. 移除或隔离当前 `detThr: 0.15` 作为正式修复的含义。

3. 补一个数据源选择层：
   - `resolveSourcePoseInput(...)`
   - `resolveTargetPoseInput(...)`
   - 明确返回：imageUrl/base64、joints、coordinateSpace、sourceDescription。

这样后续再改 Pose Proxy 主逻辑时，不会继续把“真实图像姿态”和“mesh 投影辅助图”混在一起。
