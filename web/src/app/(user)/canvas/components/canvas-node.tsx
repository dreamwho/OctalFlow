"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BriefcaseBusiness, ChevronRight, CircleCheck, Globe2, Image as ImageIcon, ListChecks, Music2, Palette, RefreshCw, Settings2, Sparkles, Star, Upload, Video } from "lucide-react";

import { canvasSelectionFlowColors, canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasNodeData, type Position } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { resizeNodeBox } from "../utils/canvas-node-size";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#5b5ce2";

function isInteractiveTarget(target: EventTarget | null) {
    return target instanceof Element && Boolean(target.closest("button,input,textarea,select,video,audio,[data-canvas-no-drag]"));
}

const NODE_TITLE_ICON: Partial<Record<CanvasNodeType, typeof Video>> = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Panorama]: Globe2,
    [CanvasNodeType.Text]: ListChecks,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.VideoRemake]: Sparkles,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Brief]: BriefcaseBusiness,
    [CanvasNodeType.Task]: CircleCheck,
    [CanvasNodeType.BrandKit]: Palette,
};

function NodeTitleIcon({ type, size }: { type: CanvasNodeType; size: number }) {
    const Icon = NODE_TITLE_ICON[type];
    return Icon ? <Icon className="shrink-0" style={{ width: size, height: size }} /> : null;
}

function nodeResolution(node: CanvasNodeData) {
    if (!isCanvasImageNodeType(node.type) && node.type !== CanvasNodeType.Video) return "";
    const width = Math.max(1, Math.round(node.metadata?.naturalWidth || node.width));
    const height = Math.max(1, Math.round(node.metadata?.naturalHeight || node.height));
    return `${width} × ${height}`;
}

export function resolveNodeMetaScale(scale: number) {
    return Math.max(0.38, Math.min(1, Math.pow(Math.max(0, scale), 0.55)));
}

export function resolveNodeResolutionOpacity(nodeWidth: number, scale: number) {
    return Math.max(0, Math.min(1, (nodeWidth * Math.max(0, scale) - 180) / 80));
}

export type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    isAgentReferencePicker?: boolean;
    isAgentReferenceCandidate?: boolean;
    editRequestNonce?: number;
    showPanel: boolean;
    showImageInfo: boolean;
    upscaleSourceUrl?: string;
    resourceLabel?: CanvasResourceReference;
    mentionReferences?: CanvasResourceReference[];
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    batchCount?: number;
    batchExpanded?: boolean;
    batchClosing?: boolean;
    batchOpening?: boolean;
    batchRecovering?: boolean;
    batchMotion?: { x: number; y: number; index: number };
    onMouseDown: (event: React.MouseEvent | React.PointerEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent | React.PointerEvent, nodeId: string, handleType: "source" | "target") => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd?: (nodeId: string, width: number, height: number, position?: Position) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (node: CanvasNodeData) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onOpenPanel?: (node: CanvasNodeData) => void;
    onImageDimensions?: (nodeId: string, naturalWidth: number, naturalHeight: number) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    onUpload?: (node: CanvasNodeData) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

import {
    NodeContent,
    nodeContentRenderers,
    BriefNodeContent,
    TaskNodeContent,
    BrandKitNodeContent,
    LoadingContent,
    ErrorContent,
    UnknownNodeContent,
    TextContent,
    ImageNodeContent,
    EmptyImageContent,
    VideoNodeContent,
    AudioNodeContent,
    ImageContent,
    ImageInfoBar,
    BatchFrame,
    ResizeHandle,
    ConnectionHandleDot,
} from "./canvas-node-content";

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    isAgentReferencePicker = false,
    isAgentReferenceCandidate = false,
    editRequestNonce = 0,
    showPanel,
    showImageInfo,
    upscaleSourceUrl,
    mentionReferences = [],
    renderPanel,
    renderNodeContent,
    batchCount = 0,
    batchExpanded = false,
    batchClosing = false,
    batchOpening = false,
    batchRecovering = false,
    batchMotion,
    onMouseDown,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onTitleChange,
    onToggleBatch,
    onSetBatchPrimary,
    onRetry,
    onGenerateImage,
    onOpenPanel,
    onImageDimensions,
    onViewImage,
    onUpload,
    onContextMenu,
}: CanvasNodeProps) {
    const themeMode = useThemeStore((state) => state.theme);
    const theme = canvasThemes[themeMode];
    const [hovered, setHovered] = useState(false);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title);
    const hasImageContent = isCanvasImageNodeType(data.type) && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isConfig = data.type === CanvasNodeType.Config;
    const nodeBackground = isConfig ? theme.node.panel : hasImageContent || hasVideoContent ? "transparent" : theme.node.fill;
    const isBatchRoot = data.type === CanvasNodeType.Image && Boolean(data.metadata?.isBatchRoot) && batchCount > 1;
    const isBatchChild = data.type === CanvasNodeType.Image && Boolean(data.metadata?.batchRootId);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const selectionFlowId = `canvas-node-selection-flow-${data.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const referencePickerHighlight = isAgentReferencePicker && isAgentReferenceCandidate && hovered;
    const imageBorderColor = isActive ? selectionBlue : isRelated && !isBatchChild ? theme.node.muted : theme.node.stroke;
    const screenScale = Math.max(scale, 0.01);
    const metaScale = resolveNodeMetaScale(scale);
    const titleFontSize = (12 * metaScale) / screenScale;
    const titleLineHeight = (15 * metaScale) / screenScale;
    const titleIconSize = (14 * metaScale) / screenScale;
    const resolution = nodeResolution(data);
    const resolutionOpacity = resolution ? resolveNodeResolutionOpacity(data.width, scale) : 0;
    const showResolution = resolutionOpacity > 0;
    const titleMaxScreenWidth = Math.max(48, Math.min(280, data.width * scale - (showResolution ? 76 * resolutionOpacity + 8 : 0)));
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const titleEditingRef = useRef(false);
    const promptPanelRef = useRef<HTMLDivElement>(null);
    const clickStartRef = useRef<{ x: number; y: number } | null>(null);
    const [promptPanelOffsetX, setPromptPanelOffsetX] = useState(0);
    const [promptPanelOffsetY, setPromptPanelOffsetY] = useState(0);
    const [promptPanelPlacement, setPromptPanelPlacement] = useState<"above" | "below">("below");
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
        pointerId: null as number | null,
        currentWidth: 0,
        currentHeight: 0,
        currentPosition: { x: 0, y: 0 },
    });
    const resizeMoveRef = useRef<(event: PointerEvent) => void>(() => undefined);
    const resizeFinishRef = useRef<() => void>(() => undefined);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingTitle) setTitleDraft(data.title);
    }, [data.title, isEditingTitle]);

    useEffect(() => {
        if (!isEditingTitle) return;
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
    }, [isEditingTitle]);

    useEffect(() => {
        if (!isEditingContent) return;
        textareaRef.current?.focus({ preventScroll: true });
    }, [isEditingContent]);

    useLayoutEffect(() => {
        if (!showPanel || !promptPanelRef.current) {
            setPromptPanelOffsetX(0);
            setPromptPanelOffsetY(0);
            setPromptPanelPlacement("below");
            return;
        }

        const panel = promptPanelRef.current;
        const updateLayout = () => {
            const panelRect = panel.getBoundingClientRect();
            const nodeRect = panel.closest<HTMLElement>("[data-node-id]")?.getBoundingClientRect();
            if (!nodeRect) return;
            const layout = resolvePromptPanelLayout(panelRect, nodeRect, window.innerWidth, window.innerHeight);
            setPromptPanelOffsetX((current) => {
                const next = Math.round((current + layout.horizontalCorrection) * 100) / 100;
                return Math.abs(next - current) < 0.5 ? current : next;
            });
            setPromptPanelOffsetY(layout.verticalCorrection);
            setPromptPanelPlacement(layout.placement);
        };

        const frame = requestAnimationFrame(updateLayout);
        const resizeObserver = new ResizeObserver(updateLayout);
        resizeObserver.observe(panel);
        window.addEventListener("resize", updateLayout);
        return () => {
            cancelAnimationFrame(frame);
            resizeObserver.disconnect();
            window.removeEventListener("resize", updateLayout);
        };
    }, [data.id, scale, showPanel]);

    useEffect(() => {
        if (!editRequestNonce || data.type !== CanvasNodeType.Text) return;
        setIsEditingContent(true);
    }, [data.type, editRequestNonce]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const applyResize = useCallback(
        (clientX: number, clientY: number) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (clientX - resizeRef.current.startX) / scale;
            const dy = (clientY - resizeRef.current.startY) / scale;
            const result = resizeNodeBox({
                startLeft: resizeRef.current.startLeft,
                startTop: resizeRef.current.startTop,
                startWidth: resizeRef.current.startWidth,
                startHeight: resizeRef.current.startHeight,
                fromLeft: resizeRef.current.corner.includes("left"),
                fromTop: resizeRef.current.corner.includes("top"),
                dx,
                dy,
                keepRatio: resizeRef.current.keepRatio,
                ratio: resizeRef.current.ratio,
                minWidth: 220,
                minHeight: 160,
            });
            resizeRef.current.currentWidth = result.width;
            resizeRef.current.currentHeight = result.height;
            resizeRef.current.currentPosition = result.position;
            onResize(data.id, result.width, result.height, result.position);
        },
        [data.id, onResize, scale],
    );

    const finishResize = useCallback(() => {
        if (!resizeRef.current.isResizing) return;
        resizeRef.current.isResizing = false;
        resizeRef.current.pointerId = null;
        onResizeEnd?.(data.id, resizeRef.current.currentWidth, resizeRef.current.currentHeight, resizeRef.current.currentPosition);
    }, [data.id, onResizeEnd]);

    resizeMoveRef.current = (event) => applyResize(event.clientX, event.clientY);
    resizeFinishRef.current = finishResize;

    useEffect(() => {
        const handleWindowPointerMove = (event: PointerEvent) => {
            const resize = resizeRef.current;
            if (!resize.isResizing || (resize.pointerId !== null && resize.pointerId !== event.pointerId)) return;
            resizeMoveRef.current(event);
        };
        const handleWindowPointerEnd = (event: PointerEvent) => {
            const resize = resizeRef.current;
            if (!resize.isResizing || (resize.pointerId !== null && resize.pointerId !== event.pointerId)) return;
            resizeFinishRef.current();
        };
        window.addEventListener("pointermove", handleWindowPointerMove);
        window.addEventListener("pointerup", handleWindowPointerEnd);
        window.addEventListener("pointercancel", handleWindowPointerEnd);
        return () => {
            window.removeEventListener("pointermove", handleWindowPointerMove);
            window.removeEventListener("pointerup", handleWindowPointerEnd);
            window.removeEventListener("pointercancel", handleWindowPointerEnd);
        };
    }, []);

    const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
            // The pointer may have ended between the browser event and capture.
            // The window-level listener still commits the last stable frame.
        }
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (isCanvasImageNodeType(data.type) && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video,
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
            pointerId: event.pointerId,
            currentWidth: data.width,
            currentHeight: data.height,
            currentPosition: data.position,
        };
    };

    const handleNodeDoubleClick = (event: React.MouseEvent) => {
        if (isAgentReferencePicker) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button,input,textarea,select,audio,[data-canvas-no-drag]")) return;
        if (isBatchRoot) {
            event.stopPropagation();
            onToggleBatch?.(data.id);
            return;
        }
        if ((isCanvasImageNodeType(data.type) && hasImageContent) || (data.type === CanvasNodeType.Video && hasVideoContent)) {
            event.stopPropagation();
            onViewImage?.(data);
            return;
        }
        if (data.type === CanvasNodeType.Text) {
            event.stopPropagation();
            setIsEditingContent(true);
            return;
        }
        if (data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Panorama || data.type === CanvasNodeType.Video || data.type === CanvasNodeType.Audio || data.type === CanvasNodeType.Config) {
            event.stopPropagation();
            onOpenPanel?.(data);
        }
    };

    const rememberNodePointer = (event: React.MouseEvent | React.PointerEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button,input,textarea,select,[data-canvas-no-drag]")) return;
        clickStartRef.current = { x: event.clientX, y: event.clientY };
    };

    const handleNodeClick = (event: React.MouseEvent) => {
        if (isAgentReferencePicker) return;
        const start = clickStartRef.current;
        clickStartRef.current = null;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button,input,textarea,select,[data-canvas-no-drag]")) return;
        if (data.type === CanvasNodeType.Text) {
            setIsEditingContent(true);
            return;
        }
        if (data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Panorama || data.type === CanvasNodeType.Video || data.type === CanvasNodeType.Audio || data.type === CanvasNodeType.Config) {
            onOpenPanel?.(data);
        }
    };

    const activateTextEditorAfterClick = (event: React.MouseEvent | React.PointerEvent) => {
        if (isAgentReferencePicker) return;
        if (data.type !== CanvasNodeType.Text || isInteractiveTarget(event.target)) return;
        const start = clickStartRef.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6 && !event.shiftKey && !event.ctrlKey && !event.metaKey) setIsEditingContent(true);
    };

    const startTitleEditing = (event: React.MouseEvent | React.KeyboardEvent) => {
        if (isAgentReferencePicker) return;
        event.preventDefault();
        event.stopPropagation();
        if (isEditingTitle) return;
        titleEditingRef.current = true;
        setTitleDraft(data.title);
        setIsEditingTitle(true);
    };

    const finishTitleEditing = (save: boolean) => {
        if (!titleEditingRef.current) return;
        titleEditingRef.current = false;
        const next = titleDraft.trim();
        if (save && next) onTitleChange(data.id, next);
        else setTitleDraft(data.title);
        setIsEditingTitle(false);
    };

    return (
        <div
            data-node-id={data.id}
            data-canvas-agent-reference-candidate={isAgentReferencePicker && isAgentReferenceCandidate ? "true" : undefined}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
                cursor: isAgentReferencePicker && isAgentReferenceCandidate ? "crosshair" : undefined,
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onClick={handleNodeClick}
            onMouseUp={activateTextEditorAfterClick}
            onPointerUp={(event) => {
                if (event.pointerType !== "mouse") activateTextEditorAfterClick(event);
            }}
            onDoubleClick={handleNodeDoubleClick}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <div
                className={`relative h-full w-full overflow-visible ${isConfig ? "rounded-lg border" : "rounded-md border"}`}
                style={{
                    background: nodeBackground,
                    borderColor: referencePickerHighlight ? "#a3e635" : isSelected ? "transparent" : hasImageContent ? imageBorderColor : isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.stroke,
                    boxShadow: referencePickerHighlight
                        ? "0 0 0 1px rgba(163,230,53,.72), 0 0 22px rgba(163,230,53,.56), 0 0 46px rgba(101,163,13,.3)"
                        : isSelected
                          ? "0 0 18px rgba(129,140,248,.3), 0 0 32px rgba(192,132,252,.16)"
                        : isActive
                          ? `0 0 0 1px ${selectionBlue}55`
                          : isRelated && !isBatchChild
                            ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)`
                            : undefined,
                }}
                onMouseDown={(event) => {
                    rememberNodePointer(event);
                    onMouseDown(event, data.id);
                }}
                onPointerDown={(event) => {
                    rememberNodePointer(event);
                    if (event.pointerType !== "mouse") onMouseDown(event, data.id);
                }}
            >
                {isSelected ? (
                    <svg data-canvas-node-selection-flow aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                        <defs>
                            <linearGradient id={selectionFlowId} x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor={canvasSelectionFlowColors.start} />
                                <stop offset="48%" stopColor={canvasSelectionFlowColors.middle} />
                                <stop offset="100%" stopColor={canvasSelectionFlowColors.end} />
                            </linearGradient>
                        </defs>
                        <rect x="0.8" y="0.8" width="98.4" height="98.4" rx={isConfig ? 4 : 3} fill="none" stroke={`url(#${selectionFlowId})`} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
                    </svg>
                ) : null}
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: nodeBackground,
                            "--batch-from-x": `${batchMotion?.x || 0}px`,
                            "--batch-from-y": `${batchMotion?.y || 0}px`,
                            "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
                            animation: data.metadata?.batchRootId ? (batchClosing ? "canvas-batch-child-out 260ms cubic-bezier(.4,0,.2,1) both" : "canvas-batch-child-in 340ms cubic-bezier(.2,.85,.18,1) both") : undefined,
                            animationDelay: data.metadata?.batchRootId ? `${batchClosing ? 0 : 45 + (batchMotion?.index || 0) * 24}ms` : undefined,
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        scale={scale}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        batchOpening={batchOpening}
                        batchRecovering={batchRecovering}
                        renderNodeContent={renderNodeContent}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onStartEditing={() => setIsEditingContent(true)}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onGenerateImage={onGenerateImage}
                        onImageDimensions={onImageDimensions}
                        upscaleSourceUrl={upscaleSourceUrl}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={() => onSetBatchPrimary?.(data)}
                        onUpload={onUpload}
                    />
                </div>

                {data.type === CanvasNodeType.Audio && onUpload ? <button type="button" data-canvas-no-drag className="absolute left-1/2 top-[-27px] z-40 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border px-2 py-1 text-[11px] shadow-sm transition hover:brightness-110" style={{ borderColor: theme.node.subtleBorder, background: theme.toolbar.panel, color: theme.node.text }} onClick={(event) => { event.stopPropagation(); onUpload(data); }}><Upload className="size-3" />上传</button> : null}

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {NODE_TITLE_ICON[data.type] ? (
                    <div
                        data-canvas-node-title
                        data-canvas-no-drag
                        role={isEditingTitle ? undefined : "button"}
                        tabIndex={isEditingTitle ? -1 : 0}
                        aria-label={isEditingTitle ? undefined : `编辑节点标题：${data.title}`}
                        title={isEditingTitle ? undefined : "点击修改节点标题"}
                        className={`absolute left-0 z-30 flex min-w-0 items-center outline-none ${isEditingTitle ? "pointer-events-auto" : "cursor-text focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[#5b5ce2]"}`}
                        style={{
                            top: (-25 * metaScale) / screenScale,
                            maxWidth: titleMaxScreenWidth / screenScale,
                            gap: (4 * metaScale) / screenScale,
                            color: theme.node.text,
                            filter: `drop-shadow(0 1px 3px ${themeMode === "dark" ? "rgba(0,0,0,0.85)" : "rgba(0,0,0,0.28)"})`,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onPointerUp={startTitleEditing}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") startTitleEditing(event);
                        }}
                    >
                        <NodeTitleIcon type={data.type} size={titleIconSize} />
                        {isEditingTitle ? (
                            <input
                                ref={titleInputRef}
                                aria-label="编辑节点标题"
                                value={titleDraft}
                                maxLength={64}
                                className="min-w-0 flex-1 rounded border bg-transparent px-1 outline-none focus:ring-2 focus:ring-[#5b5ce2]"
                                style={{ height: `${titleLineHeight + 4 / screenScale}px`, fontSize: titleFontSize, lineHeight: `${titleLineHeight}px`, borderColor: theme.node.activeStroke, background: theme.toolbar.panel, color: theme.node.text }}
                                onChange={(event) => setTitleDraft(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                onBlur={() => finishTitleEditing(true)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        event.currentTarget.blur();
                                    }
                                    if (event.key === "Escape") {
                                        event.preventDefault();
                                        finishTitleEditing(false);
                                    }
                                }}
                            />
                        ) : (
                            <span className="min-w-0 truncate font-medium" style={{ fontSize: titleFontSize, lineHeight: `${titleLineHeight}px` }}>
                                {data.title}
                            </span>
                        )}
                    </div>
                ) : null}

                {showResolution ? (
                    <span
                        data-canvas-node-resolution
                        className="pointer-events-none absolute right-0 z-30 font-semibold tabular-nums"
                        style={{
                            top: (-25 * metaScale) / screenScale,
                            fontSize: (10 * metaScale) / screenScale,
                            lineHeight: `${titleLineHeight}px`,
                            color: theme.node.muted,
                            opacity: resolutionOpacity,
                            filter: `drop-shadow(0 1px 3px ${themeMode === "dark" ? "rgba(0,0,0,0.85)" : "rgba(0,0,0,0.2)"})`,
                        }}
                    >
                        {resolution}
                    </span>
                ) : null}

                {!hasImageContent && !hasVideoContent && !hasAudioContent && data.type !== CanvasNodeType.Config ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} />
                ) : null}

                <ResizeHandle corner="top-left" onPointerDown={handleResizePointerDown} onPointerUp={finishResize} />
                <ResizeHandle corner="top-right" onPointerDown={handleResizePointerDown} onPointerUp={finishResize} />
                <ResizeHandle corner="bottom-left" onPointerDown={handleResizePointerDown} onPointerUp={finishResize} />
                <ResizeHandle corner="bottom-right" onPointerDown={handleResizePointerDown} onPointerUp={finishResize} />
            </div>

            <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onConnectStart={(event) => onConnectStart(event, data.id, "target")} />
            <ConnectionHandleDot side="right" visible={data.type !== CanvasNodeType.Config && (hovered || isSelected || isConnecting)} onConnectStart={(event) => onConnectStart(event, data.id, "source")} />

            {showPanel && renderPanel ? (
                <div
                    ref={promptPanelRef}
                    data-canvas-no-drag
                    data-canvas-prompt-connection
                    data-canvas-prompt-placement={promptPanelPlacement}
                    className={`absolute left-1/2 z-[70] ${promptPanelPlacement === "above" ? "bottom-full pb-7" : "top-full pt-7"}`}
                    style={{
                        left: `calc(50% + ${promptPanelOffsetX / Math.max(scale, 0.01)}px)`,
                        ...(promptPanelPlacement === "above" ? { bottom: `calc(100% - ${promptPanelOffsetY / Math.max(scale, 0.01)}px)` } : { top: `calc(100% + ${promptPanelOffsetY / Math.max(scale, 0.01)}px)` }),
                        width: "min(820px, calc(100vw - 2rem))",
                        transform: `translateX(-50%) scale(${1 / Math.max(scale, 0.01)})`,
                        transformOrigin: promptPanelPlacement === "above" ? "bottom center" : "top center",
                    }}
                    onContextMenu={(event) => event.stopPropagation()}
                >
                    {renderPanel(data)}
                </div>
            ) : null}
        </div>
    );
});

export function resolvePromptPanelLayout(panelRect: DOMRect, nodeRect: DOMRect, viewportWidth: number, viewportHeight: number) {
    const viewportMargin = 16;
    const topSafeMargin = 72;
    const horizontalCorrection = panelRect.left < viewportMargin ? viewportMargin - panelRect.left : panelRect.right > viewportWidth - viewportMargin ? viewportWidth - viewportMargin - panelRect.right : 0;
    const roomBelow = viewportHeight - viewportMargin - nodeRect.bottom;
    const roomAbove = nodeRect.top - viewportMargin;
    const placement = panelRect.height <= roomBelow || roomBelow >= roomAbove ? "below" : "above";
    const rawTop = placement === "above" ? nodeRect.top - panelRect.height : nodeRect.bottom;
    const rawBottom = placement === "above" ? nodeRect.top : nodeRect.bottom + panelRect.height;
    const verticalCorrection = rawTop < topSafeMargin ? topSafeMargin - rawTop : rawBottom > viewportHeight - viewportMargin ? viewportHeight - viewportMargin - rawBottom : 0;
    return { horizontalCorrection, verticalCorrection, placement } as const;
}
