"use client";

import { useMemo, type ReactNode } from "react";
import { Dropdown, type MenuProps } from "antd";
import { Boxes, ChevronDown, Copy, LayoutGrid, Sparkles, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, ViewportTransform } from "../types";
import type { CanvasLayoutMode } from "../utils/canvas-surface-geometry";

type CanvasSelectionToolbarProps = {
    selectedNodeIds: ReadonlySet<string>;
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    onLayout: (mode: CanvasLayoutMode) => void;
    onDuplicate?: () => void;
    onDelete?: () => void;
};

export function CanvasSelectionToolbar({
    selectedNodeIds,
    nodes,
    viewport,
    onLayout,
    onDuplicate,
    onDelete,
}: CanvasSelectionToolbarProps) {
    const themeName = useThemeStore((state) => state.theme);
    const theme = canvasThemes[themeName];

    const selectedRoots = useMemo(() => {
        return nodes.filter((node) => selectedNodeIds.has(node.id) && !node.metadata?.batchRootId);
    }, [nodes, selectedNodeIds]);

    const bounds = useMemo(() => {
        if (selectedRoots.length < 2) return null;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        selectedRoots.forEach((node) => {
            minX = Math.min(minX, node.position.x);
            maxX = Math.max(maxX, node.position.x + node.width);
            minY = Math.min(minY, node.position.y);
        });
        return { minX, maxX, minY };
    }, [selectedRoots]);

    if (!bounds || selectedRoots.length < 2) return null;

    // 转换为屏幕坐标，置于被选节点包围盒正上方
    const screenX = viewport.x + ((bounds.minX + bounds.maxX) / 2) * viewport.k;
    const screenY = Math.max(72, viewport.y + bounds.minY * viewport.k - 16);

    const layoutMenuItems: MenuProps["items"] = [
        {
            key: "grid",
            label: (
                <div className="flex flex-col py-1 pr-2">
                    <div className="flex items-center gap-2 text-xs font-medium">
                        <LayoutGrid className="size-4 text-emerald-500" />
                        <span>宫格布局</span>
                    </div>
                    <span className="mt-0.5 text-[11px] text-zinc-400 pl-6">保持当前物理空间顺序，等间距网格排列</span>
                </div>
            ),
            onClick: () => onLayout("grid"),
        },
        {
            type: "divider",
        },
        {
            key: "smart",
            label: (
                <div className="flex flex-col py-1 pr-2">
                    <div className="flex items-center gap-2 text-xs font-medium">
                        <Sparkles className="size-4 text-cyan-500" />
                        <span>智能布局</span>
                    </div>
                    <span className="mt-0.5 text-[11px] text-zinc-400 pl-6">根据节点宽高比例自适应紧凑瀑布流排版</span>
                </div>
            ),
            onClick: () => onLayout("smart"),
        },
    ];

    return (
        <div
            className="fixed z-[105] flex items-center gap-1 rounded-xl border px-2.5 py-1.5 shadow-2xl backdrop-blur-md select-none transition-all duration-75"
            style={{
                left: screenX,
                top: screenY,
                transform: "translate(-50%, -100%)",
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.node.text,
            }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <span className="px-1 text-xs font-medium opacity-80 whitespace-nowrap">
                {selectedRoots.length} 个节点
            </span>

            <div className="mx-1 h-3.5 w-px opacity-20" style={{ background: theme.node.text }} />

            {/* 布局菜单下拉 */}
            <Dropdown menu={{ items: layoutMenuItems }} trigger={["click"]} placement="bottom">
                <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                >
                    <LayoutGrid className="size-3.5 text-emerald-500" />
                    <span>布局</span>
                    <ChevronDown className="size-3 opacity-60" />
                </button>
            </Dropdown>

            {onDuplicate ? (
                <button
                    type="button"
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                    onClick={onDuplicate}
                    title="复制选中节点"
                >
                    <Copy className="size-3.5" />
                    <span>复制</span>
                </button>
            ) : null}

            {onDelete ? (
                <button
                    type="button"
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-rose-500 transition-colors hover:bg-rose-500/10"
                    onClick={onDelete}
                    title="删除选中节点"
                >
                    <Trash2 className="size-3.5" />
                    <span>删除</span>
                </button>
            ) : null}
        </div>
    );
}
