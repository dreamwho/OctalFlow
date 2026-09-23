"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileText, Image as ImageIcon, Sparkles, User, Video, Volume2, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { DreamyoIcon } from "@/components/ui/dreamyo-icon";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import { isSubjectReference, type CanvasResourceReference } from "../utils/canvas-resource-references";
import { handleMentionNavigation } from "../utils/canvas-mention-navigation";
import type { AgentSkillSummary } from "@/services/api/agent-skills";
import { findResourceMentionAtCursor, referenceMentionLabel, resolveMentionMenuPosition, type CanvasInlineToken } from "./canvas-resource-mention-textarea";

type PromptNodeLike = {
    type?: { name?: string } | string;
    attrs?: Record<string, unknown>;
    isText?: boolean;
    text?: string | null;
    nodeSize?: number;
    content?: readonly PromptNodeLike[] | { size: number };
    forEach?: (callback: (child: PromptNodeLike, offset: number, index: number) => void) => void;
    descendants?: (callback: (node: PromptNodeLike, pos: number) => boolean | void) => void;
    nodesBetween?: (from: number, to: number, callback: (node: PromptNodeLike, pos: number) => boolean | void) => void;
};

type PromptDocumentLike = PromptNodeLike & {
    forEach?: (callback: (child: PromptNodeLike, offset: number, index: number) => void) => void;
};

type MentionState = { start: number; query: string; type: "mention" | "slash" };

export type CanvasPromptToken =
    { type: "reference"; id: string; label: string; title: string; kind: CanvasResourceReference["kind"]; previewUrl?: string } | { type: "skill"; id: string; label: string } | { type: "camera-motion"; token: string; label: string };

export type CanvasPromptTokenSnapshot = { token: CanvasPromptToken; start: number; end: number };

export type CanvasPromptEditorHandle = {
    focus: () => void;
    focusAt: (offset: number) => void;
    getSelectionOffset: () => number;
    insertTextAt: (start: number, end: number, text: string) => void;
    insertReference: (reference: CanvasResourceReference, start?: number, end?: number) => void;
    insertSkill: (skill: AgentSkillSummary, start?: number, end?: number) => void;
    removeToken: (type: CanvasPromptToken["type"], id: string) => boolean;
    clear: () => void;
};

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "onSelect"> & {
    value: string;
    references: CanvasResourceReference[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    submitOnModEnterOnly?: boolean;
    containerClassName?: string;
    highlightLabels?: boolean;
    inlineTokens?: CanvasInlineToken[];
    skills?: AgentSkillSummary[];
    selectedSkillIds?: readonly string[];
    onSelectSkill?: (skill: AgentSkillSummary) => void;
    onRemoveSkill?: (skillId: string) => void;
    onSelectionChange?: (value: string, offset: number) => void;
    tokenSnapshot?: readonly CanvasPromptTokenSnapshot[];
    onTokenSnapshotChange?: (tokens: CanvasPromptTokenSnapshot[]) => void;
    onConnectReference?: (sourceNodeId: string) => void;
};

const REFERENCE_TOKEN_NAME = "referenceToken";
const SKILL_TOKEN_NAME = "skillToken";
const CAMERA_TOKEN_NAME = "cameraMotionToken";

function ReferenceTokenView({ node, deleteNode }: NodeViewProps) {
    const attrs = node.attrs as Record<string, string>;
    const kind = (attrs.kind || "image") as CanvasResourceReference["kind"];
    return (
        <NodeViewWrapper
            as="span"
            className="canvas-prompt-token canvas-prompt-reference-token inline-flex max-w-full items-center gap-1 rounded-lg border px-1 py-0.5 align-middle text-sm leading-6 shadow-sm dark:border-[#52658e] dark:bg-[#172342] dark:text-[#edf5ff]"
            data-canvas-token="reference"
            data-reference-id={attrs.id}
        >
            <span className="canvas-prompt-token-preview grid size-6 shrink-0 place-items-center overflow-hidden rounded-md bg-black/5 dark:bg-white/10">
                {attrs.previewUrl && (kind === "image" || kind === "video") ? (
                    kind === "image" ? (
                        <img src={imagePreviewUrl(attrs.previewUrl, 96)} alt="" draggable={false} />
                    ) : (
                        <video src={attrs.previewUrl} muted playsInline preload="metadata" />
                    )
                ) : kind === "audio" ? (
                    <DreamyoIcon name="audio" size={15} />
                ) : (
                    <FileText aria-hidden="true" className="size-3.5" />
                )}
            </span>
            <span className="canvas-prompt-token-label min-w-0 truncate px-0.5">{attrs.label || "引用"}</span>
            <button
                type="button"
                className="canvas-prompt-token-remove grid size-7 shrink-0 place-items-center rounded-md text-slate-500 transition hover:bg-slate-500/10 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label={`移除${attrs.label || "引用"}`}
                title={`移除${attrs.label || "引用"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => deleteNode()}
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </NodeViewWrapper>
    );
}

function SkillTokenView({ node, deleteNode }: NodeViewProps) {
    const attrs = node.attrs as Record<string, string>;
    return (
        <NodeViewWrapper
            as="span"
            className="canvas-prompt-token canvas-prompt-skill-token inline-flex max-w-full items-center gap-1 rounded-lg border border-[#cfc7ff] bg-[#f4f0ff] px-1 py-0.5 align-middle text-sm leading-6 text-[#4d42a8] shadow-sm dark:border-[#645ce0] dark:bg-[#342c67]/70 dark:text-[#e9e6ff]"
            data-canvas-token="skill"
            data-skill-id={attrs.id}
            data-canvas-inline-skill
        >
            <Sparkles aria-hidden="true" className="canvas-prompt-token-icon size-4 shrink-0 text-[#6854e8] dark:text-[#bdb5ff]" />
            <span className="canvas-prompt-token-label min-w-0 truncate px-0.5">{attrs.label || "Skill"}</span>
            <button
                type="button"
                className="canvas-prompt-token-remove grid size-7 shrink-0 place-items-center rounded-md text-[#6854e8]/75 transition hover:bg-[#6854e8]/10 hover:text-[#4d42a8] dark:text-[#ddd9ff] dark:hover:bg-white/10 dark:hover:text-white"
                aria-label={`移除 Skill ${attrs.label || "Skill"}`}
                title={`移除 Skill ${attrs.label || "Skill"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => deleteNode()}
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </NodeViewWrapper>
    );
}

function CameraMotionTokenView({ node, deleteNode }: NodeViewProps) {
    const attrs = node.attrs as Record<string, string>;
    return (
        <NodeViewWrapper
            as="span"
            className="canvas-prompt-token canvas-prompt-camera-token inline-flex max-w-full items-center gap-1 rounded-lg border border-[#bcb9ff] bg-[#f1f0ff] px-1.5 py-0.5 align-middle text-sm leading-6 text-[#5147b8] shadow-sm dark:border-[#5b63bd] dark:bg-[#202b58] dark:text-[#d9dcff]"
            data-canvas-token="camera-motion"
        >
            <span className="canvas-prompt-token-label min-w-0 truncate">{attrs.label || "运镜"}</span>
            <button
                type="button"
                className="canvas-prompt-token-remove grid size-7 shrink-0 place-items-center rounded-md text-[#5147b8]/75 transition hover:bg-[#5147b8]/10 hover:text-[#393083] dark:text-[#d9dcff] dark:hover:bg-white/10 dark:hover:text-white"
                aria-label={`移除${attrs.label || "运镜"}`}
                title={`移除${attrs.label || "运镜"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => deleteNode()}
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </NodeViewWrapper>
    );
}

const ReferenceTokenNode = Node.create({
    name: REFERENCE_TOKEN_NAME,
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    addAttributes() {
        return { id: { default: "" }, label: { default: "图片1" }, title: { default: "" }, kind: { default: "image" }, previewUrl: { default: "" } };
    },
    parseHTML() {
        return [{ tag: 'span[data-canvas-token="reference"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["span", mergeAttributes(HTMLAttributes, { "data-canvas-token": "reference" }), HTMLAttributes.label || "引用"];
    },
    addNodeView() {
        return ReactNodeViewRenderer(ReferenceTokenView);
    },
});

const SkillTokenNode = Node.create({
    name: SKILL_TOKEN_NAME,
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    addAttributes() {
        return { id: { default: "" }, label: { default: "Skill" } };
    },
    parseHTML() {
        return [{ tag: 'span[data-canvas-token="skill"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["span", mergeAttributes(HTMLAttributes, { "data-canvas-token": "skill" }), HTMLAttributes.label || "Skill"];
    },
    addNodeView() {
        return ReactNodeViewRenderer(SkillTokenView);
    },
});

const CameraMotionTokenNode = Node.create({
    name: CAMERA_TOKEN_NAME,
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    addAttributes() {
        return { token: { default: "" }, label: { default: "运镜" } };
    },
    parseHTML() {
        return [{ tag: 'span[data-canvas-token="camera-motion"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["span", mergeAttributes(HTMLAttributes, { "data-canvas-token": "camera-motion" }), HTMLAttributes.label || "运镜"];
    },
    addNodeView() {
        return ReactNodeViewRenderer(CameraMotionTokenView);
    },
});

function nodeTypeName(node: PromptNodeLike) {
    return typeof node.type === "string" ? node.type : node.type?.name;
}

function tokenFromNode(node: PromptNodeLike): CanvasPromptToken | undefined {
    const attrs = node.attrs || {};
    const typeName = nodeTypeName(node);
    if (typeName === REFERENCE_TOKEN_NAME)
        return {
            type: "reference",
            id: String(attrs.id || ""),
            label: String(attrs.label || "图片1"),
            title: String(attrs.title || ""),
            kind: String(attrs.kind || "image") as CanvasResourceReference["kind"],
            previewUrl: String(attrs.previewUrl || "") || undefined,
        };
    if (typeName === SKILL_TOKEN_NAME) return { type: "skill", id: String(attrs.id || ""), label: String(attrs.label || "Skill") };
    if (typeName === CAMERA_TOKEN_NAME) return { type: "camera-motion", token: String(attrs.token || ""), label: String(attrs.label || "运镜") };
    return undefined;
}

export function canvasPromptTokenText(token: CanvasPromptToken) {
    if (token.type === "reference") return referenceMentionLabel(token.label);
    if (token.type === "camera-motion") return token.token;
    return "";
}

const tokenText = canvasPromptTokenText;

function nodeContentText(node: PromptNodeLike): string {
    if (node.isText || nodeTypeName(node) === "text") return node.text || "";
    const token = tokenFromNode(node);
    if (token) return tokenText(token);
    if (nodeTypeName(node) === "hardBreak") return "\n";
    let value = "";
    if (Array.isArray(node.content)) {
        for (const child of node.content) value += nodeContentText(child);
    } else {
        node.forEach?.((child) => {
            value += nodeContentText(child);
        });
    }
    return value;
}

export function serializeCanvasPromptDocument(doc: PromptDocumentLike) {
    if (Array.isArray(doc.content)) return doc.content.map((child) => nodeContentText(child)).join("\n");
    const lines: string[] = [];
    doc.forEach?.((child) => lines.push(nodeContentText(child)));
    return lines.join("\n");
}

function tokenEntries(doc: PromptDocumentLike) {
    const entries: Array<{ token: CanvasPromptToken; pos: number; end: number }> = [];
    doc.descendants?.((node, pos) => {
        const token = tokenFromNode(node);
        if (token) entries.push({ token, pos, end: pos + (node.nodeSize || 0) });
    });
    return entries;
}

function tokenSnapshots(doc: PromptDocumentLike): CanvasPromptTokenSnapshot[] {
    return tokenEntries(doc).map(({ token, pos }) => {
        const start = plainOffsetAtPosition(doc, pos);
        const serializedLength = tokenText(token).length;
        return { token, start, end: start + serializedLength };
    });
}

function getNodeSize(node: PromptNodeLike): number {
    if (typeof node.nodeSize === "number") return node.nodeSize;
    if (node.isText || nodeTypeName(node) === "text") return (node.text || "").length;
    if (nodeTypeName(node) === "hardBreak") return 1;
    if (tokenFromNode(node)) return 1;
    let size = 0;
    if (Array.isArray(node.content)) {
        for (const child of node.content) size += getNodeSize(child);
    }
    const type = nodeTypeName(node);
    if (type === "paragraph" || type === "doc") {
        return size + 2;
    }
    return size;
}

export function plainOffsetAtPosition(doc: PromptDocumentLike, position: number) {
    let value = "";
    if (doc.nodesBetween) {
        doc.nodesBetween(0, Math.max(0, position), (node, pos) => {
            if (pos > 0 && nodeTypeName(node) === "paragraph" && pos <= position) {
                value += "\n";
            }
            if (node.isText) {
                const length = Math.max(0, Math.min(node.nodeSize || 0, position - pos));
                value += (node.text || "").slice(0, length);
            } else {
                const token = tokenFromNode(node);
                if (token && pos < position) value += tokenText(token);
                else if (nodeTypeName(node) === "hardBreak" && pos < position) value += "\n";
            }
        });
    } else {
        const paragraphs = Array.isArray(doc.content) ? doc.content : [];
        let blockStart = 0;
        paragraphs.forEach((p, index) => {
            const pSize = getNodeSize(p);
            if (index > 0 && position >= blockStart) value += "\n";
            if (position >= blockStart) {
                const items = Array.isArray(p.content) ? p.content : [];
                let itemPos = blockStart + 1;
                for (const item of items) {
                    const itemSize = getNodeSize(item);
                    if (item.isText || item.type === "text") {
                        const text = String(item.text || "");
                        const length = Math.max(0, Math.min(text.length, position - itemPos));
                        value += text.slice(0, length);
                    } else {
                        const token = tokenFromNode(item);
                        if (token && itemPos < position) value += tokenText(token);
                        else if (nodeTypeName(item) === "hardBreak" && itemPos < position) value += "\n";
                    }
                    itemPos += itemSize;
                }
            }
            blockStart += pSize;
        });
    }
    return value.length;
}

function documentContentSize(doc: PromptDocumentLike) {
    if (Array.isArray(doc.content)) return doc.content.reduce((size, child) => size + getNodeSize(child), 0);
    return doc.content && !Array.isArray(doc.content) ? (doc.content as { size: number }).size : 0;
}

export function positionAtPlainOffset(doc: PromptDocumentLike, offset: number) {
    let current = 0;
    let result = documentContentSize(doc);
    const find = (node: PromptNodeLike, pos: number): boolean => {
        if (node.isText || nodeTypeName(node) === "text") {
            const text = node.text || "";
            if (offset <= current + text.length) {
                result = pos + Math.max(0, offset - current);
                return true;
            }
            current += text.length;
            return false;
        }
        const token = tokenFromNode(node);
        const text = token ? tokenText(token) : nodeTypeName(node) === "hardBreak" ? "\n" : "";
        if (token || nodeTypeName(node) === "hardBreak") {
            if (offset <= current + text.length) {
                result = offset === current ? pos : pos + getNodeSize(node);
                return true;
            }
            current += text.length;
            return false;
        }
        let found = false;
        let childOffset = 0;
        if (node.forEach) {
            node.forEach((child) => {
                if (!found) found = find(child, pos + 1 + childOffset);
                childOffset += child.nodeSize || 0;
            });
        } else if (Array.isArray(node.content)) {
            for (const child of node.content) {
                if (found) break;
                found = find(child, pos + 1 + childOffset);
                childOffset += getNodeSize(child);
            }
        }
        return found;
    };
    let blockOffset = 0;
    if (doc.forEach) {
        doc.forEach((child) => {
            if (result !== documentContentSize(doc)) return;
            if (blockOffset > 0) current += 1;
            find(child, blockOffset);
            blockOffset += child.nodeSize || 0;
        });
    } else if (Array.isArray(doc.content)) {
        for (const child of doc.content) {
            if (result !== documentContentSize(doc)) break;
            if (blockOffset > 0) current += 1;
            find(child, blockOffset);
            blockOffset += getNodeSize(child);
        }
    }
    return result;
}

function itemSerializedText(item: Record<string, unknown>) {
    if (item.type === "text") return String(item.text || "");
    if (item.type === REFERENCE_TOKEN_NAME) return referenceMentionLabel(String((item.attrs as { label?: string } | undefined)?.label || ""));
    if (item.type === CAMERA_TOKEN_NAME) return String((item.attrs as { token?: string } | undefined)?.token || "");
    return "";
}

function insertTokenSnapshotAtOffset(paragraphs: Array<{ type: "paragraph"; content?: Array<Record<string, unknown>> }>, value: string, snapshot: CanvasPromptTokenSnapshot) {
    if (snapshot.token.type === "skill" && snapshot.end !== snapshot.start) return;
    const before = value.slice(0, snapshot.start);
    const lineIndex = Math.min(paragraphs.length - 1, before.split("\n").length - 1);
    const localOffset = snapshot.start - before.lastIndexOf("\n") - 1;
    const paragraph = paragraphs[lineIndex];
    if (!paragraph) return;
    const content = paragraph.content || (paragraph.content = []);
    let current = 0;
    for (let index = 0; index < content.length; index += 1) {
        const item = content[index];
        const text = itemSerializedText(item);
        const next = current + text.length;
        if (localOffset > next) {
            current = next;
            continue;
        }
        const tokenNode = tokenNodeForSnapshot(snapshot);
        if (localOffset === next) {
            content.splice(index + 1, 0, tokenNode);
            return;
        }
        if (item.type === "text" && localOffset > current && localOffset < next) {
            const split = localOffset - current;
            content.splice(index, 1, { type: "text", text: String(item.text || "").slice(0, split) }, tokenNode, { type: "text", text: String(item.text || "").slice(split) });
        } else {
            content.splice(index, 0, tokenNode);
        }
        return;
    }
    content.push(tokenNodeForSnapshot(snapshot));
}

function tokenNodeForSnapshot(snapshot: CanvasPromptTokenSnapshot) {
    if (snapshot.token.type === "skill") return { type: SKILL_TOKEN_NAME, attrs: { id: snapshot.token.id, label: snapshot.token.label } };
    if (snapshot.token.type === "reference") return { type: REFERENCE_TOKEN_NAME, attrs: { id: snapshot.token.id, label: snapshot.token.label, title: snapshot.token.title, kind: snapshot.token.kind, previewUrl: snapshot.token.previewUrl || "" } };
    return { type: CAMERA_TOKEN_NAME, attrs: { token: snapshot.token.token, label: snapshot.token.label } };
}

function referenceAttrs(reference: CanvasResourceReference) {
    return { id: reference.id, label: reference.label.replace(/^@/u, ""), title: reference.title, kind: reference.kind, previewUrl: reference.previewUrl || "" };
}

function cameraAttrs(inlineToken: CanvasInlineToken) {
    return { token: inlineToken.token, label: inlineToken.label };
}

export function parseCanvasPromptDocument(
    value: string,
    references: readonly CanvasResourceReference[],
    inlineTokens: readonly CanvasInlineToken[],
    skills: readonly AgentSkillSummary[],
    selectedSkillIds: readonly string[],
    tokenSnapshot: readonly CanvasPromptTokenSnapshot[] = [],
    preservedTokens: readonly CanvasPromptToken[] = [],
) {
    const skillById = new Map(skills.map((skill) => [skill.id, skill]));
    const referenceByMarker = new Map<string, CanvasResourceReference>();
    for (const reference of references) {
        const label = reference.label.replace(/^@/u, "");
        referenceByMarker.set(`@${label}`, reference);
        referenceByMarker.set(referenceMentionLabel(reference.label), reference);
        referenceByMarker.set(label, reference);
        referenceByMarker.set(`@[node:${reference.id}]`, reference);
        if (reference.nodeId) {
            referenceByMarker.set(`@[node:${reference.nodeId}]`, reference);
        }
    }
    const cameraByToken = new Map(inlineTokens.map((item) => [item.token, item]));
    const paragraphs: Array<{ type: "paragraph"; content?: Array<Record<string, unknown>> }> = value.split("\n").map((line) => {
        const content: Array<Record<string, unknown>> = [];
        let offset = 0;
        const pattern = /@[^\s@，。！？、,.!?]+|【[^\n】]+】/gu;
        for (const match of line.matchAll(pattern)) {
            const raw = match[0];
            const start = match.index ?? 0;
            if (start > offset) content.push({ type: "text", text: line.slice(offset, start) });
            const reference = referenceByMarker.get(raw);
            const camera = cameraByToken.get(raw);
            if (reference) content.push({ type: REFERENCE_TOKEN_NAME, attrs: referenceAttrs(reference) });
            else if (camera) content.push({ type: CAMERA_TOKEN_NAME, attrs: cameraAttrs(camera) });
            else content.push({ type: "text", text: raw });
            offset = start + raw.length;
        }
        if (offset < line.length) content.push({ type: "text", text: line.slice(offset) });
        return { type: "paragraph" as const, content: content.length ? content : undefined };
    });
    const parsedTokenKeys = new Set<string>();
    for (const paragraph of paragraphs)
        for (const item of paragraph.content || []) {
            if (item.type === REFERENCE_TOKEN_NAME || item.type === SKILL_TOKEN_NAME) parsedTokenKeys.add(String((item.attrs as { id?: string } | undefined)?.id || ""));
            if (item.type === CAMERA_TOKEN_NAME) parsedTokenKeys.add(`camera:${String((item.attrs as { token?: string } | undefined)?.token || "")}`);
        }
    for (const storedSnapshot of [...tokenSnapshot].sort((left, right) => left.start - right.start)) {
        const snapshot =
            storedSnapshot.token.type === "skill"
                ? {
                      ...storedSnapshot,
                      token: {
                          ...storedSnapshot.token,
                          label: skillById.get(storedSnapshot.token.id)?.name || storedSnapshot.token.label,
                      },
                  }
                : storedSnapshot;
        if (snapshot.token.type === "skill" && !selectedSkillIds.includes(snapshot.token.id)) continue;
        const key = snapshot.token.type === "camera-motion" ? `camera:${snapshot.token.token}` : snapshot.token.id;
        if (!key || parsedTokenKeys.has(key)) continue;
        insertTokenSnapshotAtOffset(paragraphs, value, snapshot);
        parsedTokenKeys.add(key);
    }
    const existingIds = new Set<string>();
    for (const paragraph of paragraphs)
        for (const item of paragraph.content || []) {
            const id = String((item.attrs as { id?: string } | undefined)?.id || "");
            if (id) existingIds.add(id);
        }
    const lastParagraph = paragraphs[paragraphs.length - 1];
    const extraTokens = preservedTokens.filter((token): token is Extract<CanvasPromptToken, { type: "skill" }> => token.type === "skill" && Boolean(token.id) && !existingIds.has(token.id));
    for (const skillId of selectedSkillIds) {
        if (!skillId || existingIds.has(skillId) || extraTokens.some((token) => token.id === skillId)) continue;
        const skill = skillById.get(skillId);
        extraTokens.push({ type: "skill", id: skillId, label: skill?.name || skillId });
        existingIds.add(skillId);
    }
    if (lastParagraph && extraTokens.length) {
        lastParagraph.content ||= [];
        if (lastParagraph.content.length && lastParagraph.content[lastParagraph.content.length - 1].type !== "text") lastParagraph.content.push({ type: "text", text: " " });
        for (const token of extraTokens) lastParagraph.content.push({ type: SKILL_TOKEN_NAME, attrs: { id: token.id, label: token.label } });
    }
    return { type: "doc", content: paragraphs };
}

const parseValue = parseCanvasPromptDocument;

function styleToString(style: CSSProperties | undefined) {
    if (!style) return undefined;
    return Object.entries(style)
        .map(([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${String(value)}`)
        .join(";");
}

export const CanvasRichPromptEditor = forwardRef<CanvasPromptEditorHandle, Props>(function CanvasRichPromptEditor(
    {
        value,
        references,
        onChange,
        onSubmit,
        submitOnModEnterOnly = false,
        onKeyDown,
        className,
        containerClassName,
        style,
        highlightLabels = true,
        inlineTokens = [],
        skills = [],
        selectedSkillIds = [],
        onSelectSkill,
        onRemoveSkill,
        onSelectionChange,
        tokenSnapshot = [],
        onTokenSnapshotChange,
        onConnectReference,
        autoFocus,
        placeholder,
        ...props
    },
    forwardedRef,
) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [ready, setReady] = useState(false);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const lastValueRef = useRef(value);
    const composingRef = useRef(false);
    const editorRef = useRef<TiptapEditor | null>(null);
    const [compositionRevision, setCompositionRevision] = useState(0);
    const previousTokensRef = useRef<CanvasPromptToken[]>([]);
    const callbacksRef = useRef({ onChange, onSelectionChange, onSelectSkill, onRemoveSkill, onTokenSnapshotChange, onSubmit, onKeyDown, onConnectReference });
    callbacksRef.current = { onChange, onSelectionChange, onSelectSkill, onRemoveSkill, onTokenSnapshotChange, onSubmit, onKeyDown, onConnectReference };
    const activeReferences = useMemo(() => {
        return [...references].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    }, [references]);
    const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);

    const emitMention = useCallback(
        (instance: TiptapEditor) => {
            const nextValue = serializeCanvasPromptDocument(instance.state.doc);
            const offset = plainOffsetAtPosition(instance.state.doc, instance.state.selection.from);
            callbacksRef.current.onSelectionChange?.(nextValue, offset);
            const resourceMention = findResourceMentionAtCursor(nextValue, offset);
            if (resourceMention) {
                setMention({ ...resourceMention, type: "mention" });
                setActiveIndex(0);
                return;
            }
            const prefix = nextValue.slice(0, offset);
            const slashMatch = /(^|\s)\/([^\s/]*)$/u.exec(prefix);
            if (slashMatch && skills.length) {
                setMention({ start: offset - slashMatch[2].length - 1, query: slashMatch[2], type: "slash" });
                setActiveIndex(0);
                return;
            }
            setMention(null);
            setActiveIndex(0);
        },
        [skills.length],
    );

    const publishEditorChange = (instance: TiptapEditor) => {
        const nextValue = serializeCanvasPromptDocument(instance.state.doc);
        lastValueRef.current = nextValue;
        callbacksRef.current.onChange(nextValue);
        const currentTokens = tokenEntries(instance.state.doc).map(({ token }) => token);
        const previousTokens = previousTokensRef.current;
        for (const oldToken of previousTokens) if (oldToken.type === "skill" && !currentTokens.some((token) => token.type === "skill" && token.id === oldToken.id)) callbacksRef.current.onRemoveSkill?.(oldToken.id);
        for (const token of currentTokens) {
            if (token.type !== "skill" || previousTokens.some((oldToken) => oldToken.type === "skill" && oldToken.id === token.id)) continue;
            const skill = skillById.get(token.id);
            if (skill) callbacksRef.current.onSelectSkill?.(skill);
        }
        previousTokensRef.current = currentTokens;
        callbacksRef.current.onTokenSnapshotChange?.(tokenSnapshots(instance.state.doc));
        emitMention(instance);
    };

    const editor = useEditor({
        immediatelyRender: false,
        extensions: [StarterKit.configure({ heading: false, blockquote: false, bulletList: false, orderedList: false, codeBlock: false, horizontalRule: false, listItem: false }), ReferenceTokenNode, SkillTokenNode, CameraMotionTokenNode],
        content: parseValue(value, highlightLabels ? references : [], highlightLabels ? inlineTokens : [], skills, selectedSkillIds, tokenSnapshot),
        editorProps: {
            handleDOMEvents: {
                compositionstart: () => {
                    composingRef.current = true;
                    setMention(null);
                    return false;
                },
                compositionend: () => {
                    requestAnimationFrame(() => {
                        composingRef.current = false;
                        const instance = editorRef.current;
                        if (instance && !instance.isDestroyed) publishEditorChange(instance);
                        setCompositionRevision((revision) => revision + 1);
                    });
                    return false;
                },
            },
            attributes: {
                class: `canvas-resource-editor-content cursor-text ${className || ""}`,
                role: "textbox",
                "aria-multiline": "true",
                ...(props["aria-label"] ? { "aria-label": props["aria-label"] } : { "aria-label": "提示词编辑器" }),
                ...((props as Record<string, unknown>)["data-testid"] ? { "data-testid": String((props as Record<string, unknown>)["data-testid"]) } : {}),
                style: `cursor:text!important;${styleToString(style) || ""}`,
            },
            handleKeyDown: (_view, event) => {
                if (composingRef.current || event.isComposing || event.keyCode === 229) return false;
                if (mention && candidatesRef.current.length) {
                    const handled = handleMentionNavigation(event, candidatesRef.current, activeIndex, setActiveIndex, selectCandidateRef.current, () => setMention(null));
                    if (handled) return true;
                }
                if (event.key === "Escape" && mention) {
                    event.preventDefault();
                    setMention(null);
                    return true;
                }
                if (event.key === "Enter" && !event.isComposing) {
                    if (submitOnModEnterOnly) {
                        if ((event.metaKey || event.ctrlKey) && callbacksRef.current.onSubmit) {
                            event.preventDefault();
                            callbacksRef.current.onSubmit();
                            return true;
                        }
                        event.preventDefault();
                        if (event.shiftKey) {
                            if (!editor?.commands.setHardBreak()) {
                                if (!editor?.commands.splitBlock()) {
                                    editor?.commands.insertContent("\n");
                                }
                            }
                        } else if (!editor?.commands.splitBlock()) {
                            if (!editor?.commands.setHardBreak()) {
                                editor?.commands.insertContent("\n");
                            }
                        }
                        return true;
                    }
                    if (!event.shiftKey && callbacksRef.current.onSubmit) {
                        event.preventDefault();
                        callbacksRef.current.onSubmit();
                        return true;
                    }
                    if (event.shiftKey) {
                        event.preventDefault();
                        if (!editor?.commands.setHardBreak()) {
                            if (!editor?.commands.splitBlock()) {
                                editor?.commands.insertContent("\n");
                            }
                        }
                        return true;
                    }
                }
                callbacksRef.current.onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
                return false;
            },
        },
        onCreate: ({ editor: instance }) => {
            setReady(true);
            lastValueRef.current = serializeCanvasPromptDocument(instance.state.doc);
            previousTokensRef.current = tokenEntries(instance.state.doc).map(({ token }) => token);
            callbacksRef.current.onTokenSnapshotChange?.(tokenSnapshots(instance.state.doc));
        },
        onUpdate: ({ editor: instance }) => {
            if (!composingRef.current) publishEditorChange(instance);
        },
        onSelectionUpdate: ({ editor: instance }) => {
            if (!composingRef.current) emitMention(instance);
        },
    });
    editorRef.current = editor;

    const candidates = useMemo<(CanvasResourceReference | AgentSkillSummary)[]>(() => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        if (mention.type === "mention") {
            const list = activeReferences.length ? activeReferences : references;
            return query ? list.filter((item) => `${item.label} ${item.title} ${item.kind} ${item.text || ""}`.toLowerCase().includes(query)) : list;
        }
        return query ? skills.filter((skill) => `${skill.name} ${skill.description || ""}`.toLowerCase().includes(query)) : skills;
    }, [activeReferences, mention, references, skills]);
    const candidatesRef = useRef(candidates);
    const selectCandidateRef = useRef<(item: CanvasResourceReference | AgentSkillSummary) => void>(() => undefined);
    candidatesRef.current = candidates;

    const createHandle = useCallback(
        (instance: NonNullable<typeof editor> | null): CanvasPromptEditorHandle => ({
            focus: () => instance?.commands.focus(),
            focusAt: (offset) => {
                if (!instance) return;
                instance.commands.focus();
                instance.commands.setTextSelection(positionAtPlainOffset(instance.state.doc, offset));
            },
            getSelectionOffset: () => (instance ? plainOffsetAtPosition(instance.state.doc, instance.state.selection.from) : 0),
            insertTextAt: (start, end, text) => {
                if (!instance) return;
                instance
                    .chain()
                    .focus()
                    .setTextSelection({ from: positionAtPlainOffset(instance.state.doc, start), to: positionAtPlainOffset(instance.state.doc, end) })
                    .insertContent(text)
                    .run();
            },
            insertReference: (reference, start, end) => {
                if (!instance) return;
                const selectionStart = typeof start === "number" ? start : plainOffsetAtPosition(instance.state.doc, instance.state.selection.from);
                const selectionEnd = typeof end === "number" ? end : selectionStart;
                instance
                    .chain()
                    .focus()
                    .setTextSelection({ from: positionAtPlainOffset(instance.state.doc, selectionStart), to: positionAtPlainOffset(instance.state.doc, selectionEnd) })
                    .insertContent([
                        { type: REFERENCE_TOKEN_NAME, attrs: referenceAttrs(reference) },
                        { type: "text", text: " " },
                    ])
                    .run();
            },
            insertSkill: (skill, start, end) => {
                if (!instance) return;
                const selectionStart = typeof start === "number" ? start : plainOffsetAtPosition(instance.state.doc, instance.state.selection.from);
                const selectionEnd = typeof end === "number" ? end : selectionStart;
                instance
                    .chain()
                    .focus()
                    .setTextSelection({ from: positionAtPlainOffset(instance.state.doc, selectionStart), to: positionAtPlainOffset(instance.state.doc, selectionEnd) })
                    .insertContent([
                        { type: SKILL_TOKEN_NAME, attrs: { id: skill.id, label: skill.name } },
                        { type: "text", text: " " },
                    ])
                    .run();
            },
            removeToken: (type, id) => {
                if (!instance) return false;
                const entry = tokenEntries(instance.state.doc).find(({ token }) => token.type === type && "id" in token && token.id === id);
                if (!entry) return false;
                instance.chain().focus().deleteRange({ from: entry.pos, to: entry.end }).run();
                return true;
            },
            clear: () => instance?.commands.clearContent(true),
        }),
        [],
    );

    const exposeHandle = useCallback(() => {
        if (!hostRef.current || !editor) return;
        const handle = createHandle(editor);
        if (typeof forwardedRef === "function") forwardedRef(handle);
        else if (forwardedRef) forwardedRef.current = handle;
    }, [createHandle, editor, forwardedRef]);

    useLayoutEffect(() => {
        exposeHandle();
        return () => {
            if (typeof forwardedRef === "function") forwardedRef(null);
            else if (forwardedRef) forwardedRef.current = null;
        };
    }, [editor, exposeHandle, forwardedRef, ready]);

    useEffect(() => {
        if (!editor || editor.isDestroyed || composingRef.current) return;
        const currentTokens = tokenEntries(editor.state.doc).map(({ token }) => token);
        const currentSnapshotKey = JSON.stringify(tokenSnapshots(editor.state.doc));
        const requestedSnapshotKey = JSON.stringify(tokenSnapshot);
        const currentSkillIds = currentTokens.filter((token): token is Extract<CanvasPromptToken, { type: "skill" }> => token.type === "skill").map((token) => token.id);
        const selectedSkillsMatch = currentSkillIds.every((id) => selectedSkillIds.includes(id)) && selectedSkillIds.every((id) => currentSkillIds.includes(id));
        const referenceMarkers = highlightLabels ? activeReferences : [];
        const referencesMatch = referenceMarkers.every((reference) => {
            const marker = referenceMentionLabel(reference.label);
            return !value.includes(marker) || currentTokens.some((token) => token.type === "reference" && token.id === reference.id);
        });
        const cameraMarkersMatch = (highlightLabels ? inlineTokens : []).every((inlineToken) => {
            return !value.includes(inlineToken.token) || currentTokens.some((token) => token.type === "camera-motion" && token.token === inlineToken.token);
        });
        const tokenStateMatches = selectedSkillsMatch && referencesMatch && cameraMarkersMatch;
        const skillLabelsMatch = currentTokens.every((token) => token.type !== "skill" || !skillById.has(token.id) || token.label === skillById.get(token.id)?.name);
        if (lastValueRef.current === value && tokenStateMatches && skillLabelsMatch && currentSnapshotKey === requestedSnapshotKey) return;
        const preservedSkills = currentTokens.filter((token): token is Extract<CanvasPromptToken, { type: "skill" }> => token.type === "skill" && selectedSkillIds.includes(token.id));
        editor.commands.setContent(parseValue(value, highlightLabels ? references : [], highlightLabels ? inlineTokens : [], skills, selectedSkillIds, tokenSnapshot, preservedSkills), { emitUpdate: false });
        lastValueRef.current = value;
        previousTokensRef.current = tokenEntries(editor.state.doc).map(({ token }) => token);
        callbacksRef.current.onTokenSnapshotChange?.(tokenSnapshots(editor.state.doc));
    }, [activeReferences, compositionRevision, editor, highlightLabels, inlineTokens, references, selectedSkillIds, skillById, skills, tokenSnapshot, value]);

    useEffect(() => {
        if (!editor || !autoFocus) return;
        requestAnimationFrame(() => editor.commands.focus("end"));
    }, [autoFocus, editor]);

    const selectCandidate = (item: CanvasResourceReference | AgentSkillSummary) => {
        if (!editor || !mention) return;
        const documentValue = serializeCanvasPromptDocument(editor.state.doc);
        const cursor = plainOffsetAtPosition(editor.state.doc, editor.state.selection.from);
        if (mention.type === "mention") {
            const match = findResourceMentionAtCursor(documentValue, cursor);
            const ref = item as CanvasResourceReference;
            createHandle(editor).insertReference(ref, match?.start ?? cursor, cursor);
            if (!ref.active && callbacksRef.current.onConnectReference) {
                callbacksRef.current.onConnectReference(ref.nodeId);
            }
        } else {
            const match = /(?:^|\s)\/([^\s/]*)$/u.exec(documentValue.slice(0, cursor));
            const start = match ? cursor - match[0].length + match[0].lastIndexOf("/") : cursor;
            createHandle(editor).insertSkill(item as AgentSkillSummary, start, cursor);
        }
        setMention(null);
    };
    selectCandidateRef.current = selectCandidate;

    if (!editor) return <div className={`relative cursor-text ${containerClassName || ""}`} style={{ cursor: "text", ...style }} data-ready="false" />;
    return (
        <div ref={hostRef} className={`relative cursor-text ${containerClassName || ""}`} style={{ cursor: "text", ...style }}>
            <EditorContent
                editor={editor}
                className="size-full min-h-0 cursor-text"
                style={{ cursor: "text" }}
                onBlur={props.onBlur ? (event) => props.onBlur?.(event as unknown as FocusEvent<HTMLTextAreaElement>) : undefined}
                onFocus={props.onFocus ? (event) => props.onFocus?.(event as unknown as FocusEvent<HTMLTextAreaElement>) : undefined}
                onMouseDown={(event) => {
                    props.onMouseDown?.(event as unknown as MouseEvent<HTMLTextAreaElement>);
                    event.stopPropagation();
                }}
                onPointerDown={(event) => {
                    props.onPointerDown?.(event as unknown as PointerEvent<HTMLTextAreaElement>);
                    event.stopPropagation();
                }}
                data-ready={ready ? "true" : "false"}
            />
            {editor.isEmpty && placeholder ? <span className="pointer-events-none absolute left-0 top-0 px-1 py-1 text-sm opacity-45">{placeholder}</span> : null}
            {mention ? (
                <MentionPortal
                    editorElement={hostRef.current?.querySelector<HTMLElement>('[contenteditable="true"]') || null}
                    candidates={candidates}
                    allReferences={references}
                    activeIndex={activeIndex}
                    type={mention.type}
                    query={mention.query}
                    theme={theme}
                    onSelect={selectCandidate}
                />
            ) : null}
        </div>
    );
});

const REFERENCE_CATEGORIES = [
    { key: "subject", label: "主体", icon: "user" },
    { key: "image", label: "图片", icon: "image" },
    { key: "video", label: "视频", icon: "video" },
    { key: "audio", label: "音频", icon: "audio" },
] as const;

type ReferenceCategoryKey = (typeof REFERENCE_CATEGORIES)[number]["key"];

function getCategoryReferences(category: ReferenceCategoryKey, references: CanvasResourceReference[]) {
    const unconnected = references.filter((ref) => !ref.active);
    if (category === "subject") {
        const subjects = unconnected.filter(isSubjectReference);
        return subjects.length > 0 ? subjects : unconnected.filter((ref) => ref.kind === "image");
    }
    if (category === "image") {
        return unconnected.filter((ref) => ref.kind === "image");
    }
    if (category === "video") {
        return unconnected.filter((ref) => ref.kind === "video");
    }
    if (category === "audio") {
        return unconnected.filter((ref) => ref.kind === "audio");
    }
    return [];
}

function MentionPortal({
    editorElement,
    candidates,
    allReferences,
    activeIndex,
    type,
    query = "",
    theme,
    onSelect,
}: {
    editorElement: HTMLElement | null;
    candidates: (CanvasResourceReference | AgentSkillSummary)[];
    allReferences: CanvasResourceReference[];
    activeIndex: number;
    type: "mention" | "slash";
    query?: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onSelect: (item: CanvasResourceReference | AgentSkillSummary) => void;
}) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
    const [activeCategory, setActiveCategory] = useState<ReferenceCategoryKey | null>(null);
    const [categoryRect, setCategoryRect] = useState<DOMRect | null>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const updatePosition = useCallback(() => {
        if (!editorElement || !menuRef.current || typeof window === "undefined") return;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const caret = range?.getBoundingClientRect();
        const editorRect = editorElement.getBoundingClientRect();
        const anchor =
            caret && (caret.width || caret.height)
                ? { left: caret.left, top: caret.top, right: caret.right, bottom: caret.bottom }
                : { left: editorRect.left + 8, top: editorRect.top + 8, right: editorRect.left + 8, bottom: editorRect.top + 28 };
        const boundary = { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
        const menuRect = menuRef.current.getBoundingClientRect();
        setPosition(resolveMentionMenuPosition({ anchor, boundary, menuWidth: menuRect.width || 280, menuHeight: menuRect.height || 260 }));
    }, [editorElement]);

    useLayoutEffect(() => {
        updatePosition();
        const frame = requestAnimationFrame(updatePosition);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [updatePosition]);

    useEffect(() => {
        return () => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        };
    }, []);

    if (!editorElement || typeof window === "undefined") return null;
    const stop = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    const handleCategoryMouseEnter = (key: ReferenceCategoryKey, rect: DOMRect) => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
        setActiveCategory(key);
        setCategoryRect(rect);
    };

    const handleMenuMouseLeave = () => {
        closeTimerRef.current = setTimeout(() => {
            setActiveCategory(null);
        }, 250);
    };

    const handleFlyoutMouseEnter = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    };

    const handleFlyoutMouseLeave = () => {
        closeTimerRef.current = setTimeout(() => {
            setActiveCategory(null);
        }, 250);
    };

    const isMention = type === "mention";
    const hasQuery = Boolean(query.trim());

    const menuWidth = menuRef.current?.getBoundingClientRect().width || 280;
    const flyoutWidth = 260;
    let flyoutLeft = (position?.left ?? 0) + menuWidth + 6;
    let flyoutTop = categoryRect ? categoryRect.top : (position?.top ?? 0);

    if (typeof window !== "undefined") {
        if (flyoutLeft + flyoutWidth > window.innerWidth - 12) {
            flyoutLeft = Math.max(12, (position?.left ?? 0) - flyoutWidth - 6);
        }
        const maxTop = window.innerHeight - 340;
        if (flyoutTop > maxTop) {
            flyoutTop = Math.max(12, maxTop);
        }
    }

    const categoryReferences = activeCategory ? getCategoryReferences(activeCategory, allReferences) : [];
    const connectedReferences = allReferences.filter((ref) => ref.active);

    return createPortal(
        <>
            <div
                ref={menuRef}
                data-canvas-resource-mention-menu="true"
                className="thin-scrollbar fixed z-[2500] max-h-[360px] w-72 overflow-y-auto rounded-xl border p-1.5 shadow-2xl backdrop-blur-md"
                style={{
                    left: position?.left ?? 0,
                    top: position?.top ?? 0,
                    visibility: position ? "visible" : "hidden",
                    background: theme.toolbar.panel,
                    borderColor: theme.toolbar.border,
                    color: theme.node.text,
                }}
                onPointerDown={stop}
                onMouseDown={stop}
                onClick={(event) => event.stopPropagation()}
                onMouseLeave={handleMenuMouseLeave}
            >
                {isMention ? (
                    <>
                        {hasQuery ? (
                            <>
                                <div className="mb-1 flex items-center justify-between border-b px-2 py-1 text-[11px] font-semibold opacity-60" style={{ borderColor: `${theme.toolbar.border}66` }}>
                                    <span>搜索素材</span>
                                    <span className="text-[10px] font-normal opacity-60">共 {candidates.length} 个</span>
                                </div>
                                {candidates.length === 0 ? (
                                    <div className="px-3 py-3 text-xs opacity-50">未找到匹配的素材</div>
                                ) : (
                                    candidates.map((item, index) => {
                                        const reference = item as CanvasResourceReference;
                                        return (
                                            <button
                                                key={reference.id}
                                                type="button"
                                                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                                                style={{
                                                    background: index === activeIndex ? theme.toolbar.activeBg : "transparent",
                                                    color: index === activeIndex ? theme.toolbar.activeText : theme.node.text,
                                                }}
                                                onPointerDown={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    onSelect(reference);
                                                }}
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    onSelect(reference);
                                                }}
                                            >
                                                <div className="size-7 shrink-0 overflow-hidden rounded-md bg-black/10">
                                                    <ReferencePreview reference={reference} fit="cover" />
                                                </div>
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex items-center gap-1.5 font-medium">
                                                        <span className="truncate">{reference.label}</span>
                                                        {!reference.active ? (
                                                            <span className="rounded bg-black/5 px-1 py-0.2 text-[9px] opacity-60 dark:bg-white/10">未连线</span>
                                                        ) : null}
                                                    </span>
                                                    <span className="block truncate text-[10px] opacity-65">{reference.text || reference.title}</span>
                                                </span>
                                            </button>
                                        );
                                    })
                                )}
                            </>
                        ) : (
                            <>
                                {/* 顶部：已连接素材 (可能@的内容) */}
                                <div className="mb-1 px-2 pt-1 pb-0.5 text-[11px] font-medium opacity-50" style={{ color: theme.node.muted }}>
                                    可能@的内容
                                </div>
                                {connectedReferences.length === 0 ? (
                                    <div className="px-3 py-2 text-xs opacity-40">暂无已连接的素材节点</div>
                                ) : (
                                    connectedReferences.map((reference, index) => (
                                        <button
                                            key={reference.id}
                                            type="button"
                                            className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
                                            style={{
                                                background: index === activeIndex ? theme.toolbar.activeBg : "transparent",
                                                color: index === activeIndex ? theme.toolbar.activeText : theme.node.text,
                                            }}
                                            onPointerDown={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                onSelect(reference);
                                            }}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                onSelect(reference);
                                            }}
                                        >
                                            <div className="size-7 shrink-0 overflow-hidden rounded-md bg-black/10">
                                                <ReferencePreview reference={reference} fit="cover" />
                                            </div>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate font-medium">{reference.label}</span>
                                                {reference.title && reference.title !== reference.label ? (
                                                    <span className="block truncate text-[10px] opacity-60">{reference.title}</span>
                                                ) : null}
                                            </span>
                                        </button>
                                    ))
                                )}

                                {/* 分割线 */}
                                <div className="my-1.5 border-t" style={{ borderColor: `${theme.toolbar.border}66` }} />

                                {/* 底部：分类导航 (添加参考) */}
                                <div className="mb-1 px-2 pt-0.5 pb-0.5 text-[11px] font-medium opacity-50" style={{ color: theme.node.muted }}>
                                    添加参考
                                </div>
                                {REFERENCE_CATEGORIES.map((cat) => {
                                    const isHovered = activeCategory === cat.key;
                                    return (
                                        <button
                                            key={cat.key}
                                            type="button"
                                            className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
                                            style={{
                                                background: isHovered ? theme.toolbar.activeBg : "transparent",
                                                color: isHovered ? theme.toolbar.activeText : theme.node.text,
                                            }}
                                            onMouseEnter={(event) => {
                                                handleCategoryMouseEnter(cat.key, event.currentTarget.getBoundingClientRect());
                                            }}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                handleCategoryMouseEnter(cat.key, event.currentTarget.getBoundingClientRect());
                                            }}
                                        >
                                            <span className="grid size-5 shrink-0 place-items-center rounded text-current opacity-80">
                                                {cat.icon === "user" ? (
                                                    <User className="size-3.5" />
                                                ) : cat.icon === "image" ? (
                                                    <ImageIcon className="size-3.5" />
                                                ) : cat.icon === "video" ? (
                                                    <Video className="size-3.5" />
                                                ) : (
                                                    <Volume2 className="size-3.5" />
                                                )}
                                            </span>
                                            <span className="flex-1 font-medium">{cat.label}</span>
                                            <ChevronRight className="size-3.5 opacity-40" />
                                        </button>
                                    );
                                })}
                            </>
                        )}
                    </>
                ) : (
                    <>
                        <div className="mb-1 flex items-center gap-1 border-b px-2 py-1 text-[11px] font-semibold opacity-50" style={{ borderColor: theme.toolbar.border }}>
                            选择引用 Skill 技能 (/)
                        </div>
                        {candidates.length === 0 ? (
                            <div className="px-3 py-2 text-xs opacity-50">暂无匹配的 Skill</div>
                        ) : (
                            candidates.map((item, index) => {
                                const skill = item as AgentSkillSummary;
                                return (
                                    <button
                                        key={skill.id}
                                        type="button"
                                        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                                        style={{
                                            background: index === activeIndex ? theme.toolbar.activeBg : "transparent",
                                            color: index === activeIndex ? theme.toolbar.activeText : theme.node.text,
                                        }}
                                        onPointerDown={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onSelect(item);
                                        }}
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onSelect(item);
                                        }}
                                    >
                                        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#5b5ce2]/10 text-[#5b5ce2]">
                                            <Sparkles className="size-4" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block font-medium text-[#5b5ce2]">{skill.name}</span>
                                            <span className="block truncate text-[11px] opacity-65">{skill.description || skill.id}</span>
                                        </span>
                                    </button>
                                );
                            })
                        )}
                    </>
                )}
            </div>

            {/* 二级悬浮子菜单 (Image 3: 未连接素材列表) */}
            {activeCategory && isMention && !hasQuery ? (
                <div
                    className="thin-scrollbar fixed z-[2501] max-h-[320px] w-64 overflow-y-auto rounded-xl border p-1.5 shadow-2xl backdrop-blur-md"
                    style={{
                        left: flyoutLeft,
                        top: flyoutTop,
                        background: theme.toolbar.panel,
                        borderColor: theme.toolbar.border,
                        color: theme.node.text,
                    }}
                    onPointerDown={stop}
                    onMouseDown={stop}
                    onClick={(event) => event.stopPropagation()}
                    onMouseEnter={handleFlyoutMouseEnter}
                    onMouseLeave={handleFlyoutMouseLeave}
                >
                    <div className="mb-1 flex items-center justify-between border-b px-2 py-1 text-[11px] font-semibold opacity-60" style={{ borderColor: `${theme.toolbar.border}66` }}>
                        <span>未连接{REFERENCE_CATEGORIES.find((c) => c.key === activeCategory)?.label}</span>
                        <span className="text-[10px] font-normal opacity-60">点击连入当前节点</span>
                    </div>
                    {categoryReferences.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs opacity-50">画布中暂无此类未连接素材</div>
                    ) : (
                        categoryReferences.map((ref) => (
                            <button
                                key={ref.id}
                                type="button"
                                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
                                style={{ color: theme.node.text }}
                                onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onSelect(ref);
                                }}
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onSelect(ref);
                                }}
                            >
                                <div className="size-8 shrink-0 overflow-hidden rounded-md bg-black/10">
                                    <ReferencePreview reference={ref} fit="cover" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{ref.title || ref.label}</div>
                                    <div className="truncate text-[10px] opacity-60">{ref.label}</div>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            ) : null}
        </>,
        document.body,
    );
}

function ReferencePreview({ reference, fit = "cover" }: { reference: CanvasResourceReference; fit?: "cover" | "contain" }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={imagePreviewUrl(reference.previewUrl, 96)} alt="" className={`size-full rounded-md ${fit === "cover" ? "object-cover" : "object-contain"}`} />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} muted playsInline preload="metadata" className={`size-full rounded-md bg-black ${fit === "cover" ? "object-cover" : "object-contain"}`} />;
    const iconName = reference.kind === "audio" ? "audio" : reference.kind === "video" ? "video" : reference.kind === "image" ? "image" : "document";
    return (
        <span className="grid size-full place-items-center rounded-md bg-black/10">
            <DreamyoIcon name={iconName} size={16} />
        </span>
    );
}
