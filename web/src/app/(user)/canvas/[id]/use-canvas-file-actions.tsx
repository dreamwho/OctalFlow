"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect } from "react";

import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { uploadMediaFile } from "@/services/file-storage";
import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";
import { fitCanvasImageNodeSize, fitNodeSize } from "../utils/canvas-node-size";
import { CANVAS_NODE_GAP } from "../utils/canvas-surface-geometry";

import { CANVAS_DROP_NODE_OFFSET, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS, VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH, createCanvasNode } from "./canvas-page-elements";
import { audioMetadata, imageMetadata, uploadCanvasImage, videoMetadata } from "./canvas-page-utils";

import type { CanvasInteractions } from "./use-canvas-interactions";
import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasFileActions({ state, interactions }: { state: CanvasPageState; interactions: CanvasInteractions }) {
    const {
        message,
        setNodes,
        size,
        setSelectedNodeIds,
        selectedConnectionId,
        setSelectedConnectionId,
        setHoveredNodeId,
        setPendingConnectionCreate,
        setContextMenu,
        setToolbarNodeId,
        setDialogNodeId,
        setEditingNodeId,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        nodesRef,
        selectedNodeIdsRef,
    } = state;
    const { getCanvasCenter, deleteNodes, deleteConnection, copySelectedNodes, pasteCopiedNodes, undoCanvas, redoCanvas } = interactions;

    const patchUploadNode = useCallback(
        (id: string, updater: (node: CanvasNodeData) => CanvasNodeData | null) => {
            setNodes((prev) => prev.flatMap((node) => {
                if (node.id !== id) return [node];
                const next = updater(node);
                return next ? [next] : [];
            }));
        },
        [setNodes],
    );

    const runUploadNode = useCallback(
        <T,>(id: string, blobUrl: string | null, task: (onProgress: (percent: number) => void) => Promise<T>, finalize: (node: CanvasNodeData, result: T) => CanvasNodeData, failureMessage: string) => {
            void task((percent) => patchUploadNode(id, (node) => ({ ...node, metadata: { ...node.metadata, uploadProgress: percent } })))
                .then((result) => {
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    patchUploadNode(id, (node) => finalize(node, result));
                })
                .catch((error) => {
                    // 上传失败时移除乐观节点，行为与旧的“上传成功才建节点”保持一致，并给出明确提示。
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    patchUploadNode(id, () => null);
                    message.error(error instanceof Error && error.message ? `${failureMessage}：${error.message}` : failureMessage);
                });
        },
        [message, patchUploadNode],
    );

    const createImageFileNode = useCallback(async (file: File, position: Position, preserveSelection = false, openDialog = true) => {
        const draft = createCanvasNode(CanvasNodeType.Image, position);
        const id = draft.id;
        const blobUrl = URL.createObjectURL(file);
        const newNode: CanvasNodeData = {
            ...draft,
            title: file.name || "图片上传",
            metadata: {
                ...draft.metadata,
                content: blobUrl,
                status: NODE_STATUS_LOADING,
                uploading: true,
                uploadProgress: 0,
                uploadKind: "image",
            },
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
        setSelectedConnectionId(null);
        if (openDialog) setDialogNodeId(id);
        runUploadNode(
            id,
            blobUrl,
            (onProgress) => uploadCanvasImage(file, { onProgress }),
            (node, image) => {
                const size = fitCanvasImageNodeSize(image.width, image.height);
                return {
                    ...node,
                    title: node.title || file.name || "图片上传",
                    width: size.width,
                    height: size.height,
                    metadata: imageMetadata(image),
                };
            },
            "图片上传失败",
        );
        return id;
    }, [runUploadNode]);

    const createVideoFileNode = useCallback(async (file: File, position: Position, preserveSelection = false, openDialog = true) => {
        const draft = createCanvasNode(CanvasNodeType.Video, position);
        const id = draft.id;
        const blobUrl = URL.createObjectURL(file);
        setNodes((prev) => [
            ...prev,
            {
                ...draft,
                title: file.name || "视频上传",
                metadata: {
                    ...draft.metadata,
                    content: blobUrl,
                    status: NODE_STATUS_LOADING,
                    uploading: true,
                    uploadProgress: 0,
                    uploadKind: "video",
                },
            },
        ]);
        setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
        setSelectedConnectionId(null);
        if (openDialog) setDialogNodeId(id);
        runUploadNode(
            id,
            blobUrl,
            (onProgress) => uploadMediaFile(file, "video", { onProgress }),
            (node, video) => {
                const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                return {
                    ...node,
                    title: node.title || file.name || "视频上传",
                    width: size.width,
                    height: size.height,
                    metadata: videoMetadata(video),
                };
            },
            "视频上传失败",
        );
        return id;
    }, [runUploadNode]);

    const createAudioFileNode = useCallback(async (file: File, position: Position, preserveSelection = false) => {
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${nanoid()}`;
        const blobUrl = URL.createObjectURL(file);
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name || "音频上传",
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: { content: blobUrl, status: NODE_STATUS_LOADING, uploading: true, uploadProgress: 0, uploadKind: "audio" as const },
            },
        ]);
        setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
        setSelectedConnectionId(null);
        runUploadNode(
            id,
            blobUrl,
            (onProgress) => uploadMediaFile(file, "audio", { onProgress }),
            (node, audio) => ({ ...node, title: node.title || file.name || "音频上传", metadata: audioMetadata(audio) }),
            "音频上传失败",
        );
        return id;
    }, [runUploadNode]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom]")) return;
            if (!event.clipboardData) return;
            const images = clipboardImageFiles(event.clipboardData);
            if (images.length) {
                event.preventDefault();
                setSelectedNodeIds(new Set());
                const center = getCanvasCenter();
                const cols = images.length <= 4 && images.length !== 3 ? 2 : 3;
                const itemWidth = 340;
                const itemHeight = 240;
                const creations = images.map((file, index) => {
                    const col = index % cols;
                    const row = Math.floor(index / cols);
                    const pos = images.length > 1
                        ? { x: center.x + col * (itemWidth + CANVAS_NODE_GAP), y: center.y + row * (itemHeight + CANVAS_NODE_GAP) }
                        : center;
                    return createImageFileNode(file, pos, true, false);
                });
                void Promise.allSettled(creations).then((results) => {
                    const createdIds = results
                        .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && typeof r.value === "string")
                        .map((r) => r.value);
                    if (createdIds.length) {
                        setSelectedNodeIds(new Set(createdIds));
                    }
                    const failures = results.filter((result) => result.status === "rejected");
                    if (failures.length) message.error(failures.length === images.length ? "剪切板图片添加失败" : `有 ${failures.length} 张剪切板图片添加失败`);
                    if (failures.length < images.length) message.success(`已从剪切板添加 ${images.length - failures.length} 张图片`);
                });
                return;
            }
            const text = event.clipboardData?.getData("text/plain") || "";
            if (!text.trim()) return;
            event.preventDefault();
            if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, setSelectedNodeIds]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                if (pasteCopiedNodes()) event.preventDefault();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, redoCanvas, selectedConnectionId, undoCanvas]);
    return {
        createImageFileNode,
        createVideoFileNode,
        createAudioFileNode,
        createTextNodeFromClipboard,
    };
}

export type CanvasFileActions = ReturnType<typeof useCanvasFileActions>;
