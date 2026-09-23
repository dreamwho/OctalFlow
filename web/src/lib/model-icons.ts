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
