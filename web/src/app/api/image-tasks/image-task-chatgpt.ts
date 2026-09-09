import type { ImageTaskConfig } from "@/lib/server/image-task-store";

// GPTAPI（chatgpt-api）渠道的画质即导出规格：
// 低 = 上游原生档位直接交付；中 = 生成后本地放大到 2K；高 = 生成后本地放大到 4K。
export function isChatGptApiImageTaskConfig(config: Pick<ImageTaskConfig, "advancedConfig">) {
    return config.advancedConfig?.protocol === "chatgpt-api";
}

export function chatGptApiExportUpscaleLongEdge(quality: string | undefined): number | undefined {
    if (quality === "medium") return 2048;
    if (quality === "high") return 3840;
    return undefined;
}
