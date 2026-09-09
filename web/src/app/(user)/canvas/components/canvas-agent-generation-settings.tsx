"use client";

import { useEffect, useMemo } from "react";

import { CompactAgentGenerationSettings, agentImageQualities, compactAgentPreferenceSummary, type AgentImageGenerationCapabilityProfile, type AgentVideoGenerationCapabilityProfile, updateAgentGenerationPreferences } from "@/components/agent/compact-agent-generation-settings";
import type { CreativeAgentModelOption } from "@/components/agent/creative-agent-controls";
import type { CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { resolveModelChannel, useConfigStore } from "@/stores/use-config-store";

import { isChatGptApiModelConfig } from "./canvas-image-settings-popover";
import { canvasDreaminaImageProfile, canvasDreaminaVideoProfile, resolveCanvasDreaminaModelId } from "../utils/canvas-dreamina-cli";

export function CanvasAgentGenerationSettings({
    preferences,
    onChange,
    models = [],
    selectedModels = [],
    smartPlanning = true,
    onSelectModel,
    onSmartPlanningChange,
}: {
    preferences: CreativeGenerationPreferences;
    onChange: (preferences: CreativeGenerationPreferences) => void;
    models?: CreativeAgentModelOption[];
    selectedModels?: CreativeAgentModelOption[];
    smartPlanning?: boolean;
    onSelectModel?: (model: CreativeAgentModelOption) => void;
    onSmartPlanningChange?: (enabled: boolean) => void;
}) {
    const config = useConfigStore((state) => state.config);
    const imageProfile = useMemo(() => canvasAgentSelectedImageProfile(config, selectedModels), [config, selectedModels]);
    const videoProfile = useMemo(() => canvasAgentSelectedVideoProfile(config, selectedModels), [config, selectedModels]);

    useEffect(() => {
        if (!imageProfile?.lockedRatios || preferences.mode !== "image") return;
        const size = preferences.image?.size || "auto";
        const quality = preferences.image?.quality || "";
        const sizeValid = size === "auto" || imageProfile.ratios.some((option) => option.value === size);
        const qualityValid = imageProfile.qualities.some((option) => option.value === quality);
        if (sizeValid && qualityValid) return;
        onChange(updateAgentGenerationPreferences(preferences, "image", {
            size: sizeValid ? size : "auto",
            quality: qualityValid ? quality : imageProfile.defaultQuality || "auto",
        }));
    }, [imageProfile, onChange, preferences]);

    useEffect(() => {
        if (!videoProfile || preferences.mode !== "video") return;
        const normalized = normalizeCanvasAgentVideoPreferences(preferences, videoProfile);
        if (normalized !== preferences) onChange(normalized);
    }, [onChange, preferences, videoProfile]);

    return (
        <CompactAgentGenerationSettings
            preferences={preferences}
            onChange={onChange}
            imageCapabilities={imageProfile}
            videoCapabilities={videoProfile}
            videoCapabilityHint={videoProfile ? canvasAgentVideoCapabilityHint(videoProfile) : undefined}
            models={models}
            selectedModel={selectedModels.find((model) => model.capability === preferences.mode)}
            smartPlanning={smartPlanning}
            onSelectModel={onSelectModel}
            onSmartPlanningChange={onSmartPlanningChange}
            emphasizedTrigger
        />
    );
}

export function selectSingleCanvasAgentModel(model: CreativeAgentModelOption, selectedModels: CreativeAgentModelOption[] = []) {
    return [...selectedModels.filter((selected) => selected.capability !== model.capability).map((selected) => selected.id), model.id];
}

export const canvasAgentCompactPreferenceSummary = compactAgentPreferenceSummary;
export const updateCanvasAgentGenerationPreferences = updateAgentGenerationPreferences;

const chatGptApiAgentImageProfile: AgentImageGenerationCapabilityProfile = {
    ratios: [
        { value: "auto", label: "智能", width: 18, height: 18 },
        { value: "1024x1024", label: "方形", width: 18, height: 18 },
        { value: "1024x1536", label: "竖版", width: 14, height: 21 },
        { value: "1536x1024", label: "横版", width: 21, height: 14 },
    ],
    qualities: [
        { value: "low", label: "低画质", shortLabel: "低" },
        { value: "medium", label: "中画质（2K）", shortLabel: "中" },
        { value: "high", label: "高画质（4K）", shortLabel: "高" },
    ],
    allowCustomSize: false,
    lockedRatios: true,
    defaultQuality: "low",
};

export function canvasAgentSelectedImageProfile(config: Parameters<typeof resolveCanvasDreaminaModelId>[0], selectedModels: CreativeAgentModelOption[]): AgentImageGenerationCapabilityProfile | undefined {
    const imageModel = selectedModels.find((model) => model.capability === "image");
    if (!imageModel) return undefined;
    const profile = canvasDreaminaImageProfile(resolveCanvasDreaminaModelId(config, imageModel.id));
    if (profile) return { ratios: profile.ratios, qualities: profile.qualities };
    if (isChatGptApiModelConfig(config, imageModel.id)) return chatGptApiAgentImageProfile;
    return undefined;
}

export function canvasAgentSelectedVideoProfile(config: Parameters<typeof resolveCanvasDreaminaModelId>[0], selectedModels: CreativeAgentModelOption[]): AgentVideoGenerationCapabilityProfile | undefined {
    const videoModels = selectedModels.filter((model) => model.capability === "video");
    if (!videoModels.length) return undefined;
    const profiles = videoModels.map((model) => canvasDreaminaVideoProfile(resolveCanvasDreaminaModelId(config, model.id), "text2video"));
    if (profiles.some((profile) => !profile)) return undefined;
    return intersectCanvasAgentVideoProfiles(profiles as AgentVideoGenerationCapabilityProfile[]);
}

export function normalizeCanvasAgentVideoPreferences(preferences: CreativeGenerationPreferences, profile: AgentVideoGenerationCapabilityProfile): CreativeGenerationPreferences {
    const video = preferences.video || {};
    const quality = normalizeVideoValue(video.quality);
    const nextQuality = profile.qualities.some((option) => option.value === quality) ? quality : profile.qualities[0]?.value || "auto";
    const currentSeconds = positiveInteger(video.seconds, 5);
    const nextSeconds = Math.min(profile.durationRange.max, Math.max(profile.durationRange.min, currentSeconds));
    const nextSize = profile.fixedRatio || (video.size && video.size !== "auto" && !profile.ratios.some((option) => option.value === video.size)) ? "auto" : video.size;
    if (preferences.mode === "video" && video.quality === nextQuality && video.seconds === nextSeconds && video.size === nextSize) return preferences;
    return { ...preferences, mode: "video", video: { ...video, quality: nextQuality, seconds: nextSeconds, ...(nextSize !== undefined ? { size: nextSize } : {}) } };
}

export function canvasAgentVideoCapabilityHint(profile: AgentVideoGenerationCapabilityProfile) {
    const qualities = profile.qualities.map((option) => option.shortLabel || option.label).join(" / ");
    return `当前模型支持 ${qualities} · ${profile.durationRange.min}–${profile.durationRange.max} 秒`;
}

function intersectCanvasAgentVideoProfiles(profiles: AgentVideoGenerationCapabilityProfile[]): AgentVideoGenerationCapabilityProfile | undefined {
    const [first, ...rest] = profiles;
    if (!first) return undefined;
    const qualities = first.qualities.filter((option) => rest.every((profile) => profile.qualities.some((candidate) => candidate.value === option.value)));
    const ratios = first.ratios.filter((option) => rest.every((profile) => profile.ratios.some((candidate) => candidate.value === option.value)));
    const durationRange = { min: Math.max(...profiles.map((profile) => profile.durationRange.min)), max: Math.min(...profiles.map((profile) => profile.durationRange.max)) };
    if (!qualities.length || !ratios.length || durationRange.min > durationRange.max) return undefined;
    const durations = first.durations.filter((option) => option.value >= durationRange.min && option.value <= durationRange.max);
    return { qualities, ratios, durations: durations.length ? durations : [{ value: durationRange.min, label: `${durationRange.min} 秒` }], durationRange, fixedRatio: profiles.some((profile) => profile.fixedRatio) };
}

function normalizeVideoValue(value?: string) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/p$/, "");
}

function positiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
