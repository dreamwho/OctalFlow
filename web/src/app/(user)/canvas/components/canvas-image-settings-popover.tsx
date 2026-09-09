"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect } from "react";

import { CreativeGenerationPreferences, generationPreferenceSummary, type CreativeGenerationPreferencePatch, type GenerationQualityOption, type GenerationRatioOption } from "@/components/creative-generation-preferences";
import type { CreativeGenerationPreferences as GenerationPreferences } from "@/lib/creative-runtime-contract";
import { resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { useCreativeComposerPopoverPlacement, type CreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { canvasDreaminaImageProfile, resolveCanvasDreaminaModelId } from "../utils/canvas-dreamina-cli";

const chatGptApiImageSizes: GenerationRatioOption[] = [
    { value: "auto", label: "智能", width: 18, height: 18 },
    { value: "1024x1024", label: "方形", width: 18, height: 18 },
    { value: "1024x1536", label: "竖版", width: 14, height: 21 },
    { value: "1536x1024", label: "横版", width: 21, height: 14 },
];

// GPTAPI 画质即导出规格：低 = 上游原生档位；中 = 放大到 2K；高 = 放大到 4K
const chatGptApiImageQualities: GenerationQualityOption[] = [
    { value: "low", label: "低画质", shortLabel: "低" },
    { value: "medium", label: "中画质（2K）", shortLabel: "中" },
    { value: "high", label: "高画质（4K）", shortLabel: "高" },
];
const CHATGPT_API_DEFAULT_QUALITY = "low";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    placement?: CreativeComposerPopoverPlacement;
    fixedSizeLabel?: string;
    compactTriggerLabel?: string;
    showTriggerChevron?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", fixedSizeLabel, compactTriggerLabel, showTriggerChevron = true }: CanvasImageSettingsPopoverProps) {
    const responsivePlacement = useCreativeComposerPopoverPlacement(placement);
    const geminiAi = isGeminiAiImageConfig(config);
    const chatGptApi = isChatGptApiImageConfig(config);
    const dreaminaModelId = resolveCanvasDreaminaModelId(config);
    const dreamina = canvasDreaminaImageProfile(dreaminaModelId);
    const allowCustomSize = !(dreaminaModelId === "dreamina-seedream-3-0" || dreaminaModelId === "dreamina-seedream-3-1") || config.quality !== "low";
    const preferences: GenerationPreferences = {
        mode: "image",
        image: {
            size: config.size || "auto",
            quality: imageQuality(config.quality),
            count: positiveInteger(config.count),
        },
    };
    const summary = canvasImagePreferenceSummary(preferences, fixedSizeLabel, geminiAi, dreamina?.qualities);
    const fullSummary = fixedSizeLabel
        ? `${fixedSizeLabel} · ${imageQualityLabel(preferences.image?.quality, geminiAi, dreamina?.qualities)} · ${preferences.image?.count || 1}张`
        : geminiAi
          ? `${compactSizeLabel(preferences.image?.size, true)} · ${imageQualityLabel(preferences.image?.quality, true)} · ${preferences.image?.count || 1}张`
          : dreamina
            ? `${compactSizeLabel(preferences.image?.size)} · ${imageQualityLabel(preferences.image?.quality, false, dreamina.qualities)} · ${preferences.image?.count || 1}张`
            : generationPreferenceSummary("image", preferences);

    useEffect(() => {
        if (!dreamina && chatGptApi) {
            const size = config.size || "auto";
            if (size !== "auto" && !chatGptApiImageSizes.some((option) => option.value === size)) onConfigChange("size", "auto");
            const quality = config.quality || "";
            if (!chatGptApiImageQualities.some((option) => option.value === quality)) onConfigChange("quality", CHATGPT_API_DEFAULT_QUALITY);
            return;
        }
        if (!dreamina) return;
        if (!dreamina.qualities.some((option) => option.value === config.quality)) onConfigChange("quality", dreamina.defaultQuality);
        const size = config.size || "auto";
        if (!/^\d+x\d+$/i.test(size) && !dreamina.ratios.some((option) => option.value === size)) onConfigChange("size", "auto");
        if (!allowCustomSize && /^\d+x\d+$/i.test(size)) onConfigChange("size", "auto");
    }, [allowCustomSize, chatGptApi, config.quality, config.size, dreamina, onConfigChange]);

    return (
        <CreativeGenerationPreferences
            capability="image"
            preferences={preferences}
            triggerLabel={compactTriggerLabel || summary}
            triggerAriaLabel={`图片设置：${fullSummary}`}
            triggerIcon={<SlidersHorizontal className="size-4" />}
            triggerClassName={buttonClassName}
            triggerLabelClassName="min-w-0 truncate whitespace-nowrap text-left"
            showTriggerChevron={showTriggerChevron}
            placement={responsivePlacement}
            autoAdjustOverflow
            tabless
            fixedSizeLabel={fixedSizeLabel}
            imageQualityProfile={geminiAi ? "geminiai" : "default"}
            ratioOptions={chatGptApi ? chatGptApiImageSizes : dreamina?.ratios}
            imageQualityOptions={chatGptApi ? chatGptApiImageQualities : dreamina?.qualities}
            allowCustomSize={chatGptApi ? false : allowCustomSize}
            onOpenChange={onOpenChange}
            onChange={(patch) => applyImagePreferencePatch(patch, onConfigChange)}
        />
    );
}

export function canvasImagePreferenceSummary(preferences: GenerationPreferences, fixedSizeLabel?: string, geminiAi = false, qualityOptions?: readonly GenerationQualityOption[]) {
    const image = preferences.image;
    const size = fixedSizeLabel || compactSizeLabel(image?.size, geminiAi);
    if (!fixedSizeLabel && /^\d+x\d+$/i.test(image?.size || "")) return size;
    const quality =
        qualityOptions?.find((option) => option.value === (image?.quality || "auto"))?.shortLabel ||
        (geminiAi
            ? ({ auto: "智能", high: "高·4K", medium: "中·2K", low: "低·1K" } as Record<string, string>)[image?.quality || "auto"] || image?.quality || "智能"
            : ({ auto: "智能", high: "高", medium: "中", low: "低" } as Record<string, string>)[image?.quality || "auto"] || image?.quality || "智能");
    const count = image?.count || 1;
    return `${size} · ${quality}${count > 1 ? ` · ${count}张` : ""}`;
}

function applyImagePreferencePatch(patch: CreativeGenerationPreferencePatch, onChange: (key: keyof AiConfig, value: string) => void) {
    if (patch.size !== undefined) onChange("size", patch.size);
    if (patch.quality !== undefined) onChange("quality", patch.quality);
    if (patch.count !== undefined) onChange("count", String(patch.count));
}

function imageQuality(value?: string): NonNullable<GenerationPreferences["image"]>["quality"] {
    return value === "high" || value === "medium" || value === "low" ? value : "auto";
}

function imageQualityLabel(value?: string, geminiAi = false, options?: readonly GenerationQualityOption[]) {
    const configured = options?.find((option) => option.value === (value || "auto"));
    if (configured) return configured.label;
    const labels = geminiAi
        ? ({ auto: "智能画质（默认 1K）", high: "高画质（4K）", medium: "中画质（2K）", low: "低画质（1K）" } as Record<string, string>)
        : ({ auto: "智能画质", high: "高画质", medium: "中画质", low: "低画质" } as Record<string, string>);
    return labels[value || "auto"] || value;
}

export function isGeminiAiImageConfig(config: AiConfig) {
    return resolveModelChannel(config, config.model).id === "geminiai";
}

export function isChatGptApiImageConfig(config: AiConfig) {
    return isChatGptApiChannel(resolveModelChannel(config, config.model));
}

export function isChatGptApiModelConfig(config: AiConfig, modelId: string) {
    return isChatGptApiChannel(resolveModelChannel(config, modelId));
}

function isChatGptApiChannel(channel: ReturnType<typeof resolveModelChannel>) {
    // 老版本持久化的渠道条目可能没有 advancedConfig，用渠道 ID / 系统代理路径兜底识别
    return channel.advancedConfig?.protocol === "chatgpt-api" || channel.id === "chatgpt-api" || (channel.baseUrl || "").includes("/api/ai/system/chatgpt-api");
}

function positiveInteger(value: unknown) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function compactSizeLabel(value?: string, geminiAi = false) {
    return !value || value === "auto" ? (geminiAi ? "Auto" : "智能") : value.replace("x", "×");
}
