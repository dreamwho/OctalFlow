import type { AgentSkill, AgentSkillModelConstraints, AgentSkillRequiredAssetRole, AgentSkillStage } from "@/lib/auth/store-types";

const SOURCE_REPOSITORY = "MiniMax-AI/MiniMax-H3";
export const LEGACY_MINIMAX_H3_PROMPT_SKILL_ID = "skill-minimax-h3-prompt";
const H3_PREFERRED: AgentSkillModelConstraints = { capability: "video", preferredModelFamilies: ["minimax-h3"] };
const H3_REQUIRED: AgentSkillModelConstraints = { capability: "video", requiredModelFamilies: ["minimax-h3"] };

const sharedReferenceRules = `仅在用户本轮明确选择本 Skill 时生效。用户上传或 @ 引用的每一项素材都是具名参考：先识别其角色、主体、场景、色彩、文字、构图和不可变特征，再把同一真实素材 ID 传入后续任务。不得把参考素材概括成模糊“灵感”，不得替换、重绘、合并或臆造已锁定的人物身份、商品结构、品牌元素、场景关系、音乐或文字。时长、比例、清晰度、批量数和可引用素材数量必须由当前已解析的视频模型能力决定；不得把来源文档中的任何固定时长、比例或模型名当成全局默认值。`;

function source(path: string, version: string, sourceContentHash: string) {
    return {
        sourceUrl: `https://github.com/${SOURCE_REPOSITORY}/blob/main/${path}`,
        sourceRepository: SOURCE_REPOSITORY,
        sourcePath: path,
        sourceVersion: version,
        sourceContentHash,
    };
}

function role(id: string, label: string, required: boolean, acceptedAssetTypes: AgentSkillRequiredAssetRole["acceptedAssetTypes"]): AgentSkillRequiredAssetRole {
    return { id, label, required, acceptedAssetTypes: [...acceptedAssetTypes] };
}

function stage(id: string, label: string, description: string, requiresUserConfirmation = false): AgentSkillStage {
    return { id, label, description, ...(requiresUserConfirmation ? { requiresUserConfirmation: true } : {}) };
}

const stagedWorkflowGuard = `这是待阶段确认能力接入后才可完整执行的工作流。当前不具备可强制暂停、收集确认以及自动成片合成的运行时契约；即使管理员临时启用，也只能交付当前阶段的可审核方案和下一步所需素材，不能假称已完成旁白、配乐、字幕、剪辑或成片合成。`;

export const MINIMAX_H3_OFFICIAL_STYLE_SKILLS: readonly AgentSkill[] = [
    {
        id: "minimax-h3-handdrawn-live",
        name: "手绘实拍融合",
        description: "把粗粝发光手绘动画与真实空间、触碰和连续追拍结合成单场景短视频。",
        plannerSummary: "用于单场景手绘实拍融合短片；锁定参考主体后规划真实接触、连续变形与慢半拍追拍。",
        instructions: `${sharedReferenceRules}
仅生成一个连续、可追踪的真实空间或相邻空间中的短视频，不按分镜数量机械拆成多条视频。先建立实拍空间、触碰对象、手绘实体、色彩母题、连续变形链路、逃跑路线和拍摄者反应；在最早的叙事节拍中明确真实手或真实物体与手绘实体的物理接触。
后续形态必须保留前一形态的线条、色彩、轮廓或动作痕迹，不能突然替换成无关的新角色；拍摄者的反应和手持镜头必须连续，镜头可略晚于主体移动但不得失去主体。
保持粗糙蜡笔、粉笔、彩铅或粉彩的逐帧笔触，避免光滑矢量线、精致 CG、毛绒玩具感、恐怖威胁、跳吓和无理由换场。结尾可以产生与前述线索相连的空间级变化，但不得破坏参考主体、场景或用户指定的结尾。
仅在已解析模型属于 MiniMax H3 系列且其当前能力支持本次参数与参考方式时提交视频；否则清楚说明需要改选兼容模型，不能静默降级到其他模型。`,
        enabled: true,
        workspaces: ["video", "canvas"],
        nodeModes: ["video"],
        action: "generate",
        requiresReference: false,
        modelConstraints: H3_REQUIRED,
        requiredAssetRoles: [role("scene_reference", "场景或主体参考", false, ["image", "video"])],
        stages: [stage("generation", "连续短片生成", "在模型能力内生成一条单场景、连续运动的视频。")],
        defaultConfig: {},
        keywords: ["手绘实拍", "手绘动画", "实拍融合", "蜡笔动画", "粉笔动画", "连续变形", "手持追拍"],
        ...source("handdrawn-live-video-generator/SKILL.md", "1.0.2", "5c62175b552f51ed0bfb1e8fcb6fdcfab09530a36570478e58e41c14340b3001"),
    },
    {
        id: "minimax-h3-brand-promo",
        name: "品牌宣传片",
        description: "基于已授权的品牌事实与素材，规划可审核的品牌宣传短片工作流。",
        plannerSummary: "适用于已有授权 Logo、产品或界面素材的品牌宣传片；先核验事实和素材来源，再进入创意与分镜。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先建立品牌事实表和素材来源表：只使用用户明确提供或可核验的品牌名称、功能、卖点、Logo、产品图、界面图和行动号召；无法核验的宣称必须标记为待确认，禁止虚构功能、数据、授权或品牌标识。
在事实确认前仅输出缺失信息和风险；确认后输出一个可审核的受众、叙事主线、节拍、镜头与素材需求方案。未经视觉方案确认不得生成最终镜头；没有已实现的合成能力时不得承诺旁白、音乐、字幕或成片交付。`,
        enabled: false,
        workspaces: ["video", "canvas"],
        nodeModes: [],
        action: "generate",
        requiresReference: true,
        modelConstraints: H3_PREFERRED,
        requiredAssetRoles: [role("brand_identity", "品牌身份与授权素材", true, ["image", "text"]), role("product_or_interface", "产品或界面素材", true, ["image", "video", "text"])],
        stages: [
            stage("fact_check", "事实与素材核验", "核对品牌事实、资产来源和不可使用的内容。", true),
            stage("creative_plan", "创意与分镜方案", "输出受众、信息主线、节拍和镜头计划。", true),
            stage("visual_preview", "视觉预览", "确认关键视觉锚点后才能进入镜头生成。", true),
            stage("delivery_review", "交付复核", "检查授权、品牌事实、镜头和未实现的后期需求。", true),
        ],
        defaultConfig: {},
        keywords: ["品牌宣传", "品牌片", "产品发布", "官网宣传", "App宣传", "营销短片"],
        ...source("brand-promo-video-generator/SKILL.md", "0.1.9", "a50d270e412be4ed5cf88b187665585f4da637701eb24333fbdef95a19442f37"),
    },
    {
        id: "minimax-h3-minimal-product-ad",
        name: "极简产品广告",
        description: "围绕真实产品素材、卖点与使用场景规划干净克制的产品广告短片。",
        plannerSummary: "适用于实体产品的极简广告；锁定产品外观和可验证卖点后规划单一视觉重点与连续展示。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先从真实产品素材提取不可变外观锚点、材质、颜色、包装、文字和已确认卖点；每个镜头都必须保持这些锚点，不得改写产品结构、Logo 或包装文字。
使用干净、克制、以产品为中心的视觉语言和转场，避免模仿特定品牌、字体、广告片或外部音乐工具。先提交卖点、镜头节拍和文字出现策略供确认；如当前模型无法可靠呈现文字，则把文字作为后期需求标记，不得承诺已在视频内准确生成。
没有确认锚图和阶段确认时，停在方案与素材清单，不直接提交完整广告成片。`,
        enabled: false,
        workspaces: ["video", "canvas"],
        nodeModes: [],
        action: "generate",
        requiresReference: true,
        modelConstraints: H3_PREFERRED,
        requiredAssetRoles: [role("product_reference", "产品参考素材", true, ["image", "video"])],
        stages: [
            stage("product_facts", "产品与卖点核验", "锁定产品外观和可公开使用的卖点。", true),
            stage("anchor_preview", "产品锚图确认", "确认产品外观、光线和场景锚点。", true),
            stage("shot_plan", "广告镜头计划", "确认节拍、镜头和文字策略。", true),
            stage("delivery_review", "交付复核", "标注需要真实后期执行的文字、音乐和合成项。", true),
        ],
        defaultConfig: {},
        keywords: ["产品广告", "极简广告", "电商短片", "新品发布", "产品宣传"],
        ...source("minimalist-product-ad-generator/SKILL.md", "0.5.6", "1f07c58090141159861fa84762ad09eaaf78c2ceaa4cebb08e0e429a55994196"),
    },
    {
        id: "minimax-h3-3d-animation-short",
        name: "3D叙事短片",
        description: "把故事创意整理为角色、场景、镜头交接与审核节点明确的 3D 动画短片方案。",
        plannerSummary: "适用于多镜头 3D 叙事；先完成故事、角色、场景和连续性镜头表，再等待阶段确认。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先确定故事钩子、人物关系、场景空间和角色/环境的独立锚点；随后按语义边界而非平均时长拆镜，每一段明确动作起止、景别、机位、光线、声音意图和与前后段的连续性交接。
角色、场景和关键道具必须先形成可审核的身份锚点；不得复刻影视工作室、IP、角色或特定渲染软件的专有风格。所有片段时长均以当前模型能力为准，若无法覆盖导演计划，应重新拆镜并请求确认。
在角色/场景卡、镜头表和视觉方向确认前，不能创建整片视频任务；当前没有自动合成与配乐契约时，只交付生产计划和可执行的分段任务说明。`,
        enabled: false,
        workspaces: ["video", "canvas", "drama"],
        nodeModes: [],
        action: "generate",
        requiresReference: false,
        modelConstraints: H3_PREFERRED,
        stages: [
            stage("story_plan", "故事与镜头结构", "确认叙事、时长目标和镜头连续性。", true),
            stage("asset_bible", "角色与场景锚点", "确认角色、环境和关键道具的身份锚点。", true),
            stage("storyboard", "分镜确认", "确认按语义拆分的镜头表与交接关系。", true),
            stage("delivery_review", "制作与交付复核", "标注仍需合成、配乐或人工剪辑的内容。", true),
        ],
        defaultConfig: {},
        keywords: ["3D动画", "动画短片", "故事短片", "角色动画", "分镜导演"],
        ...source("3d-animation-short-generator/SKILL.md", "0.5.4", "92f1130ccf456b3e5be2d8aab238a739d26e130ff72061c239e613e4d615f5b4"),
    },
    {
        id: "minimax-h3-music-video-subtitle",
        name: "音乐MV动态字幕",
        description: "基于音乐、歌词和参考素材，规划节拍同步的镜头与动态字幕方案。",
        plannerSummary: "适用于有音乐和歌词的 AI MV；先锁定音频时间线、歌词和人物/场景引用，再设计可衔接镜头。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先识别音乐时长、节拍、人声段落和歌词边界；不得在歌词、关键动作或连续镜头中间机械切段。人物、场景、文字和音乐引用必须分角色锁定，后续镜头只能使用对应真实资产。
先输出音频时间线、镜头边界、歌词可读性和动态字幕位置方案供确认；若当前视频模型或后期流程不能保证文字可读与音画同步，应把它列为待后期项，不能声称已经完成节拍分析、卡点字幕、混音或拼接。
不得复制受版权保护的歌词、音乐、字体或现成 MV 视觉表达；用户未提供权利清晰的音乐或歌词时，停在概念方案。`,
        enabled: false,
        workspaces: ["video", "canvas"],
        nodeModes: [],
        action: "generate",
        requiresReference: true,
        modelConstraints: H3_PREFERRED,
        requiredAssetRoles: [role("music_track", "音乐轨道", true, ["audio"]), role("lyrics", "歌词或文字脚本", true, ["text"])],
        stages: [
            stage("audio_timeline", "音乐与歌词时间线", "核对音乐、歌词和可用的时间信息。", true),
            stage("mv_plan", "MV镜头与字幕方案", "确认镜头边界、角色素材和字幕策略。", true),
            stage("visual_preview", "视觉锚点确认", "确认人物、场景和动态文字的视觉方向。", true),
            stage("delivery_review", "交付复核", "标注仍需剪辑、混音和文字后期的内容。", true),
        ],
        defaultConfig: {},
        keywords: ["音乐MV", "动态字幕", "歌词视频", "节拍卡点", "音乐视觉"],
        ...source("music-video-subtitle-generator/SKILL.md", "0.6.6", "a2c0904632e8db52d2ffdcbaa21208331efd7447b9f34185e7a63a408ae0c848"),
    },
    {
        id: "minimax-h3-coop-game-intro",
        name: "双人游戏开场",
        description: "基于双人角色、游戏名称和视觉方向，先确认菜单首图再规划开场动效。",
        plannerSummary: "适用于双人合作游戏概念片；先锁定角色身份和菜单首图，再进入视频规划。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先收集两位玩家名称、游戏名称、视觉方向与可选角色参考；若有角色参考，分别锁定人物身份特征，不得混用两位角色或替换用户提供的名称。
先生成可审核的静态菜单视觉说明，明确角色位置、信息层级、色彩和非品牌化 UI 元素；用户确认首图前不得生成视频。文字、按钮和图标是否能在视频中准确呈现取决于当前模型能力，无法保证时必须标为后期需求。
不得复刻现有游戏的 Logo、菜单、角色或可识别界面；当前未实现完整 UI 动画与成片合成时，只输出确认首图方案和后续镜头计划。`,
        enabled: false,
        workspaces: ["video", "canvas"],
        nodeModes: [],
        action: "generate",
        requiresReference: false,
        modelConstraints: H3_PREFERRED,
        requiredAssetRoles: [role("player_one_reference", "玩家一角色参考", false, ["image"]), role("player_two_reference", "玩家二角色参考", false, ["image"])],
        stages: [
            stage("input_brief", "角色与菜单简报", "确认玩家名称、游戏名称和视觉方向。", true),
            stage("menu_preview", "菜单首图确认", "确认静态菜单布局、角色身份与信息层级。", true),
            stage("motion_plan", "开场动效计划", "确认镜头、交互节奏和待后期文字项。", true),
        ],
        defaultConfig: {},
        keywords: ["双人游戏", "游戏开场", "游戏菜单", "角色菜单", "合作游戏"],
        ...source("co-op-game-intro-generator/SKILL.md", "0.1.5", "8b49cf84a70fbbc99c661fdac2235cba7f7dd0bde51b639b6ed9c1679a707f5e"),
    },
    {
        id: "minimax-h3-paper-collage-explainer",
        name: "纸拼贴讲解",
        description: "把知识点、观点或叙述转成可审核的纸拼贴视觉隐喻与停格讲解方案。",
        plannerSummary: "适用于讲解类纸拼贴动画；先提炼内容与视觉隐喻，确认静帧后再规划纸片动作。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先提炼用户文案中的核心观点、知识路径和一个可读的纸拼贴视觉隐喻；每一镜只承载一个信息节拍。纸张纹理、剪裁边缘、分层投影、停格节奏和纸片物理运动必须在所有镜头中保持一致。
先提交制作计划与分镜，再提交关键静帧预览供确认；确认前不生成最终片段。默认不假设已经具备旁白、背景音乐、字幕或成片拼接能力，只有用户明确需求且运行时支持时才进入对应阶段。
避免把抽象话题变成无关的装饰性拼贴，不得把用户参考素材改造成不同人物、商品或场景。`,
        enabled: false,
        workspaces: ["video", "canvas"],
        nodeModes: [],
        action: "generate",
        requiresReference: false,
        modelConstraints: H3_PREFERRED,
        stages: [
            stage("content_plan", "内容与隐喻方案", "确认知识路径、视觉隐喻和目标受众。", true),
            stage("storyboard", "纸拼贴分镜", "确认每个信息节拍和纸片运动。", true),
            stage("still_preview", "纸拼贴静帧确认", "确认材质、层次、光线和角色/场景锚点。", true),
            stage("delivery_review", "交付复核", "标注需要额外音频或人工合成的内容。", true),
        ],
        defaultConfig: {},
        keywords: ["纸拼贴", "拼贴动画", "科普动画", "讲解视频", "停格动画"],
        ...source("paper-collage-explainer-generator/SKILL.md", "0.3.9", "2223d4b4ec6b2842db4252a83f00aa6c31e6daa5e8d020d9518e3a8743c47de0"),
    },
    {
        id: "minimax-h3-papercraft-stop-motion",
        name: "纸艺定格科普",
        description: "把知识主题发展为纸偶、分层纸雕布景、分镜和短视频提示词的阶段化制作方案。",
        plannerSummary: "适用于纸艺定格科普；先确认学习目标和视觉隐喻，再逐步产出布景、分镜与可执行素材计划。",
        instructions: `${sharedReferenceRules}
${stagedWorkflowGuard}
先确认知识主题、核心信息、受众、画幅和目标交付形式；为每个知识节拍设计一个可读的纸艺隐喻，并把角色、分层纸雕布景、道具和声音线索拆成可复用资产。
先提供有限数量的创意方向和视觉预览说明，用户确认后才制作分镜、单图或短视频提示词。纸张纤维、折痕、剪裁边缘、真实投影和克制定格运动必须跨镜一致；不得把纸艺风格退化为普通插画、光滑 CG 或无关真人镜头。
当前阶段确认和成片合成未接入时，只交付已确认阶段的创作包，不承诺自动生成多段视频、旁白、音乐或最终成片。`,
        enabled: false,
        workspaces: ["video", "canvas", "drama"],
        nodeModes: [],
        action: "generate",
        requiresReference: false,
        modelConstraints: H3_PREFERRED,
        stages: [
            stage("learning_goal", "学习目标与创意方向", "确认主题、受众和纸艺隐喻。", true),
            stage("asset_plan", "纸艺资产与布景", "确认角色、道具、分层布景和一致性锚点。", true),
            stage("visual_preview", "视觉预览确认", "确认纸艺材质、场景和关键机制。", true),
            stage("storyboard", "分镜与提示词包", "确认镜头、运镜、纸片动作和声音线索。", true),
        ],
        defaultConfig: {},
        keywords: ["纸艺定格", "纸雕科普", "立体书", "剪纸动画", "纸偶", "定格科普"],
        ...source("papercraft-stop-motion-explainer/SKILL.md", "0.6.5", "bf8b8e42acd91a0221335d3414abac6c1ad1fd9d8a452b0f7e08f2a973a4fbce"),
    },
];

export function cloneMinimaxH3OfficialStyleSkill(skill: AgentSkill): AgentSkill {
    return {
        ...skill,
        keywords: [...skill.keywords],
        workspaces: skill.workspaces ? [...skill.workspaces] : undefined,
        nodeModes: skill.nodeModes ? [...skill.nodeModes] : undefined,
        defaultConfig: skill.defaultConfig ? { ...skill.defaultConfig } : undefined,
        modelConstraints: skill.modelConstraints
            ? {
                  ...skill.modelConstraints,
                  requiredModelFamilies: skill.modelConstraints.requiredModelFamilies ? [...skill.modelConstraints.requiredModelFamilies] : undefined,
                  preferredModelFamilies: skill.modelConstraints.preferredModelFamilies ? [...skill.modelConstraints.preferredModelFamilies] : undefined,
              }
            : undefined,
        requiredAssetRoles: skill.requiredAssetRoles?.map((item) => ({ ...item, acceptedAssetTypes: [...item.acceptedAssetTypes] })),
        stages: skill.stages?.map((item) => ({ ...item })),
    };
}
