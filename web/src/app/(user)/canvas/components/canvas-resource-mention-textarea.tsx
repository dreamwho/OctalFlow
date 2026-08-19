"use client";

import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { handleMentionNavigation } from "../utils/canvas-mention-navigation";

type MentionState = {
    start: number;
    query: string;
};

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
    value: string;
    references: CanvasResourceReference[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    containerClassName?: string;
    highlightLabels?: boolean;
};

export const CanvasResourceMentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function CanvasResourceMentionTextarea(
    { value, references, onChange, onSubmit, onKeyDown, className, containerClassName, style, highlightLabels = true, autoFocus, ...props },
    forwardedRef,
) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
        if (!autoFocus) return;
        const frame = requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        });
        return () => cancelAnimationFrame(frame);
    }, [autoFocus]);
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        const activeReferences = references.filter((item) => item.active);
        if (!query) return activeReferences;
        return activeReferences.filter((item) => `${item.label} ${item.title} ${item.kind} ${item.text || ""}`.toLowerCase().includes(query));
    }, [mention, references]);
    const activeLabels = useMemo(() => (highlightLabels ? Array.from(new Set(references.filter((item) => item.active).map((item) => item.label))).sort((a, b) => b.length - a.length) : []), [highlightLabels, references]);

    const updateValue = (next: string, selectionStart?: number) => {
        onChange(next);
        if (typeof selectionStart !== "number") return;
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(selectionStart, selectionStart);
        });
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const handleReferenceLabelDeletion = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!activeLabels.length || mention || (event.key !== "Backspace" && event.key !== "Delete")) return false;
        if (event.nativeEvent.isComposing) return false;
        const textarea = event.currentTarget;
        const next = deleteReferenceLabelAtCaret(textarea.value, textarea.selectionStart, textarea.selectionEnd, event.key, activeLabels);
        if (!next) return false;
        event.preventDefault();
        updateValue(next.value, next.cursor);
        syncMention(next.value, next.cursor);
        requestAnimationFrame(syncOverlayScroll);
        return true;
    };

    const syncMention = (nextValue: string, cursor: number) => {
        const prefix = nextValue.slice(0, cursor);
        const match = /(^|\s)@([^\s@]*)$/.exec(prefix);
        if (!match || !references.some((item) => item.active)) {
            closeMention();
            return;
        }
        setMention({ start: cursor - match[2].length - 1, query: match[2] });
        setActiveIndex(0);
    };

    const insertReference = (reference: CanvasResourceReference) => {
        if (!mention) return;
        const textarea = textareaRef.current;
        const end = textarea?.selectionStart ?? value.length;
        const insertText = `${reference.label} `;
        const next = `${value.slice(0, mention.start)}${insertText}${value.slice(end)}`;
        closeMention();
        updateValue(next, mention.start + insertText.length);
    };

    const syncOverlayScroll = () => {
        if (!overlayRef.current || !textareaRef.current) return;
        overlayRef.current.scrollTop = textareaRef.current.scrollTop;
        overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    };

    const hasActiveLabelInValue = activeLabels.some((label) => value.includes(label));
    const showOverlay = Boolean(value && hasActiveLabelInValue);

    useEffect(() => {
        const converted = replacePictureTags(value, references);
        if (converted !== value) updateValue(converted);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, references]);

    const mergedStyle = {
        ...(style || {}),
        color: showOverlay ? "transparent" : style?.color,
        caretColor: style?.color || theme.node.text,
    } as CSSProperties;
    const menu = mention && candidates.length && textareaRef.current ? <MentionMenu textarea={textareaRef.current} references={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} /> : null;

    return (
        <div className={`relative h-full w-full ${containerClassName || ""}`}>
            {showOverlay ? (
                <div
                    ref={overlayRef}
                    className={`${className || ""} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words`}
                    style={{ ...style, background: "transparent", backgroundColor: "transparent", color: theme.node.text }}
                >
                    <MentionHighlightText value={value || props.placeholder?.toString() || ""} labels={activeLabels} placeholder={!value} />
                </div>
            ) : null}
            <textarea
                {...props}
                autoFocus={autoFocus}
                ref={(node) => {
                    textareaRef.current = node;
                    if (typeof forwardedRef === "function") forwardedRef(node);
                    else if (forwardedRef) forwardedRef.current = node;
                }}
                value={value}
                className={className}
                style={mergedStyle}
                onChange={(event) => {
                    const next = event.target.value;
                    onChange(next);
                    syncMention(next, event.target.selectionStart);
                    requestAnimationFrame(syncOverlayScroll);
                }}
                onSelect={(event) => {
                    props.onSelect?.(event);
                }}
                onFocus={(event) => {
                    props.onFocus?.(event);
                }}
                onKeyUp={(event) => {
                    props.onKeyUp?.(event);
                }}
                onPointerUp={(event) => {
                    props.onPointerUp?.(event);
                }}
                onKeyDown={(event) => {
                    if (handleReferenceLabelDeletion(event)) return;
                    if (mention && handleMentionNavigation(event, candidates, activeIndex, setActiveIndex, insertReference, closeMention)) return;
                    if (event.key === "Enter" && onSubmit && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }
                    onKeyDown?.(event);
                }}
                onScroll={(event) => {
                    syncOverlayScroll();
                    props.onScroll?.(event);
                }}
                onBlur={(event) => {
                    window.setTimeout(closeMention, 120);
                    props.onBlur?.(event);
                }}
            />
            {menu}
        </div>
    );
});

function MentionHighlightText({ value, labels, placeholder }: { value: string; labels: string[]; placeholder: boolean }) {
    if (placeholder) return <span className="opacity-45">{value}</span>;
    if (!labels.length) return <>{value}</>;
    const pattern = new RegExp(`(${labels.map(escapeRegExp).join("|")})`, "g");
    return (
        <>
            {value.split(pattern).map((part, index) =>
                labels.includes(part) ? (
                    <span key={`${part}-${index}`} className="rounded bg-[#2f80ff]/16 text-[#2f80ff]">
                        {part}
                    </span>
                ) : (
                    <span key={`${part}-${index}`}>{part}</span>
                ),
            )}
        </>
    );
}

function MentionMenu({
    textarea,
    references,
    activeIndex,
    theme,
    onSelect,
}: {
    textarea: HTMLTextAreaElement;
    references: CanvasResourceReference[];
    activeIndex: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onSelect: (reference: CanvasResourceReference) => void;
}) {
    const selectedRef = useRef(false);
    const rect = textarea.getBoundingClientRect();
    const boundary = textarea.closest(".ant-modal-content")?.getBoundingClientRect() || { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
    const menuWidth = 256;
    const maxMenuHeight = 224;
    const gap = 6;
    const left = clamp(rect.left, boundary.left + 8, boundary.right - menuWidth - 8);
    const showAbove = rect.bottom + gap + maxMenuHeight > boundary.bottom && rect.top - gap - maxMenuHeight >= boundary.top;
    const top = clamp(showAbove ? rect.top - gap - maxMenuHeight : rect.bottom + gap, boundary.top + 8, boundary.bottom - maxMenuHeight - 8);

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => {
        event.stopPropagation();
    };
    const selectReference = (reference: CanvasResourceReference) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(reference);
    };

    return createPortal(
        <div
            data-canvas-resource-mention-menu="true"
            className="fixed z-[120] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md"
            style={{ left, top, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={stopCanvasInteraction}
            onMouseDown={stopCanvasInteraction}
            onClick={(event) => event.stopPropagation()}
        >
            {references.map((reference, index) => (
                <button
                    key={reference.id}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectReference(reference);
                    }}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectReference(reference);
                    }}
                >
                    <ReferencePreview reference={reference} />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{reference.label}</span>
                        <span className="block truncate opacity-65">{reference.text || reference.title}</span>
                    </span>
                </button>
            ))}
        </div>,
        document.body,
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={imagePreviewUrl(reference.previewUrl, 96)} alt="" className="size-9 rounded-md object-cover" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function clamp(value: number, min: number, max: number) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PICTURE_TAG_PATTERN = /<Picture\s+(\d+)>/gi;

export function replacePictureTags(value: string, references: CanvasResourceReference[]) {
    if (!value || !references.length) return value;
    const images = references.filter((reference) => reference.kind === "image" && reference.active);
    if (!images.length) return value;
    return value.replace(PICTURE_TAG_PATTERN, (match, number: string) => {
        const index = Number(number);
        const reference = images.find((item) => item.label === `图片${index}`) || (index >= 1 && index <= images.length ? images[index - 1] : undefined);
        return reference ? reference.label : match;
    });
}

export function insertTextAtSelection(value: string, start: number, end: number, text: string) {
    const from = clamp(start, 0, value.length);
    const to = clamp(Math.max(end, from), from, value.length);
    return { value: `${value.slice(0, from)}${text}${value.slice(to)}`, caret: from + text.length };
}

export function deleteReferenceLabelAtCaret(value: string, selectionStart: number, selectionEnd: number, key: "Backspace" | "Delete", labels: string[]) {
    for (const label of labels) {
        let index = value.indexOf(label);
        while (index !== -1) {
            const start = index;
            const end = index + label.length;
            const intersectsSelection = selectionStart !== selectionEnd && selectionStart < end && selectionEnd > start;
            if (intersectsSelection) return { value: `${value.slice(0, start)}${value.slice(end)}`, cursor: start };
            const insideOrAtEnd = key === "Backspace" && selectionStart > start && selectionStart <= end;
            const afterTrailingSpace = key === "Backspace" && selectionStart === end + 1 && /\s/u.test(value[end] || "");
            if (insideOrAtEnd || afterTrailingSpace) {
                const swallowSpace = (selectionStart === end || afterTrailingSpace) && /\s/u.test(value[end] || "");
                return { value: `${value.slice(0, start)}${value.slice(end + (swallowSpace ? 1 : 0))}`, cursor: start };
            }
            if (key === "Delete" && selectionStart >= start && selectionStart < end) {
                const swallowSpace = selectionStart === start && /\s/u.test(value[end] || "");
                return { value: `${value.slice(0, start)}${value.slice(end + (swallowSpace ? 1 : 0))}`, cursor: start };
            }
            index = value.indexOf(label, index + 1);
        }
    }
    return undefined;
}
