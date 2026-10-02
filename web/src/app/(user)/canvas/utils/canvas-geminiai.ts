import type { GenerationDurationOption, GenerationQualityOption, GenerationRatioOption } from "@/components/creative-generation-preferences";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

const GEMINIAI_OMNI_RATIOS: readonly GenerationRatioOption[] = [
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
];
const GEMINIAI_OMNI_QUALITIES: readonly GenerationQualityOption[] = [
    { value: "360p", label: "360P", shortLabel: "360P" },
    { value: "720p", label: "720P", shortLabel: "720P" },
    { value: "1080p", label: "1080P", shortLabel: "1080P" },
    { value: "4k", label: "4K", shortLabel: "4K" },
];
const GEMINIAI_OMNI_DURATIONS: readonly GenerationDurationOption[] = [3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({ value, label: `${value} 秒` }));

export function resolveCanvasGeminiAiOmniModelId(config: AiConfig, value = config.model) {
    const requested = modelOptionName(value).trim();
    const logical = config.logicalModels.find((model) => model.enabled && model.id.toLowerCase() === requested.toLowerCase());
    const binding = logical?.bindings.find((item) => item.enabled && item.channelId === "geminiai");
    if (binding?.upstreamModel.toLowerCase().startsWith("gemini-omni")) return binding.upstreamModel.trim().toLowerCase();
    return resolveModelChannel(config, value).id === "geminiai" && requested.toLowerCase().startsWith("gemini-omni") ? requested.toLowerCase() : "";
}

export function canvasGeminiAiVideoProfile(modelId: string) {
    if (!modelId.startsWith("gemini-omni")) return null;
    return { ratios: GEMINIAI_OMNI_RATIOS, qualities: GEMINIAI_OMNI_QUALITIES, durations: GEMINIAI_OMNI_DURATIONS, durationRange: { min: 3, max: 10 }, fixedRatio: false } as const;
}
