import type { GenerationDurationOption, GenerationQualityOption, GenerationRatioOption } from "@/components/creative-generation-preferences";
import { modelOptionName, resolveModelChannel, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

import type { CanvasNodeMetadata } from "../types";
import type { CanvasResourceReference } from "./canvas-resource-references";

export type CanvasDreaminaVideoCommand = "text2video" | "image2video" | "frames2video" | "multiframe2video" | "multimodal2video";

const IMAGE_RATIOS: readonly GenerationRatioOption[] = [
    { value: "auto", label: "默认 16:9", width: 24, height: 14 },
    { value: "21:9", label: "21:9", width: 26, height: 11 },
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "3:2", label: "3:2", width: 23, height: 15 },
    { value: "4:3", label: "4:3", width: 21, height: 16 },
    { value: "1:1", label: "1:1", width: 18, height: 18 },
    { value: "3:4", label: "3:4", width: 16, height: 21 },
    { value: "2:3", label: "2:3", width: 15, height: 23 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
];

const VIDEO_RATIOS: readonly GenerationRatioOption[] = [
    { value: "auto", label: "默认 16:9", width: 24, height: 14 },
    { value: "1:1", label: "1:1", width: 18, height: 18 },
    { value: "3:4", label: "3:4", width: 16, height: 21 },
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "4:3", label: "4:3", width: 21, height: 16 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
    { value: "21:9", label: "21:9", width: 26, height: 11 },
];

const QUALITY_1K_2K: readonly GenerationQualityOption[] = [
    { value: "low", label: "1K", shortLabel: "1K" },
    { value: "medium", label: "2K", shortLabel: "2K" },
];
const QUALITY_2K_4K: readonly GenerationQualityOption[] = [
    { value: "medium", label: "2K", shortLabel: "2K" },
    { value: "high", label: "4K", shortLabel: "4K" },
];
const QUALITY_15K_2K_4K: readonly GenerationQualityOption[] = [{ value: "low", label: "1.5K", shortLabel: "1.5K" }, ...QUALITY_2K_4K];

export function resolveCanvasDreaminaModelId(config: AiConfig, value = config.model) {
    const requested = modelOptionName(value).trim();
    const logical = config.logicalModels.find((model) => model.enabled && model.id.toLowerCase() === requested.toLowerCase());
    const binding = logical?.bindings.find((item) => item.enabled && item.channelId === "dreamina-cli");
    if (binding?.upstreamModel) return binding.upstreamModel.trim().toLowerCase();
    return resolveModelChannel(config, value).id === "dreamina-cli" && requested.startsWith("dreamina-") ? requested.toLowerCase() : "";
}

export function canvasDreaminaImageProfile(modelId: string) {
    if (!modelId.startsWith("dreamina-seedream-")) return null;
    if (modelId === "dreamina-seedream-3-0" || modelId === "dreamina-seedream-3-1") {
        return { ratios: IMAGE_RATIOS, qualities: QUALITY_1K_2K, defaultQuality: "medium" } as const;
    }
    if (modelId === "dreamina-seedream-5-0-pro") {
        return { ratios: IMAGE_RATIOS, qualities: QUALITY_15K_2K_4K, defaultQuality: "medium" } as const;
    }
    return { ratios: IMAGE_RATIOS, qualities: QUALITY_2K_4K, defaultQuality: "medium" } as const;
}

export function canvasDreaminaVideoCommand(metadata: CanvasNodeMetadata | undefined, references: readonly CanvasResourceReference[]): CanvasDreaminaVideoCommand {
    const mode = metadata?.videoReferenceMode || "reference";
    if (mode === "first_last" && metadata?.videoFirstFrame && metadata?.videoLastFrame) return "frames2video";
    if (mode === "first_frame" && metadata?.videoFirstFrame) return "image2video";
    if (references.some((reference) => reference.kind === "video" || reference.kind === "audio")) return "multimodal2video";
    const images = references.filter((reference) => reference.kind === "image").length;
    if (!images) return "text2video";
    if (images === 1) return "image2video";
    return "multiframe2video";
}

export function canvasDreaminaVideoProfile(modelId: string, command: CanvasDreaminaVideoCommand) {
    if (!modelId.startsWith("dreamina-seedance-") || !dreaminaModelSupportsCommand(modelId, command)) return null;
    if (command === "multiframe2video") {
        return {
            ratios: VIDEO_RATIOS,
            qualities: qualityOptions("720", "1080"),
            durations: durationOptions(2, 8),
            durationRange: { min: 2, max: 8 },
            fixedRatio: true,
        } as const;
    }
    const fixedRatio = command === "image2video" || command === "frames2video";
    if (modelId === "dreamina-seedance-2-5") {
        return {
            ratios: VIDEO_RATIOS,
            qualities: qualityOptions("480", "720", "1080"),
            durations: durationOptions(4, 30),
            durationRange: { min: 4, max: 30 },
            fixedRatio,
        } as const;
    }
    if (modelId === "dreamina-seedance-2-0-vip") {
        return {
            ratios: VIDEO_RATIOS,
            qualities: qualityOptions("720", "1080", "4k"),
            durations: durationOptions(4, 15),
            durationRange: { min: 4, max: 15 },
            fixedRatio,
        } as const;
    }
    const durationRange = modelId === "dreamina-seedance-1-0-fast" ? { min: 5, max: 10 } : modelId === "dreamina-seedance-1-5-pro" ? { min: 5, max: 12 } : { min: 4, max: 15 };
    return {
        ratios: VIDEO_RATIOS,
        qualities: qualityOptions("720"),
        durations: durationOptions(durationRange.min, durationRange.max),
        durationRange,
        fixedRatio,
    } as const;
}

export function canvasDreaminaModelCompatible(config: AiConfig, value: string, capability: ModelCapability, command: CanvasDreaminaVideoCommand | "text2image" | "image2image") {
    const modelId = resolveCanvasDreaminaModelId(config, value);
    if (!modelId) return true;
    if (capability === "image") return command === "text2image" || (modelId !== "dreamina-seedream-3-0" && modelId !== "dreamina-seedream-3-1");
    if (capability === "video") return dreaminaModelSupportsCommand(modelId, command as CanvasDreaminaVideoCommand);
    return true;
}

function dreaminaModelSupportsCommand(modelId: string, command: CanvasDreaminaVideoCommand) {
    if (command === "multiframe2video") return modelId.startsWith("dreamina-seedance-");
    if (modelId === "dreamina-seedance-1-0-fast") return command === "image2video";
    if (modelId === "dreamina-seedance-1-5-pro") return command === "image2video" || command === "frames2video";
    return modelId.startsWith("dreamina-seedance-2-");
}

function qualityOptions(...values: string[]): readonly GenerationQualityOption[] {
    return values.map((value) => ({ value, label: value.toLowerCase() === "4k" ? "4K" : `${value}P`, shortLabel: value.toLowerCase() === "4k" ? "4K" : `${value}P` }));
}

function durationOptions(min: number, max: number): readonly GenerationDurationOption[] {
    const candidates = [min, 5, 8, 10, 12, 15, max];
    return Array.from(new Set(candidates.filter((value) => value >= min && value <= max)))
        .map((value) => ({ value, label: `${value} 秒` }));
}
