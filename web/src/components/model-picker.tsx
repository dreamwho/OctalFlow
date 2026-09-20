"use client";

import { Popover } from "antd";
import { Check, ChevronDown, Clock3, Cpu, Search, Timer } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { formatDurationMinSec } from "@/lib/duration-format";
import { cn } from "@/lib/utils";
import { modelOptionLabel, modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    options?: readonly string[];
    getModelLabel?: (model: string) => string;
};

export type ModelOption = {
    id: string;
    label: string;
    provider: string;
    modelName: string;
};

const RECENT_MODEL_LIMIT = 4;
/* 搜索框 + 列表内边距等面板固定占用高度 */
const PANEL_CHROME_HEIGHT = 74;
type ModelDurationStats = Record<string, { avgDurationMs: number; samples: number }>;
const DURATION_STATS_TTL_MS = 60_000;

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig, options: allowedOptions, getModelLabel }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [recentModels, setRecentModels] = useState<string[]>([]);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [listMaxHeight, setListMaxHeight] = useState<number>();
    const [placement, setPlacement] = useState<"bottomLeft" | "topLeft">("bottomLeft");
    const [durationStats, setDurationStats] = useState<ModelDurationStats>({});
    const durationStatsFetchedAtRef = useRef(0);

    const configuredOptions = useMemo(() => {
        const configured = selectableModelsByCapability(config, capability);
        if (!allowedOptions) return configured;
        const allowed = new Set(allowedOptions);
        return configured.filter((model) => allowed.has(model));
    }, [allowedOptions, capability, config]);

    const current = !capability || !value || configuredOptions.includes(value) ? value || "" : "";
    const options = useMemo(() => {
        const currentOption = !capability || !value || configuredOptions.includes(value) ? value : "";
        return Array.from(new Set((currentOption && !configuredOptions.includes(currentOption) ? [currentOption, ...configuredOptions] : configuredOptions).filter((model): model is string => Boolean(model))));
    }, [capability, configuredOptions, value]);
    const hasConfiguredOptions = configuredOptions.length > 0;
    const labelForModel = useCallback((model: string) => getModelLabel?.(model) || modelOptionLabel(config, model), [config, getModelLabel]);
    const modelOptions = useMemo<ModelOption[]>(
        () =>
            options.map((model) => ({
                id: model,
                label: labelForModel(model),
                modelName: modelOptionName(model),
                provider: modelProviderLabel(model),
            })),
        [labelForModel, options],
    );
    const recentOptions = useMemo(() => {
        const optionById = new Map(modelOptions.map((option) => [option.id, option]));
        return recentModels.map((model) => optionById.get(model)).filter((option): option is ModelOption => Boolean(option));
    }, [modelOptions, recentModels]);
    const filteredOptions = useMemo(() => filterModelOptions(modelOptions, query), [modelOptions, query]);
    const filteredRecentOptions = useMemo(() => filterModelOptions(recentOptions, query), [query, recentOptions]);
    const groupedOptions = useMemo(() => groupModelOptions(filteredOptions), [filteredOptions]);

    useEffect(() => {
        if (!current || !options.includes(current)) return;
        setRecentModels((previous) => [current, ...previous.filter((model) => model !== current)].slice(0, RECENT_MODEL_LIMIT));
    }, [current, options]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const updateRecent = (model: string) => setRecentModels((previous) => [model, ...previous.filter((item) => item !== model)].slice(0, RECENT_MODEL_LIMIT));
    /* 弹层自动选择上下空间更大的一侧，并按视口分辨率动态限制列表高度，
     * 保证矮视口也不溢出、高分辨率屏幕有足够的选择空间。 */
    const measureAvailableHeight = useCallback(() => {
        window.requestAnimationFrame(() => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
            const below = viewportHeight - rect.bottom - 16 - PANEL_CHROME_HEIGHT;
            const above = rect.top - 16 - PANEL_CHROME_HEIGHT;
            const useTop = above > below;
            setPlacement(useTop ? "topLeft" : "bottomLeft");
            const desired = Math.max(280, Math.min(560, Math.floor(viewportHeight * 0.55)));
            setListMaxHeight(Math.max(240, Math.min(desired, Math.max(below, above))));
        });
    }, []);
    const handleOpenChange = (nextOpen: boolean) => {
        if (nextOpen && !hasConfiguredOptions) {
            setOpen(false);
            onMissingConfig?.();
            return;
        }
        if (nextOpen) {
            window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
            setQuery("");
            measureAvailableHeight();
            loadDurationStats();
        }
        setOpen(nextOpen);
    };
    const loadDurationStats = () => {
        if (Date.now() - durationStatsFetchedAtRef.current < DURATION_STATS_TTL_MS) return;
        durationStatsFetchedAtRef.current = Date.now();
        fetch("/api/model-generation-stats")
            .then((response) => (response.ok ? response.json() : null))
            .then((payload: { data?: ModelDurationStats } | null) => {
                if (payload?.data) setDurationStats(payload.data);
            })
            .catch(() => {});
    };
    const handleSelect = (model: string) => {
        updateRecent(model);
        onChange(model);
        setQuery("");
        setOpen(false);
    };

    const content = (
        <div
            className="w-[min(34rem,calc(100vw-24px))] min-w-0 overflow-hidden rounded-[18px] border border-border bg-popover text-popover-foreground shadow-2xl"
            data-canvas-no-drag
            data-canvas-no-zoom
            data-model-picker-panel
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="border-b border-border/70 p-2.5">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <input
                        autoFocus={open}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setOpen(false);
                                return;
                            }
                            event.stopPropagation();
                        }}
                        placeholder="搜索模型名称 / 厂商..."
                        aria-label="搜索模型名称或厂商"
                        className="h-9 w-full rounded-xl border border-border/80 bg-background/70 pr-3 pl-9 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
                    />
                </div>
            </div>
            <div className="hide-scrollbar max-h-[min(28rem,calc(100dvh-132px))] overflow-y-auto overscroll-contain p-2" style={listMaxHeight ? { maxHeight: `${listMaxHeight}px` } : undefined} role="listbox" aria-label="模型列表">
                {filteredRecentOptions.length ? <ModelOptionGroup title="最近使用" icon={<Clock3 className="size-3.5" />} options={filteredRecentOptions} current={current} capability={capability} durationStats={durationStats} onSelect={handleSelect} /> : null}
                {Array.from(groupedOptions.entries()).map(([provider, providerOptions]) => (
                    <ModelOptionGroup key={provider} title={provider} options={providerOptions} current={current} capability={capability} durationStats={durationStats} onSelect={handleSelect} />
                ))}
                {!filteredOptions.length ? <div className="rounded-xl border border-dashed border-border/80 px-3 py-6 text-center text-xs text-muted-foreground">{query.trim() ? "没有匹配的模型" : emptyModelLabel(config, capability)}</div> : null}
            </div>
        </div>
    );

    return (
        <Popover
            open={open}
            onOpenChange={handleOpenChange}
            trigger="click"
            placement={placement}
            arrow={false}
            autoAdjustOverflow
            zIndex={1200}
            getPopupContainer={() => document.body}
            classNames={{ container: "model-picker-popover-container" }}
            styles={{ container: { padding: 0, borderRadius: 18, overflow: "hidden" } }}
            content={content}
        >
            <button
                ref={triggerRef}
                type="button"
                className={cn(
                    "canvas-composer-model-picker inline-flex h-8 w-fit max-w-full items-center justify-between gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal text-foreground shadow-sm outline-none transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    open && "border-ring bg-accent/30 ring-2 ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? labelForModel(current) : placeholder}
                aria-label={current ? "当前模型：" + labelForModel(current) : placeholder}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-disabled={!hasConfiguredOptions}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? labelForModel(current) : placeholder}</span>
                <ChevronDown className={cn("canvas-select-chevron size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
        </Popover>
    );
}

function ModelOptionGroup({ title, icon, options, current, capability, durationStats, onSelect }: { title: string; icon?: ReactNode; options: ModelOption[]; current: string; capability?: ModelCapability; durationStats: ModelDurationStats; onSelect: (model: string) => void }) {
    return (
        <section className="mb-2 last:mb-0" aria-label={title}>
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {icon}
                <span className="truncate">{title}</span>
            </div>
            <div className="space-y-0.5">
                {options.map((option) => {
                    const selected = current === option.id;
                    const stat = durationStats[option.id] || durationStats[option.modelName];
                    return (
                        <button
                            key={option.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-model-id={option.id}
                            data-state={selected ? "selected" : ""}
                            className={cn(
                                "group flex min-h-10 w-full min-w-0 items-center gap-2 rounded-xl border border-transparent px-2.5 py-1.5 text-left transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
                                selected ? "border-primary/30 bg-primary/10 text-primary" : "text-foreground hover:border-border hover:bg-accent/70",
                            )}
                            onClick={() => onSelect(option.id)}
                        >
                            <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-muted/65", selected && "bg-primary/15")}>
                                <ModelIcon model={option.id} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{option.label}</span>
                            </span>
                            {stat ? (
                                <span
                                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-400/15 px-2 py-1 text-xs font-semibold leading-none text-emerald-300 tabular-nums ring-1 ring-emerald-400/25 ring-inset"
                                    title={`最近 ${stat.samples} 次生成平均耗时`}
                                >
                                    <Timer className="size-3.5" aria-hidden="true" />
                                    {formatDurationMinSec(stat.avgDurationMs)}
                                </span>
                            ) : null}
                            {capability ? <span className="hidden shrink-0 rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">{modelCapabilityLabel(capability)}</span> : null}
                            <span className={cn("grid size-5 shrink-0 place-items-center rounded-md border border-transparent text-primary", selected && "border-primary/35 bg-primary/10")} aria-hidden="true">
                                {selected ? <Check className="size-3.5" /> : null}
                            </span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability === "image" ? "图片" : capability === "video" ? "视频" : capability === "text" ? "文本" : capability === "audio" ? "音频" : "";
    if (config.models.length) return "暂无匹配的" + label + "模型";
    return "请联系管理员在后台配置渠道和模型";
}

export function filterModelOptions(options: readonly ModelOption[], query: string) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [...options];
    return options.filter((option) => (option.label + " " + option.modelName + " " + option.provider).toLowerCase().includes(normalized));
}

export function groupModelOptions(options: readonly ModelOption[]) {
    const grouped = new Map<string, ModelOption[]>();
    for (const option of options) grouped.set(option.provider, [...(grouped.get(option.provider) || []), option]);
    return grouped;
}

export function modelProviderLabel(model: string) {
    const name = modelOptionName(model).toLowerCase();
    if (name.includes("gemini") || name.includes("google") || name.includes("imagen") || name.includes("veo")) return "Google Gemini";
    if (name.includes("seedream") || name.includes("seedance") || name.includes("dreamina") || name.includes("jimeng") || name.includes("即梦") || name.includes("doubao") || name.includes("bytedance")) return "ByteDance Seedream";
    if (name.includes("gpt") || name.includes("openai")) return "OpenAI";
    if (name.includes("minimax") || name.includes("hailuo") || name.includes("海螺") || /(?:^|[-_ ])(?:speech|music)-/i.test(name)) return "MiniMax";
    if (name.includes("claude") || name.includes("anthropic")) return "Anthropic";
    if (name.includes("qwen") || name.includes("aliyun") || name.includes("bailian") || name.includes("cosyvoice") || name.includes("通义")) return "阿里云 / 通义千问";
    if (name.includes("deepseek")) return "DeepSeek";
    if (name.includes("glm") || name.includes("chatglm") || name.includes("智谱")) return "智谱 GLM";
    if (name.includes("grok") || name.includes("xai")) return "xAI";
    return "其他模型";
}

function modelCapabilityLabel(capability: ModelCapability) {
    return capability === "image" ? "图片" : capability === "video" ? "视频" : capability === "audio" ? "音频" : "文本";
}

export function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    const colorIcon = icon === "/icons/jimeng.svg" || icon === "/icons/minimax.svg" || icon === "/icons/qwen.svg";
    return icon ? <img src={icon} alt="" className={cn("size-4 shrink-0", colorIcon ? "" : "dark:invert")} /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

export function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("minimax") || name.includes("hailuo") || name.includes("海螺") || /(?:^|[-_ ])(?:speech|music)-/i.test(name)) return "/icons/minimax.svg";
    if (name.includes("seedance") || name.includes("seedream") || name.includes("dreamina") || name.includes("jimeng") || name.includes("即梦")) return "/icons/jimeng.svg";
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm")) return "/icons/glm.svg";
    if (name.includes("qwen") || name.includes("aliyun") || name.includes("bailian") || name.includes("cosyvoice")) return "/icons/qwen.svg";
    return "";
}
