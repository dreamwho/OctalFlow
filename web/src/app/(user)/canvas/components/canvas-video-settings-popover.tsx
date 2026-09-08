"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect } from "react";

import { CreativeGenerationPreferences, generationPreferenceSummary, type CreativeGenerationPreferencePatch } from "@/components/creative-generation-preferences";
import { useCreativeComposerPopoverPlacement, type CreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CreativeGenerationPreferences as GenerationPreferences } from "@/lib/creative-runtime-contract";
import { boolConfig } from "@/lib/seedance-video";
import type { AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasNodeMetadata } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { canvasVideoReferenceModeLabel, normalizeCanvasVideoReferenceMode } from "../utils/canvas-video-references";
import { CanvasVideoReferenceSettings } from "./canvas-video-reference-settings";
import { canvasDreaminaVideoCommand, canvasDreaminaVideoProfile, resolveCanvasDreaminaModelId } from "../utils/canvas-dreamina-cli";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    metadata?: CanvasNodeMetadata;
    references: CanvasResourceReference[];
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMetadataChange: (patch: Partial<CanvasNodeMetadata>) => void;
    buttonClassName?: string;
    placement?: CreativeComposerPopoverPlacement;
};

export function CanvasVideoSettingsPopover({ config, metadata, references, onConfigChange, onMetadataChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const responsivePlacement = useCreativeComposerPopoverPlacement(placement);
    const dreaminaModelId = resolveCanvasDreaminaModelId(config);
    const dreaminaCommand = canvasDreaminaVideoCommand(metadata, references);
    const dreamina = canvasDreaminaVideoProfile(dreaminaModelId, dreaminaCommand);
    const preferences: GenerationPreferences = {
        mode: "video",
        video: {
            size: config.size || "auto",
            quality: config.vquality || "auto",
            seconds: positiveInteger(config.videoSeconds, 5),
            generateAudio: boolConfig(config.videoGenerateAudio, true),
            watermark: boolConfig(config.videoWatermark, false),
            referenceMode: normalizeCanvasVideoReferenceMode(metadata?.videoReferenceMode),
        },
    };
    const summary = canvasVideoPreferenceSummary(preferences);
    const fullSummary = generationPreferenceSummary("video", preferences);
    const referenceLabel = canvasVideoReferenceModeLabel(metadata?.videoReferenceMode);
    const fixedSizeLabel = dreamina?.fixedRatio ? "由参考素材比例决定" : undefined;

    useEffect(() => {
        if (!dreamina) return;
        const quality = String(config.vquality || "720")
            .toLowerCase()
            .replace(/p$/, "");
        if (!dreamina.qualities.some((option) => option.value === quality)) onConfigChange("vquality", dreamina.qualities[0]?.value || "720");
        const seconds = positiveInteger(config.videoSeconds, 5);
        if (seconds < dreamina.durationRange.min || seconds > dreamina.durationRange.max) onConfigChange("videoSeconds", String(Math.min(Math.max(5, dreamina.durationRange.min), dreamina.durationRange.max)));
        const size = config.size || "auto";
        if (dreamina.fixedRatio && size !== "auto") onConfigChange("size", "auto");
        else if (!dreamina.fixedRatio && !dreamina.ratios.some((option) => option.value === size)) onConfigChange("size", "auto");
    }, [config.size, config.videoSeconds, config.vquality, dreamina, onConfigChange]);

    return (
        <CreativeGenerationPreferences
            capability="video"
            preferences={preferences}
            triggerLabel={summary}
            triggerAriaLabel={`视频设置：${referenceLabel} · ${fullSummary}`}
            triggerIcon={<SlidersHorizontal className="size-4" />}
            triggerClassName={buttonClassName}
            triggerLabelClassName="min-w-0 truncate whitespace-nowrap text-left"
            placement={responsivePlacement}
            autoAdjustOverflow
            showCount={false}
            tabless
            fixedSizeLabel={fixedSizeLabel}
            ratioOptions={dreamina?.ratios}
            videoQualityOptions={dreamina?.qualities}
            videoDurationOptions={dreamina?.durations}
            videoDurationRange={dreamina?.durationRange}
            allowCustomSize={!dreamina}
            allowCustomVideoQuality={!dreamina}
            videoReferenceContent={<CanvasVideoReferenceSettings metadata={metadata} references={references} theme={theme} compact onChange={onMetadataChange} />}
            onChange={(patch) => applyVideoPreferencePatch(patch, onConfigChange)}
        />
    );
}

export function canvasVideoPreferenceSummary(preferences: GenerationPreferences) {
    const video = preferences.video;
    const size = !video?.size || video.size === "auto" ? "智能" : video.size.replace("x", "×");
    const quality = !video?.quality || video.quality === "auto" ? "智能" : `${video.quality.replace(/p$/i, "")}P`;
    const seconds = video?.seconds ? `${video.seconds}s` : "";
    if (/^\d+x\d+$/i.test(video?.size || "")) return [size, seconds].filter(Boolean).join(" · ");
    return [size, quality, seconds].filter(Boolean).join(" · ");
}

function applyVideoPreferencePatch(patch: CreativeGenerationPreferencePatch, onChange: (key: keyof AiConfig, value: string) => void) {
    if (patch.size !== undefined) onChange("size", patch.size);
    if (patch.quality !== undefined) onChange("vquality", patch.quality);
    if (patch.seconds !== undefined) onChange("videoSeconds", String(patch.seconds));
    if (patch.generateAudio !== undefined) onChange("videoGenerateAudio", String(patch.generateAudio));
    if (patch.watermark !== undefined) onChange("videoWatermark", String(patch.watermark));
}

function positiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
