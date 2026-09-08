"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUp, LoaderCircle, Sparkles, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getDreaminaStatus, type DreaminaStatus, type ImageUpscaleResolution } from "@/services/api/image";
import type { CanvasNodeData } from "../types";
import { DREAMINA_UPSCALE_RESOLUTION_OPTIONS, canUseDreaminaUpscale, resolveDreaminaUpscaleSize, type CanvasImageUpscaleParams } from "./canvas-node-upscale-dialog";

type CanvasNodeUpscalePanelProps = {
    node: CanvasNodeData;
    sourceNode: CanvasNodeData | null;
    onClose: () => void;
    onConfirm: (params: CanvasImageUpscaleParams) => void;
};

export function resolveDreaminaUpscaleSubmitStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    return { background: theme.node.activeStroke, borderColor: theme.node.activeStroke, color: theme.node.actionText };
}

export function CanvasNodeUpscalePanel({ node, sourceNode, onClose, onConfirm }: CanvasNodeUpscalePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const initialResolution = node.metadata?.upscaleTask?.resolutionType || "2k";
    const [resolutionType, setResolutionType] = useState<ImageUpscaleResolution>(initialResolution);
    const [status, setStatus] = useState<DreaminaStatus | null>(null);
    const [loadingStatus, setLoadingStatus] = useState(true);
    const sourceWidth = Math.max(0, Math.round(sourceNode?.metadata?.naturalWidth || sourceNode?.width || 0));
    const sourceHeight = Math.max(0, Math.round(sourceNode?.metadata?.naturalHeight || sourceNode?.height || 0));
    const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
    const outputSize = useMemo(() => (sourceWidth && sourceHeight ? resolveDreaminaUpscaleSize(sourceWidth, sourceHeight, resolutionType) : null), [resolutionType, sourceHeight, sourceWidth]);
    const canSubmit = canUseDreaminaUpscale(status, sourceLongEdge, resolutionType);

    useEffect(() => {
        setResolutionType(node.metadata?.upscaleTask?.resolutionType || "2k");
    }, [node.id, node.metadata?.upscaleTask?.resolutionType]);

    useEffect(() => {
        const controller = new AbortController();
        setLoadingStatus(true);
        setStatus(null);
        void getDreaminaStatus(controller.signal)
            .then((next) => {
                if (!controller.signal.aborted) setStatus(next);
            })
            .catch(() => {
                if (!controller.signal.aborted) setStatus(null);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoadingStatus(false);
            });
        return () => controller.abort();
    }, []);

    const submit = () => {
        const targetLongEdge = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((item) => item.value === resolutionType)?.pixels || 2048;
        if (!canSubmit) return;
        onConfirm({ engine: "dreamina-cli", algorithm: "high", resolutionType, targetLongEdge });
    };

    const statusText = loadingStatus
        ? "正在确认即梦 CLI 状态…"
        : !sourceNode
          ? "原图节点不可用，无法重新提交超清任务"
          : status?.enabled !== true
            ? "即梦 CLI 图片超清尚未在上游配置中启用"
            : status.authorized !== true
              ? "即梦 CLI 尚未授权"
              : sourceLongEdge >= (DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((item) => item.value === resolutionType)?.pixels || 0)
                ? "原图已达到当前目标分辨率"
                : `即梦 CLI 已连接${status.vipLevel ? ` · ${status.vipLevel}` : ""}`;

    return (
        <section
            data-canvas-upscale-panel
            className="mx-auto w-[min(440px,calc(100vw-2rem))] overflow-hidden rounded-2xl border shadow-[0_18px_54px_rgba(15,23,42,.18)]"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <header className="flex h-11 items-center gap-2 border-b px-4" style={{ borderColor: theme.toolbar.border }}>
                <Sparkles className="size-4" style={{ color: theme.node.activeStroke }} />
                <span className="text-sm font-semibold">高清放大</span>
                <span className="ml-auto text-xs" style={{ color: theme.node.muted }}>
                    即梦 CLI
                </span>
                <button type="button" data-canvas-no-drag className="grid size-7 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" onClick={onClose} aria-label="关闭高清放大设置">
                    <X className="size-4" />
                </button>
            </header>
            <div className="space-y-3 px-4 py-3.5">
                <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 text-sm">
                    <span style={{ color: theme.node.muted }}>模型</span>
                    <span className="truncate font-medium">即梦 CLI 图片超清</span>
                </div>
                <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 text-sm">
                    <span style={{ color: theme.node.muted }}>清晰度</span>
                    <div className="grid grid-cols-3 gap-1.5">
                        {DREAMINA_UPSCALE_RESOLUTION_OPTIONS.map((option) => {
                            const selected = resolutionType === option.value;
                            const disabled = sourceLongEdge >= option.pixels;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    data-canvas-no-drag
                                    disabled={disabled}
                                    className="h-8 rounded-lg border px-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                                    style={{
                                        background: selected ? theme.toolbar.activeBg : theme.node.subtleSurface,
                                        borderColor: selected ? theme.node.activeStroke : theme.node.subtleBorder,
                                        color: selected ? theme.toolbar.activeText : theme.node.text,
                                    }}
                                    onClick={() => setResolutionType(option.value)}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="flex items-center justify-between rounded-lg px-3 py-2 text-xs" style={{ background: theme.node.subtleSurface, color: theme.node.muted }}>
                    <span>原图 {sourceWidth && sourceHeight ? `${sourceWidth} × ${sourceHeight}` : "尺寸待读取"}</span>
                    <span className="font-semibold" style={{ color: theme.node.text }}>
                        输出 {outputSize ? `${outputSize.width} × ${outputSize.height}` : "待确认"}
                    </span>
                </div>
            </div>
            <footer className="flex h-11 items-center gap-3 border-t px-3" style={{ borderColor: theme.toolbar.border }}>
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: canSubmit ? theme.node.muted : theme.node.warningText }}>
                    {statusText}
                </span>
                <button
                    type="button"
                    data-canvas-no-drag
                    disabled={!canSubmit}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-sm transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                    style={resolveDreaminaUpscaleSubmitStyle(theme)}
                    onClick={submit}
                >
                    {loadingStatus ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
                    重新放大
                </button>
            </footer>
        </section>
    );
}
