"use client";

import { Globe2, ImageIcon, List, Music2, Settings2, Sparkles, Video } from "lucide-react";
import { nanoid } from "nanoid";
import { useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getNodeSpec } from "../constants";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type ConnectionHandle, type Position } from "../types";
import { CANVAS_GRID_SIZE, CANVAS_NODE_GAP } from "../utils/canvas-surface-geometry";

export type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

export type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

export type CanvasCreatableNodeType = CanvasNodeType.Image | CanvasNodeType.Panorama | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.VideoRemake | CanvasNodeType.Audio;

export type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export const VIDEO_NODE_MAX_WIDTH = 420;
export const VIDEO_NODE_MAX_HEIGHT = 420;
export const CANVAS_DROP_NODE_OFFSET = CANVAS_NODE_GAP;
export const CONNECTION_HANDLE_HIT_RADIUS = 40;
export const CONNECTION_NODE_HIT_PADDING = 32;
export const NODE_STATUS_IDLE = "idle" as const;
export const NODE_STATUS_LOADING = "loading" as const;
export const NODE_STATUS_SUCCESS = "success" as const;
export const NODE_STATUS_ERROR = "error" as const;
export const NODE_STATUS_NEEDS_REVIEW = "needs_review" as const;
export const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

export function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${nanoid()}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export function CanvasRefreshShell() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <main className="relative h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.backdrop, color: theme.node.text }}>
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: `radial-gradient(circle, ${theme.canvas.dot} 1px, transparent 1px)`,
                    backgroundSize: `${CANVAS_GRID_SIZE}px ${CANVAS_GRID_SIZE}px`,
                }}
            />

            <div className="absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-24 left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-5 left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}

export function canvasFloatingMenuTransform(scale: number) {
    return `scale(${1 / Math.max(scale, 0.01)})`;
}

export function resolveCreateMenuOffset(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">, viewportWidth: number, viewportHeight: number) {
    const margin = 16;
    const safeTop = 72;
    const safeBottom = viewportHeight - 92;
    return {
        x: rect.left < margin ? margin - rect.left : rect.right > viewportWidth - margin ? viewportWidth - margin - rect.right : 0,
        y: rect.top < safeTop ? safeTop - rect.top : rect.bottom > safeBottom ? safeBottom - rect.bottom : 0,
    };
}

export function NodeCreateMenu({ position, scale, onCreate, onClose }: { position: Position; scale: number; onCreate: (type: CanvasCreatableNodeType) => void; onClose: () => void }) {
    return (
        <CanvasCreateMenu position={position} scale={scale} label="新建节点" dataAttribute="data-canvas-node-create-menu" onClose={onClose}>
            <ConnectionCreateOption icon={<List className="size-4" />} title="文本" onClick={() => onCreate(CanvasNodeType.Text)} />
            <ConnectionCreateOption icon={<ImageIcon className="size-4" />} title="图片" onClick={() => onCreate(CanvasNodeType.Image)} />
            <ConnectionCreateOption icon={<Globe2 className="size-4" />} title="全景图" onClick={() => onCreate(CanvasNodeType.Panorama)} />
            <ConnectionCreateOption icon={<Video className="size-4" />} title="视频" onClick={() => onCreate(CanvasNodeType.Video)} />
            <ConnectionCreateOption icon={<Sparkles className="size-4" />} title="一键视频复刻" onClick={() => onCreate(CanvasNodeType.VideoRemake)} />
            <ConnectionCreateOption icon={<Music2 className="size-4" />} title="音频" onClick={() => onCreate(CanvasNodeType.Audio)} />
            <ConnectionCreateOption icon={<Settings2 className="size-4" />} title="生成配置" onClick={() => onCreate(CanvasNodeType.Config)} />
        </CanvasCreateMenu>
    );
}

export function ConnectionCreateMenu({ pending, scale, onCreate, onClose }: { pending: PendingConnectionCreate; scale: number; onCreate: (type: CanvasCreatableNodeType) => void; onClose: () => void }) {
    return (
        <CanvasCreateMenu position={pending.position} scale={scale} label="引用该节点生成" dataAttribute="data-connection-create-menu" onClose={onClose}>
            <ConnectionCreateOption icon={<List className="size-4" />} title="文本生成" onClick={() => onCreate(CanvasNodeType.Text)} />
            <ConnectionCreateOption icon={<ImageIcon className="size-4" />} title="图片生成" onClick={() => onCreate(CanvasNodeType.Image)} />
            <ConnectionCreateOption icon={<Globe2 className="size-4" />} title="全景生成" onClick={() => onCreate(CanvasNodeType.Panorama)} />
            <ConnectionCreateOption icon={<Video className="size-4" />} title="视频生成" onClick={() => onCreate(CanvasNodeType.Video)} />
            <ConnectionCreateOption icon={<Sparkles className="size-4" />} title="一键视频复刻" onClick={() => onCreate(CanvasNodeType.VideoRemake)} />
            <ConnectionCreateOption icon={<Music2 className="size-4" />} title="音频参考" onClick={() => onCreate(CanvasNodeType.Audio)} />
            <ConnectionCreateOption icon={<Settings2 className="size-4" />} title="配置节点" onClick={() => onCreate(CanvasNodeType.Config)} />
        </CanvasCreateMenu>
    );
}

function CanvasCreateMenu({
    position,
    scale,
    label,
    dataAttribute,
    onClose,
    children,
}: {
    position: Position;
    scale: number;
    label: string;
    dataAttribute: "data-canvas-node-create-menu" | "data-connection-create-menu";
    onClose: () => void;
    children: React.ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const safeScale = Math.max(scale, 0.01);

    useLayoutEffect(() => {
        const placeInsideViewport = () => {
            const rect = menuRef.current?.getBoundingClientRect();
            if (!rect) return;
            const { x, y } = resolveCreateMenuOffset(rect, window.innerWidth, window.innerHeight);
            if (x || y) setOffset((current) => ({ x: current.x + x, y: current.y + y }));
        };

        placeInsideViewport();
        window.addEventListener("resize", placeInsideViewport);
        return () => window.removeEventListener("resize", placeInsideViewport);
    }, [position.x, position.y, safeScale]);

    return (
        <div
            ref={menuRef}
            className="pointer-events-auto absolute z-[120] w-[224px] rounded-2xl border p-2.5 shadow-2xl backdrop-blur"
            {...{ [dataAttribute]: true }}
            style={{
                left: position.x,
                top: position.y,
                background: theme.node.panel,
                borderColor: theme.node.stroke,
                color: theme.node.text,
                transform: `translate(${offset.x / safeScale}px, ${offset.y / safeScale}px) ${canvasFloatingMenuTransform(safeScale)}`,
                transformOrigin: "top left",
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                    {label}
                </span>
                <button
                    type="button"
                    className="grid size-6 place-items-center rounded-md text-sm opacity-55 transition hover:opacity-100"
                    onClick={onClose}
                    onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                    onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                    aria-label="关闭"
                >
                    ×
                </button>
            </div>
            <div className="grid gap-0.5">{children}</div>
        </div>
    );
}

export function ConnectionCreateOption({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <button
            type="button"
            className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-7 shrink-0 place-items-center rounded-md" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">{title}</span>
        </button>
    );
}
