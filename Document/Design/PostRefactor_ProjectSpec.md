# 项目结构 Spec — 重构完成态 (Post Stage 7)

> 目标版本: refactor master plan Stage 7 收尾后。
> 本文档描述的是**目标态**（V2 默认、Mockup/V1 已删除、Page2 关节链彻底清除后）的项目结构与契约。
> 历史与中间态见 [refactor_master_plan](../../memories/session/refactor_master_plan.md)。

---

## 1. 顶层职责划分

| 页面 | 角色 | 输入 | 输出（持久化） |
|---|---|---|---|
| Page1 ConceptToRoughModel | **唯一**关节生产者 + 粗模生成 | concept 草图 | `page1.multiview` 4合1 + `page1.splits` + `page1.joints` + `page1.rough` GLB |
| Page2 HighresModel | 纯抽取 / 高模代工 | Page1 multiview | `page2.extraction` 高模 GLB（**不含关节**） |
| Page3 ModelAssemble (V2) | 纯消费者 + 对齐策略宿主 | Page1 splits/joints + Page2 高模 | `page3.segpack` 对齐结果 |

**关键不变量**：关节数据从 Page1 单向流向 Page3，Page2 不读不写关节。

---

## 2. 目录结构

### 2.1 源码

```
src/
├── App.tsx                       # 路由 + 顶层布局（仅 V2，无 ?v1/?mockup 切换）
├── main.tsx                      # 入口
├── components/                   # 通用 UI（Button / TopNav / Modal …）
├── contexts/
│   └── ProjectContext.tsx        # 工程根 + 当前项目状态
├── pages/
│   ├── Page1/ConceptToRoughModel.tsx   # 含 multiview→split→DWPose 自动链
│   ├── Page2/
│   │   ├── HighresModel.tsx            # 仅抽取/高模，无 Generate Joints 按钮
│   │   └── PartPipeline.tsx
│   └── Page3/
│       ├── ModelAssemble.tsx           # = 旧 V2，重命名后唯一对齐页
│       └── SAM3Panel.tsx
├── services/
│   ├── projectStore.ts                 # File System Access + project.json 读写
│   ├── comfyui.ts / workflows.ts       # ComfyUI 通讯
│   ├── dwpose.ts                       # DWPose 调用 + 全视图坐标切分
│   ├── multiviewSplit.ts               # 4合1 → 4 视图切分
│   ├── extraction.ts / garmentParsing.ts
│   ├── leihuo.ts / tripo.ts / trellis2.ts
│   ├── segmentationPack.ts
│   ├── meshRegion.ts
│   └── alignStrategies/                # Stage 5 注册表（声明式）
│       ├── types.ts                    # AlignStrategy / Context / Requirements
│       ├── index.ts                    # registry 聚合
│       ├── poseProxyStrategy.ts
│       ├── limbStructureStrategy.ts
│       ├── surfaceStrategy.ts
│       ├── manualStrategy.ts
│       └── runners.ts                  # 算法回调 thin wrapper
├── three/                              # Babylon.js + 几何算法
│   ├── DualViewport.tsx / MeshViewer.tsx / TexturedSceneViewer.tsx
│   ├── alignment.ts / poseAlignment.ts / icpRefine.ts / ransacAlign.ts
│   ├── partialMatch.ts / limbStructureMatch.ts
│   ├── skeletonProxy.ts / regionGrow.ts / regionDescriptor.ts
│   ├── meshFeatures.ts / meshAdjacency.ts / fpfh.ts
│   ├── landmark*.ts / LandmarkMarker.tsx
│   ├── maskReproject.ts / orthoFrontRender.ts / imageSubjectBBox.ts
│   ├── cameraSyncStore.ts / axialFrame.ts / glbLoader.ts
│   └── types.ts / index.ts
└── types/
    ├── index.ts
    └── joints.ts                       # 全部关节/坐标空间契约
```

**已删除清单**（重构产物）：
- [src/services/jointsGeneration.ts](src/services/jointsGeneration.ts) — 已不存在
- [src/three/jointsTransform.ts](src/three/jointsTransform.ts) — 已不存在
- `src/pages/Page3/ModelAssembleMockup.tsx` — Stage 7 删除
- `src/pages/Page3/ModelAssembleV2.tsx` — Stage 7 重命名为 ModelAssemble.tsx
- `App.tsx` 中 `?v2` / `?mockup` URL 参数解析 — Stage 7 删除

### 2.2 工程数据 (Project Root)

```
<ProjectRoot>/
├── project.json                  # ProjectMeta（含 page1.splits / page1.joints）
├── page1_concept_to_rough/
│   ├── 01_concept/               # index.json + 草图历史版本
│   ├── 02_tpose/
│   ├── 03_multiview/             # 4合1 大图 + segment set 子目录（split 切片）
│   ├── 04_rough/                 # 粗模 GLB
│   ├── 05_rigging/
│   └── 06_extraction/
├── page2_highres/
│   ├── 00_image_input/
│   ├── 01_extraction/
│   ├── 02_modify/
│   └── 02_highres/               # 高模 GLB（不再写 *_joints.json）
└── page3_assemble/
    └── 01_segpack/
```

**project.json 关键字段**：

```ts
interface ProjectMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
  version: 1;
  absolutePath?: string;
  page1?: {
    splits?: Page1SplitsMeta;     // 4 视图切分元信息
    joints?: Page1JointsMeta;     // 4 视图 split-local 坐标关节
  };
}
```

`PersistedPipeline.jointsMeta` 字段在 Stage 3 已删除，旧工程加载时直接忽略。

---

## 3. 数据流契约

### 3.1 端到端关节流

```
Page1 多视图生成
   └─ multiview 4合1 PNG
        ├─ splitMultiView()  → page1.splits（4 切片 + bbox）
        └─ DWPose()         → GlobalJointsMeta
              └─ globalJointsToPage1Views() → page1.joints (split-local)
                                                    │
Page3 加载 ───────────────────────────────────────┘
   └─ loadPoseProxyJoints()  // page1 唯一来源，无回退
        ├─ src 渲染目标 size = page1.splits.front.size
        ├─ tar 渲染目标 size = page1.splits.front.size
        └─ joints = page1.joints.front  // 0 坐标变换
```

### 3.2 坐标空间（重构后简化）

| 编号 | 名称 | 谁产生 | 谁消费 |
|---|---|---|---|
| 1 | global 2x2 image | Page1 multiview | DWPose |
| 2 | split-local view | Page1 split + globalJointsToPage1Views | **Page3 直接消费** |
| 3 | 3D mesh ortho projection | Page3 src/tar 渲染 | Page3 对齐 |

旧链路中的 "processed 2x2 image" (SmartCrop 输出) 在 Page3 路径中**已不再出现**；如有遗留代码请检查 `src/three/` 中的相关 import。

---

## 4. Page3 对齐策略注册表

`src/services/alignStrategies/` 是 V2 GUI 的数据骨架。新增策略只需：

1. 新建 `xxxStrategy.ts`，导出符合 `AlignStrategy` 接口的对象
2. 在 `index.ts` 中加入 registry 数组
3. （可选）在 `runners.ts` 中加入算法回调

`ModelAssemble.tsx` 不需任何修改，新策略卡 + 步骤面板 + 就绪状态会自动出现。

策略契约（[types.ts](src/services/alignStrategies/types.ts)）：

```ts
interface AlignStrategy {
  id: 'pose-proxy' | 'limb-structure' | 'surface' | 'manual' | string;
  label: string;
  summary: string;
  kind: 'auto' | 'manual';
  requirements: (ctx: AlignStrategyContext) => RequirementCheck[];
  steps: StrategyStep[];
}
```

---

## 5. 模块依赖契约

```
pages/*  ──depends on──▶  services/*  ──depends on──▶  types/*
   │                           │
   └────────depends on────────▶ three/*
                                  │
                                  └─▶ types/*
```

**禁止反向依赖**：
- `services/` 不得 import `pages/`
- `three/` 不得 import `pages/` 或 `services/projectStore`（保持纯几何/渲染）
- `types/` 不得 import 任何运行时模块

---

## 6. UI 入口路由

| URL | 页面 |
|---|---|
| `/` 或 `/page1` | Page1 ConceptToRoughModel |
| `/page2` | Page2 HighresModel |
| `/page3` | Page3 ModelAssemble (= 旧 V2) |

无任何实验性 query 参数。

---

## 7. 已知遗留缺陷（不属本次重构）

- **splitMultiView 全图连通分量缺陷** ([src/services/multiviewSplit.ts](src/services/multiviewSplit.ts))
  - 4 角色像素经边缘灰边相连时 back 视图 bbox 退化为整图
  - 单角色举手等突出肢体可能被分到隔壁象限
  - Page3 主用例只读 front，不阻塞；P2 优先级
  - 修复方向：象限内独立连通分量

- **朝向契约无运行时校验** — 详见 [Document/Risks/OrientationContract_Risk.md](../Risks/OrientationContract_Risk.md)

---

## 8. 验收 Checklist（重构完成态）

- [ ] `grep -r "ModelAssembleMockup\|ModelAssembleV2"` 全工程零命中
- [ ] `grep -r "jointsGeneration\|jointsTransform"` 全工程零命中
- [ ] `grep -r "handleGenerateJoints\|jointsMeta"` 仅出现在向后兼容的 `@deprecated` 字段或读取处
- [ ] Page2 UI 无 "Generate Joints" 按钮
- [ ] Page3 启动 trace 显示 `joints source: page1.joints`，**无** `detectPoses` 回退
- [ ] 加载 Stage 0 之前的旧工程仍能进入 Page3（jointsMeta 字段静默忽略）
- [ ] `npx tsc -p tsconfig.json --noEmit` 零错误
- [ ] 4 个对齐策略 smoke test 行为与 Stage 0 一致
