import type { GenerationDurationOption, GenerationQualityOption, GenerationRatioOption } from "@/components/creative-generation-preferences";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

const GEMINIVIDS_RATIOS: readonly GenerationRatioOption[] = [
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
];
const GEMINIVIDS_QUALITIES: readonly GenerationQualityOption[] = [
    { value: "720", label: "720P", shortLabel: "720P" },
    { value: "1080", label: "1080P", shortLabel: "1080P" },
];
const GEMINIVIDS_DURATIONS: readonly GenerationDurationOption[] = [4, 5, 6, 7, 8, 9, 10].map((value) => ({ value, label: `${value} 秒` }));

export function resolveCanvasGeminiVidsModelId(config: AiConfig, value = config.model) {
    const requested = modelOptionName(value).trim();
    const logical = config.logicalModels.find((model) => model.enabled && model.id.toLowerCase() === requested.toLowerCase());
    const binding = logical?.bindings.find((item) => item.enabled && item.channelId === "geminivids");
    if (binding?.upstreamModel) return binding.upstreamModel.trim().toLowerCase();
    return resolveModelChannel(config, value).id === "geminivids" && requested.startsWith("google-vids-") ? requested.toLowerCase() : "";
}

export function canvasGeminiVidsVideoProfile(modelId: string) {
    if (!modelId.startsWith("google-vids-")) return null;
    return { ratios: GEMINIVIDS_RATIOS, qualities: GEMINIVIDS_QUALITIES, durations: GEMINIVIDS_DURATIONS, durationRange: { min: 4, max: 10 }, fixedRatio: false } as const;
}
