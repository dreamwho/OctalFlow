import { imageRequestAspectRatio } from "./image-task-size";

export type GeminiAiImageRequestFields = {
    aspect_ratio?: string;
    image_size: "1K" | "2K" | "4K";
    google_search: false;
    image_search: false;
};

export function geminiAiImageRequestFields(config: { quality?: string; size?: string; advancedConfig?: { protocol?: string } }): GeminiAiImageRequestFields | Record<string, never> {
    if (config.advancedConfig?.protocol !== "geminiai") return {};
    const configuredSize = String(config.size || "auto").trim();
    const aspectRatio = configuredSize.toLowerCase() === "auto" ? "" : imageRequestAspectRatio(configuredSize);
    return {
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        image_size: geminiAiImageSize(config.quality),
        google_search: false,
        image_search: false,
    };
}

export function geminiAiImageSize(quality?: string): GeminiAiImageRequestFields["image_size"] {
    const value = String(quality || "auto")
        .trim()
        .toLowerCase();
    if (value === "high" || value === "4k") return "4K";
    if (value === "medium" || value === "2k" || value === "hd") return "2K";
    return "1K";
}
