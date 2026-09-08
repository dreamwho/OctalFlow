"use client";

import { Button, Popover, Tooltip } from "antd";
import { Boxes, Check, FileAudio, FileVideo, ImageIcon, Lightbulb, Orbit, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ModelIcon } from "@/components/model-picker";
import type { AgentSkillSummary } from "@/services/api/agent-skills";
import { cn } from "@/lib/utils";
import { CREATIVE_RUN_MODEL_LIMIT } from "@/lib/creative-runtime-contract";

export type CreativeAgentModelOption = { id: string; name: string; capability: "image" | "video" | "audio" };
export type CreativeAgentControlTheme = { panel: string; border: string; text: string; muted: string; activeBackground: string; activeText: string };
export const creativeAgentModelCapabilities = ["image", "video", "audio"] as const;

export function CreativeAgentSkillCard({ skill, onRemove, theme, className, variant = "card" }: { skill: AgentSkillSummary; onRemove: () => void; theme?: CreativeAgentControlTheme; className?: string; variant?: "card" | "inline" }) {
    if (variant === "inline") {
        return (
            <div className={cn("flex min-w-0", className)}>
                <span
                    className={cn("flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium", !theme && "border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100")}
                    style={theme ? { background: theme.panel, borderColor: theme.border, color: theme.text } : undefined}
                >
                    <Sparkles className="size-3 shrink-0" />
                    <span className="min-w-0 truncate" title={skill.name}>
                        {skill.name}
                    </span>
                    <button
                        type="button"
                        className="grid size-4 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={theme ? { color: theme.muted } : undefined}
                        onClick={onRemove}
                        aria-label={`移除 Skill ${skill.name}`}
                    >
                        <X className="size-3" />
                    </button>
                </span>
            </div>
        );
    }
    return (
        <div className={cn("flex min-w-0 px-1 pt-0.5", className)}>
            <span
                className={cn(
                    "flex min-h-8 min-w-0 max-w-full items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-medium",
                    !theme && "border-amber-200/80 bg-amber-50/70 text-stone-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-stone-100",
                )}
                style={theme ? { background: theme.activeBackground, borderColor: theme.border, color: theme.text } : undefined}
            >
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-amber-200/45 text-amber-800 dark:bg-amber-300/10 dark:text-amber-300">
                    <Sparkles className="size-3" />
                </span>
                <span className="min-w-0 flex-1 break-words leading-4">Skill · {skill.name}</span>
                <button
                    type="button"
                    className="grid size-5 shrink-0 place-items-center rounded text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-white"
                    style={theme ? { color: theme.muted } : undefined}
                    onClick={onRemove}
                    aria-label={`移除 Skill ${skill.name}`}
                >
                    <X className="size-3" />
                </button>
            </span>
        </div>
    );
}

export function CreativeAgentControls({
    skills,
    skillsLoading,
    selectedSkill,
    models,
    selectedModels,
    smartPlanning,
    onSelectSkill,
    onToggleModel,
    onClearModels,
    onSmartPlanningChange,
    theme,
    compact = false,
    className,
    middle,
    modelPickerRequest = 0,
    defaultModelCapability = "image",
    modelCapabilities,
    showPlanningControl = true,
    showModelPicker = true,
    emphasizedCompactControls = false,
}: {
    skills: AgentSkillSummary[];
    skillsLoading?: boolean;
    selectedSkill?: AgentSkillSummary;
    models: CreativeAgentModelOption[];
    selectedModels: CreativeAgentModelOption[];
    smartPlanning: boolean;
    onSelectSkill: (skill: AgentSkillSummary) => void;
    onToggleModel: (model: CreativeAgentModelOption) => void;
    onClearModels: () => void;
    onSmartPlanningChange: (enabled: boolean) => void;
    theme?: CreativeAgentControlTheme;
    compact?: boolean;
    className?: string;
    middle?: ReactNode;
    modelPickerRequest?: number;
    defaultModelCapability?: CreativeAgentModelOption["capability"];
    modelCapabilities?: readonly CreativeAgentModelOption["capability"][];
    showPlanningControl?: boolean;
    showModelPicker?: boolean;
    emphasizedCompactControls?: boolean;
}) {
    const [skillOpen, setSkillOpen] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [capability, setCapability] = useState<CreativeAgentModelOption["capability"]>(defaultModelCapability);
    const modelsByCapability = useMemo(() => groupCreativeAgentModels(models), [models]);
    const visibleCapabilities = resolveCreativeAgentModelCapabilities(modelCapabilities);
    const preferredCapability = visibleCapabilities.includes(defaultModelCapability) ? defaultModelCapability : visibleCapabilities[0];
    const activeCapability = visibleCapabilities.includes(capability) ? capability : preferredCapability;
    const visibleModels = modelsByCapability[activeCapability];

    useEffect(() => {
        if (modelPickerRequest <= 0) return;
        setCapability(preferredCapability);
        setModelOpen(true);
    }, [modelPickerRequest, preferredCapability]);

    const [previewSkillId, setPreviewSkillId] = useState<string>();
    const previewSkill = skills.find((skill) => skill.id === previewSkillId) || selectedSkill || skills[0];
    const compactControlClassName = emphasizedCompactControls ? "!size-9 !min-w-9 !rounded-lg" : "!size-7 !min-w-7 !rounded-md";
    const compactControlIconClassName = emphasizedCompactControls ? "size-4" : "size-3.5";

    const skillContent = (
        <div className="w-[min(34rem,calc(100vw-32px))] overflow-hidden rounded-xl border border-stone-200/80 bg-white p-1 shadow-2xl dark:border-white/10 dark:bg-[#12161c]" data-creative-agent-skill-picker>
            <div className="flex min-w-0 max-sm:flex-col">
                <div className="min-w-0 border-r border-stone-200/80 p-2 dark:border-white/10 sm:w-[15rem]">
                    <p className="px-1 pb-2 text-sm font-semibold text-stone-900 dark:text-stone-100">Skill</p>
                    {previewSkill ? (
                        <div className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-[#0d1116]" data-creative-agent-skill-preview>
                            <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-cyan-400/25 via-sky-500/10 to-violet-500/25">
                                {previewSkill.previewImageUrl ? (
                                    <img src={previewSkill.previewImageUrl} alt={`${previewSkill.name}效果预览`} className="block size-full object-cover" loading="lazy" />
                                ) : (
                                    <Sparkles className="absolute inset-0 m-auto size-8 text-cyan-600/70 dark:text-cyan-300/80" strokeWidth={1.5} aria-hidden="true" />
                                )}
                            </div>
                            <div className="p-2.5">
                                <p className="truncate text-xs font-semibold text-stone-900 dark:text-stone-100">{previewSkill.name}</p>
                                <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-stone-500 dark:text-stone-400">{previewSkill.description || "选择此 Skill 后，会依据当前素材和需求执行创作。"}</p>
                            </div>
                        </div>
                    ) : (
                        <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">暂无预览</div>
                    )}
                </div>
                <div className="min-w-0 p-2 sm:w-[18rem]">
                    <div className="flex items-center justify-between gap-2 px-1 pb-2">
                        <div>
                            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">选择创作 Skill</p>
                            <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">悬停可预览效果</p>
                        </div>
                        <span className="text-[11px] tabular-nums text-stone-400 dark:text-stone-500">{skills.length}</span>
                    </div>
                    <div className="thin-scrollbar max-h-[min(19rem,calc(100dvh-13rem))] space-y-1 overflow-y-auto" data-creative-agent-skill-list>
                {skills.map((skill) => {
                    const active = selectedSkill?.id === skill.id;
                    return (
                        <button
                            key={skill.id}
                            type="button"
                            className={cn(
                                "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition",
                                active ? "bg-stone-100 text-stone-950 dark:bg-stone-800 dark:text-white" : "text-stone-600 hover:bg-stone-50 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800/70 dark:hover:text-white",
                            )}
                            onMouseEnter={() => setPreviewSkillId(skill.id)}
                            onFocus={() => setPreviewSkillId(skill.id)}
                            onClick={() => {
                                onSelectSkill(skill);
                                setSkillOpen(false);
                            }}
                        >
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                                <Sparkles className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium">{skill.name}</span>
                                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-stone-500 dark:text-stone-400">{skill.description}</span>
                            </span>
                            {active ? <Check className="mt-1 size-3.5 shrink-0" /> : null}
                        </button>
                    );
                })}
                {skillsLoading ? <p className="px-2 py-5 text-center text-xs text-stone-500 dark:text-stone-400">正在加载 Skill...</p> : null}
                {!skillsLoading && !skills.length ? <p className="px-2 py-5 text-center text-xs text-stone-500 dark:text-stone-400">暂无可用 Skill</p> : null}
                    </div>
                </div>
            </div>
        </div>
    );
    const modelContent = (
        <div className={cn("w-[calc(100vw-48px)]", compact ? "max-w-[280px]" : "max-w-[330px] p-1 sm:w-[340px]")} data-creative-agent-model-picker={compact ? "compact" : "default"}>
            <div className={cn("flex items-center justify-between", compact ? "gap-2 px-1 pb-1.5" : "gap-3 px-2 pb-2 pt-1")}>
                <div className="min-w-0">
                    <p className={cn("font-semibold text-stone-900 dark:text-stone-100", compact ? "text-[13px] leading-5" : "text-sm")}>选择生成模型</p>
                    <p className={cn("truncate text-stone-500 dark:text-stone-400", compact ? "text-[10px] leading-4" : "mt-0.5 text-[11px]")}>
                        {selectedModels.length ? `已选择 ${selectedModels.length} 个，最多 ${CREATIVE_RUN_MODEL_LIMIT} 个` : smartPlanning ? "默认由智能规划自动匹配" : "手动模式需要选择生成模型"}
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={smartPlanning}
                    aria-label={smartPlanning ? "关闭智能规划" : "开启智能规划"}
                    className={cn(
                        "flex shrink-0 items-center rounded-lg text-xs font-medium transition",
                        compact ? "gap-1.5 px-1 py-0.5" : "gap-2 px-1.5 py-1",
                        smartPlanning ? "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300" : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800",
                    )}
                    onClick={() => onSmartPlanningChange(!smartPlanning)}
                >
                    <span>{smartPlanning ? (compact ? "开启" : "已开启") : compact ? "关闭" : "已关闭"}</span>
                    <span
                        className={cn(
                            "relative rounded-full border transition",
                            compact ? "h-[18px] w-8" : "h-5 w-9",
                            smartPlanning ? "border-sky-600 bg-sky-600 dark:border-sky-400 dark:bg-sky-400" : "border-stone-300 bg-stone-200 dark:border-stone-600 dark:bg-stone-700",
                        )}
                    >
                        <span className={cn("absolute left-0.5 top-0.5 rounded-full bg-white shadow-sm transition-transform dark:bg-stone-950", compact ? "size-3.5" : "size-4", smartPlanning && (compact ? "translate-x-3.5" : "translate-x-4"))} />
                    </span>
                </button>
            </div>
            {selectedModels.length ? (
                <div className={cn("flex items-center justify-between border-y border-stone-200/80 text-xs dark:border-stone-700", compact ? "mb-1.5 px-1 py-1.5" : "mb-2 px-2 py-2")}>
                    <span className="text-stone-500 dark:text-stone-400">手动模型会关闭智能规划</span>
                    <button type="button" className="font-medium text-stone-600 hover:text-stone-950 dark:text-stone-300 dark:hover:text-white" onClick={onClearModels}>
                        清空并恢复智能规划
                    </button>
                </div>
            ) : null}
            {visibleCapabilities.length > 1 ? (
                <div
                    className={cn("grid gap-1 bg-stone-100 p-1 dark:bg-stone-800", compact ? "mb-1.5 rounded-md" : "mb-2 rounded-lg")}
                    style={{ gridTemplateColumns: `repeat(${visibleCapabilities.length}, minmax(0, 1fr))` }}
                    role="tablist"
                    aria-label="模型能力分类"
                >
                    {visibleCapabilities.map((item) => {
                        const Icon = item === "image" ? ImageIcon : item === "video" ? FileVideo : FileAudio;
                        const count = modelsByCapability[item].length;
                        return (
                            <button
                                key={item}
                                type="button"
                                role="tab"
                                aria-selected={activeCapability === item}
                                className={cn(
                                    "flex min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition",
                                    compact ? "h-7" : "h-8",
                                    activeCapability === item ? "bg-white text-stone-950 shadow-sm dark:bg-stone-700 dark:text-white" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white",
                                )}
                                onClick={() => setCapability(item)}
                            >
                                <Icon className="size-3.5 shrink-0" />
                                <span className="truncate">{capabilityLabel(item)}</span>
                                {count ? <span className="shrink-0">· {count}</span> : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            <div className={cn("thin-scrollbar space-y-1 overflow-y-auto", compact ? "max-h-40" : "max-h-52")}>
                {visibleModels.map((model) => {
                    const selected = selectedModels.some((item) => item.id === model.id);
                    return (
                        <button
                            key={model.id}
                            type="button"
                            className={cn(
                                "flex w-full items-center gap-2 text-left text-xs transition",
                                compact ? "min-h-8 rounded-md px-2 py-1.5" : "rounded-lg px-2.5 py-2",
                                selected ? "bg-stone-100 text-stone-950 dark:bg-stone-800 dark:text-white" : "text-stone-600 hover:bg-stone-50 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800/70 dark:hover:text-white",
                            )}
                            onClick={() => onToggleModel(model)}
                        >
                            <ModelIcon model={`${model.id} ${model.name}`} />
                            <span className="min-w-0 flex-1 truncate font-medium">{model.name}</span>
                            <span
                                className={cn("grid size-4 shrink-0 place-items-center rounded border", selected ? "border-stone-900 bg-stone-900 text-white dark:border-white dark:bg-white dark:text-stone-950" : "border-stone-300 dark:border-stone-600")}
                            >
                                {selected ? <Check className="size-3" /> : null}
                            </span>
                        </button>
                    );
                })}
                {!visibleModels.length ? <p className={cn("px-2 text-center text-xs leading-5 text-stone-500 dark:text-stone-400", compact ? "py-3" : "py-5")}>当前未配置可用的{capabilityLabel(activeCapability)}模型</p> : null}
            </div>
        </div>
    );
    const mutedStyle = theme ? { color: theme.muted } : undefined;
    const activeStyle = theme ? { background: theme.activeBackground, color: theme.activeText } : undefined;

    return (
        <div className={cn(compact ? "flex w-full min-w-0 items-center gap-1" : "flex min-w-0 items-center gap-1.5", className)} data-creative-agent-controls={compact ? "compact" : "default"}>
            <Popover trigger="click" placement="topLeft" open={skillOpen} onOpenChange={setSkillOpen} content={skillContent}>
                <Button
                    type="text"
                    className={cn(
                        "!shrink-0 !gap-1.5 !shadow-none",
                        compact ? `${compactControlClassName} !border-0 !bg-transparent !p-0 hover:!bg-black/5 dark:hover:!bg-white/5` : "!h-8 !min-w-8 !px-2",
                        skillOpen && !theme && "!bg-amber-50 !text-amber-800 dark:!bg-amber-400/10 dark:!text-amber-300",
                    )}
                    style={skillOpen ? activeStyle : mutedStyle}
                    icon={<Boxes className={compact ? compactControlIconClassName : "size-3.5"} strokeWidth={1.7} />}
                    aria-label={selectedSkill ? `当前 Skill：${selectedSkill.name}` : "选择创作 Skill"}
                >
                    {compact ? null : <span className="text-xs">Skill</span>}
                </Button>
            </Popover>
            {showPlanningControl ? (
                <Tooltip title={smartPlanning ? "智能规划：已开启" : "智能规划：已关闭"}>
                    <Button
                        type="text"
                        className={cn(
                            "!shrink-0 !gap-1.5 !shadow-none",
                            compact ? `${compactControlClassName} !border-0 !bg-transparent !p-0 hover:!bg-black/5 dark:hover:!bg-white/5` : "!h-8 !min-w-8 !px-2",
                            smartPlanning && !theme ? "!text-sky-700 dark:!text-sky-300" : !theme ? "!text-stone-500 dark:!text-stone-400" : undefined,
                        )}
                        style={mutedStyle}
                        icon={<Lightbulb className={cn(compact ? compactControlIconClassName : "size-3.5", smartPlanning && "fill-current")} strokeWidth={1.7} />}
                        onClick={() => {
                            onSmartPlanningChange(!smartPlanning);
                            if (smartPlanning) setModelOpen(true);
                        }}
                        aria-label={smartPlanning ? "智能规划已开启，点击关闭" : "智能规划已关闭，点击开启"}
                        aria-pressed={smartPlanning}
                    >
                        {compact ? null : <span className="text-xs">智能</span>}
                    </Button>
                </Tooltip>
            ) : null}
            {showModelPicker ? (
                <Popover trigger="click" placement="top" open={modelOpen} onOpenChange={setModelOpen} content={modelContent} styles={compact ? { container: { padding: 8, borderRadius: 12 } } : undefined}>
                    <Tooltip title={selectedModels.length ? `已选择 ${selectedModels.length} 个模型` : "选择生成模型"}>
                        <Button
                            type="text"
                            shape="circle"
                            className={cn(
                                "relative !shrink-0 !border-0 !bg-transparent !p-0 !shadow-none hover:!bg-black/5 dark:hover:!bg-white/5",
                                compact ? compactControlClassName : "!h-8 !w-8 !min-w-8",
                                modelOpen && !theme && "!bg-stone-100 !text-stone-950 dark:!bg-stone-800 dark:!text-white",
                            )}
                            style={modelOpen ? activeStyle : mutedStyle}
                            icon={<Orbit className={compact ? compactControlIconClassName : "size-3.5"} strokeWidth={1.7} />}
                            aria-label={selectedModels.length ? `已选择 ${selectedModels.length} 个模型` : "选择生成模型"}
                        >
                            {selectedModels.length ? <span className="absolute right-0 top-0 size-1.5 rounded-full bg-cyan-500" aria-hidden="true" /> : null}
                        </Button>
                    </Tooltip>
                </Popover>
            ) : null}
            {middle ? <div className={cn("min-w-0", compact && "ml-auto pl-1")}>{middle}</div> : null}
        </div>
    );
}

function capabilityLabel(capability: CreativeAgentModelOption["capability"]) {
    return capability === "image" ? "图片" : capability === "video" ? "视频" : "音频";
}

export function groupCreativeAgentModels(models: CreativeAgentModelOption[]) {
    return {
        image: models.filter((model) => model.capability === "image"),
        video: models.filter((model) => model.capability === "video"),
        audio: models.filter((model) => model.capability === "audio"),
    };
}

export function resolveCreativeAgentModelCapabilities(capabilities?: readonly CreativeAgentModelOption["capability"][]) {
    if (!capabilities?.length) return [...creativeAgentModelCapabilities];
    const requested = new Set(capabilities);
    const resolved = creativeAgentModelCapabilities.filter((capability) => requested.has(capability));
    return resolved.length ? resolved : [...creativeAgentModelCapabilities];
}
