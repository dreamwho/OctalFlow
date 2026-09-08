"use client";

import { useEffect, useRef, useState } from "react";
import { Columns2 } from "lucide-react";

import { imagePreviewUrl } from "@/lib/media-image-url";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function clampImageComparisonSplit(clientX: number, rect: Pick<DOMRect, "left" | "width">) {
    if (!rect.width) return 50;
    return Math.round(Math.min(96, Math.max(4, ((clientX - rect.left) / rect.width) * 100)));
}

export function sourceImageComparisonClip(split: number) {
    return `inset(0 ${100 - split}% 0 0)`;
}

type CanvasImageComparisonProps = {
    sourceUrl: string;
    resultUrl: string;
    alt: string;
    fill?: boolean;
    className?: string;
};

export function CanvasImageComparison({ sourceUrl, resultUrl, alt, fill = false, className = "" }: CanvasImageComparisonProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [comparing, setComparing] = useState(false);
    const [split, setSplit] = useState(50);
    const frameRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setComparing(false);
        setSplit(50);
    }, [resultUrl, sourceUrl]);

    const updateSplit = (clientX: number) => {
        const frame = frameRef.current;
        if (frame) setSplit(clampImageComparisonSplit(clientX, frame.getBoundingClientRect()));
    };

    return (
        <div ref={frameRef} data-canvas-image-comparison className={`relative overflow-hidden rounded-[inherit] bg-black/5 ${fill ? "size-full" : "inline-block max-h-[80vh] max-w-full"} ${className}`}>
            <img data-canvas-image-comparison-result src={imagePreviewUrl(resultUrl, 1920)} alt={alt} draggable={false} className={`pointer-events-none block select-none ${fill ? "size-full object-contain" : "max-h-[80vh] max-w-full object-contain"}`} />
            {comparing ? (
                <>
                    <div className="pointer-events-none absolute inset-0" style={{ clipPath: sourceImageComparisonClip(split) }}>
                        <img data-canvas-image-comparison-original src={imagePreviewUrl(sourceUrl, 1920)} alt={`${alt} 原图`} draggable={false} className="size-full select-none object-contain" />
                    </div>
                    {split >= 18 ? (
                        <span className="pointer-events-none absolute left-2 top-2 z-20 whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold shadow-sm backdrop-blur-sm" style={{ background: theme.node.activeStroke, color: theme.node.actionText }}>
                            原图
                        </span>
                    ) : null}
                    {split <= 82 ? (
                        <span
                            className="pointer-events-none absolute right-2 top-2 z-20 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-semibold shadow-sm backdrop-blur-sm"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                        >
                            高清结果
                        </span>
                    ) : null}
                    <div className="pointer-events-none absolute inset-y-0 z-30 w-px bg-white shadow-[0_0_8px_rgba(15,23,42,.55)]" style={{ left: `${split}%` }} />
                    <button
                        type="button"
                        data-canvas-no-drag
                        className="absolute top-1/2 z-40 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border shadow-lg transition hover:scale-105"
                        style={{ left: `${split}%`, touchAction: "none", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                        aria-label="拖动对比原图与高清图"
                        title="拖动对比原图与高清图"
                        onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            updateSplit(event.clientX);
                        }}
                        onPointerMove={(event) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event.clientX);
                        }}
                        onPointerUp={(event) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                    >
                        <Columns2 className="size-4" />
                    </button>
                </>
            ) : null}
            <button
                type="button"
                data-canvas-no-drag
                className="absolute bottom-2 right-2 z-50 grid size-9 place-items-center rounded-lg border shadow-lg backdrop-blur-sm transition hover:scale-105 hover:brightness-95"
                aria-label={comparing ? "关闭原图对比" : "对比原图"}
                title={comparing ? "关闭原图对比" : "对比原图"}
                style={comparing ? { background: theme.node.activeStroke, borderColor: theme.node.activeStroke, color: theme.node.actionText } : { background: theme.node.removeSurface, borderColor: theme.node.removeBorder, color: theme.node.removeText }}
                onClick={(event) => {
                    event.stopPropagation();
                    setComparing((current) => !current);
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <Columns2 className="size-4" />
            </button>
        </div>
    );
}
