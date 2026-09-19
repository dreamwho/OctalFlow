import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Segmented, Switch } from "antd";
import { CircleDot, Eraser, FolderOpen, Globe2, Hand, Image as ImageIcon, Info, MousePointer2, Music2, Palette, Redo2, Settings2, Sparkles, Square, Trash2, Type, Undo2, Upload, Video } from "lucide-react";

import { canvasThemes, type CanvasBackgroundMode, type CanvasColorTheme, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasInteractionMode } from "./canvas-surface";

export function CanvasToolbar({
    selectedCount,
    canUndo,
    canRedo,
    agentOpen,
    composerOpen,
    backgroundMode,
    interactionMode,
    showImageInfo,
    onAddImage,
    onAddPanorama,
    onAddVideo,
    onAddVideoRemake,
    onAddAudio,
    onAddText,
    onAddConfig,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onClear,
    onInteractionModeChange,
    onBackgroundModeChange,
    onShowImageInfoChange,
    onOpenAssets,
}: {
    selectedCount: number;
    canUndo: boolean;
    canRedo: boolean;
    agentOpen?: boolean;
    composerOpen?: boolean;
    backgroundMode: CanvasBackgroundMode;
    interactionMode: CanvasInteractionMode;
    showImageInfo: boolean;
    onAddImage: () => void;
    onAddPanorama: () => void;
    onAddVideo: () => void;
    onAddVideoRemake: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddConfig: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onInteractionModeChange: (mode: CanvasInteractionMode) => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onOpenAssets: () => void;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const [tipOffset, setTipOffset] = useState(0);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [panelY, setPanelY] = useState(0);
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 10px 30px rgba(0,0,0,.24)" : "0 12px 34px rgba(45,49,88,.10)" };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const tip = hovered ? toolLabel(hovered) : "";

    useEffect(() => {
        if (!appearanceOpen) return;
        const closeOnOutside = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && (target.closest(".canvas-appearance-panel") || target.closest(".canvas-toolbar-dock"))) return;
            setAppearanceOpen(false);
        };
        window.addEventListener("pointerdown", closeOnOutside);
        return () => window.removeEventListener("pointerdown", closeOnOutside);
    }, [appearanceOpen]);

    return (
        <div className="canvas-toolbar-dock-wrap pointer-events-none absolute left-4 top-1/2 z-50 -translate-y-1/2">
            {tip ? <DockTip label={tip} offset={tipOffset} theme={theme} /> : null}
            <div
                ref={wrapRef}
                className={`canvas-toolbar-dock thin-scrollbar pointer-events-auto flex max-h-[calc(100dvh-160px)] w-12 flex-col items-center gap-1 overflow-y-auto rounded-2xl border py-2 backdrop-blur-xl [&>*]:shrink-0 ${agentOpen ? "is-agent-open" : ""} ${composerOpen ? "is-composer-open" : ""}`}
                style={dockStyle}
            >
                <ToolbarButton
                    id={interactionMode === "pan" ? "tool-pan-mode" : "tool-select-mode"}
                    label={interactionMode === "pan" ? "切换到框选模式" : "切换到小手模式"}
                    active
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipOffset={setTipOffset}
                    onHover={setHovered}
                    onClick={() => onInteractionModeChange(interactionMode === "pan" ? "select" : "pan")}
                >
                    {interactionMode === "pan" ? <Hand className="size-4.5" /> : <MousePointer2 className="size-4.5" />}
                </ToolbarButton>
                <ToolbarButton id="tool-undo" label="撤销" disabled={!canUndo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onUndo}>
                    <Undo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-redo" label="重做" disabled={!canRedo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onRedo}>
                    <Redo2 className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton id="tool-text" label="文本" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddText}>
                    <Type className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-image" label="图片" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddImage}>
                    <ImageIcon className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-panorama" label="全景图" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddPanorama}>
                    <Globe2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-video" label="视频" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddVideo}>
                    <Video className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-video-remake" label="一键视频复刻" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddVideoRemake}>
                    <Sparkles className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-audio" label="音频" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddAudio}>
                    <Music2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-config" label="生成配置" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onAddConfig}>
                    <Settings2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-upload" label="上传素材" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onUpload}>
                    <Upload className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton id="tool-assets" label="资产" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onOpenAssets}>
                    <FolderOpen className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton
                    id="tool-style"
                    label="画布外观"
                    active={appearanceOpen}
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipOffset={setTipOffset}
                    onHover={setHovered}
                    onClick={(event) => {
                        setPanelY(getTipOffset(wrapRef.current, event.currentTarget));
                        setAppearanceOpen((value) => !value);
                    }}
                >
                    <Palette className="size-4.5" />
                </ToolbarButton>
                {selectedCount ? (
                    <>
                        <Divider theme={theme} />
                        <ToolbarButton id="tool-delete" label="删除选中" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onDelete} danger>
                            <Trash2 className="size-4.5" />
                        </ToolbarButton>
                    </>
                ) : null}
                <Divider theme={theme} />
                <ToolbarButton id="tool-clear" label="清空画布" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipOffset={setTipOffset} onHover={setHovered} onClick={onClear} danger>
                    <Eraser className="size-4.5" />
                </ToolbarButton>
            </div>

            {appearanceOpen ? (
                <div
                    className="canvas-appearance-panel pointer-events-auto absolute left-[60px] z-30 w-[248px] rounded-xl border p-2.5 shadow-xl backdrop-blur"
                    style={{ top: panelY, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                >
                    <div className="px-1 pb-2 text-sm font-medium opacity-65">画布外观</div>
                    <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">网格样式</div>
                    <Segmented
                        className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                        value={backgroundMode}
                        onChange={(value: string | number) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                        options={[
                            {
                                value: "dots",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <CircleDot className="size-4" />点
                                    </span>
                                ),
                            },
                            {
                                value: "blank",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Square className="size-4" />
                                        空白
                                    </span>
                                ),
                            },
                        ]}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                            <Info className="size-3.5" />
                            图片信息
                        </span>
                        <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    wrapRef,
    onTipOffset,
    onHover,
    onClick,
    disabled = false,
    danger = false,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: CSSProperties;
    hoverStyle: CSSProperties;
    wrapRef: RefObject<HTMLDivElement | null>;
    onTipOffset: (offset: number) => void;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <Button
            type="text"
            aria-label={label}
            className="!h-8 !w-8 !min-w-8 !p-0"
            disabled={disabled}
            style={active ? activeStyle : hovered === id && !disabled ? hoverStyle : { color: danger ? "#f87171" : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }}
            icon={children}
            onMouseEnter={(event: ReactMouseEvent<HTMLElement>) => {
                onHover(id);
                onTipOffset(getTipOffset(wrapRef.current, event.currentTarget));
            }}
            onMouseLeave={() => onHover(null)}
            onClick={onClick}
        />
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="canvas-toolbar-divider my-1 h-px w-6" style={{ background: theme.toolbar.border }} />;
}

function DockTip({ label, offset, theme }: { label: string; offset: number; theme: CanvasTheme }) {
    return (
        <span className="canvas-toolbar-dock-tip absolute whitespace-nowrap rounded-md px-2 py-1 text-xs shadow-lg" style={{ left: "calc(100% + 10px)", top: offset, background: theme.node.text, color: theme.node.panel }}>
            {label}
        </span>
    );
}

function toolLabel(id: string) {
    if (id === "tool-pan-mode") return "小手模式 · 拖动画布";
    if (id === "tool-select-mode") return "框选模式 · 拖框选择";
    if (id === "tool-undo") return "撤销";
    if (id === "tool-redo") return "重做";
    if (id === "tool-text") return "文本";
    if (id === "tool-image") return "图片";
    if (id === "tool-panorama") return "全景图";
    if (id === "tool-video") return "视频";
    if (id === "tool-video-remake") return "一键视频复刻";
    if (id === "tool-audio") return "音频";
    if (id === "tool-config") return "生成配置";
    if (id === "tool-upload") return "上传素材";
    if (id === "tool-assets") return "资产";
    if (id === "tool-style") return "画布外观";
    if (id === "tool-delete") return "删除选中";
    if (id === "tool-clear") return "清空画布";
    return "";
}

function getTipOffset(wrap: HTMLDivElement | null, target: HTMLElement) {
    if (!wrap) return 0;
    const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.top - wrapBox.top + box.height / 2;
}
