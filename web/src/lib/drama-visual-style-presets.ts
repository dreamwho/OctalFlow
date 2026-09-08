export type DramaVisualStylePreset = {
    id: string;
    label: string;
    shortDescription: string;
    shotLanguage: string;
    colorGrade: string;
    capture: string;
    productionDesign: string;
};

export const DEFAULT_DRAMA_VISUAL_STYLE_ID = "cinematic-realism";

export const DRAMA_VISUAL_STYLE_PRESETS: DramaVisualStylePreset[] = [
    {
        id: "cinematic-realism",
        label: "电影写实",
        shortDescription: "克制运镜、自然表演与电影级动态范围",
        shotLanguage: "以建立镜头、中近景和细节特写构成清晰叙事，运镜克制，轴线与视线连续，景深服务人物关系",
        colorGrade: "低饱和中性色，柔和高光滚降，肤色自然，暗部保留层次，轻微电影颗粒",
        capture: "ARRI Alexa Mini LF 质感，Cooke S7/i 镜头语言，24/35/50/85mm 依据景别切换",
        productionDesign: "真实可用的空间、材质与生活痕迹，陈设围绕人物行动组织，避免过度舞台化",
    },
    {
        id: "vertical-drama",
        label: "竖版短剧",
        shortDescription: "9:16 强人物、快节奏、手机端高信息密度",
        shotLanguage: "主体集中在竖幅安全区，以近景、特写和正反打为主，前 2 秒建立冲突，每个镜头只承担一个清晰信息点",
        colorGrade: "明快通透、人物肤色优先、局部对比明确，重要表情和道具具有视觉聚焦",
        capture: "Sony Venice 2 竖幅裁切，35/50/85mm 人像镜头，稳定器与短距离推拉结合",
        productionDesign: "前中后景层次简洁，关键人物与道具避免字幕区，场景识别信息集中且易读",
    },
    {
        id: "hong-kong-poetic",
        label: "香港都市诗意",
        shortDescription: "霓虹、错位构图、慢快门与暧昧情绪",
        shotLanguage: "隔着玻璃、门框或镜面观察人物，使用偏心构图、碎片化特写、手持跟随与偶发抽帧，留出情绪停顿",
        colorGrade: "青绿阴影与暖红霓虹形成综合色偏，浓郁饱和，潮湿高光，暗部带轻微胶片噪点",
        capture: "Kodak 35mm 胶片响应，Vintage Leica R 镜头，28/35/50mm，允许轻微拖影和呼吸感",
        productionDesign: "狭窄城市空间、反射表面、旧招牌与层叠前景，色彩承担人物距离和情绪变化",
    },
    {
        id: "american-action",
        label: "美国动作片",
        shortDescription: "强动势、硬光、高对比与精确动作连续性",
        shotLanguage: "广角建立空间后快速切入中近景，低机位、跟拍、甩镜与冲击点特写交替，动作方向和空间轴线始终明确",
        colorGrade: "冷暖分离、高对比、金属与火光高光突出，黑位扎实但保留动作细节",
        capture: "RED V-Raptor 高帧率质感，Atlas Anamorphic 镜头，18/24/35/65mm，稳定器、车载与肩扛组合",
        productionDesign: "尺度清晰的动作场地、可交互障碍和可信破坏痕迹，服装与道具轮廓利于快速识别",
    },
    {
        id: "shaw-brothers",
        label: "邵氏武侠",
        shortDescription: "棚拍美学、戏曲身段、对称构图与复古色彩",
        shotLanguage: "正面全景展示身段和阵势，中景交代招式，快速推拉与定格式特写强化出招节点，构图强调对称和舞台层次",
        colorGrade: "浓郁复古红绿金配色，暖肤色、轻微胶片褪色与柔焦高光",
        capture: "35mm 复古胶片响应，35/50/75mm 定焦，摇臂、轨道和快速变焦形成经典棚拍节奏",
        productionDesign: "写意棚景、层叠布景、烟雾与轮廓光，服化道色块鲜明，保留传统武侠舞台感",
    },
    {
        id: "live-vlog",
        label: "真人 Vlog",
        shortDescription: "手机手持、自然光、即兴交流与生活颗粒",
        shotLanguage: "自拍开场、第一人称观察、手持跟随和环境插镜交替，保留自然微抖、呼吸停顿与真实视线交流",
        colorGrade: "自然白平衡、轻微 HDR、肤色真实，保留环境混合光与不过度磨皮的皮肤纹理",
        capture: "iPhone 17 Pro 手持写实拍摄，主摄 24mm 与 48mm 等效视角切换，计算摄影克制，收音贴近现场",
        productionDesign: "使用真实生活空间与可操作物件，保留轻微凌乱和偶发遮挡，不做广告棚拍式过度陈列",
    },
    {
        id: "cinematic-guoman",
        label: "电影感国漫",
        shortDescription: "东方叙事、电影级光影与精致动画构图",
        shotLanguage: "用大景建立东方空间尺度，以中近景和情绪特写推进人物关系，镜头运动稳健并保持动作关键帧清晰",
        colorGrade: "东方矿物色与低饱和环境色结合，体积光、柔和高光和层次分明的冷暖关系",
        capture: "模拟大画幅电影机与变形宽银幕镜头，依据画幅使用 24/35/50/85mm 电影景别",
        productionDesign: "东方建筑、服饰与器物结构可信，材质细节统一，环境叙事服务剧情且避免无意义装饰堆叠",
    },
];

export function getDramaVisualStylePreset(id?: string, style?: string) {
    return DRAMA_VISUAL_STYLE_PRESETS.find((item) => item.id === id) || DRAMA_VISUAL_STYLE_PRESETS.find((item) => item.label === style) || DRAMA_VISUAL_STYLE_PRESETS.find((item) => item.id === DEFAULT_DRAMA_VISUAL_STYLE_ID)!;
}

export function dramaVisualStylePrompt(style?: string, presetId?: string) {
    const preset = getDramaVisualStylePreset(presetId, style);
    const customStyle = style?.trim() && style.trim() !== preset.label ? `补充风格：${style.trim()}。` : "";
    return [
        `统一风格：${style?.trim() || preset.label}`,
        `视觉风格：${preset.label}。${customStyle}`,
        `镜头语言：${preset.shotLanguage}。`,
        `调色：${preset.colorGrade}。`,
        `拍摄设备与光学：${preset.capture}。`,
        `美术设计：${preset.productionDesign}。`,
    ].join("\n");
}
