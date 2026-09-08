"use client";

import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Music2, Video, Sparkles } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { handleMentionNavigation } from "../utils/canvas-mention-navigation";
import type { AgentSkillSummary } from "@/services/api/agent-skills";

export function insertTextAtSelection(value: string, selectionStart: number, selectionEnd: number, textToInsert: string): { value: string; caret: number } {
    const start = Math.max(0, Math.min(selectionStart, value.length));
    const end = Math.max(start, Math.min(selectionEnd, value.length));
    const nextValue = `${value.slice(0, start)}${textToInsert}${value.slice(end)}`;
    return {
        value: nextValue,
        caret: start + textToInsert.length,
    };
}

export function referenceMentionLabel(label: string) {
    return label.startsWith("@") ? label : `@${label}`;
}

export function findResourceMentionAtCursor(value: string, cursor: number) {
    const prefix = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
    const match = /@([^\s@]*)$/.exec(prefix);
    return match ? { start: prefix.length - match[1].length - 1, query: match[1] } : null;
}

export function deleteReferenceLabelAtCaret(value: string, selectionStart: number, selectionEnd: number, key: string, activeLabels: string[]): { value: string; cursor: number } | undefined {
    if (!activeLabels.length) return undefined;

    // 浏览器必须按用户看到的选区逐字删除；只有折叠光标才把引用当作原子标签处理。
    if (selectionStart !== selectionEnd) return undefined;

    if (key === "Backspace") {
        for (const label of activeLabels) {
            // 1. 光标在 label 之后，或 label 紧跟一个空格后
            if (value.slice(0, selectionStart).endsWith(label)) {
                const removeThrough = value[selectionStart] === " " ? selectionStart + 1 : selectionStart;
                return {
                    value: `${value.slice(0, selectionStart - label.length)}${value.slice(removeThrough)}`,
                    cursor: selectionStart - label.length,
                };
            }
            if (value.slice(0, selectionStart).endsWith(`${label} `)) {
                return {
                    value: `${value.slice(0, selectionStart - label.length - 1)}${value.slice(selectionStart)}`,
                    cursor: selectionStart - label.length - 1,
                };
            }
            // 2. 光标在 label 内部
            const before = value.slice(0, selectionStart);
            const after = value.slice(selectionStart);
            for (let i = 1; i < label.length; i++) {
                if (before.endsWith(label.slice(0, i)) && after.startsWith(label.slice(i))) {
                    return {
                        value: `${value.slice(0, selectionStart - i)}${value.slice(selectionStart + label.length - i)}`,
                        cursor: selectionStart - i,
                    };
                }
            }
        }
    } else if (key === "Delete") {
        for (const label of activeLabels) {
            if (value.slice(selectionStart).startsWith(label)) {
                const removeThrough = value[selectionStart + label.length] === " " ? selectionStart + label.length + 1 : selectionStart + label.length;
                return {
                    value: `${value.slice(0, selectionStart)}${value.slice(removeThrough)}`,
                    cursor: selectionStart,
                };
            }
            // 光标在 label 内部或起始
            const before = value.slice(0, selectionStart);
            const after = value.slice(selectionStart);
            for (let i = 0; i < label.length; i++) {
                if (before.endsWith(label.slice(0, i)) && after.startsWith(label.slice(i))) {
                    return {
                        value: `${value.slice(0, selectionStart - i)}${value.slice(selectionStart + label.length - i)}`,
                        cursor: selectionStart - i,
                    };
                }
            }
        }
    }
    return undefined;
}

export function replacePictureTags(value: string, references: CanvasResourceReference[]): string {
    return value.replace(/<Picture\s+(\d+)>/gi, (_match, id) => {
        const found = references.find((r) => r.active && (r.id === id || r.label === `图片${id}` || r.label === `@图片${id}`));
        return found ? referenceMentionLabel(found.label) : _match;
    });
}

type MentionState = {
    start: number;
    query: string;
    type: "mention" | "slash";
};

export type CanvasInlineToken = {
    token: string;
    label: string;
    kind: "camera-motion";
};

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
    value: string;
    references: CanvasResourceReference[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    containerClassName?: string;
    highlightLabels?: boolean;
    inlineTokens?: CanvasInlineToken[];
    skills?: AgentSkillSummary[];
    onSelectSkill?: (skill: AgentSkillSummary) => void;
};

export const CanvasResourceMentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function CanvasResourceMentionTextarea(
    { value, references, onChange, onSubmit, onKeyDown, className, containerClassName, style, highlightLabels = true, inlineTokens = [], skills = [], onSelectSkill, autoFocus, ...props },
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
        if (mention.type === "mention") {
            const activeReferences = references.filter((item) => item.active);
            if (!query) return activeReferences;
            return activeReferences.filter((item) => `${item.label} ${item.title} ${item.kind} ${item.text || ""}`.toLowerCase().includes(query));
        }
        // Slash commands for skills
        if (!query) return skills;
        return skills.filter((s) => `${s.name} ${s.description || ""}`.toLowerCase().includes(query));
    }, [mention, references, skills]);

    const activeReferencesByLabel = useMemo(() => new Map(references.filter((item) => item.active).flatMap((item) => [[referenceMentionLabel(item.label), item] as const, [item.label, item] as const])), [references]);
    const inlineTokensByValue = useMemo(() => new Map(inlineTokens.map((token) => [token.token, token])), [inlineTokens]);
    const activeLabels = useMemo(() => (highlightLabels ? Array.from(new Set([...activeReferencesByLabel.keys(), ...inlineTokensByValue.keys()])).sort((a, b) => b.length - a.length) : []), [activeReferencesByLabel, highlightLabels, inlineTokensByValue]);

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
        const resourceMention = findResourceMentionAtCursor(nextValue, cursor);
        if (resourceMention && references.some((item) => item.active)) {
            setMention({ ...resourceMention, type: "mention" });
            setActiveIndex(0);
            return;
        }

        const prefix = nextValue.slice(0, cursor);
        const slashMatch = /(^|\s)\/([^\s\/]*)$/.exec(prefix);
        if (slashMatch && skills.length > 0) {
            setMention({ start: cursor - slashMatch[2].length - 1, query: slashMatch[2], type: "slash" });
            setActiveIndex(0);
            return;
        }

        closeMention();
    };

    const insertReference = (item: CanvasResourceReference | AgentSkillSummary) => {
        if (!mention) return;
        const textarea = textareaRef.current;
        const end = textarea?.selectionStart ?? value.length;
        let insertText = "";
        if (mention.type === "mention") {
            const ref = item as CanvasResourceReference;
            insertText = `${referenceMentionLabel(ref.label)} `;
        } else {
            const skill = item as AgentSkillSummary;
            onSelectSkill?.(skill);
        }
        const next = `${value.slice(0, mention.start)}${insertText}${value.slice(end)}`;
        closeMention();
        updateValue(next, mention.start + insertText.length);
    };

    const syncOverlayScroll = () => {
        if (!overlayRef.current || !textareaRef.current) return;
        overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    };

    const highlightedOverlay = useMemo(() => {
        if (!highlightLabels || !activeLabels.length || !value || !activeLabels.some((label) => value.includes(label))) return null;
        const pattern = new RegExp(`(${activeLabels.map(escapeRegExp).join("|")})`, "g");
        const parts = value.split(pattern);

        return parts.map((part, index) => {
            if (!activeLabels.includes(part)) return <span key={index}>{part}</span>;
            const reference = activeReferencesByLabel.get(part);
            const inlineToken = inlineTokensByValue.get(part);
            if (inlineToken?.kind === "camera-motion") {
                return (
                    <span
                        key={index}
                        data-canvas-inline-camera-motion
                        aria-label={inlineToken.label}
                        className="rounded-md bg-[#5b5ce2]/10 text-[#5b5ce2] shadow-[inset_0_0_0_1px_rgba(91,92,226,0.35)] dark:text-[#a5a6ff]"
                    >
                        {part}
                    </span>
                );
            }
            return (
                <span
                    key={index}
                    data-canvas-inline-reference
                    title={reference?.title || referenceTokenCaption(part)}
                    className="rounded-full"
                    style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText, boxShadow: `inset 0 0 0 1px ${theme.node.activeStroke}55` }}
                >
                    {part}
                </span>
            );
        });
    }, [activeLabels, activeReferencesByLabel, highlightLabels, inlineTokensByValue, theme.node.activeStroke, theme.toolbar.activeBg, theme.toolbar.activeText, value]);

    const editorSurface = highlightedOverlay
        ? {
              background: style?.background,
              backgroundColor: style?.backgroundColor,
              borderRadius: style?.borderRadius,
          }
        : undefined;

    return (
        <div className={`relative ${containerClassName || ""}`} style={editorSurface}>
            {highlightedOverlay ? (
                <div
                    ref={overlayRef}
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-0 z-10 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-xl border bg-transparent ${className || "p-3 text-xs leading-relaxed"}`}
                    style={{ ...style, background: "transparent", backgroundColor: "transparent", borderColor: theme.toolbar.border, color: style?.color ?? theme.node.text }}
                >
                    {highlightedOverlay}
                </div>
            ) : null}

            <textarea
                {...props}
                ref={(node) => {
                    textareaRef.current = node;
                    if (typeof forwardedRef === "function") forwardedRef(node);
                    else if (forwardedRef) forwardedRef.current = node;
                }}
                value={value}
                rows={props.rows ?? 4}
                className={`relative z-20 w-full resize-none rounded-xl border bg-transparent outline-none transition ${className || "p-3 text-xs leading-relaxed"}`}
                style={{
                    ...style,
                    ...(highlightedOverlay ? { background: "transparent", backgroundColor: "transparent" } : null),
                    color: highlightedOverlay ? "transparent" : (style?.color ?? theme.node.text),
                    WebkitTextFillColor: highlightedOverlay ? "transparent" : style?.WebkitTextFillColor,
                    caretColor: style?.color ?? theme.node.text,
                    borderColor: theme.toolbar.border,
                }}
                onScroll={syncOverlayScroll}
                onChange={(event) => {
                    const nextValue = event.target.value;
                    const cursor = event.target.selectionStart ?? nextValue.length;
                    updateValue(nextValue, cursor);
                    syncMention(nextValue, cursor);
                    requestAnimationFrame(syncOverlayScroll);
                }}
                onClick={(event) => {
                    const cursor = event.currentTarget.selectionStart ?? value.length;
                    syncMention(value, cursor);
                }}
                onKeyUp={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
                        const cursor = event.currentTarget.selectionStart ?? value.length;
                        syncMention(value, cursor);
                    }
                }}
                onKeyDown={(event) => {
                    if (handleReferenceLabelDeletion(event)) return;

                    if (mention && candidates.length > 0) {
                        const handled = handleMentionNavigation(event, candidates, activeIndex, setActiveIndex, insertReference, closeMention);
                        if (handled) return;
                    }

                    if (event.key === "Escape" && mention) {
                        event.preventDefault();
                        closeMention();
                        return;
                    }

                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && onSubmit) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }

                    onKeyDown?.(event);
                }}
            />

            {mention && candidates.length > 0 ? (
                <MentionPortal
                    textarea={textareaRef.current}
                    anchorIndex={textareaRef.current?.selectionStart ?? mention.start + mention.query.length + 1}
                    candidates={candidates}
                    activeIndex={activeIndex}
                    type={mention.type}
                    theme={theme}
                    onSelect={insertReference}
                />
            ) : null}
        </div>
    );
});

function MentionPortal({
    textarea,
    anchorIndex,
    candidates,
    activeIndex,
    type,
    theme,
    onSelect,
}: {
    textarea: HTMLTextAreaElement | null;
    anchorIndex: number;
    candidates: (CanvasResourceReference | AgentSkillSummary)[];
    activeIndex: number;
    type: "mention" | "slash";
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onSelect: (item: CanvasResourceReference | AgentSkillSummary) => void;
}) {
    const selectedRef = useRef(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

    const updatePosition = useCallback(() => {
        if (!textarea || !menuRef.current) return;
        const boundaryRect = textarea.closest(".ant-modal-content")?.getBoundingClientRect();
        const boundary = boundaryRect || { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
        const menuRect = menuRef.current.getBoundingClientRect();
        const anchor = getTextareaCaretRect(textarea, anchorIndex);
        setPosition(resolveMentionMenuPosition({ anchor, boundary, menuWidth: menuRect.width, menuHeight: menuRect.height }));
    }, [anchorIndex, textarea]);

    useLayoutEffect(() => {
        if (!textarea) return;
        updatePosition();
        const frame = requestAnimationFrame(updatePosition);
        const viewport = window.visualViewport;
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        textarea.addEventListener("scroll", updatePosition);
        viewport?.addEventListener("resize", updatePosition);
        viewport?.addEventListener("scroll", updatePosition);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
            textarea.removeEventListener("scroll", updatePosition);
            viewport?.removeEventListener("resize", updatePosition);
            viewport?.removeEventListener("scroll", updatePosition);
        };
    }, [textarea, updatePosition]);

    if (!textarea || typeof window === "undefined") return null;

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => {
        event.stopPropagation();
    };
    const selectItem = (item: CanvasResourceReference | AgentSkillSummary) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(item);
    };

    return createPortal(
        <div
            ref={menuRef}
            data-canvas-resource-mention-menu="true"
            className="fixed z-[1300] max-h-60 w-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl backdrop-blur-md"
            style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={stopCanvasInteraction}
            onMouseDown={stopCanvasInteraction}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="px-2 py-1 text-[11px] font-semibold opacity-50 flex items-center gap-1 border-b mb-1 pb-1" style={{ borderColor: theme.toolbar.border }}>
                {type === "mention" ? "选择引用节点 (@)" : "选择引用 Skill 技能 (/)"}
            </div>
            {candidates.map((item, index) => {
                const isMention = type === "mention";
                const ref = item as CanvasResourceReference;
                const skill = item as AgentSkillSummary;

                return (
                    <button
                        key={item.id}
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                        style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                        onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            selectItem(item);
                        }}
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            selectItem(item);
                        }}
                    >
                        {isMention ? (
                            <>
                                <ReferencePreview reference={ref} />
                                <span className="min-w-0 flex-1">
                                    <span className="block font-medium">{ref.label}</span>
                                    <span className="block truncate opacity-65">{ref.text || ref.title}</span>
                                </span>
                            </>
                        ) : (
                            <>
                                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#5b5ce2]/10 text-[#5b5ce2]">
                                    <Sparkles className="size-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block font-medium text-[#5b5ce2]">{skill.name}</span>
                                    <span className="block truncate opacity-65 text-[11px]">{skill.description || skill.id}</span>
                                </span>
                            </>
                        )}
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}

type RectEdges = { left: number; top: number; right: number; bottom: number };

export function resolveMentionMenuPosition({ anchor, boundary, menuWidth, menuHeight, gap = 6 }: { anchor: RectEdges; boundary: RectEdges; menuWidth: number; menuHeight: number; gap?: number }) {
    const inset = 8;
    const fitsAbove = anchor.top - gap - menuHeight >= boundary.top + inset;
    const preferredTop = fitsAbove ? anchor.top - gap - menuHeight : anchor.bottom + gap;
    return {
        left: clamp(anchor.left, boundary.left + inset, boundary.right - menuWidth - inset),
        top: clamp(preferredTop, boundary.top + inset, boundary.bottom - menuHeight - inset),
    };
}

function getTextareaCaretRect(textarea: HTMLTextAreaElement, cursor: number): RectEdges {
    const textareaRect = textarea.getBoundingClientRect();
    const computed = window.getComputedStyle(textarea);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    const properties = [
        "boxSizing",
        "width",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "letterSpacing",
        "lineHeight",
        "textAlign",
        "textIndent",
        "textTransform",
        "tabSize",
        "wordBreak",
        "overflowWrap",
    ] as const;
    for (const property of properties) mirror.style[property] = computed[property];
    mirror.style.position = "fixed";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflow = "hidden";
    mirror.style.left = `${textareaRect.left - textarea.scrollLeft}px`;
    mirror.style.top = `${textareaRect.top - textarea.scrollTop}px`;
    mirror.textContent = textarea.value.slice(0, Math.max(0, Math.min(cursor, textarea.value.length)));
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const markerRect = marker.getBoundingClientRect();
    const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) || 16;
    mirror.remove();
    return { left: markerRect.left, right: markerRect.left, top: markerRect.top, bottom: markerRect.top + lineHeight };
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

function referenceTokenCaption(label: string) {
    return label.replace(/^@/, "");
}

function clamp(value: number, min: number, max: number) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
