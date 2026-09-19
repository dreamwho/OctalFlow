import { inferModelCapability } from "@/lib/model-capability";
import { modelOptionName, resolveModelChannel, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import { IMAGE_NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasConnection, type CanvasInteriorDesignScene, type CanvasInteriorDesignSettings, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { CANVAS_NODE_GAP } from "./canvas-surface-geometry";

export const INTERIOR_DESIGN_PREVIEW_URL = "https://djxai.oss-cn-beijing.aliyuncs.com/uploads/1774437000895.gif";
export const INTERIOR_DESIGN_NODE_SIZE = { width: IMAGE_NODE_DEFAULT_SIZE.height, height: IMAGE_NODE_DEFAULT_SIZE.height } as const;

export type InteriorDesignOption = { label: string; value: string };

const option = (label: string, value = label): InteriorDesignOption => ({ label, value });
const options = (labels: string[]) => labels.map((label) => option(label));

export const INTERIOR_DESIGN_SCENES: Array<{ value: CanvasInteriorDesignScene; label: string }> = [
    { value: "interior", label: "室内" },
    { value: "interior-light", label: "室内+光影" },
    { value: "exterior", label: "室外" },
    { value: "enclosed", label: "封闭空间" },
];

export const INTERIOR_DESIGN_TABS = [
    { key: "generation", label: "生图模式" },
    { key: "scene", label: "场景" },
    { key: "lighting", label: "光影氛围" },
    { key: "camera", label: "摄影设备" },
    { key: "constraints", label: "AI约束" },
] as const;

export const INTERIOR_DESIGN_OPTIONS = {
    task: [
        option("SU真实摄影", "将SU模型截图转换为真实摄影照片，保留原始设计与空间关系"),
        option("酷家乐真实摄影", "将酷家乐效果图转换为真实摄影照片，保留原始设计与空间关系"),
        option("3Dmax真实摄影", "将3Dmax模型图转换为真实摄影照片，保留原始设计与空间关系"),
        option("SU写实效果图", "将SU模型截图转换为高质量写实效果图"),
        option("酷家乐写实效果图", "将酷家乐模型图转换为高质量写实效果图"),
        option("3Dmax写实效果图", "将3Dmax模型图转换为高质量写实效果图"),
        option("效果图真实摄影", "将现有效果图转换为真实摄影照片"),
        option("效果图写实", "将现有效果图优化为高质量写实效果图"),
    ],
    conversion: [option("PBR超写实", "真实摄影照片，使用PBR超写实物理材质与真实微瑕疵"), option("写实效果图", "高质量写实效果图，材质与光影自然")],
    spaceType: [
        option("平层", "平层家装室内空间"),
        option("LOFT", "LOFT复式室内空间"),
        option("别墅", "别墅住宅空间"),
        option("办公", "办公空间"),
        option("零售", "零售展示空间"),
        option("餐饮", "餐饮空间"),
        option("酒店", "酒店住宿空间"),
        option("教育医疗", "教育或医疗空间"),
        option("文化艺术", "文化艺术空间"),
        option("生产制造", "生产制造空间"),
        option("庭院", "庭院景观空间"),
        option("室外门头", "商业室外门头"),
        option("别墅外立面", "别墅建筑外立面"),
        option("通用室外", "通用室外建筑与景观空间"),
        option("工装封闭", "无自然采光的工装封闭空间"),
        option("地下室", "地下室封闭空间"),
    ],
    style: [
        option("现代室内", "现代室内设计，克制、实用、比例舒适"),
        option("现代室外", "现代建筑与景观设计，简洁利落"),
        ...options([
            "现代简约",
            "现代极简",
            "包豪斯",
            "意式极简",
            "现代轻奢",
            "现代原木",
            "轻法式",
            "古典法式",
            "现代欧式",
            "奶油法式",
            "法式轻奢",
            "美式",
            "地中海",
            "新古典",
            "巴洛克",
            "洛可可",
            "新中式",
            "宋式新中式",
            "禅意新中式",
            "传统明清中式",
            "现代北欧",
            "原木北欧",
            "北欧轻奢",
            "现代日式",
            "原木日式",
            "侘寂",
            "日式禅意",
            "奶油风",
        ]),
    ],
    exteriorView: [
        option("高层小区", "小区外景，16楼以上视角"),
        option("小区中层", "小区外景，4至15楼视角"),
        option("小区低层", "小区外景，1至3楼视角"),
        option("江景"),
        option("湖景"),
        option("海景"),
        option("山景"),
        option("公园绿植"),
        option("田园"),
        option("天空"),
        option("城市天际线"),
        option("城市夜景"),
        option("老街区"),
        option("校园"),
        option("禅意庭院"),
        option("湿地"),
        option("山谷"),
        option("雪景"),
        option("别墅自建房", "别墅或自建房室外背景"),
        option("别墅庭院"),
        option("商铺门头"),
        option("无外景", "封闭空间，不出现窗外景观"),
    ],
    location: options(["自动", "哈尔滨", "乌鲁木齐", "北京", "西安", "上海", "杭州", "南京", "长沙", "成都", "重庆", "昆明", "广州", "海口", "台北", "封闭空间"]),
    season: options(["自动", "春季", "夏季", "秋季", "冬季"]),
    weather: options(["自动", "晴天", "阴天", "雾天", "雨天", "雪天", "有风"]),
    time: options(["凌晨2点", "黎明4点", "清晨6点", "上午9点", "中午12点", "下午16点", "夕阳17点", "傍晚18点", "晚上19点", "夜晚20点", "深夜24点"]),
    curtain: options(["保持原图窗帘", "单层纱帘（关闭）", "单层纱帘（打开）", "双层窗帘（打开）", "香格里拉帘", "梦幻帘", "无窗帘"]),
    sunlight: options(["无太阳光", "香格里拉帘光影", "梦幻帘光影", "纱帘光影", "树影斑驳", "丁达尔效应", "顶部光斑", "室外晴天树影", "室外阴天漫射光"]),
    indoorLight: options(["仅自然光", "天花灯全开", "室内光全开", "仅氛围灯", "封闭空间人工照明"]),
    colorTemperature: options(["冷白光 6000K", "中性光 4500K", "暖白光 3500K", "暖黄光 2800K"]),
    postTone: options(["原生中性微暖", "暖调纪实", "冷调纪实", "电影胶片", "白色中性平衡", "浅青色中性平衡"]),
    lightingQuality: options(["柔和纪实影调", "温润柔焦影调", "清透硬朗影调", "电影质感影调", "自然纪实影调"]),
    camera: options(["Fujifilm GFX100S", "Hasselblad X2D 100C", "Nikon Z9", "Sony A7R V", "Leica M11", "Canon EOS R5", "iPhone 17 Pro Max"]),
    aperture: options(["f/1.4", "f/2.8", "f/5.6", "f/8", "f/11", "手机 f/1.6"]),
    shutter: options(["1/1000s", "1/250s", "1/30s", "1s", "5s", "30s", "手机 1/15s", "手机 1/60s"]),
    iso: options(["ISO 50", "ISO 100", "ISO 200", "ISO 400", "ISO 800", "ISO 1600"]),
    focalLength: [option("13mm 超广角", "13mm超广角镜头"), option("24mm 空间", "24mm广角空间摄影"), option("28mm 卧室", "28mm自然视角"), option("48mm 细节", "48mm空间细节摄影"), option("90mm 长焦", "90mm长焦压缩"), option("135mm 长焦", "135mm长焦压缩")],
    techniques: options(["单张直出", "原画质直出（保留真实瑕疵）", "HDR包围曝光", "移轴矫正", "三脚架长曝光"]),
    geometry: [option("强制几何保真", "强制几何保真，不改变墙体、门窗、结构与物体位置"), option("允许局部微调", "基本保持几何关系，允许局部微调"), option("硬装不动", "禁止改动硬装，可优化家具布局")],
    objectIntegrity: [
        option("物体完全一致", "所有原有物体完整一致，不增删、不替换"),
        option("仅增加软装", "原有物体保持一致，仅允许增加软装"),
        option("可替换软装", "硬装保持一致，允许替换软装"),
        option("结构不动", "整体结构保持一致，允许替换软装与局部硬装材质"),
    ],
    materialIntegrity: [option("材质完全还原", "材质完整一致，保持原有颜色、纹理与分区"), option("PBR材质优化", "保持材质类别与颜色关系，允许优化为PBR真实材质")],
    aspectRatio: [option("保持原图", "auto"), option("16:9"), option("4:3"), option("1:1"), option("3:4"), option("9:16")],
    resolution: options(["8K", "4K"]),
} as const;

const baseDefaults: Omit<CanvasInteriorDesignSettings, "scene"> = {
    task: INTERIOR_DESIGN_OPTIONS.task[0].value,
    conversion: INTERIOR_DESIGN_OPTIONS.conversion[0].value,
    spaceType: INTERIOR_DESIGN_OPTIONS.spaceType[0].value,
    style: INTERIOR_DESIGN_OPTIONS.style[0].value,
    exteriorView: INTERIOR_DESIGN_OPTIONS.exteriorView[0].value,
    location: "西安",
    season: "夏季",
    weather: "晴天",
    time: "上午9点",
    curtain: "保持原图窗帘",
    mainLight: true,
    artificialLight: false,
    sunlight: "无太阳光",
    indoorLight: "仅自然光",
    colorTemperature: "中性光 4500K",
    postTone: "原生中性微暖",
    lightingQuality: "自然纪实影调",
    camera: "Hasselblad X2D 100C",
    aperture: "f/8",
    shutter: "1s",
    iso: "ISO 100",
    focalLength: "24mm广角空间摄影",
    techniques: ["单张直出"],
    geometry: INTERIOR_DESIGN_OPTIONS.geometry[0].value,
    objectIntegrity: INTERIOR_DESIGN_OPTIONS.objectIntegrity[0].value,
    materialIntegrity: INTERIOR_DESIGN_OPTIONS.materialIntegrity[0].value,
    aspectRatio: "auto",
    resolution: "8K",
};

export function createInteriorDesignSettings(scene: CanvasInteriorDesignScene = "interior"): CanvasInteriorDesignSettings {
    const common = { ...baseDefaults, techniques: [...baseDefaults.techniques] };
    if (scene === "interior-light") return { ...common, scene, curtain: "单层纱帘（关闭）", sunlight: "纱帘光影" };
    if (scene === "exterior") {
        return {
            ...common,
            scene,
            spaceType: valueFor("spaceType", "通用室外"),
            style: valueFor("style", "现代室外"),
            exteriorView: valueFor("exteriorView", "别墅自建房"),
            season: "自动",
            mainLight: false,
            sunlight: "室外晴天树影",
            indoorLight: "室内光全开",
            colorTemperature: "暖白光 3500K",
            shutter: "5s",
        };
    }
    if (scene === "enclosed") {
        return {
            ...common,
            scene,
            spaceType: valueFor("spaceType", "工装封闭"),
            exteriorView: valueFor("exteriorView", "无外景"),
            location: "封闭空间",
            time: "晚上19点",
            mainLight: false,
            artificialLight: true,
            sunlight: "无太阳光",
            indoorLight: "封闭空间人工照明",
            colorTemperature: "暖白光 3500K",
        };
    }
    return { ...common, scene };
}

export function compileInteriorDesignPrompt(settings: CanvasInteriorDesignSettings) {
    const result: Record<string, Record<string, string | string[] | boolean>> = {};
    addSection(result, "生图模式", {
        图生图任务: settings.task,
        转换逻辑: settings.conversion,
    });
    addSection(result, "场景设计", {
        场景类型: sceneLabel(settings.scene),
        空间类型: settings.spaceType,
        设计风格: settings.style,
        外景类型: settings.exteriorView,
        地点: settings.location,
    });
    addSection(result, "光影氛围", {
        季节: settings.season,
        天气: settings.weather,
        时间段: settings.time,
        窗帘类型: settings.curtain,
        ...(settings.mainLight ? { 主进光口控制: "开启并遵循场景中的真实主进光方向" } : {}),
        ...(settings.artificialLight ? { 人工主光源: "开启并以真实室内灯具作为主光源" } : {}),
        太阳光光影: settings.sunlight,
        室内光: settings.indoorLight,
        室内灯光色温: settings.colorTemperature,
        后期色调: settings.postTone,
        光影品质: settings.lightingQuality,
    });
    addSection(result, "摄影参数", {
        相机: settings.camera,
        光圈: settings.aperture,
        快门: settings.shutter,
        感光度: settings.iso,
        焦距: settings.focalLength,
        摄影技法: settings.techniques,
    });
    addSection(result, "核心约束", {
        几何保真: settings.geometry,
        物体完整性: settings.objectIntegrity,
        材质完整性: settings.materialIntegrity,
    });
    addSection(result, "出图参数", {
        画面比例: settings.aspectRatio === "auto" ? "100%保持原图比例" : settings.aspectRatio,
        目标精度: settings.resolution,
    });
    return JSON.stringify(result, null, 4);
}

export function interiorDesignNodePatch(settings: CanvasInteriorDesignSettings, model: string, generation?: Pick<CanvasNodeMetadata, "size" | "sizeUserSelected" | "quality" | "count">): CanvasNodeMetadata {
    const size = generation?.size || settings.aspectRatio;
    return {
        configKind: "interior-design",
        interiorDesign: settings,
        generationMode: "image",
        model,
        size,
        sizeUserSelected: generation?.sizeUserSelected ?? size !== "auto",
        quality: generation?.quality || "high",
        count: Math.max(1, Math.floor(Number(generation?.count) || 1)),
        sourcePrompt: "SU直出摄影级照片",
        executionPrompt: compileInteriorDesignPrompt(settings),
        status: "idle",
    };
}

export function createInteriorDesignConfigNode(input: { source: CanvasNodeData; nodes: CanvasNodeData[]; settings: CanvasInteriorDesignSettings; model: string; nodeId: string; connectionId: string }): {
    node: CanvasNodeData;
    connection: CanvasConnection;
} {
    const size = INTERIOR_DESIGN_NODE_SIZE;
    const draft: CanvasNodeData = {
        id: input.nodeId,
        type: CanvasNodeType.Config,
        title: "室内设计",
        position: { x: 0, y: 0 },
        width: size.width,
        height: size.height,
        metadata: { content: "", ...interiorDesignNodePatch(input.settings, input.model) },
    };
    const preferredY = input.source.position.y + (input.source.height - draft.height) / 2;
    const rightEdge = Math.max(
        input.source.position.x + input.source.width,
        ...input.nodes.filter((node) => node.id !== input.source.id && preferredY < node.position.y + node.height + CANVAS_NODE_GAP && preferredY + draft.height + CANVAS_NODE_GAP > node.position.y).map((node) => node.position.x + node.width),
    );
    return {
        node: {
            ...draft,
            position: { x: rightEdge + CANVAS_NODE_GAP, y: preferredY },
        },
        connection: { id: input.connectionId, fromNodeId: input.source.id, toNodeId: input.nodeId },
    };
}

export function isInteriorDesignNode(metadata?: CanvasNodeMetadata | null) {
    return metadata?.configKind === "interior-design";
}

export function interiorDesignModels(config: AiConfig) {
    return selectableModelsByCapability(config, "image").filter((model) => {
        if (inferModelCapability(modelOptionName(model)) !== "image") return false;
        const channel = resolveModelChannel(config, model);
        const request = resolveModelRequestConfig(config, model);
        const protocol = request.advancedConfig?.protocol || channel.advancedConfig?.protocol;
        if (channel.id !== "geminiai" && protocol !== "geminiai") return false;
        return /nano[-_.\s]?banana|gemini.*image|image.*gemini/i.test(`${modelOptionName(model)} ${request.model}`);
    });
}

export function isInteriorDesignModel(config: AiConfig, model: string) {
    return Boolean(model && interiorDesignModels(config).includes(model));
}

export function interiorDesignOptionLabel(key: keyof typeof INTERIOR_DESIGN_OPTIONS, value: string) {
    return INTERIOR_DESIGN_OPTIONS[key].find((item) => item.value === value)?.label || value;
}

function valueFor(key: keyof typeof INTERIOR_DESIGN_OPTIONS, label: string) {
    return INTERIOR_DESIGN_OPTIONS[key].find((item) => item.label === label)?.value || label;
}

function sceneLabel(scene: CanvasInteriorDesignScene) {
    return INTERIOR_DESIGN_SCENES.find((item) => item.value === scene)?.label || "室内";
}

function addSection(target: Record<string, Record<string, string | string[] | boolean>>, title: string, fields: Record<string, string | string[] | boolean | undefined>) {
    const normalized = Object.fromEntries(Object.entries(fields).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : typeof value === "string" ? Boolean(value.trim()) : value !== undefined))) as Record<string, string | string[] | boolean>;
    if (Object.keys(normalized).length) target[title] = normalized;
}
