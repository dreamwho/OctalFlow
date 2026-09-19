"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Popover } from "antd";
import { Camera, ChevronRight, Clapperboard, House, LayoutGrid, Pencil, Plus, ScanLine, ScanSearch, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "../types";

export function CanvasNodeContextMenu({
    menu,
    canArrange = false,
    canInteriorDesign = false,
    canUpscale = false,
    canStoryboard = false,
    canUseVideoTools = false,
    onClose,
    onArrange,
    onDuplicate,
    onDelete,
    onInteriorDesign,
    onRename,
    onUpscale,
    onStoryboard,
    onCaptureFrames,
    onDepthExtract,
    onAnalyzeVideo,
}: {
    menu: ContextMenuState;
    canArrange?: boolean;
    canInteriorDesign?: boolean;
    canUpscale?: boolean;
    canStoryboard?: boolean;
    canUseVideoTools?: boolean;
    onClose: () => void;
    onArrange?: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onInteriorDesign?: () => void;
    onRename: () => void;
    onUpscale?: () => void;
    onStoryboard?: () => void;
    onCaptureFrames?: () => void;
    onDepthExtract?: () => void;
    onAnalyzeVideo?: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const element = menuRef.current;
        if (!element) return;
        const update = () => setPosition(clampCanvasContextMenuPosition({ x: menu.x, y: menu.y }, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [menu]);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            role="menu"
            className="fixed z-[110] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: position.x, top: position.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "node" ? <MenuButton icon={<Pencil className="size-4" />} label="重命名" onClick={onRename} /> : null}
            {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label="复制" onClick={onDuplicate} /> : null}
            {menu.type === "node" && canArrange ? <MenuButton icon={<LayoutGrid className="size-4" />} label="一键整理" onClick={onArrange} /> : null}
            {menu.type === "node" && canInteriorDesign ? <MenuButton icon={<House className="size-4" />} label="室内设计" onClick={onInteriorDesign} /> : null}
            {menu.type === "node" && canUpscale ? <MenuButton icon={<ScanLine className="size-4" />} label="图片超分" onClick={onUpscale} /> : null}
            {menu.type === "node" && canStoryboard ? <StoryboardMenuButton onSelect={onStoryboard} /> : null}
            {menu.type === "node" && canUseVideoTools ? <MenuButton icon={<Camera className="size-4" />} label="捕捉帧" onClick={onCaptureFrames} /> : null}
            {menu.type === "node" && canUseVideoTools ? <MenuButton icon={<ScanLine className="size-4" />} label="深度提取" onClick={onDepthExtract} /> : null}
            {menu.type === "node" && canUseVideoTools ? <MenuButton icon={<ScanSearch className="size-4" />} label="分析" onClick={onAnalyzeVideo} /> : null}
            <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger />
        </div>
    );
}

function StoryboardMenuButton({ onSelect }: { onSelect?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);
    return (
        <Popover
            trigger="click"
            placement="rightTop"
            open={open}
            onOpenChange={setOpen}
            content={
                <button
                    type="button"
                    role="menuitem"
                    className="flex min-w-36 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition hover:opacity-80"
                    style={{ color: theme.node.text }}
                    onClick={() => {
                        setOpen(false);
                        onSelect?.();
                    }}
                >
                    <Clapperboard className="size-4" />
                    人物三视图
                </button>
            }
        >
            <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: theme.node.text }}>
                <Clapperboard className="size-4" />
                <span className="flex-1">分镜大师</span>
                <ChevronRight className="size-3.5 opacity-55" />
            </button>
        </Popover>
    );
}

export function canArrangeCanvasSelection(menu: ContextMenuState | null, selectedNodeIds: ReadonlySet<string>) {
    return Boolean(menu?.type === "node" && selectedNodeIds.size >= 2 && selectedNodeIds.has(menu.nodeId));
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}

export function clampCanvasContextMenuPosition(anchor: { x: number; y: number }, menu: { width: number; height: number }, viewport: { width: number; height: number }) {
    const margin = 8;
    return {
        x: Math.max(margin, Math.min(anchor.x, viewport.width - menu.width - margin)),
        y: Math.max(margin, Math.min(anchor.y, viewport.height - menu.height - margin)),
    };
}
