# 右侧 SAM3 区域 Region 选中高亮功能

## 一、功能位置
右侧面板 SAM 3 板块下的 Region 列表区域。

## 二、核心功能
在 Region 列表中，用户点击选中任意一个 Region 条目时，对应 Region 需要进行颜色高亮标识。

## 三、触发逻辑规则
当处于 seg 模式 且开启 region overlay 叠加模式 时：选中列表里的 Region，视窗内对应区域同步高亮；
未开启 region overlay 模式时：即便在列表选中 Region，视窗也不做任何高亮反馈，无视觉变化