"use client";

import { useEffect } from "react";
import { Aperture, Sparkles, Workflow } from "lucide-react";

import { GenerationActionButton } from "@/components/generation-action-button";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "../types";
import { interiorDesignModels } from "../utils/canvas-interior-design";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";

type Props = {
    node: CanvasNodeData;
    isRunning: boolean;
    imageInputCount: number;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onEdit: (nodeId: string) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
};

export function CanvasInteriorDesignNodePanel({ node, isRunning, imageInputCount, onConfigChange, onEdit, onGenerate, onStop }: Props) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const models = interiorDesignModels(globalConfig);
    const currentModel = models.includes(node.metadata?.model || "") ? node.metadata?.model || "" : models[0] || "";
    const settings = node.metadata?.interiorDesign;
    const runningHubAppId = node.metadata?.runningHubAppId;
    const modelConfig = {
        ...globalConfig,
        model: currentModel,
        imageModel: currentModel,
        size: node.metadata?.size || settings?.aspectRatio || "auto",
        quality: node.metadata?.quality || "high",
        count: String(node.metadata?.count || 1),
    };
    const canGenerate = Boolean((runningHubAppId || currentModel) && settings && imageInputCount > 0);

    useEffect(() => {
        if (!runningHubAppId && currentModel && currentModel !== node.metadata?.model) onConfigChange(node.id, { model: currentModel });
    }, [currentModel, node.id, node.metadata?.model, onConfigChange, runningHubAppId]);

    return (
        <div data-canvas-interior-design-node className="flex h-full w-full cursor-move flex-col px-3 py-3 text-sm" style={{ color: theme.node.text }}>
            <div className="mb-2.5 flex min-w-0 items-center gap-2.5 px-0.5">
                <span className={`canvas-interior-design-icon grid size-7 shrink-0 place-items-center rounded-lg ${isRunning ? "is-running" : ""}`} style={{ background: theme.toolbar.itemHover, color: theme.node.action }}>
                    <Sparkles className="size-3.5" />
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{node.metadata?.runningHubAppName || "SU直出摄影级照片"}</span>
                    <span className="mt-0.5 block truncate text-[10px]" style={{ color: theme.node.faint }}>
                        {imageInputCount ? "已连接原图" : "请连接一张原图"}
                    </span>
                </span>
            </div>

            <div data-canvas-interior-controls className="flex min-w-0 flex-col rounded-2xl border p-2" style={{ gap: 8, background: theme.node.fill, borderColor: theme.node.stroke }}>
                <div className="min-w-0" onMouseDown={(event) => event.stopPropagation()}>
                    {runningHubAppId ? (
                        <button type="button" data-canvas-no-drag className="canvas-compact-control flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border px-3 text-left text-[11px] font-medium" style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.muted }} onClick={() => onEdit(node.id)}>
                            <Workflow className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">RunningHub · {node.metadata?.runningHubAppName || "已绑定应用"}</span>
                        </button>
                    ) : (
                        <ModelPicker
                            className="canvas-compact-control !h-9 !w-full !gap-1.5 !rounded-xl !border !px-2.5 !text-[11px] !shadow-none"
                            config={globalConfig}
                            value={currentModel}
                            capability="image"
                            options={models}
                            placeholder="Gemini 生图模型"
                            onChange={(model) => onConfigChange(node.id, { model })}
                            onMissingConfig={() => openConfigDialog(true)}
                            fullWidth
                        />
                    )}
                </div>

                <div data-canvas-interior-parameter-row className="grid min-w-0 grid-cols-2 gap-2" onMouseDown={(event) => event.stopPropagation()}>
                    <CanvasImageSettingsPopover
                        config={modelConfig}
                        placement="topLeft"
                        compactTriggerLabel="模型参数"
                        showTriggerChevron={false}
                        buttonClassName="canvas-compact-control !h-9 !w-full !min-w-0 !justify-center !gap-1.5 !rounded-xl !border !px-2 !text-[11px] !font-medium !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, modelParameterPatch(key, value))}
                    />
                    <button
                        type="button"
                        data-canvas-no-drag
                        className="inline-flex h-9 min-w-0 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-2 text-[11px] font-medium transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                        style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.muted }}
                        onClick={() => onEdit(node.id)}
                    >
                        <Aperture className="size-3.5 shrink-0" />
                        <span className="whitespace-nowrap">摄影参数</span>
                    </button>
                </div>
            </div>

            <div data-canvas-interior-actions className="mt-2.5">
                {!runningHubAppId && !models.length ? <div className="mb-1.5 truncate text-[10px] text-amber-500">请先配置 Gemini Nano Banana 生图模型</div> : null}
                <GenerationActionButton
                    data-canvas-no-drag
                    data-canvas-interior-generate
                    appearance="primary"
                    running={isRunning}
                    cancellable
                    className="!h-9 !w-full !rounded-xl !px-3 !text-[13px] !font-semibold"
                    disabled={!isRunning && !canGenerate}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
                >
                    {isRunning ? "停止生成" : "生成"}
                </GenerationActionButton>
            </div>
        </div>
    );
}

function modelParameterPatch(key: string, value: string): Partial<CanvasNodeMetadata> {
    if (key === "size") return { size: value, sizeUserSelected: value !== "auto" };
    if (key === "quality") return { quality: value };
    if (key === "count") return { count: Math.max(1, Math.floor(Number(value) || 1)) };
    return {};
}
