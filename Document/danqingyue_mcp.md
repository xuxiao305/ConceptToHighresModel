
丹青约平台地址：danqing.163.com

丹青约 MCP 介绍
--------------------------------------------------------------------------------
丹青约 MCP（模型上下文协议）是丹青约平台面向集团内各业务提供的标准化开放接口，可安全调用平台内 GPT-Image2、Nano-Banana2、Seedance2.0、混元3D 等 AI 生图、生视频、生 3D 能力，并复用丹青约的用户鉴权和积分体系
相比直接在平台上手动操作，MCP 能把丹青约的 AI 能力，直接集成到你自己的软件、编辑器或内部系统里使用，不用手动点按钮，可按业务需求自动批量生成、定时生成、对接工作流，更适合游戏美术工业化生产和营销素材规模化产出

调用方式
--------------------------------------------------------------------------------
1. 配置MCP服务
1.1. Claude Code
claude mcp add --transport http danqing-mcp https://mcp-danqing.apps-sl.danlu.netease.com/mcp
1.2. Cursor/OpenClaw
// 参考相关文档配置mcp服务
{
  "mcpServers": {
    "danqing-mcp": {
      "url": "https://mcp-danqing.apps-sl.danlu.netease.com/mcp"
    }
  }
}
2. 完成MCP认证
首次使用自动跳转 RBAC 完成登录授权，之后无需重复登录。

在claude code中，也可以使用官方的/mcp命令完成mcp服务的认证





3. 登录完成
可以开始使用


已支持的MCP能力
--------------------------------------------------------------------------------
AI 图像生成 / 编辑
能力MCP 能力名主要参数体验地址GPT-Image-2图像生成与编辑（OpenAI 新一代，最多 10 张参考图）gpt_image_2文本提示词（<=5000 字符）参考图尺寸（默认 auto，可选 1024x1024/1024x1536/1536x1024）图像质量（默认 medium，可选 high/medium/low/auto）GPT-Image-2生图GPT-Image-1GPT-4o 图像生成与编辑（支持透明背景）gpt_4o_image文本提示词参考图尺寸（默认 1024x1024）背景（默认 auto，可选 transparent/opaque）GPT-4o生图Nano Banana 2NanoBanana 2.0（Gemini 3.1 Flash Image Preview）nano_banana_2文本提示词参考图宽高比分辨率（默认 4K）NanoBanana生图Nano Banana ProGoogle Banana Pro 高质量参考图生成banana_pro参考图文本提示词尺寸分辨率（默认 4K）NanoBanana生图Nano BananaGoogle Gemini 2.5 Flash 图像生成gemini_25_flash文本提示词参考图（最多 5 张）NanoBanana生图Seedream 5.0 Lite豆包 SeeDream 5.0 Lite（最多 15 张组图）doubao_seedream_5_lite文本提示词参考图组图数量上限（默认 15）图片尺寸（默认 2K）豆包·图像创作模型Seedream 4.0豆包 SeeDream 4.0（文生图 / 参考图编辑）doubao_seedream_4文本提示词参考图、图片尺寸（默认 2K）豆包·图像创作模型Seedream 4.0 (即梦)同样使用豆包 Seedream 4.0底模，即梦团队自行魔改过，对齐即梦网页端的效果jimeng_image_v4文本提示词参考图（最多 10 张）即梦AIMidjourneyMidjourney 文 / 图生图，可切换 V6/V6.1/Niji6/Niji7/V7midjourney_imagineMJ 版本（默认 V6）提示词出图比例（默认 1:1）垫图角色参考图风格参考图风格化强度（默认 700）怪异感（默认 0）混乱度（默认 0）随机种子（默认 -1）四方连续贴图（默认 false）丹青约一键抠图 (通用版)输出 4 张透明通道图供择优bg_removal_general_enhanced输入图最长边尺寸一键抠图一键抠图 (半透明材质)（玻璃 / 薄纱 / 烟雾等）cutout_translucent输入图最长边尺寸（默认 2048）一键抠图多视图生成单图任意角度多视图生成multi_angle_generation输入图水平角度（默认 0）垂直角度（默认 0）相机缩放（默认 5）场景-人物-道具-任意多角度生成通用转写实 V2将草图快速计算出模型预览效果，约 60s，更快general_realistic_v2原图提示词步数（默认 8）颜色鲜艳度（默认 3）种子控制（默认 randomize）通用转写实/发型反馈/褶皱反馈通用转写实 V1将草图快速计算出模型预览效果，约 90s，可控线稿一致性general_realistic_v1原图提示词细节强度（默认 0.2）模型（默认 RealisticGanMix_15）原图一致性（默认 0.6）线稿一致性（默认 0.75）LoRA 强度（默认 0）种子控制（默认 randomize）通用转写实/发型反馈/褶皱反馈场景原画渲染风格图 + 白模图生成场景概念图scene_concept_art风格参考图白模/线框图场景描述场景原画渲染

AI 视频生成
能力MCP 能力名主要参数体验地址Seedance 2.0 全模态参考（图 + 视频 + 音频任意组合）seedance_2_all_in_one模型选择提示词参考图参考视频参考音频视频比例分辨率视频时长智能时长（默认关闭）是否生成音频（默认开启）Seedance 2.0Seedance 2.0 首尾帧（智能时长 + 自动配音）seedance_2_first_last_video提示词首帧图尾帧图模型选择视频比例分辨率视频时长智能时长（默认关闭）是否生成音频（默认开启）Seedance 2.0可灵 O1 视频指令编辑（改背景 / 服装 / 风格）kling_o1_video_edit原视频提示词参考图视频比例是否保留原声（默认 yes）参考视频类型（默认 base）生成模式（默认 std）可灵o1可灵 O1 视频参考生成（基础 / 特征两种参考模式）kling_o1_video_reference参考视频提示词参考图视频比例是否保留原声（默认 yes）参考类型（默认 base）视频时长（默认 5 秒）生成模式（默认 std）可灵o1可灵 O1 首尾帧（尾帧可选）kling_o1_first_last_video首帧图尾帧图（可选）提示词视频比例视频时长（默认 5 秒）生成模式（默认 std）可灵o1可灵 O1 图生视频（支持多参考图）kling_o1_i2v参考图列表提示词视频比例（默认 9:16）视频时长（默认 5 秒）生成模式（默认 pro）可灵o1可灵 Kling 2.6首尾帧视频生成kling_first_last_video首帧图尾帧图提示词视频时长（默认 5 秒）模型版本（默认 kling-v1）自由度（默认 0.5）生成模式（默认 std）可灵AI视频生成可灵 Kling 2.6图生视频kling_i2v输入图提示词模型版本（默认 kling-v1-6）视频时长（默认 10 秒）自由度（默认 0.5）生成模式（默认 std）可灵AI视频生成Seedance 3.0 Pro图生视频（9 种比例可选）jimeng_i2v首帧图提示词视频比例（默认 16:9）视频时长（默认 10 秒）https://danqing.163.com/community/workflow-group/q0zrtt1t?workflowVersionId=hak4qvpwSeedance 3.0 Pro首尾帧视频jimeng_first_last_video首帧图尾帧图提示词视频时长（默认 5 秒）https://danqing.163.com/community/workflow-group/q0zrtt1t?workflowVersionId=tomirphaRunway 首尾帧（8 种分辨率比例）runway_first_last_video首帧图尾帧图提示词视频时长（默认 5 秒）视频比例随机种子Runway视频生成

3D 模型生成
能力MCP 能力名主要参数体验地址腾讯混元3D-v3.1 图生3D（前后左右上下六视图输入）hunyuan_i2_3d_v31多视图列表面数自定义面数是否 PBR任务类型（默认 Normal）草图提示词混元3D腾讯混元3D-v3.1 文生3Dhunyuan_t2_3d_v31文本提示词面数自定义面数是否 PBR任务类型（默认 Normal）混元3D腾讯混元3D-v3.0单图 / 多视图 / PBR / 低面 / 草图模式全支持hunyuan_3d正面图背面图左侧图右侧图面数自定义面数是否 PBR（默认 0 关闭）任务类型（默认 Normal，可选 LowPoly/Geometry/Sketch）草图提示词网格类型混元3DTrellis2微软开源模型（高分辨率 + 高纹理）trellis2_3d_generation输入图像素配置面数纹理尺寸随机种子种子控制3D生成-多模型

3D 网格 / 拓扑工具
能力MCP 能力名主要参数体验地址腾讯混元-智能拓扑3D 模型重拓扑优化（三角 / 四边面）hunyuan_topology模型文件面数等级（默认 low）多边形类型（默认 triangle）智能拓扑腾讯混元-组件拆分3D 组件智能拆分（仅支持 fbx）hunyuan_3d_split模型文件组件拆分3D 模型格式转换fbx/glb → FBX/STL/MP4/USDZ/GIFhunyuan_3d_format_convert模型文件目标格式模型格式转换腾讯混元-UV 展开3D 模型 UV 自动展开（fbx/obj/glb）hunyuan_3d_uv_unwrap模型文件UV展开

纹理生成
能力MCP 能力名主要参数体验地址腾讯混元-图生纹理混元 3D 模型纹理生成（参考图驱动）hunyuan_3d_texture模型文件纹理参考图纹理生成腾讯混元-文生纹理混元 3D 文生纹理hunyuan_3d_text_texture模型文件文本提示词纹理生成材质平铺1:1 无缝材质平铺图，可挂 LoRAmaterial_tiling输入图提示词随机种子种子控制（默认 randomize）LoRA 名称LoRA 强度场景PBR工具集(材质贴图生成，四方连续贴图生成，去光影，材质平铺等)灰度图-法线灰度图 / 法线图 / 边缘图三件套生成depth_normal_curvature输入图分辨率（默认 2048）输入图类型（默认 2 立体感强）保留原始强度（默认 -2）线稿优化（默认 0.35）深度优化（默认 0.4）种子控制（默认 randomize）灰度图-法线

MCP 定制联系
--------------------------------------------------------------------------------
若项目有需要开放成MCP的工作流（如项目定制工作流、自行训练的模型等），请联系 @一成(陈天威)