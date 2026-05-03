# Page3 三种对齐模式数据流审计 — 事实文档

> 审计原则：只做事实获取和整理，不做判断。每个结论均来自代码检索。

---

## 一、模式概览

| 属性 | Surface RANSAC | Limb Structure | Pose Proxy |
|------|---------------|----------------|------------|
| PartialMatchMode 值 | `'surface'` | `'limb-structure'` | `'pose-proxy'` |
| 算法文件 | `partialMatch.ts` | `limbStructureMatch.ts` | `skeletonProxy.ts` + `poseAlignment.ts` |
| 核心思路 | FPFH特征+轴方向RANSAC | PCA轴+3锚点(root/bend/end) | DWPose关节→骨骼胶囊代理→加权SVD |
| 手动Step1 | ✅ 支持 | ✅ 支持 | ❌ 不支持（按钮disabled+代码拦截） |
| 一键自动 | ✅ 支持 | ✅ 支持 | ✅ 支持（需额外前置条件） |
| 源端输入 | srcMesh顶点+邻接 | srcMesh顶点 | srcMesh顶点 + Page2缓存关节 |
| 目标端输入 | tarMesh顶点+邻接+约束区域 | tarMesh顶点+约束区域+躯干区域 | tarMesh顶点+约束区域 + Page1前视DWPose |

---

## 二、共享前置：2D定位管道

所有三种模式在一键自动对齐时共享同一定位管道，用于将SAM3分割mask映射到3D顶点集合。

### 2.1 定位管道步骤

```
参考图(refImage) → computeLocalizationSpace → localizationSpace{w,h}
                                                      ↓
tarMesh → renderOrthoFrontViewWithCamera(tarMesh, {width:localizationSpace.w, height:localizationSpace.h})
          → orthoRenderUrl(dataUrl) + orthoCamera(OrthoFrontCamera)
                                                      ↓
maskImage → loadMaskGray(maskImageUrl, {resizeTo:{width:cam.width, height:cam.height}})
          → GrayImage
                                                      ↓
tarMesh.vertices + GrayImage + segPack.regions + orthoCamera
    → reprojectMaskToVertices(...)
    → MaskReprojectionResult { regions: Map<string, Set<number>>, ... }
                                                      ↓
targetRegionLabel → regions.get(label) → Set<number>
    → buildTarRegionFromSet(vertexSet) → MeshRegion
```

### 2.2 关键常量

| 常量 | 值 | 位置 |
|------|---|------|
| `LOCALIZATION_LONG_EDGE` | 1024 | ModelAssemble.tsx:485 |
| `ALIGNMENT_MODE` | `'similarity'` | 全文件硬编码 |

### 2.3 OrthoFrontCamera 约定

- Camera 在 +X 方向，朝 -X 看
- up = +Y, image-right = world -Z
- 字段: `{width, height, camY, camZ, worldPerPx, meshFrontX}`
- 提供确定性像素→世界坐标映射

### 2.4 maskReproject 参数

- `projectionMode: 'through'` — 分配mask像素下所有顶点
- `splatRadiusPx: 1`
- `maskDilatePx: 2`

---

## 三、Surface RANSAC 模式

### 3.1 数据流详图

```
输入:
  srcMesh.vertices + srcMesh.adjacency (srcAdjacency)
  tarMesh.vertices + tarMesh.adjacency (tarAdjacency)
  workingTarRegion.vertices (tarConstraintVertices)
  参数: numSrcSamples=25, numTarSamples=80, topK=8, iterations=600,
        descriptor='fpfh', axialWeight=5, seed=random

Step 1: 显著性计算
  computeVertexSaliency(src) → srcSaliency[]
  computeVertexSaliency(tar) → tarSaliency[]

Step 2: 采样
  pickPartialSamplePool(src, srcSaliency, mode='robust')
    → macroSaliency采样 → srcSamplePool
  farthestPointSample(tar, 80, constraintVertices=tarConstraintVertices)
    → tarSamples[] (约束到目标区域内)

Step 3: FPFH描述子
  computeMultiScaleFPFH(src, srcSamplePool, ...)
    → srcDescriptors[] (缓存供8次轴旋转复用)
  computeMultiScaleFPFH(tar, tarSamples, ...)
    → tarDescriptors[]

Step 4: 轴方向
  computeAxialFrame(srcMesh.vertices) → src主轴方向

Step 5: 8次轴旋转RANSAC
  for each axial trial (45°间隔 × 2翻转 × 2轴 = 8次):
    旋转tar描述子
    Top-K匹配: src↔tar 按FPFH距离排序 → topK候选对
    RANSAC验证: 随机采样点对→刚体变换→内点计数
  选最优: 最大内点数的轴方向 + 最优刚体变换

Step 6: Refit
  用全部内点重拟合刚体变换 → matrix4x4

输出:
  PartialMatchResult {
    pairs: LandmarkCandidate[]      // 匹配的顶点对
    matrix4x4: number[][]           // 初始刚体变换
    rmse: number
    thresholdUsed: number
    iterationsRun: number
    rawSrcSamples: number
    rawTarSamples: number
    bestInlierCount: number
    timings: PartialMatchTimingReport
  }
```

### 3.2 handleFindPartial (手动Step1) 的Surface路径

```typescript
pm = matchPartialToWhole(
  { vertices: srcMesh.vertices, adjacency: srcAdjacency },
  { vertices: tarMesh.vertices, adjacency: tarAdjacency },
  {
    numSrcSamples, numTarSamples, topK, iterations,
    inlierThreshold, descriptor, samplePoolMode,
    radiusFractions, macroSaliencyRings,
    tarSeedCentroid: tarRegion?.centroid,
    tarSeedRadius: tarRegion?.boundingRadius,
    tarSeedWeight: tarRegion ? partialSeedWeight : 0,
    tarConstraintVertices: tarRegion?.vertices,
    tarConstraintUseSaliency: Boolean(tarRegion?.vertices?.size),
    axialWeight, seed,
  },
);
```

注意：手动Step1使用 `tarRegion`（可能为null），一键自动使用 `workingTarRegion`（保证非null）。

### 3.3 handleAutoAlign 的Surface路径

与手动Step1相同的算法调用，但：
- 使用 `workingTarRegion` 代替 `tarRegion`
- `tarSeedWeight` 在 `workingTarRegion` 存在时 = `partialSeedWeight`，否则 = 0
- 后续自动执行 SVD + ICP

---

## 四、Limb Structure 模式

### 4.1 数据流详图

```
输入:
  srcMesh.vertices
  tarMesh.vertices
  workingTarRegion.vertices (tarConstraintVertices)
  workingMaskReproj.regions → findMaskRegion(['body','torso']) → tarBodyVertices
  参数: mode='similarity', endpointFraction=0.08, axialBins=13

Step 1: PCA主轴
  computeAxialFrame(srcMesh.vertices) → src主轴
  computeAxialFrame(tarConstraintVertices) → tar主轴

Step 2: 四肢结构检测
  detectRawLimbStructure(src, srcAxialFrame, {endpointFraction, axialBins})
    → 沿PCA轴分13bin → 找lower/upper端点 + 弯折点
    → srcRawAnchors {root, bend, end}
  detectRawLimbStructure(tar, tarAxialFrame, ...)
    → tarRawAnchors {root, bend, end}

Step 3: 锚点语义定向
  orientAnchors(srcRawAnchors, srcAxialFrame)
    → src无body参考，保持检测顺序
  orientAnchors(tarRawAnchors, tarAxialFrame, tarBodyVertices)
    → 计算bodyCentroid
    → 端点与bodyCentroid距离近→root, 远→end

Step 4: 3锚点SVD
  配对: src.root↔tar.root, src.bend↔tar.bend, src.end↔tar.end
  computeLandmarkAlignment(3点, mode='similarity')
    → matrix4x4 + rmse

输出:
  LimbStructureMatchResult {
    pairs: LandmarkCandidate[]      // 恰好3个: root/bend/end
    matrix4x4: number[][]
    rmse: number
    srcAnchors: {root, bend, end}
    tarAnchors: {root, bend, end}
    diagnostics
  }
```

### 4.2 关键事实：tarBodyVertices 来源

```typescript
const workingTarBodyVertices = findMaskRegion(workingMaskReproj?.regions, ['body', 'torso']);
```

- `findMaskRegion` 查找 `maskReproj.regions` 中 label 为 `'body'` 或 `'torso'` 的区域
- 如果没有 body/torso 区域，`tarBodyVertices` 为 null
- tar端锚点定向依赖此值：缺失时无法区分root/end

### 4.3 Limb Structure 在 handleFindPartial vs handleAutoAlign 的差异

| 项目 | handleFindPartial | handleAutoAlign |
|------|-------------------|-----------------|
| tarConstraintVertices | `tarRegion?.vertices`（可能null） | `workingTarRegion?.vertices`（保证非null） |
| tarBodyVertices | `findMaskRegion(maskReproj?.regions, ['body','torso'])` | `findMaskRegion(workingMaskReproj?.regions, ['body','torso'])` |

---

## 五、Pose Proxy 模式

### 5.1 数据流详图

```
前置条件 (仅pose-proxy):
  - project 非空
  - sourceGalleryBinding.pipelineKey 非空
  - orthoRenderUrl + orthoCamera 非空

Step 1: 获取源关节 (srcJoints)
  getPipelineJoints(project, sourceGalleryBinding.pipelineKey)
    → PipelineJointsMeta
    → srcJoints = meta.views.front  (Joint2D[])

Step 2: 获取源相机 (srcCamera)
  srcJointsMeta.splitMeta.views.find(v => v.view === 'front')
    → frontViewMeta.sliceSize {w, h}
  renderOrthoFrontViewWithCamera(srcMesh, {width: srcViewW, height: srcViewH})
    → srcRender.camera (OrthoFrontCamera)
  注意：srcCamera 来自splitMeta尺寸渲染，非localization camera

Step 3: 获取目标关节 (tarJoints)
  loadPage1FrontSegment()
    → projectStore.loadLatest('page1.multiview')
    → loadLatestSegments() → 找 'front' entry
    → blobToDataUrl → {dataUrl, file, dirName, source, size}

  detectPoses(targetFront.dataUrl, {includeHand:false, includeFace:false})
    → POST /api/dwpose → DwposeResponse

  cocoPoseToJoint2D(tPose.raw.poses[0], tPose.raw.imageSize)
    → Joint2D[] (单视图，不切分象限)

  scaleJointsToImageSize(detectedTarJoints, tPose.raw.imageSize,
                          {width: orthoCamera.width, height: orthoCamera.height})
    → tarJoints (缩放到orthoCamera尺寸)

Step 4: 构建源骨骼代理 (srcProxy)
  jointsToSeeds3D(srcJoints, srcMesh.vertices, srcCamera)
    → 对每个关节: 在2D投影空间找kNearest=3个最近顶点 → 3D均值
    → Map<string, Vec3> (关节名→3D种子点)

  buildSkeletonProxy(srcMesh.vertices, srcJoints, srcCamera, {capsuleRadiusFraction:0.08})
    → buildCapsules for each LIMB_SEGMENT
    → PCA on capsule vertices → ProxyAnchors
    → 提取命名锚点:
        shoulderLine (两肩中点方向)
        torsoAxis (躯干主轴)
        leftSleeveNear/Far (左袖近/远端)
        rightSleeveNear/Far (右袖近/远端)

Step 5: 构建目标骨骼代理 (tarProxy)
  buildSkeletonProxy(tarMesh.vertices, tarJoints, orthoCamera,
                     {capsuleRadiusFraction:0.08},
                     workingTarRegion?.vertices)  ← restrictVertices限制
    → 同上结构，但胶囊体仅收集约束区域内顶点

Step 6: 姿态对齐 (SVD)
  computePoseAlignment(srcProxy, tarProxy, {svdMode:'similarity'})
    → pairAnchors: 按kind配对 + 默认权重
        torso_axis=1.0, shoulder_line=0.8
        sleeve_near=1.0, sleeve_far=1.0
        upper_arm=0.9, forearm=0.7
    → checkLeftRightSwap: 检测左右是否互换
    → weightedSVD: 按权重复制锚点 → computeLandmarkAlignment(similarity)
    → 可靠性检查: rmse < 0.15*bboxDiag, confidence > 0.3

Step 7: 生成配对 (pairs)
  anchorPairs: poseAlign.anchorErrors 中每个kind → LandmarkCandidate
    srcPosition = srcProxy.anchors.find(kind).position
    tarPosition = tarProxy.anchors.find(kind).position
    confidence = anchorError.confidence

  directJointPairs: buildDirectJointCandidates(srcProxy.jointSeeds, tarProxy.jointSeeds, srcJoints, tarJoints)
    POSE_PROXY_DIRECT_JOINTS = ['left_shoulder','right_shoulder','left_elbow','right_elbow']
    对每个关节名: srcSeeds.get(name) ↔ tarSeeds.get(name)
    confidence = min(srcJoints[name].confidence, tarJoints[name].confidence)
    如果confidence ≤ 0 → 跳过

  最终: pm.pairs = [...anchorPairs, ...directJointPairs]

输出 (pm对象):
  {
    pairs: LandmarkCandidate[],        // anchorPairs + directJointPairs
    matrix4x4: poseAlign.matrix4x4,    // 来自computePoseAlignment
    rmse: poseAlign.svdRmse,
    thresholdUsed: 0,
    iterationsRun: 1,
    rawSrcSamples: srcProxy.anchors.length + srcProxy.jointSeeds.size,
    rawTarSamples: tarProxy.anchors.length + tarProxy.jointSeeds.size,
    bestInlierCount: posePairs.length,
    diagnostics: { mode, srcAnchors, tarAnchors, directJointPairCount, ... }
  }
```

### 5.2 关键事实：目标DWPose输入来源

- **输入图像**: Page1 MultiView 正视图（`loadPage1FrontSegment` → `page1.multiview` front segment）
- **不是**: ortho灰色渲染图
- orthoCamera仅用于2D→3D投影参考
- DWPose在真实概念图前视图上运行

### 5.3 关键事实：源关节来源

- 来自 `getPipelineJoints(project, pipelineKey)` — Page2缓存结果
- `srcJoints = meta.views.front` — 仅使用front视图关节
- 源相机从 `splitMeta.sliceSize` 推导，重新渲染获得

### 5.4 关键事实：Pose Proxy 不支持手动Step1

```typescript
// handleFindPartial 中:
if (partialMatchMode === 'pose-proxy') {
  onStatusChange(
    'Pose Proxy 模式不支持手动 Step 1，请使用上方「一键 · Pose Proxy 对齐」按钮',
    'error',
  );
  setPartialLoading(false);
  return null;
}
```

UI端同步：pose-proxy模式下手动Step1按钮被disabled。

---

## 六、共享后置管道 (SVD + ICP)

仅 `handleAutoAlign` 执行此管道。`handleFindPartial` 不执行。

### 6.1 数据流

```
输入:
  pm.pairs (模式特异产出)
  srcMesh.vertices
  tarMesh.vertices
  workingTarRegion?.vertices

Step 3: SVD对齐
  alignSourceMeshByLandmarks(
    srcMesh.vertices,
    pm.pairs.map(p => p.srcPosition),
    pm.pairs.map(p => p.tarPosition),
    'similarity'
  )
  → lmFit {matrix4x4, rmse, scale, ...}

Step 4: ICP精化
  icpRefine(srcMesh.vertices, tarMesh.vertices, lmFit.matrix4x4, {
    maxIterations, sampleCount, rejectMultiplier, convergenceImprovement,
    firstIterMode: 'similarity',
    subsequentMode: 'similarity',    ← 注意：不是'rigid'
    seed: runSeed,
    tarRestrictVertices: workingTarRegion?.vertices,
  })
  → icp {matrix4x4, rmse, iterations[], bestIteration, stopReason}

Step 5: 结果比较
  evalRmseOnLandmarks(lmFit.matrix4x4) → lmFitLandmarkRmse
  evalRmseOnLandmarks(icp.matrix4x4) → icpLandmarkRmse
  minIcpPairsKept = min(30, max(6, floor(sampleCount*0.1)))
  useIcp = isFinite(icp.rmse)
         && icp.iterations.length > 0
         && bestIcpIter.pairsKept >= minIcpPairsKept
  finalMatrix = useIcp ? icp.matrix4x4 : lmFit.matrix4x4
  finalRmse = useIcp ? icp.rmse : lmFitLandmarkRmse

Step 6: 状态更新
  setCandidates(pm.pairs)
  setAcceptedCandidateIds(全部选中)
  setAlignResult({matrix4x4, transformedVertices, ...})
  setResultPreview({alignedVertices, ...})
  setAutoAlignSummary({mode, pairs, rmse, scale, method, elapsedMs})
  setCenterViewMode('result')
  setResultViewMode('overlay')
```

### 6.2 关键事实：ICP判断逻辑

- ICP判断**不**依赖 landmark RMSE 比较
- 而是检查：`icp.rmse` 是否有限 + 迭代是否执行 + `pairsKept >= minIcpPairsKept`
- 注释原文：*"SVD optimizes the sparse RANSAC landmark pairs; ICP optimizes dense surface fit inside the target region. Manual testing shows ICP can visibly improve alignment while increasing landmark RMSE"*
- 因此：只要ICP收敛且保留足够点对，就采用ICP结果

### 6.3 关键事实：subsequentMode

- `firstIterMode: ALIGNMENT_MODE` (= 'similarity')
- `subsequentMode: ALIGNMENT_MODE` (= 'similarity')
- 这意味着ICP所有轮次都使用similarity变换（含缩放），不是首轮similarity后续rigid

---

## 七、handleAutoAlign 完整流程图

```
handleAutoAlign(modeOverride?)
  │
  ├─ 1. 解析 runMode = modeOverride ?? partialMatchMode
  │
  ├─ 2. 前置检查
  │     ├─ srcMesh/tarMesh 非空?
  │     ├─ activeTargetRegionLabel 非空?
  │     ├─ maskReproj 或 (segPack+maskImageUrl+refImageSize+localizationSpace)?
  │     └─ [pose-proxy] project + sourceGalleryBinding + orthoRenderUrl + orthoCamera?
  │
  ├─ 3. 解析 workingTarRegion
  │     ├─ tarRegion 已缓存且 label 匹配 → 直接使用
  │     ├─ maskReproj 中查找 region → buildTarRegionFromSet
  │     └─ 从头执行: renderOrtho → loadMask → reproject → buildTarRegion
  │
  ├─ 4. 模式分支 → pm结果
  │     ├─ surface: matchPartialToWhole(...)
  │     ├─ limb-structure: matchLimbStructureToWhole(...)
  │     └─ pose-proxy: [10步管道] → pm
  │
  ├─ 5. 检查 pm.pairs.length >= 3
  │
  ├─ 6. SVD: alignSourceMeshByLandmarks(pairs, 'similarity') → lmFit
  │
  ├─ 7. ICP: icpRefine(srcMesh, tarMesh, lmFit.matrix4x4, {tarRestrictVertices}) → icp
  │
  ├─ 8. 比较选择: useIcp ? icp.matrix4x4 : lmFit.matrix4x4 → finalMatrix
  │
  └─ 9. 状态更新 + UI反馈
```

---

## 八、handleFindPartial vs handleAutoAlign 对比

| 维度 | handleFindPartial | handleAutoAlign |
|------|-------------------|-----------------|
| 触发 | "Step 1" 按钮 | "一键对齐" 按钮 |
| pose-proxy | ❌ 报错拦截 | ✅ 完整10步管道 |
| surface | ✅ matchPartialToWhole | ✅ matchPartialToWhole |
| limb-structure | ✅ matchLimbStructureToWhole | ✅ matchLimbStructureToWhole |
| 工作区域 | tarRegion (可能null) | workingTarRegion (保证非null, 有fallback) |
| tarBodyVertices | findMaskRegion(maskReproj?.regions) | findMaskRegion(workingMaskReproj?.regions) |
| SVD | ❌ 不执行 | ✅ 执行 |
| ICP | ❌ 不执行 | ✅ 执行 |
| 结果选择 | ❌ 无 | ✅ SVD vs ICP 比较 |
| 输出状态 | candidates + partialMatchSummary | candidates + alignResult + resultPreview + autoAlignSummary |
| 异步 | 同步(setTimeout但无await) | async (有await: getPipelineJoints, loadPage1FrontSegment, detectPoses) |

---

## 九、UI按钮映射

### 9.1 三个一键按钮 (line ~3711-3737)

| 按钮 | 调用 | disabled条件 |
|------|------|-------------|
| 一键 · Pose Proxy 对齐 | `handleAutoAlign('pose-proxy')` | `!sourceGalleryBinding \|\| !poseProxyAvailable` |
| 一键 · 四肢大结构对齐 | `handleAutoAlign('limb-structure')` | 无 |
| 一键 · RANSAC 对齐 | `handleAutoAlign('surface')` | 无 |

### 9.2 结果区重跑按钮 (line ~4912-4918)

同样的三个模式按钮，出现在结果摘要区域。

### 9.3 poseProxyAvailable 计算

```typescript
useEffect(() => {
  const available = Boolean(sourceGalleryBinding?.pipelineKey) && Boolean(orthoRenderUrl) && Boolean(orthoCamera);
  setPoseProxyAvailable(available);
}, [sourceGalleryBinding, orthoRenderUrl, orthoCamera]);
```

---

## 十、DWPose服务详情

### 10.1 detectPoses

```typescript
detectPoses(imageBase64: string, opts?: {includeHand?, includeFace?})
  → POST /api/dwpose
  → {raw: DwposeResponse, overlayBase64: string}
```

### 10.2 cocoPoseToJoint2D

```typescript
cocoPoseToJoint2D(pose: CocoPose, imageSize: {width, height})
  → Joint2D[]
```

COCO关键点映射:
- 1→neck, 2→right_shoulder, 5→left_shoulder
- 3→right_elbow, 6→left_elbow
- 4→right_wrist, 7→left_wrist
- 8→right_hip, 11→left_hip

### 10.3 convertToGlobalJoints vs cocoPoseToJoint2D

| 方法 | 用途 | 象限切分 |
|------|------|---------|
| `convertToGlobalJoints` | Page1多视图 | ✅ 有 (splitMeta quadrant) |
| `cocoPoseToJoint2D` | Pose Proxy (单视图) | ❌ 无 |

---

## 十一、类型定义关键

### 11.1 LandmarkCandidate

```typescript
{
  srcVertex: number;      // 顶点索引 (pose-proxy中为-1)
  srcPosition: Vec3;
  tarVertex: number;      // 顶点索引 (pose-proxy中为-1)
  tarPosition: Vec3;
  confidence: number;
  descriptorDist: number;
  suggestAccept: boolean;
}
```

### 11.2 LIMB_SEGMENTS (types/joints.ts)

8个肢体段: left_arm, right_arm, left_upper_arm, left_forearm,
right_upper_arm, right_forearm, torso, torso_neck

### 11.3 POSE_PROXY_DIRECT_JOINTS

```typescript
['left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow']
```

这4个关节在anchor pairs之外额外添加为direct joint pairs。

---

## 十二、poseProxy可用的依赖链

```
sourceGalleryBinding.pipelineKey
  ← 用户在Gallery中绑定源模型时设置
  ← 绑定时需选择pipelineKey（Page2输出标识）

orthoRenderUrl
  ← renderOrthoFrontViewWithCamera 的输出
  ← 在定位管道执行时设置
  ← 依赖: tarMesh已加载 + localizationSpace已计算

orthoCamera
  ← 同上，渲染时同时产出

project
  ← ProjectContext 提供
  ← 打开项目即有
```

---

## 十三、各模式的workingTarRegion使用

| 模式 | workingTarRegion用途 |
|------|---------------------|
| surface | `tarConstraintVertices`: 限制tar采样池到区域内; `tarConstraintUseSaliency`: 区域内使用saliency; `tarSeedCentroid`/`tarSeedRadius`: 采样偏向区域中心 |
| limb-structure | `tarConstraintVertices`: PCA+结构检测仅在约束顶点上执行 |
| pose-proxy | `restrictVertices`: buildSkeletonProxy中胶囊体仅收集约束区域内顶点 |

所有模式在ICP阶段都使用 `workingTarRegion?.vertices` 作为 `tarRestrictVertices`。
