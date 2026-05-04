Phase A — Pose Proxy 真分步（先做这个，验证模式）
A1. 新增 poseProxySteps.ts：把 runPoseProxy 拆成 5 个独立步骤函数

collectJoints({srcJointsRaw, tarJointsRaw, tarCamera, page1Size}) → {srcJoints, tarJoints}
renderSrcOrtho(srcMesh, page1Size) → {srcCamera, srcOrthoDataUrl}
buildProxies({srcMesh, tarMesh, srcJoints, tarJoints, srcCamera, tarCamera, tarConstraint}) → {srcProxy, tarProxy, pairs}
solveSvd(pairs, mode) → {lmFitMatrix, lmFitRmse}
solveIcp({srcMesh, tarMesh, lmFitMatrix, icpCfg, tarConstraint, pairs}) → {finalMatrix, icpRmse, ...}
A2. ModelAssemble 内加 poseProxyState: { joints?, srcRender?, proxies?, svd?, icp? }，每步把结果写入对应槽位

A3. 上游状态变化（Page1 joints 变了 / SAM3 区域变了 / mesh 重载）→ 整个清空。手动改 ICP 参数 → 只清 icp 槽

A4. StepCardV2：每步真显示 pending（上游缺）/ ready（可跑）/ running / done（有结果）/ stale（上游变了）；"重跑此步" 只重跑该步并清下游

A5. 策略卡顶部"一键"按钮 = 顺序触发所有未完成步

A6. 旧 runPoseProxy 改为 thin wrapper，调五步组合（保持现有 handleRunAuto 行为不变）

Phase B — 同模式套用 Limb / Surface / Manual
Limb 三步：detect-anchors / svd / icp
Surface 四步：sample-fpfh / ransac / svd / icp
Manual 已经天然两步：svd / icp

Phase C — 清理
删 STUB_FALLBACK / REAL_FIELDS / TOTAL_FIELDS 死代码
ICP meanError/maxError 真返回（不再 alias rmse）
合并 tarRegion / tarRegionLabel / tarOrthoCamera / tarReprojRegions 为单个 tarSegmentationState
canRunManual / canRunAuto 改成基于 summarizeReadiness
文件头 stage 注释归档/删除