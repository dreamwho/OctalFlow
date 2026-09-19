"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, MessageSquare, Settings2 } from "lucide-react";
import { Button, Dropdown } from "antd";

import { GenerationActionButton } from "@/components/generation-action-button";
import { ModelPicker } from "@/components/model-picker";
import { DreamyoIcon } from "@/components/ui/dreamyo-icon";
import { CreditSymbol, formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasCameraControl } from "./canvas-camera-control";
import { CanvasInteriorDesignNodePanel } from "./canvas-interior-design-node-panel";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { buildCanvasNodeConfig, canvasAudioConfigPatch, canvasVideoConfigPatch, resolveCanvasGenerationModel } from "../utils/canvas-node-config";
import { canvasDreaminaModelCompatible, canvasDreaminaVideoCommand } from "../utils/canvas-dreamina-cli";
import { isInteriorDesignNode } from "../utils/canvas-interior-design";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    references: CanvasResourceReference[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
    onInteriorDesignEdit?: (nodeId: string) => void;
};

export function CanvasConfigNodePanel(props: CanvasConfigNodePanelProps) {
    if (isInteriorDesignNode(props.node.metadata)) {
        return (
            <CanvasInteriorDesignNodePanel
                node={props.node}
                isRunning={props.isRunning}
                imageInputCount={props.inputSummary.imageCount}
                onConfigChange={props.onConfigChange}
                onEdit={(nodeId) => props.onInteriorDesignEdit?.(nodeId)}
                onGenerate={props.onGenerate}
                onStop={props.onStop}
            />
        );
    }
    return <CanvasDefaultConfigNodePanel {...props} />;
}

function CanvasDefaultConfigNodePanel({ node, isRunning, inputSummary, references, onConfigChange, onGenerate, onStop, onComposerToggle }: CanvasConfigNodePanelProps) {
    const [detailsOpen, setDetailsOpen] = useState(node.metadata?.configDetailsOpen === true);
    const [modeMenuOpen, setModeMenuOpen] = useState(false);
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const credits = requestCreditCost({
        apiSource: config.apiSource,
        modelPointCosts: config.modelPointCosts,
        generationPointMultipliers: config.generationPointMultipliers,
        kind: mode,
        model: config.model,
        count: mode === "image" ? count : 1,
        quality: config.quality,
        videoQuality: config.vquality,
        videoSeconds: config.videoSeconds,
    });
    const inputTotal = inputSummary.textCount + inputSummary.imageCount + inputSummary.videoCount + inputSummary.audioCount;
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);
    const modeLabel = generationModeLabel(mode);
    const dreaminaCommand = mode === "video" ? canvasDreaminaVideoCommand(node.metadata, references) : inputSummary.imageCount ? "image2image" : "text2image";
    const compatibleModels = selectableModelsByCapability(globalConfig, mode).filter((model) => canvasDreaminaModelCompatible(globalConfig, model, mode, dreaminaCommand));
    const setDetails = (nextOpen: boolean) => {
        setDetailsOpen(nextOpen);
        onConfigChange(node.id, { configDetailsOpen: nextOpen });
    };
    const selectMode = (nextMode: CanvasGenerationMode) => {
        onConfigChange(node.id, { generationMode: nextMode, model: resolveCanvasGenerationModel(globalConfig, nextMode) });
        setModeMenuOpen(false);
    };

    useEffect(() => {
        setDetailsOpen(node.metadata?.configDetailsOpen === true);
    }, [node.id, node.metadata?.configDetailsOpen]);

    return (
        <div
            data-canvas-config-node-panel
            data-canvas-config-ready={canGenerate ? "true" : "false"}
            className="canvas-config-node-panel flex h-full w-full cursor-move flex-col px-4 pb-4 pt-4 text-sm"
            style={{ color: theme.node.text }}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-3 flex min-h-10 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-10 shrink-0 place-items-center rounded-2xl" style={{ background: theme.toolbar.itemHover, color: theme.node.action }}>
                        <DreamyoIcon name="magic" size={22} />
                    </span>
                    <div className="min-w-0">
                        <div className="truncate text-[18px] font-semibold tracking-[0.01em]">生成配置</div>
                        <div className="mt-1 truncate text-xs" style={{ color: theme.node.faint }}>
                            {isRunning ? "正在处理当前输入" : canGenerate ? `${inputTotal ? `${inputTotal} 项` : "提示词"} · 就绪` : "连接素材或输入提示词"}
                        </div>
                    </div>
                </div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomRight"
                        open={modeMenuOpen}
                        onOpenChange={setModeMenuOpen}
                        popupRender={() => (
                            <div
                                role="menu"
                                className="min-w-36 rounded-xl border p-1.5 shadow-[0_14px_34px_rgba(15,23,42,.16)]"
                                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                                onPointerDown={(event) => event.stopPropagation()}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium opacity-45">生成类型</div>
                                {GENERATION_MODES.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        role="menuitem"
                                        aria-label={item.label}
                                        className="flex h-9 w-full items-center justify-between rounded-lg px-2 text-left text-xs transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.08]"
                                        style={{ color: item.value === mode ? theme.node.action : theme.node.text }}
                                        onClick={() => selectMode(item.value)}
                                    >
                                        <ModeLabel mode={item.value} label={item.label} />
                                        {item.value === mode ? <Check className="size-3.5" /> : null}
                                    </button>
                                ))}
                            </div>
                        )}
                    >
                        <Button
                            type="text"
                            size="small"
                            data-canvas-no-drag
                            className="!inline-flex !h-11 !items-center !rounded-2xl !border !px-3 !text-[15px] !shadow-none"
                            style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.text }}
                            aria-label={`切换生成类型，当前${modeLabel}`}
                        >
                            <ModeLabel mode={mode} label={modeLabel} />
                            <ChevronDown className="ml-1 size-4 opacity-60" />
                        </Button>
                    </Dropdown>
                </div>
            </div>

            <div
                className={`mb-2 grid h-12 min-w-0 cursor-default items-stretch overflow-hidden rounded-2xl border ${mode === "image" || mode === "video" || mode === "audio" ? "grid-cols-[minmax(0,1fr)_150px] divide-x" : "grid-cols-1"}`}
                style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <ModelPicker
                    className="canvas-compact-control !h-12 !rounded-none !border-0 !bg-transparent !text-[15px] !shadow-none"
                    config={config}
                    value={config.model}
                    onChange={(model) => onConfigChange(node.id, { model })}
                    capability={mode}
                    options={compatibleModels}
                    onMissingConfig={() => openConfigDialog(true)}
                    fullWidth
                />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover
                        config={config}
                        metadata={node.metadata}
                        references={references}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-12 !w-full !justify-start !rounded-none !border-0 !bg-transparent !px-3 !text-[14px] !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, canvasVideoConfigPatch(key, value))}
                        onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                    />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover
                        config={config}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-12 !w-full !justify-start !rounded-none !border-0 !bg-transparent !px-3 !text-[14px] !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                    />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover
                        config={config}
                        placement="top"
                        buttonClassName="canvas-compact-control !h-12 !w-full !justify-start !rounded-none !border-0 !bg-transparent !px-3 !text-[14px] !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, canvasAudioConfigPatch(key, value))}
                    />
                ) : null}
            </div>

            <div className="mb-2 min-w-0 cursor-default overflow-hidden rounded-2xl border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }} onMouseDown={(event) => event.stopPropagation()}>
                <div className="flex h-12 min-w-0 items-stretch">
                    <button
                        type="button"
                        className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 text-left transition-colors hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                        aria-expanded={detailsOpen}
                        aria-controls={`canvas-config-details-${node.id}`}
                        aria-label={detailsOpen ? "收起输入与镜头" : "展开输入与镜头"}
                        onClick={() => setDetails(!detailsOpen)}
                    >
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}>
                            <DreamyoIcon name="image" size={18} />
                        </span>
                        <span className="min-w-0 truncate text-[14px] font-medium">素材与镜头</span>
                        <span className="truncate text-xs" style={{ color: theme.node.faint }}>
                            {inputTotal ? `${inputTotal} 项已连接` : "等待连接"}
                        </span>
                        <ChevronDown className={`ml-auto size-4 shrink-0 opacity-55 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
                    </button>
                    <button
                        type="button"
                        data-canvas-no-drag
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-l px-2.5 text-[11px] font-medium transition-colors hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                        style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                        onClick={onComposerToggle}
                    >
                        <Settings2 className="size-3.5 opacity-70" />
                        <span className="hidden min-[360px]:inline">编辑提示词</span>
                    </button>
                </div>

                {detailsOpen ? (
                    <div id={`canvas-config-details-${node.id}`} data-canvas-config-details className="flex min-w-0 items-center gap-2 border-t px-2 py-2" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex h-9 min-w-0 flex-1 items-center divide-x overflow-hidden" style={{ color: theme.node.muted }}>
                            <InputCount icon={<MessageSquare className="size-3" />} label="提示词" value={inputSummary.textCount} />
                            <InputCount icon={<DreamyoIcon name="image" size={14} />} label="参考图" value={inputSummary.imageCount} />
                            <InputCount icon={<DreamyoIcon name="video" size={14} />} label="参考视频" value={inputSummary.videoCount} />
                            <InputCount icon={<DreamyoIcon name="audio" size={14} />} label="参考音频" value={inputSummary.audioCount} />
                        </div>
                        {mode === "image" || mode === "video" ? (
                            <div className="ml-1.5 min-w-0 w-[150px] shrink-0 border-l pl-2">
                                <CanvasCameraControl
                                    value={node.metadata?.cameraControl}
                                    onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })}
                                    placement="topRight"
                                    buttonClassName="canvas-compact-control !h-9 !w-full !justify-start !rounded-xl !border-0 !bg-transparent !px-2 !text-xs !shadow-none"
                                />
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {!isRunning ? (
                <div data-canvas-credit-cost className="mb-1.5 flex shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums" style={{ color: theme.node.muted }}>
                    <CreditSymbol />
                    {formatCreditAmount(credits)}
                </div>
            ) : null}
            <GenerationActionButton
                appearance="primary"
                running={isRunning}
                cancellable
                className="mt-auto !h-12 !w-full !cursor-pointer !rounded-2xl !text-[15px] !font-semibold"
                disabled={!isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
            >
                {isRunning ? "停止生成" : "开始生成"}
            </GenerationActionButton>
        </div>
    );
}

function InputCount({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
    return (
        <span className="inline-flex h-full min-w-0 flex-1 items-center justify-center gap-1 px-1 text-[11px]" title={`${label} ${value}`}>
            {icon}
            <span className="font-medium tabular-nums">{value}</span>
        </span>
    );
}

const GENERATION_MODES: Array<{ value: CanvasGenerationMode; label: string }> = [
    { value: "image", label: "生图" },
    { value: "text", label: "文本" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
];

function ModeLabel({ mode, label }: { mode: CanvasGenerationMode; label: string }) {
    const icon = mode === "image" || mode === "video" || mode === "audio" ? <DreamyoIcon name={mode} size={16} /> : <MessageSquare className="size-3.5" />;
    return (
        <span className="inline-flex items-center gap-1.5">
            {icon}
            {label}
        </span>
    );
}

function generationModeLabel(mode: CanvasGenerationMode) {
    return GENERATION_MODES.find((item) => item.value === mode)?.label || "生图";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    const model = resolveCanvasGenerationModel(globalConfig, mode, node.metadata?.model);
    return buildCanvasNodeConfig(globalConfig, node, mode, model);
}
