"use client";

import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback } from "react";

import { droppedFiles, preventFileDragEvent } from "@/lib/file-drop";
import { readImageMeta } from "@/lib/image-utils";
import { uploadMediaFile } from "@/services/file-storage";
import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasAssistantSession, type Position } from "../types";
import { fitCanvasImageNodeSize, fitNodeSize } from "../utils/canvas-node-size";
import { PANORAMA_IMAGE_SIZE, isPanoramaRatio } from "../utils/canvas-panorama";
import { CANVAS_NODE_GAP } from "../utils/canvas-surface-geometry";

import { CANVAS_DROP_NODE_OFFSET, VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH } from "./canvas-page-elements";
import { audioMetadata, imageMetadata, isAudioFile, replaceCanvasNodeMediaMetadata, uploadCanvasImage, videoMetadata } from "./canvas-page-utils";

import type { CanvasInteractions } from "./use-canvas-interactions";
import type { CanvasPageState } from "./use-canvas-page-state";

import type { CanvasFileActions } from "./use-canvas-file-actions";

export function useCanvasMediaSessionActions({ state, interactions, files }: { state: CanvasPageState; interactions: CanvasInteractions; files: CanvasFileActions }) {
    const {
        message,
        projectId,
        containerRef,
        imageInputRef,
        uploadTargetRef,
        renameProject,
        currentProject,
        setNodes,
        setChatSessions,
        setActiveChatId,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setTitleEditing,
        titleDraft,
        setTitleDraft,
        nodesRef,
    } = state;
    const { screenToCanvas } = interactions;
    const { createImageFileNode, createVideoFileNode, createAudioFileNode } = files;

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const uploadReplacement = useCallback(async <T,>(nodeId: string, task: (onProgress: (percent: number) => void) => Promise<T>) => {
        const key = `canvas-replace-${nodeId}`;
        message.open({ key, type: "loading", content: "正在处理文件…", duration: 0 });
        try {
            return await task((percent) => message.open({ key, type: "loading", content: `上传素材 ${percent}%`, duration: 0 }));
        } finally {
            message.destroy(key);
        }
    }, [message]);

    const replaceAudioNodeFile = useCallback(
        async (nodeId: string, file: File) => {
            if (!isAudioFile(file)) throw new Error("请选择 MP3、WAV、M4A、AAC、FLAC 或 OGG 音频文件");
            const audio = await uploadReplacement(nodeId, (onProgress) => uploadMediaFile(file, "audio", { onProgress }));
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              type: CanvasNodeType.Audio,
                              title: file.name,
                              position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                              width: spec.width,
                              height: spec.height,
                              metadata: replaceCanvasNodeMediaMetadata(node.metadata, audioMetadata(audio)),
                          }
                        : node,
                ),
            );
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
        },
        [setNodes, setSelectedConnectionId, setSelectedNodeIds, uploadReplacement],
    );

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const rawFiles = event.target.files ? Array.from(event.target.files) : [];
            const target = uploadTargetRef.current;
            if (!rawFiles.length) return;

            try {
                if (target?.nodeId) {
                    const file = rawFiles[0];
                    if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !isAudioFile(file)) {
                        message.error("请选择图片、视频、MP3 或 WAV 文件");
                        return;
                    }
                    if (isAudioFile(file)) {
                        await replaceAudioNodeFile(target.nodeId, file);
                        return;
                    }
                    if (file.type.startsWith("video/")) {
                        const video = await uploadReplacement(target.nodeId, (onProgress) => uploadMediaFile(file, "video", { onProgress }));
                        const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === target.nodeId
                                    ? {
                                          ...node,
                                          type: CanvasNodeType.Video,
                                          title: file.name,
                                          position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                          width: nextSize.width,
                                          height: nextSize.height,
                                          metadata: replaceCanvasNodeMediaMetadata(node.metadata, videoMetadata(video)),
                                      }
                                    : node,
                            ),
                        );
                        setSelectedNodeIds(new Set([target.nodeId]));
                        setSelectedConnectionId(null);
                        setDialogNodeId(target.nodeId);
                        return;
                    }
                    const targetNode = nodesRef.current.find((node) => node.id === target.nodeId);
                    const isPanorama = targetNode?.type === CanvasNodeType.Panorama;
                    if (isPanorama) {
                        const objectUrl = URL.createObjectURL(file);
                        const dimensions = await readImageMeta(objectUrl).finally(() => URL.revokeObjectURL(objectUrl));
                        if (!isPanoramaRatio(dimensions.width, dimensions.height)) {
                            message.error("全景图必须接近 2:1 比例，例如 2048x1024");
                            return;
                        }
                    }
                    const image = await uploadReplacement(target.nodeId, (onProgress) => uploadCanvasImage(file, { onProgress }));
                    const imageSize = isPanorama ? NODE_DEFAULT_SIZE[CanvasNodeType.Panorama] : fitCanvasImageNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: isPanorama ? CanvasNodeType.Panorama : CanvasNodeType.Image,
                                      title: file.name,
                                      position: { x: node.position.x + node.width / 2 - imageSize.width / 2, y: node.position.y + node.height / 2 - imageSize.height / 2 },
                                      width: imageSize.width,
                                      height: imageSize.height,
                                      metadata: replaceCanvasNodeMediaMetadata(node.metadata, imageMetadata(image), isPanorama ? { size: PANORAMA_IMAGE_SIZE, panoramaProjection: "equirectangular" } : undefined),
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(target.nodeId);
                } else {
                    const validFiles = rawFiles.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f));
                    if (!validFiles.length) {
                        message.error("请选择图片、视频、MP3 或 WAV 文件");
                        return;
                    }
                    const basePosition = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                    if (validFiles.length === 1) {
                        const file = validFiles[0];
                        await (isAudioFile(file) ? createAudioFileNode(file, basePosition) : file.type.startsWith("video/") ? createVideoFileNode(file, basePosition) : createImageFileNode(file, basePosition));
                    } else {
                        const cols = validFiles.length <= 4 && validFiles.length !== 3 ? 2 : 3;
                        const itemWidth = 340;
                        const itemHeight = 240;
                        setSelectedNodeIds(new Set());
                        setSelectedConnectionId(null);
                        const creations = validFiles.map((file, index) => {
                            const col = index % cols;
                            const row = Math.floor(index / cols);
                            const nextPos = {
                                x: basePosition.x + col * (itemWidth + CANVAS_NODE_GAP),
                                y: basePosition.y + row * (itemHeight + CANVAS_NODE_GAP),
                            };
                            return isAudioFile(file) ? createAudioFileNode(file, nextPos, true) : file.type.startsWith("video/") ? createVideoFileNode(file, nextPos, true, false) : createImageFileNode(file, nextPos, true, false);
                        });
                        const results = await Promise.allSettled(creations);
                        const createdIds = results
                            .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && typeof r.value === "string")
                            .map((r) => r.value);
                        if (createdIds.length) {
                            setSelectedNodeIds(new Set(createdIds));
                        }
                    }
                }
            } catch (error) {
                message.error(error instanceof Error ? error.message : "文件添加失败，请稍后重试");
            } finally {
                uploadTargetRef.current = null;
                event.target.value = "";
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, message, nodesRef, replaceAudioNodeFile, screenToCanvas, size.height, size.width, uploadReplacement],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!preventFileDragEvent(event)) return;
            const files = droppedFiles(event, (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item));
            if (!files.length) return;

            const pos = screenToCanvas(event.clientX, event.clientY);
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            const cols = files.length <= 4 && files.length !== 3 ? 2 : 3;
            const itemWidth = 340;
            const itemHeight = 240;
            const creations = files.map((file, index) => {
                const col = index % cols;
                const row = Math.floor(index / cols);
                const nextPos = files.length > 1
                    ? { x: pos.x + col * (itemWidth + CANVAS_NODE_GAP), y: pos.y + row * (itemHeight + CANVAS_NODE_GAP) }
                    : pos;
                return isAudioFile(file) ? createAudioFileNode(file, nextPos, true) : file.type.startsWith("video/") ? createVideoFileNode(file, nextPos, true, false) : createImageFileNode(file, nextPos, true, false);
            });
            void Promise.allSettled(creations).then((results) => {
                const createdIds = results
                    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && typeof r.value === "string")
                    .map((r) => r.value);
                if (createdIds.length) {
                    setSelectedNodeIds(new Set(createdIds));
                }
                const failures = results.filter((result) => result.status === "rejected");
                if (failures.length) message.error(failures.length === files.length ? "文件添加失败" : `有 ${failures.length} 个文件添加失败`);
            });
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, message, screenToCanvas, setSelectedConnectionId, setSelectedNodeIds],
    );

    const pasteAssistantMedia = useCallback(
        async (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const isVideo = file.type.startsWith("video/");
            if (!isVideo && !file.type.startsWith("image/")) throw new Error("请选择图片或视频素材");
            const nodeId = await (isVideo ? createVideoFileNode(file, position, true, false) : createImageFileNode(file, position, true, false));
            message.success(`${isVideo ? "视频" : "图片"}已添加到本轮引用`);
            return nodeId;
        },
        [createImageFileNode, createVideoFileNode, message, screenToCanvas, size.height, size.width],
    );

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
    }, []);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);
    return {
        handleUploadRequest,
        replaceAudioNodeFile,
        handleImageInputChange,
        handleDrop,
        pasteAssistantMedia,
        handleAssistantSessionsChange,
        startTitleEditing,
        finishTitleEditing,
        preventCanvasContextMenu,
    };
}

export type CanvasMediaSessionActions = ReturnType<typeof useCanvasMediaSessionActions>;
