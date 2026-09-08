"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Dropdown, Modal } from "antd";
import { BriefcaseBusiness, ChevronDown, ChevronRight, CircleCheck, CircleX, Clock3, Copy, Expand, Film, Globe2, Image as ImageIcon, ListChecks, Minimize2, Music2, Palette, Pencil, RefreshCw, ShieldCheck, Sparkles, Star, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCopyText } from "@/hooks/use-copy-text";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasPanoramaViewer } from "./canvas-panorama-viewer";
import { useCanvasGenerationProgress } from "./use-canvas-generation-progress";
import { CanvasImageComparison } from "./canvas-image-comparison";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

export type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    scale?: number;
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    onContentChange: (nodeId: string, content: string) => void;
    onStartEditing?: () => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
    onImageDimensions?: (nodeId: string, naturalWidth: number, naturalHeight: number) => void;
    upscaleSourceUrl?: string;
};

export function NodeContent(props: NodeContentRendererProps) {
    const key = `${props.node.id}:${props.node.metadata?.generationStartedAt || ""}`;
    const status = props.node.metadata?.status;
    const [transition, setTransition] = useState({ key, status, completing: false });
    if (transition.key !== key || transition.status !== status) {
        setTransition({ key, status, completing: transition.key === key && transition.status === "loading" && status === "success" });
    }
    const finish = useCallback(() => setTransition((current) => (current.key === key ? { ...current, completing: false } : current)), [key]);
    if (props.node.type === CanvasNodeType.Config && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (transition.completing && transition.key === key && status === "success") return <LoadingContent key={key} theme={props.theme} scale={props.scale} node={props.node} completed onComplete={finish} />;
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading") return <LoadingContent key={key} theme={props.theme} scale={props.scale} node={props.node} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} scale={props.scale} onRetry={props.onRetry} />;
    if (props.node.metadata?.status === "needs_review") return <ReviewContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;
    if (props.node.metadata?.status === "cancelled") return <CancelledContent theme={props.theme} />;

    const Renderer = nodeContentRenderers[props.node.type];
    return Renderer ? <Renderer {...props} /> : <UnknownNodeContent theme={props.theme} />;
}

export const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Panorama]: PanoramaNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.VideoRemake]: VideoRemakeNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Brief]: BriefNodeContent,
    [CanvasNodeType.Task]: TaskNodeContent,
    [CanvasNodeType.BrandKit]: BrandKitNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

export function VideoRemakeNodeContent({ node, theme }: NodeContentRendererProps) {
    return (
        <div className="flex h-full min-h-0 flex-col p-5" style={{ color: theme.node.text }}>
            <div className="flex items-start justify-between gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.subtleSurface, color: theme.node.activeStroke }}>
                    <Sparkles className="size-5" />
                </span>
                <span className="rounded-full border px-2.5 py-1 text-[11px] font-medium" style={{ background: theme.node.subtleSurface, borderColor: theme.node.subtleBorder, color: theme.node.subtleText }}>
                    通用复刻
                </span>
            </div>
            <p className="mt-4 min-h-0 flex-1 overflow-y-auto text-sm leading-6" style={{ color: theme.node.muted }}>
                {node.metadata?.content}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]" style={{ color: theme.node.placeholder }}>
                <span className="inline-flex items-center gap-1.5">
                    <Film className="size-3.5" />
                    最长 15 秒/片段
                </span>
                <span className="inline-flex items-center justify-end gap-1.5">
                    <ShieldCheck className="size-3.5" />
                    原创资产替换
                </span>
            </div>
        </div>
    );
}

export function BriefNodeContent({ node, theme }: NodeContentRendererProps) {
    const brief = node.metadata?.agentBrief;
    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-5" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2 text-xs font-semibold">
                <BriefcaseBusiness className="size-4" style={{ color: theme.node.activeStroke }} />
                创作目标
            </div>
            <p className="text-sm leading-6">{brief?.objective || "等待 Agent 整理创作目标"}</p>
            {brief?.audience ? (
                <div className="text-xs" style={{ color: theme.node.placeholder }}>
                    受众：{brief.audience}
                </div>
            ) : null}
            {brief?.usage ? (
                <div className="text-xs" style={{ color: theme.node.placeholder }}>
                    场景：{brief.usage}
                </div>
            ) : null}
            {brief?.coreMessage ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    核心信息：{brief.coreMessage}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
                {brief?.deliverables?.map((item, index) => (
                    <span key={`${item.title}-${index}`} className="rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: theme.node.subtleBorder, background: theme.node.subtleSurface, color: theme.node.subtleText }}>
                        {item.title}
                        {item.count && item.count > 1 ? ` ×${item.count}` : ""}
                    </span>
                ))}
            </div>
        </div>
    );
}

export function TaskNodeContent({ node, theme }: NodeContentRendererProps) {
    const status = node.metadata?.agentTaskStatus || "pending";
    const statusTheme = taskStatusTheme(status, theme);
    return (
        <div className="flex h-full min-h-0 flex-col p-5" style={{ color: theme.node.text }}>
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="mb-4 flex items-center justify-between">
                    <ListChecks className="size-5" style={{ color: theme.node.activeStroke }} />
                    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium" style={{ background: statusTheme.surface, borderColor: statusTheme.border, color: statusTheme.text }}>
                        <span className="size-1.5 rounded-full" style={{ background: statusTheme.text }} aria-hidden="true" />
                        {TASK_STATUS_LABELS[status]}
                    </span>
                </div>
                <p className="thin-scrollbar min-h-0 flex-1 overflow-y-auto pr-1 text-sm leading-6" onWheel={(event) => event.stopPropagation()}>
                    {node.metadata?.prompt || node.metadata?.content || node.title}
                </p>
            </div>
            <div className="mt-3 flex shrink-0 items-center justify-between text-xs" style={{ color: theme.node.placeholder }}>
                <span>{node.metadata?.agentTaskType || "任务"}</span>
                <span className="flex items-center gap-1">
                    <CircleCheck className="size-3.5" />
                    尝试 {node.metadata?.agentTaskAttempts || 0}/2
                </span>
            </div>
        </div>
    );
}

export function BrandKitNodeContent({ node, theme }: NodeContentRendererProps) {
    const kit = node.metadata?.brandKit;
    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-5" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2 text-xs font-semibold">
                <Palette className="size-4" style={{ color: theme.node.activeStroke }} />
                灵感与视觉方向
            </div>
            <p className="text-sm leading-6">{kit?.summary || "等待补充品牌与视觉方向"}</p>
            {kit?.composition ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    构图：{kit.composition}
                </p>
            ) : null}
            {kit?.lighting ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    光线：{kit.lighting}
                </p>
            ) : null}
            <div className="flex gap-2">
                {kit?.colors?.map((color) => (
                    <span key={color} className="size-7 rounded-full border" style={{ background: color, borderColor: theme.node.stroke }} title={color} />
                ))}
            </div>
            <div className="flex flex-wrap gap-2">
                {(kit?.keywords || kit?.visualKeywords)?.map((word) => (
                    <span key={word} className="rounded-md border px-2 py-1 text-xs" style={{ background: theme.node.subtleSurface, borderColor: theme.node.subtleBorder, color: theme.node.subtleText }}>
                        {word}
                    </span>
                ))}
            </div>
            {kit?.avoid?.length ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    避免：{kit.avoid.join("；")}
                </p>
            ) : null}
        </div>
    );
}

export function LoadingContent({ theme, scale = 1, node, completed = false, onComplete }: Pick<NodeContentRendererProps, "theme" | "scale"> & { node?: NodeContentRendererProps["node"]; completed?: boolean; onComplete?: () => void }) {
    const [videoFailed, setVideoFailed] = useState(false);
    const { status, detail, title } = useCanvasGenerationProgress(node, completed, onComplete);
    const statusFontSize = Math.min(34, Math.max(12, 12 / Math.max(scale, 0.35)));
    return (
        <div data-canvas-node-loading role="status" aria-live="polite" aria-label={status} className="relative isolate h-full w-full overflow-hidden" style={{ background: theme.node.fill, color: theme.node.text }}>
            <img src="/generation-smoke.webp" alt="" aria-hidden="true" className={`canvas-node-generation-smoke canvas-node-generation-smoke-fallback${videoFailed ? " is-visible" : ""}`} />
            {!videoFailed ? <video src="/animations/generation-loading-animation.mp4" autoPlay muted loop playsInline preload="metadata" aria-hidden="true" className="canvas-node-generation-video" onError={() => setVideoFailed(true)} /> : null}
            <span className="pointer-events-none absolute left-4 right-4 top-4 z-10 text-left font-medium" style={{ fontSize: statusFontSize, lineHeight: 1.2, color: "white", textShadow: "0 1px 3px rgba(0,0,0,0.8)" }} title={title}>
                {status}
                {!completed && node?.metadata?.generationStage ? ` · ${node.metadata.generationStage}` : ""}
                {detail ? <span className="mt-1 block text-[0.85em] font-normal opacity-80">{detail}</span> : null}
            </span>
        </div>
    );
}

export function ErrorContent({ node, theme, onRetry, scale = 1 }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry" | "scale">) {
    const readableScale = Math.max(0.25, scale);
    const fontSize = Math.max(12, 12 / readableScale);
    const lineHeight = Math.max(20, 20 / readableScale);
    const controlHeight = Math.max(32, 32 / readableScale);
    const errorDetails = node.metadata?.errorDetails || "生成失败";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden px-5 py-4 text-center">
            <div
                data-canvas-node-error-details
                role="alert"
                title={errorDetails}
                className="thin-scrollbar max-h-[60%] w-[86%] overflow-y-auto rounded-lg border px-3 py-2 text-left font-medium whitespace-pre-wrap break-words"
                style={{ color: theme.node.danger, background: theme.node.dangerSurface, borderColor: theme.node.dangerBorder, fontSize, lineHeight }}
            >
                {errorDetails}
            </div>
            <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: theme.node.dangerSurface, borderColor: theme.node.dangerBorder, color: theme.node.danger, height: controlHeight, paddingInline: Math.max(12, 12 / readableScale), fontSize }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                重试
            </button>
        </div>
    );
}

export function ReviewContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden px-5 py-4 text-center">
            <Clock3 className="size-6 shrink-0" style={{ color: theme.node.warningText }} />
            <div className="max-h-[55%] max-w-[280px] overflow-y-auto text-xs leading-5" style={{ color: theme.node.text }}>
                {node.metadata?.errorDetails || "任务创建结果待管理员确认，系统未重复提交。"}
            </div>
            <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition hover:brightness-95"
                style={{ background: theme.node.warningSurface, borderColor: theme.node.warningBorder, color: theme.node.warningText }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                检查状态
            </button>
        </div>
    );
}

export function CancelledContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 py-4 text-center" style={{ color: theme.node.placeholder }}>
            <CircleX className="size-6" />
            <span className="text-xs">任务已取消</span>
        </div>
    );
}

export function UnknownNodeContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>
            未知节点
        </div>
    );
}

export function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStartEditing, onStopEditing, onGenerateImage }: NodeContentRendererProps) {
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    const [expanded, setExpanded] = useState(false);
    const expandedEditorRef = useRef<HTMLTextAreaElement>(null);
    const copyText = useCopyText();
    const content = node.metadata?.content || "";
    const stopCanvasInteraction = (event: React.SyntheticEvent) => event.stopPropagation();
    const copyContent = () => copyText(content, "文本已复制");

    return (
        <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden pt-8">
            <div data-canvas-no-drag className="absolute right-3 top-3 z-20 flex h-8 items-center overflow-hidden rounded-lg border backdrop-blur-md" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onMouseDown={stopCanvasInteraction} onPointerDown={stopCanvasInteraction} onClick={stopCanvasInteraction}>
                <Dropdown
                    trigger={["click"]}
                    menu={{
                        items: [
                            { key: "edit", label: "编辑文本", icon: <Pencil className="size-3.5" />, onClick: onStartEditing },
                            { key: "copy", label: "复制全文", icon: <Copy className="size-3.5" />, disabled: !content, onClick: copyContent },
                            { key: "image", label: "用文本生图", icon: <ImageIcon className="size-3.5" />, disabled: !content, onClick: () => onGenerateImage?.(node) },
                        ],
                    }}
                >
                    <button type="button" className="inline-flex h-full items-center gap-1 px-2 text-xs transition hover:bg-black/5 dark:hover:bg-white/10" aria-label="文本操作菜单">
                        操作 <ChevronDown className="size-3" />
                    </button>
                </Dropdown>
                <button type="button" disabled={!content} className="grid h-full w-8 place-items-center border-l transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-white/10" style={{ borderColor: theme.node.stroke }} onClick={copyContent} title="一键复制全文" aria-label="一键复制全文"><Copy className="size-3.5" /></button>
                <button type="button" className="grid h-full w-8 place-items-center border-l transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.node.stroke }} onClick={() => setExpanded(true)} title="展开文本" aria-label="展开文本"><Expand className="size-3.5" /></button>
            </div>
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    containerClassName="min-h-0 min-w-0 flex-1 w-full"
                    className="thin-scrollbar block h-full min-h-0 w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent pl-4 pr-14 pt-0 pb-4 m-0 font-mono outline-none select-text appearance-none"
                    style={textStyle}
                    value={content}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : (
                <div className="thin-scrollbar block min-h-0 min-w-0 flex-1 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pb-4 pt-0 font-mono" style={textStyle} onWheel={(event) => event.stopPropagation()}>
                    {content || <span style={{ color: theme.node.placeholder }}>点击编辑文字</span>}
                </div>
            )}
            <div className="contents" onClick={stopCanvasInteraction} onDoubleClick={stopCanvasInteraction} onMouseDown={stopCanvasInteraction} onPointerDown={stopCanvasInteraction} onWheel={stopCanvasInteraction} onContextMenu={stopCanvasInteraction}>
                <Modal
                    className="canvas-text-editor-modal"
                    open={expanded}
                    title="展开编辑文本"
                    centered
                    destroyOnHidden
                    mask={{ closable: false }}
                    width={760}
                    style={{ maxWidth: "calc(100vw - 24px)" }}
                    onCancel={() => setExpanded(false)}
                    afterOpenChange={(open) => {
                        if (open) requestAnimationFrame(() => expandedEditorRef.current?.focus({ preventScroll: true }));
                    }}
                    footer={null}
                    styles={{ wrapper: { width: "100vw", maxWidth: "100vw" }, container: { background: theme.node.panel, border: `1px solid ${theme.toolbar.border}`, color: theme.node.text }, header: { background: theme.node.panel, marginBottom: 0, paddingBottom: 8 }, title: { color: theme.node.text }, body: { background: theme.node.panel, padding: "4px 12px 12px" } }}
                >
                    <div className="min-w-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }}>
                        <CanvasResourceMentionTextarea ref={expandedEditorRef} value={content} references={mentionReferences} highlightLabels={false} onChange={(value) => onContentChange(node.id, value)} aria-label="展开文本编辑器" className="thin-scrollbar h-[min(58vh,30rem)] min-h-64 w-full resize-none border-0 px-4 py-3 font-mono outline-none" style={{ ...textStyle, background: theme.node.fill }} />
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                        <Button icon={<Copy className="size-4" />} disabled={!content} onClick={copyContent}>复制全文</Button>
                        <Button icon={<Minimize2 className="size-4" />} onClick={() => setExpanded(false)}>收起</Button>
                    </div>
                </Modal>
            </div>
        </div>
    );
}

export function ResourceLabelBadge({ reference }: { reference: CanvasResourceReference }) {
    return (
        <span className={`pointer-events-none absolute right-2 top-0 z-[80] -translate-y-[calc(100%+6px)] rounded-md px-1.5 py-0.5 text-[10px] font-medium ${reference.active ? "bg-[#5b5ce2] text-white shadow-sm" : "bg-black/35 text-white/75"}`}>
            {reference.label}
        </span>
    );
}

export function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && props.isBatchRoot) {
        const content =
            props.node.metadata?.status === "loading" ? (
                <LoadingContent theme={props.theme} scale={props.scale} node={props.node} />
            ) : props.node.metadata?.status === "error" ? (
                <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />
            ) : props.node.metadata?.status === "cancelled" ? (
                <CancelledContent theme={props.theme} />
            ) : (
                <EmptyImageContent {...props} isBatchRoot={false} />
            );
        return (
            <BatchFrame batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} onToggleBatch={props.onToggleBatch}>
                {content}
            </BatchFrame>
        );
    }
    if (!props.node.metadata?.content) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            isBatchRoot={props.isBatchRoot}
            batchCount={props.batchCount}
            batchExpanded={props.batchExpanded}
            batchOpening={props.batchOpening}
            batchRecovering={props.batchRecovering}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onImageDimensions={props.onImageDimensions}
            upscaleSourceUrl={props.upscaleSourceUrl}
        />
    );
}

export function EmptyImageContent({ theme, isBatchRoot, batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: NodeContentRendererProps) {
    const content = (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl border" style={{ background: theme.node.subtleSurface, borderColor: theme.node.subtleBorder, color: theme.node.subtleText }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">空图片节点</span>
        </div>
    );
    if (isBatchRoot)
        return (
            <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
                {content}
            </BatchFrame>
        );
    return content;
}

export function VideoNodeContent({ node, theme }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">空视频节点</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="relative min-h-0 flex-1">
                <video src={node.metadata.content} controls className="h-full w-full bg-black object-contain" data-canvas-no-zoom />
                <div className="absolute inset-x-0 bottom-12 top-0 cursor-grab active:cursor-grabbing" aria-hidden="true" />
            </div>
        </div>
    );
}

export function PanoramaNodeContent({ node, theme }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Globe2 className="size-7 opacity-35" />
                <span className="text-sm">空全景节点</span>
                <span className="text-[10px] opacity-55">360° · 2:1</span>
            </div>
        );
    return <CanvasPanoramaViewer src={node.metadata.content} alt={node.title || "全景图"} />;
}

export function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">空音频节点</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

export function ImageContent({
    node,
    isBatchRoot,
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    onSetBatchPrimary,
    onImageDimensions,
    upscaleSourceUrl,
}: {
    node: CanvasNodeData;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
    onImageDimensions?: (nodeId: string, naturalWidth: number, naturalHeight: number) => void;
    upscaleSourceUrl?: string;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchChild = Boolean(node.metadata?.batchRootId);
    const imageRef = useRef<HTMLImageElement>(null);
    const reportDimensions = useCallback(
        (image: HTMLImageElement) => {
            if (image.naturalWidth > 0 && image.naturalHeight > 0) onImageDimensions?.(node.id, image.naturalWidth, image.naturalHeight);
        },
        [node.id, onImageDimensions],
    );

    useEffect(() => {
        const image = imageRef.current;
        if (image?.complete) reportDimensions(image);
    }, [node.metadata?.content, reportDimensions]);

    return (
        <BatchFrame batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
            <div className="h-full w-full overflow-hidden rounded-[inherit]">
                {upscaleSourceUrl ? (
                    <CanvasImageComparison sourceUrl={upscaleSourceUrl} resultUrl={node.metadata!.content!} alt={node.title || "高清图片"} fill />
                ) : (
                    <img
                        ref={imageRef}
                        src={imagePreviewUrl(node.metadata!.content!, 1920)}
                        alt={node.title}
                        draggable={false}
                        onLoad={(event) => reportDimensions(event.currentTarget)}
                        onDragStart={(event) => event.preventDefault()}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                    />
                )}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1 rounded-full border px-2.5 text-xs font-semibold shadow-[0_6px_18px_rgba(15,23,42,.10)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    aria-label={batchExpanded ? "图片组已展开" : "图片组已收起"}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none opacity-85">{batchCount}</span>
                    <ChevronRight className={`size-3.5 transition-transform ${batchExpanded ? "rotate-90" : ""}`} style={{ color: theme.node.muted }} />
                </button>
            ) : null}
            {isBatchChild ? (
                <button
                    type="button"
                    className="absolute right-3 top-3 z-30 flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium opacity-0 shadow-[0_8px_20px_rgba(68,64,60,.13)] backdrop-blur-md transition group-hover/batch:opacity-100 hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onSetBatchPrimary?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Star className="size-3.5 text-[#5b5ce2]" />
                    设为主图
                </button>
            ) : null}
        </BatchFrame>
    );
}

export function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

export function BatchFrame({
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    children,
}: {
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div
            className="group/batch relative h-full w-full overflow-visible"
            onDoubleClick={
                isBatchRoot
                    ? (event) => {
                          event.stopPropagation();
                          onToggleBatch?.();
                      }
                    : undefined
            }
        >
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 5) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_14px_34px_rgba(68,64,60,.16)] transition-all duration-300 group-hover/batch:translate-x-2"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded && !batchOpening ? 0.34 : 1,
                                transform:
                                    batchOpening || batchRecovering ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)` : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
export function ResizeHandle({ corner, onPointerDown, onPointerUp }: { corner: ResizeCorner; onPointerDown: (event: React.PointerEvent<HTMLDivElement>, corner: ResizeCorner) => void; onPointerUp: () => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return (
        <div
            data-canvas-resize-corner={corner}
            className={`absolute z-50 size-7 ${positionClass}`}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => onPointerDown(event, corner)}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={onPointerUp}
            style={{ touchAction: "none", userSelect: "none" }}
        />
    );
}

export function ConnectionHandleDot({ side, visible, onConnectStart }: { side: "left" | "right"; visible: boolean; onConnectStart: (event: React.MouseEvent | React.PointerEvent) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            data-canvas-handle={side === "left" ? "target" : "source"}
            aria-label={side === "left" ? "输入连接点" : "输出连接点"}
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onConnectStart}
            onPointerDown={(event) => {
                if (event.pointerType !== "mouse") onConnectStart(event);
            }}
            style={{ touchAction: "none" }}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}

const TASK_STATUS_LABELS = {
    ready: "等待执行",
    pending: "等待执行",
    running: "执行中",
    paused: "已暂停",
    waiting_user: "等待确认",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
} as const;

function taskStatusTheme(status: keyof typeof TASK_STATUS_LABELS, theme: NodeContentRendererProps["theme"]) {
    if (status === "running") return { surface: theme.node.infoSurface, border: theme.node.infoBorder, text: theme.node.infoText };
    if (status === "completed") return { surface: theme.node.successSurface, border: theme.node.successBorder, text: theme.node.successText };
    if (status === "paused" || status === "waiting_user") return { surface: theme.node.warningSurface, border: theme.node.warningBorder, text: theme.node.warningText };
    if (status === "failed") return { surface: theme.node.dangerSurface, border: theme.node.dangerBorder, text: theme.node.danger };
    return { surface: theme.node.subtleSurface, border: theme.node.subtleBorder, text: theme.node.subtleText };
}
