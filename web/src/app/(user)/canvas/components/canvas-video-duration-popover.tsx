"use client";

import { Popover } from "antd";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { useCreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { canvasSelectionBorderStyle, canvasSelectionGlow, canvasThemes } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasNodeMetadata } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { canvasDolaVideoProfile, resolveCanvasDolaModelId } from "../utils/canvas-dola";
import { canvasDreaminaVideoCommand, canvasDreaminaVideoProfile, resolveCanvasDreaminaModelId } from "../utils/canvas-dreamina-cli";

type CanvasVideoDurationPopoverProps = {
    config: AiConfig;
    metadata?: CanvasNodeMetadata;
    references: CanvasResourceReference[];
    seconds: number;
    onSecondsChange: (seconds: number) => void;
    buttonClassName?: string;
};

/** 时长独立入口：复刻参数选项弹窗（图2）的渐变边框、发光阴影、深邃背景及紧凑精致排版。 */
export function CanvasVideoDurationPopover({ config, metadata, references, seconds, onSecondsChange, buttonClassName }: CanvasVideoDurationPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const placement = useCreativeComposerPopoverPlacement("top");
    const [open, setOpen] = useState(false);

    const dola = canvasDolaVideoProfile(resolveCanvasDolaModelId(config));
    const dreamina = canvasDreaminaVideoProfile(resolveCanvasDreaminaModelId(config), canvasDreaminaVideoCommand(metadata, references));
    const snapPoints = dola?.durations.map((duration) => duration.value);
    const range = dola?.durationRange || dreamina?.durationRange || (config.model?.toLowerCase().includes("minimax") ? { min: 5, max: 15 } : { min: 5, max: 15 });
    const rangeMin = range.min;
    const rangeMax = range.max;

    const clamped = Math.min(rangeMax, Math.max(rangeMin, seconds || rangeMin));
    const snapTo = (value: number) => (snapPoints?.length ? snapPoints.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a)) : Math.round(value));

    useEffect(() => {
        if (open && (seconds < rangeMin || seconds > rangeMax)) onSecondsChange(snapTo(Math.min(rangeMax, Math.max(rangeMin, seconds))));
    }, [open]);

    const slider = (
        <input
            type="range"
            aria-label="拖动选择视频生成时长"
            min={rangeMin}
            max={rangeMax}
            step={1}
            value={clamped}
            onChange={(event) => onSecondsChange(snapTo(Number(event.target.value)))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[#e3e8ec] accent-[#3978ff] dark:bg-[#252f40] dark:accent-[#5e7ff1]"
        />
    );
    const marks = (
        <div className="flex justify-between text-[10px] font-medium text-[#8c97a5] dark:text-[#7b899d]">
            <span>{rangeMin}s</span>
            {snapPoints?.length ? snapPoints.filter((point) => point > rangeMin && point < rangeMax).map((point) => <span key={point}>{point}s</span>) : <span>{Math.round((rangeMin + rangeMax) / 2)}s</span>}
            <span>{rangeMax}s</span>
        </div>
    );

    // 弹出层 UI 全面复刻参数选项弹窗（图2）：深蓝夜空黑背景、发光渐变边框、紧凑宽度与小巧输入框
    const content = (
        <div
            data-canvas-no-drag
            className="hide-scrollbar w-[260px] max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[18px] bg-white/[.98] p-3.5 text-[#1f2b46] backdrop-blur-2xl dark:bg-[#020813]/[.98] dark:text-[#f7fbff]"
            style={{
                ...canvasSelectionBorderStyle(theme.toolbar.panel),
                boxShadow: canvasSelectionGlow,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
        >
            {/* 顶部标题与当前秒数高亮徽标 */}
            <div className="mb-2.5 flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-[#1f2b46] dark:text-[#f1f5f9]">选择视频生成时长</p>
                <span className="rounded-md border border-[#3978ff]/20 bg-[#edf3ff] px-2 py-0.5 text-[11px] font-semibold text-[#3978ff] dark:border-[#5e7ff1]/30 dark:bg-[#162746] dark:text-[#7ba9ff]">
                    {clamped} 秒
                </span>
            </div>

            {/* 滑块与点位刻度 */}
            <div className="grid gap-1.5 px-0.5">
                {slider}
                {marks}
            </div>

            {/* 底部紧凑输入区：小巧输入框 + 秒，不再横向撑满 */}
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#edf2f7] pt-2.5 dark:border-white/10">
                <span className="text-[11px] font-medium text-[#64748b] dark:text-[#94a3b8]">自定义输入</span>
                <div className="flex items-center gap-1.5">
                    <input
                        type="text"
                        inputMode="numeric"
                        aria-label="输入视频生成时长"
                        value={clamped}
                        onChange={(event) => {
                            const value = Number(event.target.value.replace(/\D/g, ""));
                            if (Number.isFinite(value) && value > 0) onSecondsChange(Math.min(rangeMax, Math.max(rangeMin, Math.round(value))));
                        }}
                        className="h-7 w-16 rounded-md border border-[#dce3ec] bg-white px-2 text-center text-xs font-semibold text-[#1f2b46] outline-none transition-colors focus:border-[#3978ff] focus:ring-1 focus:ring-[#3978ff]/30 dark:border-white/15 dark:bg-[#080e1a] dark:text-[#f7fbff] dark:focus:border-[#5e7ff1] dark:focus:ring-[#5e7ff1]/30"
                    />
                    <span className="text-xs font-medium text-[#64748b] dark:text-[#94a3b8]">秒</span>
                </div>
            </div>
        </div>
    );

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            placement={placement}
            arrow={false}
            autoAdjustOverflow
            classNames={{ container: "!border-none !bg-transparent !shadow-none !p-0" }}
            styles={{
                container: {
                    background: "transparent",
                    boxShadow: "none",
                    padding: 0,
                    border: "none",
                    overflow: "visible",
                },
            }}
            content={content}
        >
            <button
                type="button"
                className={buttonClassName}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`视频生成时长 ${clamped} 秒`}
            >
                <span className="min-w-0 truncate">{clamped}s</span>
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
            </button>
        </Popover>
    );
}
