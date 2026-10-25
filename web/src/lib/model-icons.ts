import type { LogicalModelCapability, ModelIconKey } from "@/lib/auth/store-types";
import { inferModelCapability } from "@/lib/model-capability";

export const modelIconOptions: Array<{ label: string; value: ModelIconKey }> = [
    { label: "Nano Banana", value: "nanobanana" },
    { label: "豆包", value: "doubao" },
    { label: "Gemini", value: "gemini" },
    { label: "即梦", value: "jimeng" },
    { label: "OpenAI", value: "openai" },
    { label: "Claude", value: "claude" },
    { label: "DeepSeek", value: "deepseek" },
    { label: "智谱 GLM", value: "glm" },
    { label: "Grok", value: "grok" },
    { label: "MiniMax", value: "minimax" },
    { label: "通义千问", value: "qwen" },
];

const iconPaths: Record<ModelIconKey, string> = {
    nanobanana: "/icons/nanobanana.svg",
    doubao: "/icons/doubao.svg",
    gemini: "/icons/gemini.svg",
    jimeng: "/icons/jimeng.svg",
    openai: "/icons/openai.svg",
    claude: "/icons/claude.svg",
    deepseek: "/icons/deepseek.svg",
    glm: "/icons/glm.svg",
    grok: "/icons/grok.svg",
    minimax: "/icons/minimax.svg",
    qwen: "/icons/qwen.svg",
};

const validIconKeys = new Set<string>(modelIconOptions.map(({ value }) => value));

// 沿用后台品牌图片上传的 300KB 资源契约，图标随模型设置持久化。
export const MODEL_ICON_MAX_BYTES = 300 * 1024;
export const MODEL_ICON_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];

export function normalizeModelIconUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const url = value.trim();
    if (url.length > Math.ceil(MODEL_ICON_MAX_BYTES / 3) * 4 + "data:image/vnd.microsoft.icon;base64,".length) return undefined;
    const match = /^data:(image\/[a-z.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || !MODEL_ICON_MIME_TYPES.includes(match[1])) return undefined;
    try {
        return atob(match[2]).length <= MODEL_ICON_MAX_BYTES ? url : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeModelIconKey(value: unknown): ModelIconKey | undefined {
    return typeof value === "string" && validIconKeys.has(value) ? (value as ModelIconKey) : undefined;
}

export function resolveModelIconPath(model: string, capability?: LogicalModelCapability, icon?: ModelIconKey, providerHint = "") {
    if (icon) return iconPaths[icon];
    const name = `${model} ${providerHint}`.toLowerCase();
    const modelCapability = capability || inferModelCapability(model);
    if (modelCapability === "image" && /gemini|google|imagen|nano[-_.\s]?banana/.test(name)) return iconPaths.nanobanana;
    if ((modelCapability === "image" || modelCapability === "video") && /bytedance|byte dance|doubao|豆包|字节|火山|seedream|seedance|dreamina|jimeng|即梦/.test(name)) return iconPaths.doubao;
    if (name.includes("minimax") || name.includes("hailuo") || name.includes("海螺") || /(?:^|[-_ ])(?:speech|music)-/i.test(name)) return iconPaths.minimax;
    if (/seedance|seedream|dreamina|jimeng|即梦/.test(name)) return iconPaths.jimeng;
    if (name.includes("claude") || name.includes("anthropic")) return iconPaths.claude;
    if (name.includes("gemini") || name.includes("google") || name.includes("imagen") || name.includes("veo")) return iconPaths.gemini;
    if (name.includes("gpt") || name.includes("openai")) return iconPaths.openai;
    if (name.includes("grok")) return iconPaths.grok;
    if (name.includes("deepseek")) return iconPaths.deepseek;
    if (name.includes("glm")) return iconPaths.glm;
    if (name.includes("qwen") || name.includes("aliyun") || name.includes("bailian") || name.includes("cosyvoice")) return iconPaths.qwen;
    return undefined;
}
