import type { GeminiAiAccount, GeminiAiCapability, GeminiAiModel } from "@/services/api/geminiai";

const testCapabilities = new Set<GeminiAiCapability>(["text", "image", "video", "search"]);

export const geminiAiTestTabs: Array<{ capability: GeminiAiCapability; label: string; description: string }> = [
    { capability: "text", label: "文本", description: "向已声明文本能力的模型发送一次真实请求。" },
    { capability: "image", label: "图片", description: "生成并直接展示本次上游返回的全部图片。" },
    { capability: "video", label: "视频", description: "仅使用已保存的官方 Gemini/Veo 渠道，不由 AI Studio 账号冒充提供。" },
    { capability: "search", label: "Google 搜索", description: "使用模型已声明的 Google 搜索能力并展示来源。" },
];

export function geminiAiModelCapabilities(model: GeminiAiModel) {
    const capabilities = new Set<GeminiAiCapability>();
    const values = Array.isArray(model.capabilities) ? model.capabilities : model.capability ? [model.capability] : [];
    values.forEach((value) => {
        if (testCapabilities.has(value)) capabilities.add(value);
    });
    if (model.supportsSearch) capabilities.add("search");
    return Array.from(capabilities);
}

export function geminiAiModelsForCapability(models: GeminiAiModel[], capability: GeminiAiCapability) {
    return models.filter((model) => model.enabled !== false && geminiAiModelCapabilities(model).includes(capability));
}

export function geminiAiSelectableModels(models: GeminiAiModel[]) {
    return models.filter((model) => model.source === "geminiai");
}

export function geminiAiSelectedModelIds(models: GeminiAiModel[]) {
    return geminiAiSelectableModels(models)
        .filter((model) => model.enabled === true)
        .map((model) => model.id);
}

export function geminiAiModelLabel(model: GeminiAiModel) {
    return model.name || model.id;
}

export function geminiAiAccountUsage(account: GeminiAiAccount) {
    if (typeof account.usage === "string") return account.usage;
    if (account.usage?.label) return account.usage.label;
    const { used, limit, remaining } = account.usage || {};
    if (used !== undefined && limit !== undefined) return `${used}/${limit}`;
    if (remaining !== undefined) return `剩余 ${remaining}`;
    return "—";
}

export function geminiAiStatusText(status?: string) {
    if (status === "active") return "当前使用";
    if (status === "ready" || status === "healthy" || status === "available") return "可用";
    if (status === "pending") return "授权中";
    if (status === "failed" || status === "error") return "异常";
    if (status === "disabled") return "已停用";
    return status || "未知";
}
