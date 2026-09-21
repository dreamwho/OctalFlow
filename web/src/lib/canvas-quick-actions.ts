/** 画布功能菜单：后台可运营的快捷生成动作（分组 → 条目），
 *  前端在图片节点右键菜单 / 悬浮工具栏 / 功能弹窗中数据驱动渲染。 */

export type CanvasQuickActionCapability = "image" | "video" | "audio" | "text";

export type CanvasQuickActionDefaults = {
    /** 图片/视频比例，例如 "16:9" */
    size?: string;
    /** 图片画质（high/medium/standard）或视频清晰度（480p/720p/1080p） */
    quality?: string;
    /** 图片生成数量 */
    count?: string;
    /** 视频时长（秒） */
    videoSeconds?: number;
    /** 视频是否生成音效 */
    generateAudio?: boolean;
};

export type CanvasQuickActionItem = {
    id: string;
    name: string;
    prompt: string;
    capability: CanvasQuickActionCapability;
    enabled: boolean;
    defaults: CanvasQuickActionDefaults;
};

export type CanvasQuickActionGroup = {
    id: string;
    name: string;
    enabled: boolean;
    sortOrder: number;
    actions: CanvasQuickActionItem[];
};

/** 预置条目：人物三视图（原画布硬编码提示词，迁移为后台可维护的种子数据） */
export const CHARACTER_THREE_VIEW_PROMPT = `根据参考图生成角色资产三视图与超写实设计图，纯白无缝背景，无任何地平线、参考线与阴影，四面板水平排版：

【左侧三视图·三个站姿身长比例完全等大，脚底水平对齐】：

- 面板一：完整全身正面站姿（颈部以下至脚底，完整显示双腿、裤长与完整鞋子。仅头部不画且上方留出大片白底，躯干与衣服比例严格与侧面/背面一致，严禁截断下肢）
- 面板二：从头到脚完整全身侧面站姿
- 面板三：从头到脚完整全身背面站姿

【右侧正面肖像·胸部以上半身人像景别】：
正面直视镜头，包含完整锁骨、脖颈、全脸及完整顶部发髻。超真实的皮肤纹理，极具真实呼吸感，带有真实可见的毛孔、自然生理微细节，水润清新的肤色，通透皮肤下透出鼻翼微弱红润与微细血管，脸颊边缘带有微小面部绒毛。精细描绘的睫毛带有清晰的眼神光，眼神亲密而平静。虹膜纤维清晰、眼睛湿润有真实反光、睫毛根根分明，浓密眉毛略带杂毛，嘴唇柔软自然带有轻微原生唇纹，呈自然的粉红色，带有微妙的纹理，没有浓妆。

使用 100mm 微距镜头以 f/2.8 拍摄的极限微距照片，景深极浅，焦点锐利地落在眼睛上，鼻部和嘴唇平滑地虚化。未经磨皮滤镜、自然面部结构、真实发丝和胡茬细节、克制色彩、宽容度高、眼部焦点极其锐利、自然解剖准确、无美颜滤镜、获奖级编辑摄影。面部瑕疵真实可见。纯白极简空间，完全无地面线条。`;

export const DEFAULT_CANVAS_QUICK_ACTIONS: CanvasQuickActionGroup[] = [
    {
        id: "storyboard-master",
        name: "分镜大师",
        enabled: true,
        sortOrder: 0,
        actions: [
            {
                id: "character-three-view",
                name: "人物三视图",
                prompt: CHARACTER_THREE_VIEW_PROMPT,
                capability: "image",
                enabled: true,
                defaults: { size: "16:9", quality: "high" },
            },
        ],
    },
];

export const CANVAS_QUICK_ACTION_CAPABILITIES: readonly CanvasQuickActionCapability[] = ["image", "video", "audio", "text"];

export function normalizeCanvasQuickActionCapability(value: unknown): CanvasQuickActionCapability {
    return CANVAS_QUICK_ACTION_CAPABILITIES.includes(value as CanvasQuickActionCapability) ? (value as CanvasQuickActionCapability) : "image";
}

function normalizeDefaults(value: unknown): CanvasQuickActionDefaults {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const defaults: CanvasQuickActionDefaults = {};
    if (typeof source.size === "string" && source.size.trim()) defaults.size = source.size.trim().slice(0, 40);
    if (typeof source.quality === "string" && source.quality.trim()) defaults.quality = source.quality.trim().slice(0, 40);
    if (typeof source.count === "string" && source.count.trim()) defaults.count = source.count.trim().slice(0, 10);
    if (Number.isFinite(Number(source.videoSeconds)) && Number(source.videoSeconds) > 0) defaults.videoSeconds = Math.min(60, Math.floor(Number(source.videoSeconds)));
    if (typeof source.generateAudio === "boolean") defaults.generateAudio = source.generateAudio;
    return defaults;
}

/** 后台保存与读取共用：丢弃无名/无提示词条目，字段全部收敛到安全形态 */
export function normalizeCanvasQuickActionGroups(value: unknown): CanvasQuickActionGroup[] {
    if (!Array.isArray(value)) return [];
    const groups: CanvasQuickActionGroup[] = [];
    value.forEach((rawGroup, groupIndex) => {
        if (!rawGroup || typeof rawGroup !== "object") return;
        const group = rawGroup as Record<string, unknown>;
        const name = typeof group.name === "string" ? group.name.trim().slice(0, 40) : "";
        if (!name) return;
        const actions: CanvasQuickActionItem[] = [];
        if (Array.isArray(group.actions)) {
            group.actions.forEach((rawAction) => {
                if (!rawAction || typeof rawAction !== "object") return;
                const action = rawAction as Record<string, unknown>;
                const actionName = typeof action.name === "string" ? action.name.trim().slice(0, 60) : "";
                const prompt = typeof action.prompt === "string" ? action.prompt.trim() : "";
                if (!actionName || !prompt) return;
                actions.push({
                    id: typeof action.id === "string" && action.id.trim() ? action.id.trim().slice(0, 80) : `action-${groupIndex}-${actions.length}`,
                    name: actionName,
                    prompt,
                    capability: normalizeCanvasQuickActionCapability(action.capability),
                    enabled: action.enabled !== false,
                    defaults: normalizeDefaults(action.defaults),
                });
            });
        }
        groups.push({
            id: typeof group.id === "string" && group.id.trim() ? group.id.trim().slice(0, 80) : `group-${groupIndex}`,
            name,
            enabled: group.enabled !== false,
            sortOrder: Number.isFinite(Number(group.sortOrder)) ? Math.floor(Number(group.sortOrder)) : groupIndex,
            actions,
        });
    });
    return groups.sort((left, right) => left.sortOrder - right.sortOrder);
}
