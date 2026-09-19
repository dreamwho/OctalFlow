import type { GenerationDurationOption, GenerationQualityOption, GenerationRatioOption } from "@/components/creative-generation-preferences";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

const DOLA_RATIOS: readonly GenerationRatioOption[] = [
    { value: "1:1", label: "1:1", width: 18, height: 18 },
    { value: "3:4", label: "3:4", width: 16, height: 21 },
    { value: "4:3", label: "4:3", width: 21, height: 16 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "21:9", label: "21:9", width: 26, height: 11 },
];
const DOLA_QUALITY: readonly GenerationQualityOption[] = [{ value: "auto", label: "智能清晰度", shortLabel: "智能" }];

export function resolveCanvasDolaModelId(config: AiConfig, value = config.model) {
    const requested = modelOptionName(value).trim();
    const logical = config.logicalModels.find((model) => model.enabled && model.id.toLowerCase() === requested.toLowerCase());
    const binding = logical?.bindings.find((item) => item.enabled && item.channelId === "dola");
    if (binding?.upstreamModel) return binding.upstreamModel.trim().toLowerCase();
    return resolveModelChannel(config, value).id === "dola" && requested.startsWith("dola-") ? requested.toLowerCase() : "";
}

export function canvasDolaVideoProfile(modelId: string) {
    if (modelId !== "dola-seedance-2-5" && modelId !== "dola-seedance-2-0-fast") return null;
    const durationValues = modelId === "dola-seedance-2-5" ? [5, 10, 15, 30] : [5, 10, 15];
    const durations: readonly GenerationDurationOption[] = durationValues.map((value) => ({ value, label: `${value} 秒` }));
    return { ratios: DOLA_RATIOS, qualities: DOLA_QUALITY, durations, durationRange: { min: durationValues[0], max: durationValues.at(-1)! }, fixedRatio: false } as const;
}

