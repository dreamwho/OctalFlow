import type { AgentSkill } from "@/lib/auth/store-types";

export const CHARACTER_CASTING_SKILL: AgentSkill = {
    id: "skill-character-casting",
    name: "演员建立",
    description: "从人物基础信息建立自然可信的演员肖像，并按明确需求生成头肩肖像或人物三视图。",
    plannerSummary: "需要创建演员肖像、头肩广告或影视角色设计时生成单人物图；只有明确提出三视图、白底角色图或角色拆解时才生成三视图。",
    enabled: true,
    keywords: ["演员建立", "演员肖像", "人物肖像", "头肩肖像", "广告肖像", "影视角色设计", "角色三视图", "人物三视图", "白底角色图", "角色拆解", "character turnaround", "three-view character sheet"],
    workspaces: ["image", "canvas"],
    nodeModes: ["image"],
    action: "generate",
    requiresReference: false,
    previewImageUrl: "/skills/previews/character-casting-studio.png",
    defaultConfig: { size: "16:9", quality: "high", count: 1, promptOptional: true },
    sourceUrl: "https://github.com/dacnay816y62-hub/character-casting-studio-skill",
    sourceRepository: "dacnay816y62-hub/character-casting-studio-skill",
    sourcePath: "SKILL.md",
    instructions: `1. 默认先生成一张单人物图，重点处理脸型、五官和真实骨相、角色气质、发型发质、妆容、年龄、身份、服装、配饰、摄影质感、光线和背景；不得未经用户明确要求自动生成三视图、四视图、白底角色卡或信息栏。
2. 提示词区域优先补充人物基础信息：年龄、身份或职业、脸型、五官、发型、发质、肤色、气质、服装、配饰、姿态、情绪和场景；用户只给出部分信息时保留其明确内容，不擅自改变人物意图。
3. 当用户要求“头肩照片”“头肩肖像”“广告肖像”“影视角色设计”或“演员 casting 照片”时，使用头部至上胸构图，双肩可见，完整保留发型、耳饰、项链和衣领等身份信息。
4. 头肩肖像采用 85–105mm 人像镜头感，眼睛精准对焦，浅景深和自然背景虚化，脸部清晰、曝光准确，表情自然克制，不做过度摆拍。
5. 只有用户明确提出“做三视图”“生成人物三视图”“白底角色图”“角色拆解”“character turnaround”或“three-view character sheet”等要求时，才进入三视图流程。
6. 三视图流程输出纯白无缝背景、无地平线、无参考线、无阴影的角色设定图，正面、侧面、背面站姿从头到脚完整显示，脚底水平对齐，三个视图的身长比例、脸部身份、发型、服装结构和配饰保持一致。
7. 三视图右侧可补充正面胸部以上肖像；肖像需要完整显示锁骨、脖颈、全脸和顶部发型，眼部锐利对焦，保留毛孔、细微血管、面部绒毛、睫毛、虹膜纤维和自然唇纹，不使用磨皮、美颜或浓妆。
8. 视觉质量以真实摄影为基准：自然皮肤纹理、准确人体解剖、真实发丝和材质细节、克制色彩、高宽容度、合理景深；可采用 100mm 微距镜头、f/2.8 和极浅景深表现面部细节，但不要让镜头参数压过人物需求。
9. 避免蜡像皮肤、塑料高光、同质化网红脸、过度磨皮、无依据的奢华服装、随机配饰、缺失鞋子或下肢截断；参考图存在时优先保持可辨识身份和用户明确要求的特征。
10. 交付前检查生成模式是否由用户意图触发，单人物图没有意外多视图，头肩图双肩和身份信息完整，三视图没有比例漂移、裁切、姿势不一致、重复人物或多余文字水印。`,
};
