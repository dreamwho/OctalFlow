"use client";

import { saveAs } from "file-saver";
import { useCallback } from "react";

import { getDataUrlByteSize } from "@/lib/image-utils";
import { isGenerationTaskNeedsReviewError } from "@/services/api/generation-task-state";
import { type UploadedImage } from "@/services/image-storage";
import { defaultConfig } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { type CanvasImageAngleParams } from "../components/canvas-node-angle-dialog";
import { type CanvasImageCropRect } from "../components/canvas-node-crop-dialog";
import { type CanvasImageMaskEditPayload } from "../components/canvas-node-mask-edit-dialog";
import { type CanvasImageSplitParams } from "../components/canvas-node-split-dialog";
import { type CanvasImageUpscaleParams } from "../components/canvas-node-upscale-dialog";
import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasNodeData } from "../types";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "../utils/canvas-image-data";
import { fitCanvasImageNodeSize } from "../utils/canvas-node-size";
import { CANVAS_NODE_GAP, resolveCanvasNodePlacement } from "../utils/canvas-surface-geometry";
import { CHARACTER_THREE_VIEW_PROMPT, buildCharacterThreeViewGenerationConfig, createCharacterThreeViewNode, type CanvasCharacterThreeViewParams } from "../utils/canvas-storyboard";

import { IMAGE_PROMPT_REVERSE_PRESET, NODE_STATUS_ERROR, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS, createCanvasNode } from "./canvas-page-elements";
import { prepareCanvasNodeDownload } from "./canvas-node-download";
import { pauseCanvasGenerationReview } from "./canvas-generation-review";
import { applyNodeConfigPatch, buildAngleLabel, buildAnglePrompt, buildGenerationConfig, buildImageGenerationMetadata, canvasNodeReferenceImage, imageMetadata, isGenerationCanceled, uploadCanvasImage } from "./canvas-page-utils";

import type { CanvasInteractions } from "./use-canvas-interactions";
import type { CanvasPageState } from "./use-canvas-page-state";
import type { CanvasTaskRuntime } from "./use-canvas-task-runtime";

const DREAMINA_UPSCALE_MODEL = "dreamina-image-upscale";

function dreaminaUpscaleNodeSize(node: CanvasNodeData) {
    const sourceWidth = Math.max(1, node.metadata?.naturalWidth || node.width);
    const sourceHeight = Math.max(1, node.metadata?.naturalHeight || node.height);
    return fitCanvasImageNodeSize(sourceWidth, sourceHeight);
}

export function useCanvasNodeMediaActions({ state, tasks, interactions }: { state: CanvasPageState; tasks: CanvasTaskRuntime; interactions: CanvasInteractions }) {
    const {
        message,
        params,
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        addAsset,
        setNodes,
        setConnections,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setRunningNodeId,
        setDialogNodeId,
        setEditingNodeId,
        setEditRequestNonce,
        setCropNodeId,
        setMaskEditNodeId,
        setSplitNodeId,
        setUpscaleNodeId,
        setAngleNodeId,
        setStoryboardNodeId,
        setCollapsingBatchIds,
        setOpeningBatchIds,
        nodesRef,
    } = state;
    const { startGenerationRequest, finishGenerationRequest, startAndCompleteImageTask, startAndCompleteUpscaleTask } = tasks;

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback(async (node: CanvasNodeData) => {
        if ((!isCanvasImageNodeType(node.type) && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        try {
            const download = await prepareCanvasNodeDownload(node);
            saveAs(download.blob, download.fileName);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "媒体文件下载失败");
        }
    }, [message]);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                await addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                await addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: {
                        url: node.metadata.content,
                        storageKey: node.metadata.storageKey,
                        remoteUrl: node.metadata.remoteUrl,
                        serverUrl: node.metadata.serverUrl,
                        width: node.metadata.naturalWidth || node.width,
                        height: node.metadata.naturalHeight || node.height,
                        bytes: node.metadata.bytes || 0,
                        mimeType: node.metadata.mimeType || "video/mp4",
                    },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Audio) {
                if (!node.metadata?.content) return message.error("没有可保存的音频");
                await addAsset({
                    kind: "audio",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布音频",
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: {
                        url: node.metadata.content,
                        storageKey: node.metadata.storageKey,
                        remoteUrl: node.metadata.remoteUrl,
                        serverUrl: node.metadata.serverUrl,
                        durationMs: node.metadata.durationMs,
                        bytes: node.metadata.bytes || 0,
                        mimeType: node.metadata.mimeType || "audio/mpeg",
                    },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success("已加入我的素材");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            await addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    remoteUrl: node.metadata.remoteUrl,
                    serverUrl: node.metadata.serverUrl,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success("已加入我的素材");
        },
        [addAsset, message],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (!isCanvasImageNodeType(node.type) || !node.metadata?.content) {
                message.warning("图片节点为空，无法反推提示词");
                return;
            }

            const gap = CANVAS_NODE_GAP;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: IMAGE_PROMPT_REVERSE_PRESET, prompt: IMAGE_PROMPT_REVERSE_PRESET, status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: "反推提示词",
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: `参考图片：@[node:${node.id}]\n任务说明：@[node:${textNode.id}]`,
                    },
                ),
                title: "反推提示词配置",
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message],
    );

    const appendDerivedImageNode = useCallback((sourceNode: CanvasNodeData, image: UploadedImage, title: string, size: { width: number; height: number }, options: { connect?: boolean; openEditor?: boolean; inheritPrompt?: boolean } = {}) => {
        const childId = nanoid();
        const preferredPosition = { x: sourceNode.position.x + sourceNode.width + CANVAS_NODE_GAP, y: sourceNode.position.y };
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title,
            position: resolveCanvasNodePlacement(nodesRef.current, size, { x: sourceNode.position.x + sourceNode.width / 2, y: sourceNode.position.y + sourceNode.height / 2 }, preferredPosition),
            ...size,
            metadata: { ...imageMetadata(image), ...(options.inheritPrompt === false ? {} : { prompt: sourceNode.metadata?.prompt }) },
        };
        setNodes((prev) => [...prev, child]);
        if (options.connect !== false) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        if (options.openEditor !== false) setDialogNodeId(childId);
    }, []);

    const cropImageNode = useCallback(
        async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
            if (!node.metadata?.content) return;
            const cropped = await cropDataUrl(node.metadata.content, crop);
            const image = await uploadCanvasImage(cropped);
            appendDerivedImageNode(node, image, "Cropped Image", fitCanvasImageNodeSize(image.width, image.height));
            setCropNodeId(null);
        },
        [appendDerivedImageNode],
    );

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = CANVAS_NODE_GAP;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + CANVAS_NODE_GAP;
            const startY = node.position.y;
            const uploads = await Promise.allSettled(
                pieces.map(async (piece) => {
                    const image = await uploadCanvasImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: `${node.title || "图片"} ${piece.row + 1}-${piece.column + 1}`,
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            const childNodes = uploads.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
            const failedCount = uploads.length - childNodes.length;
            if (!childNodes.length) throw uploads.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason || new Error("图片切分结果保存失败");
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            setSplitNodeId(null);
            if (failedCount) message.warning(`已保留 ${childNodes.length} 个切分结果，${failedCount} 个保存失败`);
            else message.success(`已切分为 ${childNodes.length} 个子节点`);
        },
        [message],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = `只修改蒙版透明区域，其他区域保持不变。${userPrompt}`;
            const childId = nanoid();
            const source = canvasNodeReferenceImage(node);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || "局部编辑结果",
                    position: { x: node.position.x + node.width + CANVAS_NODE_GAP, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                await startAndCompleteImageTask(childId, generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, controller);
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "局部修改失败";
                const needsReview = isGenerationTaskNeedsReviewError(error);
                message.error(errorDetails);
                if (needsReview) {
                    setNodes((prev) => pauseCanvasGenerationReview(prev, [childId], errorDetails));
                    return;
                }
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, imageTask: undefined },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startAndCompleteImageTask, startGenerationRequest],
    );

    const upscaleImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
            if (!node.metadata?.content) return;
            if (params.engine === "dreamina-cli") {
                const resolutionType = params.resolutionType;
                const childId = nanoid();
                const source = canvasNodeReferenceImage(node);
                const generationConfig = { ...effectiveConfig, apiSource: "system" as const, model: DREAMINA_UPSCALE_MODEL, imageModel: DREAMINA_UPSCALE_MODEL };
                setUpscaleNodeId(null);
                setRunningNodeId(childId);
                setNodes((prev) => [
                    ...prev,
                    {
                        id: childId,
                        type: CanvasNodeType.Image,
                        title: "即梦 CLI 图片超清",
                        position: { x: node.position.x + node.width + CANVAS_NODE_GAP, y: node.position.y },
                        ...dreaminaUpscaleNodeSize(node),
                        metadata: {
                            status: NODE_STATUS_LOADING,
                            model: DREAMINA_UPSCALE_MODEL,
                            upscaleTask: { id: "", provider: "dreamina-cli", model: DREAMINA_UPSCALE_MODEL, resolutionType, sourceNodeId: node.id },
                        },
                    },
                ]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setSelectedConnectionId(null);
                setDialogNodeId(childId);
                const controller = startGenerationRequest(childId, node.id, childId);
                try {
                    await startAndCompleteUpscaleTask(childId, generationConfig, source, node.id, resolutionType, controller);
                } catch (error) {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "即梦 CLI 图片超清失败";
                    message.error(errorDetails);
                    if (isGenerationTaskNeedsReviewError(error)) {
                        setNodes((prev) => pauseCanvasGenerationReview(prev, [childId], errorDetails));
                        return;
                    }
                    setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, imageTask: undefined } } : item)));
                } finally {
                    finishGenerationRequest(childId, controller);
                    setRunningNodeId(null);
                }
                return;
            }
            const upscaled = await upscaleDataUrl(node.metadata.content, params);
            const image = await uploadCanvasImage(upscaled);
            const size = fitCanvasImageNodeSize(image.width, image.height);
            appendDerivedImageNode(node, image, "Upscaled Image", size);
            setUpscaleNodeId(null);
        },
        [
            appendDerivedImageNode,
            effectiveConfig,
            finishGenerationRequest,
            message,
            setConnections,
            setDialogNodeId,
            setNodes,
            setRunningNodeId,
            setSelectedConnectionId,
            setSelectedNodeIds,
            setUpscaleNodeId,
            startAndCompleteUpscaleTask,
            startGenerationRequest,
        ],
    );

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [canvasNodeReferenceImage(node)]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + CANVAS_NODE_GAP, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                await startAndCompleteImageTask(childId, generationConfig, prompt, [canvasNodeReferenceImage(node)], undefined, controller);
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                const needsReview = isGenerationTaskNeedsReviewError(error);
                if (needsReview) {
                    setNodes((prev) => pauseCanvasGenerationReview(prev, [childId], errorDetails));
                    return;
                }
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, imageTask: undefined },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startAndCompleteImageTask, startGenerationRequest],
    );

    const generateCharacterThreeViewNode = useCallback(
        async (node: CanvasNodeData, params: CanvasCharacterThreeViewParams) => {
            if (!isCanvasImageNodeType(node.type) || !node.metadata?.content?.trim()) return;
            const baseConfig = buildGenerationConfig(effectiveConfig, node, "image");
            const generationConfig = buildCharacterThreeViewGenerationConfig(baseConfig, params.model || baseConfig.model);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const source = canvasNodeReferenceImage(node);
            const created = createCharacterThreeViewNode({
                source: node,
                nodes: nodesRef.current,
                nodeId: childId,
                connectionId: nanoid(),
                metadata: {
                    prompt: CHARACTER_THREE_VIEW_PROMPT,
                    sourcePrompt: CHARACTER_THREE_VIEW_PROMPT,
                    executionPrompt: CHARACTER_THREE_VIEW_PROMPT,
                    status: NODE_STATUS_LOADING,
                    ...buildImageGenerationMetadata("edit", generationConfig, 1, [source]),
                },
            });
            setStoryboardNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [...prev, created.node]);
            setConnections((prev) => [...prev, created.connection]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                await startAndCompleteImageTask(childId, generationConfig, CHARACTER_THREE_VIEW_PROMPT, [source], undefined, controller, CHARACTER_THREE_VIEW_PROMPT);
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "人物三视图生成失败";
                const needsReview = isGenerationTaskNeedsReviewError(error);
                if (needsReview) {
                    setNodes((prev) => pauseCanvasGenerationReview(prev, [childId], errorDetails));
                    return;
                }
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, imageTask: undefined } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startAndCompleteImageTask, startGenerationRequest],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);
    return {
        toggleNodeFreeResize,
        handleNodeContentChange,
        toggleBatchExpanded,
        setBatchPrimary,
        openTextEditor,
        handleNodePromptChange,
        handleConfigNodeChange,
        downloadNodeImage,
        saveNodeAsset,
        createImageReversePromptNodes,
        appendDerivedImageNode,
        cropImageNode,
        splitImageNode,
        maskEditImageNode,
        upscaleImageNode,
        generateAngleNode,
        generateCharacterThreeViewNode,
        handleFontSizeChange,
    };
}

export type CanvasNodeMediaActions = ReturnType<typeof useCanvasNodeMediaActions>;
