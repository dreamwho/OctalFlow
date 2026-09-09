"use client";

import { Select } from "antd";
import { SlidersHorizontal, WandSparkles } from "lucide-react";

import {
    CreativeGenerationPreferences as GenerationPreferencesControl,
    type CreativeGenerationPreferencePatch,
    type GenerationDurationOption,
    type GenerationQualityOption,
    type GenerationRatioOption,
    type MediaCapability,
} from "@/components/creative-generation-preferences";
import { ModelIcon } from "@/components/model-picker";
import type { CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { cn } from "@/lib/utils";

import type { CreativeAgentModelOption } from "./creative-agent-controls";

type AgentMediaCapability = Extract<MediaCapability, "image" | "video">;

export type AgentVideoGenerationCapabilityProfile = {
    ratios: readonly GenerationRatioOption[];
    qualities: readonly GenerationQualityOption[];
    durations: readonly GenerationDurationOption[];
    durationRange: { min: number; max: number };
    fixedRatio?: boolean;
    allowCustomSize?: boolean;
};

export type AgentImageGenerationCapabilityProfile = {
    ratios: readonly GenerationRatioOption[];
    qualities: readonly GenerationQualityOption[];
    /** false 时隐藏自定义像素尺寸入口（如仅支持固定尺寸档的上游） */
    allowCustomSize?: boolean;
    /** true 时尺寸只能在给定档位中选择，非法值自动回退智能 */
    lockedRatios?: boolean;
    /** 画质档非法时的默认值 */
    defaultQuality?: string;
};

const agentImageRatios = [
    { value: "auto", label: "智能", width: 18, height: 18 },
    { value: "1:1", label: "1:1", width: 18, height: 18 },
    { value: "2:3", label: "2:3", width: 15, height: 23 },
    { value: "3:2", label: "3:2", width: 23, height: 15 },
    { value: "4:5", label: "4:5", width: 17, height: 21 },
    { value: "5:4", label: "5:4", width: 21, height: 17 },
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
    { value: "21:9", label: "21:9", width: 26, height: 11 },
    { value: "9:21", label: "9:21", width: 11, height: 26 },
    { value: "3:4", label: "3:4", width: 16, height: 21 },
    { value: "4:3", label: "4:3", width: 21, height: 16 },
    { value: "1:2", label: "1:2", width: 12, height: 24 },
    { value: "2:1", label: "2:1", width: 24, height: 12 },
    { value: "1:3", label: "1:3", width: 9, height: 26 },
    { value: "3:1", label: "3:1", width: 26, height: 9 },
] as const satisfies readonly GenerationRatioOption[];

export const agentImageQualities = [
    { value: "auto", label: "智能", shortLabel: "智能" },
    { value: "low", label: "1K", shortLabel: "1K" },
    { value: "medium", label: "2K", shortLabel: "2K" },
    { value: "high", label: "4K", shortLabel: "4K" },
] as const satisfies readonly GenerationQualityOption[];

export function CompactAgentGenerationSettings({
    preferences,
    onChange,
    imageCapabilities,
    videoCapabilities,
    videoCapabilityHint,
    models = [],
    selectedModel,
    smartPlanning = true,
    onSelectModel,
    onSmartPlanningChange,
    emphasizedTrigger = false,
}: {
    preferences: CreativeGenerationPreferences;
    onChange: (preferences: CreativeGenerationPreferences) => void;
    imageCapabilities?: AgentImageGenerationCapabilityProfile;
    videoCapabilities?: AgentVideoGenerationCapabilityProfile;
    videoCapabilityHint?: string;
    models?: CreativeAgentModelOption[];
    selectedModel?: CreativeAgentModelOption;
    smartPlanning?: boolean;
    onSelectModel?: (model: CreativeAgentModelOption) => void;
    onSmartPlanningChange?: (enabled: boolean) => void;
    emphasizedTrigger?: boolean;
}) {
    const capability: AgentMediaCapability = preferences.mode === "video" ? "video" : "image";
    const availableModels = models.filter((model) => model.capability === capability);
    const activeModel = selectedModel?.capability === capability ? selectedModel : undefined;
    const changeCapability = (next: MediaCapability) => {
        if (next !== "image" && next !== "video") return;
        onChange({ ...preferences, mode: next });
    };

    return (
        <GenerationPreferencesControl
            capability={capability}
            capabilities={["image", "video"]}
            preferences={preferences}
            triggerLabel={compactAgentPreferenceSummary(capability, preferences)}
            triggerAriaLabel={`生成参数：${agentPreferenceSummary(capability, preferences)}`}
            triggerIcon={<SlidersHorizontal className={emphasizedTrigger ? "size-4" : "size-3.5"} strokeWidth={1.7} />}
            triggerLabelClassName="sr-only"
            panelClassName="!w-[680px] max-w-[calc(100vw-24px)]"
            capabilityNotice={capability === "video" ? videoCapabilityHint : undefined}
            triggerClassName={(open) =>
                cn(
                    emphasizedTrigger ? "!size-9 !min-w-9 !rounded-lg" : "!size-7 !min-w-7 !rounded-md",
                    "!border-0 !bg-transparent !p-0 !text-[#7b8591] !shadow-none hover:!bg-black/5 hover:!text-[#20242a] dark:!text-[#8f99a5] dark:hover:!bg-white/5 dark:hover:!text-white",
                    open && "!bg-cyan-400/10 !text-cyan-600 dark:!text-cyan-300",
                )
            }
            placement="top"
            compact
            iconOnly
            tabless
            showCount={false}
            showCapabilityIcons={false}
            ratioGridClassName="grid-cols-[repeat(auto-fit,minmax(60px,1fr))]"
            ratioTileLayout
            panelHeader={
                <div className="mb-3 grid gap-2 px-1">
                    <div className="flex h-8 items-center justify-between">
                        <span className="text-[13px] font-semibold text-[#20242a] dark:text-white">生成偏好</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={smartPlanning}
                            className="flex items-center gap-2 text-[11px] font-medium text-[#7b8591] transition hover:text-[#20242a] dark:text-[#98a2ae] dark:hover:text-white"
                            onClick={() => onSmartPlanningChange?.(!smartPlanning)}
                        >
                            <span>自动</span>
                            <span className={cn("octaflow-smart-switch relative h-[18px] w-8 rounded-full transition", smartPlanning ? "is-checked" : "bg-[#d7dce1] dark:bg-[#4b535d]")}>
                                <span className={cn("absolute left-0.5 top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform", smartPlanning && "translate-x-3.5")} />
                            </span>
                        </button>
                    </div>
                    <label className="grid gap-1.5">
                        <span className="text-[11px] font-medium text-[#7b8591] dark:text-[#98a2ae]">模型选择</span>
                        <Select
                            size="middle"
                            className="w-full"
                            listHeight={416}
                            value={activeModel?.id}
                            placeholder={smartPlanning ? "由 Agent 自动匹配" : `切换${capability === "image" ? "图片" : "视频"}模型`}
                            options={availableModels.map((model) => ({ value: model.id, label: model.name, model }))}
                            labelRender={(label) => {
                                const model = availableModels.find((item) => item.id === label.value);
                                return model ? (
                                    <span className="flex min-w-0 items-center gap-2">
                                        <ModelIcon model={`${model.id} ${model.name}`} />
                                        <span className="truncate">{model.name}</span>
                                    </span>
                                ) : (
                                    label.label
                                );
                            }}
                            onChange={(modelId) => {
                                const model = availableModels.find((item) => item.id === modelId);
                                if (model) onSelectModel?.(model);
                            }}
                            optionRender={(option) => (
                                <div className="flex min-w-0 items-center gap-2">
                                    <ModelIcon model={`${option.data.model.id} ${option.data.model.name}`} />
                                    <span className="truncate">{option.data.model.name}</span>
                                </div>
                            )}
                            suffixIcon={<WandSparkles className="size-3.5" />}
                            aria-label={`切换${capability === "image" ? "图片" : "视频"}模型`}
                        />
                    </label>
                </div>
            }
            fixedSizeLabel={capability === "video" && videoCapabilities?.fixedRatio ? "由参考素材比例决定" : undefined}
            ratioOptions={capability === "video" ? videoCapabilities?.ratios : imageCapabilities?.ratios || agentImageRatios}
            imageQualityOptions={imageCapabilities?.qualities || agentImageQualities}
            videoQualityOptions={videoCapabilities?.qualities}
            videoDurationOptions={videoCapabilities?.durations}
            videoDurationRange={videoCapabilities?.durationRange}
            allowCustomSize={capability === "image" ? (imageCapabilities?.allowCustomSize ?? true) : (videoCapabilities?.allowCustomSize ?? !videoCapabilities)}
            allowCustomVideoQuality={!videoCapabilities}
            showPreferenceFields={Boolean(activeModel)}
            emptyPreferenceState={<p className="rounded-lg border border-dashed border-[#dce2e7] bg-[#fafbfc] px-3 py-5 text-center text-xs leading-5 text-[#7b8591] dark:border-[#3a424c] dark:bg-[#1c2026] dark:text-[#98a2ae]">请选择一个模型后查看可用的比例、清晰度和时长。</p>}
            onCapabilityChange={changeCapability}
            onChange={(patch) => onChange(updateAgentGenerationPreferences(preferences, capability, patch))}
        />
    );
}

export function compactAgentPreferenceSummary(capability: AgentMediaCapability, preferences: CreativeGenerationPreferences) {
    if (capability === "video") {
        const video = preferences.video;
        const size = video?.size && video.size !== "auto" ? video.size.replace("x", "×") : "智能";
        return isExactSize(video?.size) ? size : `${size} · ${video?.seconds || 5}秒`;
    }
    const image = preferences.image;
    const size = agentImageSizeLabel(image?.size);
    return isExactSize(image?.size) ? size : `${size} · ${image?.count || 1}张`;
}

function agentPreferenceSummary(capability: AgentMediaCapability, preferences: CreativeGenerationPreferences) {
    if (capability === "video") {
        const video = preferences.video;
        const size = video?.size && video.size !== "auto" ? video.size.replace("x", "×") : "智能";
        const quality = video?.quality && video.quality !== "auto" ? `${video.quality.replace(/p$/i, "")}P` : "智能";
        return size === "智能" && quality === "智能" ? "智能参数" : `${size} · ${quality} · ${video?.seconds || 5}秒`;
    }
    const image = preferences.image;
    const size = agentImageSizeLabel(image?.size);
    const quality = ({ high: "高", medium: "中", low: "低", auto: "智能" } as const)[image?.quality || "auto"];
    return size === "智能" && quality === "智能" && (image?.count || 1) === 1 ? "智能参数" : `${size} · ${quality}${(image?.count || 1) > 1 ? ` · ${image?.count}张` : ""}`;
}

export function updateAgentGenerationPreferences(preferences: CreativeGenerationPreferences, capability: AgentMediaCapability, patch: CreativeGenerationPreferencePatch): CreativeGenerationPreferences {
    if (capability === "image") {
        const image = { ...preferences.image };
        if (patch.size !== undefined) image.size = patch.size;
        if (patch.quality === "auto" || patch.quality === "high" || patch.quality === "medium" || patch.quality === "low") image.quality = patch.quality;
        if (patch.count !== undefined) image.count = patch.count;
        return { ...preferences, mode: "image", image };
    }
    const video = { ...preferences.video };
    if (patch.size !== undefined) video.size = patch.size;
    if (patch.quality !== undefined) video.quality = patch.quality;
    if (patch.count !== undefined) video.count = patch.count;
    if (patch.seconds !== undefined) video.seconds = patch.seconds;
    if (patch.generateAudio !== undefined) video.generateAudio = patch.generateAudio;
    if (patch.watermark !== undefined) video.watermark = patch.watermark;
    if (patch.referenceMode !== undefined) video.referenceMode = patch.referenceMode;
    return { ...preferences, mode: "video", video };
}

function isExactSize(value?: string) {
    return /^\d+x\d+$/i.test(value || "");
}

function agentImageSizeLabel(value?: string) {
    return value && value !== "auto" ? value.replace("x", "×") : "智能";
}
