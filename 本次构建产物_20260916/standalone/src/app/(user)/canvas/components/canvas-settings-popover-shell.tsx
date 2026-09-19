"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";
import { Settings2, Sparkles, X } from "lucide-react";

import { readVisualViewportBounds, resolveCreativeComposerPopoverViewportLayout } from "@/components/creative-composer-popover";
import { canvasSelectionBorderStyle, canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { DreamyoIcon } from "@/components/ui/dreamyo-icon";

export type CanvasSettingsPopoverPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasSettingsPopoverShellProps = {
    label: ReactNode;
    children: (theme: CanvasTheme, close: () => void, openChildOverlay: () => void) => ReactNode;
    buttonClassName?: string;
    defaultButtonClassName: string;
    icon?: ReactNode;
    placement?: CanvasSettingsPopoverPlacement;
    onOpenChange?: (open: boolean) => void;
    buttonAriaLabel?: string;
    panelWidth?: number;
    panelMaxHeight?: number;
    canvasPanel?: {
        title: string;
        description: string;
        summary: string;
        applyLabel?: string;
        onApply?: () => void;
    };
};

export function CanvasSettingsPopoverShell({ label, children, buttonClassName, defaultButtonClassName, icon, placement = "topLeft", onOpenChange, buttonAriaLabel, panelWidth = 340, panelMaxHeight = 420, canvasPanel }: CanvasSettingsPopoverShellProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [childOverlayOpen, setChildOverlayOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const updateOpen = useCallback(
        (nextOpen: boolean) => {
        setOpen(nextOpen);
        if (!nextOpen) setChildOverlayOpen(false);
        onOpenChange?.(nextOpen);
        },
        [onOpenChange],
    );
    const openChildOverlay = useCallback(() => setChildOverlayOpen(true), []);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest(".ant-select-dropdown, .ant-popover, .ant-modal-root, .ant-modal-wrap, .ant-modal-mask")) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            updateOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open, updateOpen]);

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || defaultButtonClassName}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={icon || <Settings2 className="size-3.5" />}
                    aria-label={buttonAriaLabel}
                    aria-expanded={open}
                    onClick={() => updateOpen(!open)}
                >
                    <span className="truncate">{label}</span>
                </Button>
            </span>
            {open && buttonRect
                ? createPortal(
                      <SettingsPanel
                          buttonRect={buttonRect}
                          panelRef={panelRef}
                          placement={placement}
                          theme={theme}
                          panelWidth={panelWidth}
                          panelMaxHeight={panelMaxHeight}
                          childOverlayOpen={childOverlayOpen}
                          canvasPanel={canvasPanel}
                          onClose={() => updateOpen(false)}
                          onApply={() => canvasPanel?.onApply?.()}
                      >
                          {children(theme, () => updateOpen(false), openChildOverlay)}
                      </SettingsPanel>,
                      document.body,
                  )
                : null}
        </>
    );
}

function SettingsPanel({
    buttonRect,
    panelRef,
    placement,
    theme,
    panelWidth,
    panelMaxHeight,
    childOverlayOpen,
    canvasPanel,
    onClose,
    onApply,
    children,
}: {
    buttonRect: DOMRect;
    panelRef: React.RefObject<HTMLDivElement | null>;
    placement: CanvasSettingsPopoverPlacement;
    theme: CanvasTheme;
    panelWidth: number;
    panelMaxHeight: number;
    childOverlayOpen: boolean;
    canvasPanel?: CanvasSettingsPopoverShellProps["canvasPanel"];
    onClose: () => void;
    onApply: () => void;
    children: ReactNode;
}) {
    const gap = 8;
    const margin = 12;
    const viewport = readVisualViewportBounds();
    const width = Math.min(panelWidth, viewport.right - viewport.left - margin * 2);
    const alignRight = placement.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const desiredHeight = Math.min(panelMaxHeight, panelRef.current?.scrollHeight || panelMaxHeight);
    const layout = resolveCreativeComposerPopoverViewportLayout(placement, buttonRect, viewport, desiredHeight, desiredHeight, margin + gap);
    const topPlacement = layout.placement.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(viewport.left + margin, Math.min(viewport.right - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap } : { top: buttonRect.bottom + gap }),
        maxHeight: layout.maxHeight,
        borderRadius: 16,
        ...canvasSelectionBorderStyle(theme.toolbar.panel),
        padding: canvasPanel ? 0 : 16,
        overflowY: "auto",
        color: theme.node.text,
        visibility: childOverlayOpen ? "hidden" : "visible",
        pointerEvents: childOverlayOpen ? "none" : "auto",
    } as const;

    return (
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            aria-hidden={childOverlayOpen}
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {canvasPanel ? (
                <>
                    <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b px-4 py-3" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                        <div className="flex min-w-0 items-start gap-2.5">
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: theme.node.infoSurface, color: theme.node.infoText }}>
                                <DreamyoIcon name="audio" size={18} />
                            </span>
                            <div className="min-w-0">
                                <h2 className="truncate text-[15px] font-semibold" style={{ color: theme.node.text }}>
                                    {canvasPanel.title}
                                </h2>
                                <p className="mt-0.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                    {canvasPanel.description}
                                </p>
                            </div>
                        </div>
                        <button type="button" className="grid size-8 shrink-0 place-items-center rounded-xl transition hover:bg-black/[.05] dark:hover:bg-white/[.08]" style={{ color: theme.node.muted }} aria-label="关闭参数设置" onClick={onClose}>
                            <X className="size-4" />
                        </button>
                    </div>
                    <div className="p-4">{children}</div>
                    <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t px-4 py-3" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                        <span className="min-w-0 truncate text-[11px] font-medium" style={{ color: theme.node.muted }}>
                            {canvasPanel.summary}
                        </span>
                        <Button
                            type="primary"
                            size="small"
                            className="!h-9 !shrink-0 !rounded-xl !px-4"
                            style={{ background: theme.node.action, borderColor: theme.node.action, color: theme.node.actionText }}
                            icon={<Sparkles className="size-3.5" />}
                            aria-label={canvasPanel.applyLabel || "应用参数设置"}
                            onClick={() => {
                                onApply();
                                onClose();
                            }}
                        >
                            {canvasPanel.applyLabel || "应用"}
                        </Button>
                    </div>
                </>
            ) : (
                children
            )}
        </div>
    );
}
