"use client";

import dynamic from "next/dynamic";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { Button, Input, Modal } from "antd";
import { Camera, Download } from "lucide-react";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { CanvasConfigComposer } from "../components/canvas-config-composer";
import { CanvasConfigNodePanel } from "../components/canvas-config-node-panel";
import { CanvasInteriorDesignDialog } from "../components/canvas-interior-design-dialog";
import { CanvasNodeContextMenu, canArrangeCanvasSelection } from "../components/canvas-context-menu";
import { CanvasAssetsPanel } from "../components/canvas-assets-panel";
import { CANVAS_AGENT_REFERENCE_LIMIT, CanvasSurface, type CanvasInteractionMode } from "../components/canvas-surface";
import { CanvasNodeAngleDialog } from "../components/canvas-node-angle-dialog";
import { CanvasNodeCropDialog } from "../components/canvas-node-crop-dialog";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "../components/canvas-node-hover-toolbar";
import { CanvasNodeMaskEditDialog } from "../components/canvas-node-mask-edit-dialog";
import { CanvasNodePromptPanel } from "../components/canvas-node-prompt-panel";
import { CanvasNodeSplitDialog } from "../components/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog } from "../components/canvas-node-upscale-dialog";
import { CanvasNodeUpscalePanel } from "../components/canvas-node-upscale-panel";
import { CanvasStoryboardDialog } from "../components/canvas-storyboard-dialog";
import { CanvasVideoFrameCaptureDialog } from "../components/canvas-video-frame-capture-dialog";
import { CanvasAudioUploadDialog } from "../components/canvas-audio-upload-dialog";
import { CanvasImageComparison } from "../components/canvas-image-comparison";
import { CanvasToolbar } from "../components/canvas-toolbar";
import { CanvasTopBar } from "../components/canvas-top-bar";
import { CanvasZoomControls } from "../components/canvas-zoom-controls";
import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasInteriorDesignSettings, type Position } from "../types";

const CanvasAssistantPanel = dynamic(() => import("../components/canvas-assistant-panel").then((mod) => mod.CanvasAssistantPanel), { ssr: false });
import { CanvasRefreshShell, ConnectionCreateMenu, NODE_STATUS_ERROR, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS, NodeCreateMenu, VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH } from "./canvas-page-elements";
import { getInputSummary, isDreaminaUpscaleImageNode, isHiddenBatchChild, resolveDreaminaUpscaleSourceNode } from "./canvas-page-utils";
import { analyzeCanvasVideo, extractCanvasVideoDepth, extractCanvasVideoFrames, type CanvasVideoFrameAsset } from "./canvas-video-frame-api";
import { videoStorageKey } from "./use-canvas-video-frame-extraction";
import { fitCanvasImageNodeSize, fitNodeSize } from "../utils/canvas-node-size";
import { CANVAS_NODE_GAP, resolveCanvasNodePlacement, resolveCanvasSelectionLayout } from "../utils/canvas-surface-geometry";
import { createInteriorDesignConfigNode, interiorDesignModels, interiorDesignNodePatch, isInteriorDesignNode } from "../utils/canvas-interior-design";

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <OctalaicanvasCanvasPage />;
}

import { useCanvasPageController } from "./use-canvas-page-controller";

function OctalaicanvasCanvasPage() {
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [interactionMode, setInteractionMode] = useState<CanvasInteractionMode>("pan");
    const [renameNodeId, setRenameNodeId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [agentReferencePicking, setAgentReferencePicking] = useState(false);
    const previewVideoRef = useRef<HTMLVideoElement | null>(null);
    const [capturingVideoFrame, setCapturingVideoFrame] = useState(false);
    const [captureFrameNodeId, setCaptureFrameNodeId] = useState<string | null>(null);
    const [depthSourceNodeIds, setDepthSourceNodeIds] = useState<Set<string>>(new Set());
    const [analysisSourceNodeIds, setAnalysisSourceNodeIds] = useState<Set<string>>(new Set());
    const [interiorDesignTarget, setInteriorDesignTarget] = useState<{ mode: "source" | "config"; nodeId: string } | null>(null);
    const [audioUploadNodeId, setAudioUploadNodeId] = useState<string | null>(null);
    const controller = useCanvasPageController();
    const {
        message,
        modal,
        params,
        router,
        projectId,
        containerRef,
        imageInputRef,
        uploadTargetRef,
        clipboardRef,
        historyRef,
        lastHistoryRef,
        historyCommitTimerRef,
        viewportSaveTimerRef,
        applyingHistoryRef,
        didInitialCenterRef,
        toolbarHideTimerRef,
        nodeDraggingRef,
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        addAsset,
        userId,
        hydrated,
        hydratedUserId,
        hydrate,
        createProject,
        updateProject,
        projectSaveState,
        renameProject,
        deleteProjects,
        currentProject,
        projectSummaries,
        theme,
        nodes,
        setNodes,
        connections,
        setConnections,
        chatSessions,
        setChatSessions,
        activeChatId,
        setActiveChatId,
        viewport,
        setViewport,
        selectedNodeIds,
        setSelectedNodeIds,
        selectedConnectionId,
        setSelectedConnectionId,
        setHoveredNodeId,
        pendingConnectionCreate,
        setPendingConnectionCreate,
        contextMenu,
        setContextMenu,
        runningNodeId,
        setRunningNodeId,
        isMiniMapOpen,
        setIsMiniMapOpen,
        backgroundMode,
        setBackgroundMode,
        showImageInfo,
        setShowImageInfo,
        clearConfirmOpen,
        setClearConfirmOpen,
        assetPickerOpen,
        setAssetPickerOpen,
        projectLoaded,
        setProjectLoaded,
        toolbarNodeId,
        setToolbarNodeId,
        nodeImageSettingsOpen,
        setNodeImageSettingsOpen,
        dialogNodeId,
        setDialogNodeId,
        editingNodeId,
        setEditingNodeId,
        editRequestNonce,
        setEditRequestNonce,
        infoNodeId,
        setInfoNodeId,
        cropNodeId,
        setCropNodeId,
        maskEditNodeId,
        setMaskEditNodeId,
        splitNodeId,
        setSplitNodeId,
        upscaleNodeId,
        setUpscaleNodeId,
        angleNodeId,
        setAngleNodeId,
        storyboardNodeId,
        setStoryboardNodeId,
        previewNodeId,
        setPreviewNodeId,
        assistantCollapsed,
        setAssistantCollapsed,
        assistantMounted,
        setAssistantMounted,
        assistantClosing,
        setAssistantClosing,
        titleEditing,
        setTitleEditing,
        titleDraft,
        setTitleDraft,
        historyState,
        setHistoryState,
        collapsingBatchIds,
        setCollapsingBatchIds,
        openingBatchIds,
        setOpeningBatchIds,
        isNodeDragging,
        setIsNodeDragging,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        agentCloseTimerRef,
        autoOpenedAgentRef,
        pendingConnectionCreateRef,
        generationRequestsRef,
        resumingImageTaskIdsRef,
        resumingVideoTaskIdsRef,
        resumingTextTaskIdsRef,
        resumingAudioTaskIdsRef,
        createHistoryEntry,
        startGenerationRequest,
        finishGenerationRequest,
        stopGenerationByRunningId,
        confirmStopGeneration,
        completeVideoTask,
        completeImageTask,
        startAndCompleteImageTask,
        completeTextTask,
        completeAudioTask,
        getCanvasCenter,
        keepNodeToolbar,
        hideNodeToolbar,
        connectNodes,
        createConnectedNode,
        cancelPendingConnectionCreate,
        toolbarNode,
        infoNode,
        cropNode,
        maskEditNode,
        splitNode,
        upscaleNode,
        angleNode,
        previewNode,
        hasMultipleSelectedNodes,
        activeNodeId,
        batchChildCountById,
        batchMotionById,
        relatedHighlight,
        configInputsById,
        resourceContextNodeId,
        canvasResourceReferences,
        resourceReferenceByNodeId,
        mentionReferencesByNodeId,
        agentSnapshot,
        applyAgentOps,
        createNode,
        deleteNodes,
        deleteConnection,
        deselectCanvas,
        clearCanvas,
        duplicateNode,
        copySelectedNodes,
        pasteCopiedNodes,
        resetViewport,
        locateCanvasNode,
        setZoomScale,
        applyHistory,
        undoCanvas,
        redoCanvas,
        createAndOpenProject,
        deleteCurrentProject,
        createImageFileNode,
        createVideoFileNode,
        createAudioFileNode,
        createTextNodeFromClipboard,
        handleImageDimensions,
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
        handleUploadRequest,
        replaceAudioNodeFile,
        handleImageInputChange,
        handleDrop,
        pasteAssistantMedia,
        handleAssistantSessionsChange,
        startTitleEditing,
        finishTitleEditing,
        preventCanvasContextMenu,
        handleGenerateNode,
        handleRetryNode,
        generateImageFromTextNode,
        insertAssistantImage,
        insertAssistantText,
        handleAssetInsert,
        assistantOpen,
        openAgent,
        closeAgent,
    } = controller;
    const hiddenCanvasNodeIds = useMemo(() => new Set(nodes.filter((node) => isHiddenBatchChild(node, nodes, collapsingBatchIds)).map((node) => node.id)), [collapsingBatchIds, nodes]);
    const activeUpscaleNode = useMemo(() => nodes.find((node) => node.id === dialogNodeId && isDreaminaUpscaleImageNode(node)) || null, [dialogNodeId, nodes]);
    const activePromptNode = useMemo(() => nodes.find((node) => node.id === dialogNodeId && node.type !== CanvasNodeType.Config && !isDreaminaUpscaleImageNode(node)) || null, [dialogNodeId, nodes]);
    const previewUpscaleSourceNode = useMemo(() => resolveDreaminaUpscaleSourceNode(previewNode, nodes), [nodes, previewNode]);
    const contextNode = useMemo(() => (contextMenu?.type === "node" ? nodes.find((node) => node.id === contextMenu.nodeId) || null : null), [contextMenu, nodes]);
    const storyboardNode = useMemo(() => nodes.find((node) => node.id === storyboardNodeId && isCanvasImageNodeType(node.type)) || null, [nodes, storyboardNodeId]);
    const captureFrameNode = useMemo(() => nodes.find((node) => node.id === captureFrameNodeId && node.type === CanvasNodeType.Video) || null, [captureFrameNodeId, nodes]);
    const canArrangeContextSelection = canArrangeCanvasSelection(contextMenu, selectedNodeIds);
    const interiorDesignTargetNode = useMemo(() => (interiorDesignTarget ? nodes.find((node) => node.id === interiorDesignTarget.nodeId) || null : null), [interiorDesignTarget, nodes]);
    const isCanvasAgentReferenceNode = useCallback(
        (node: (typeof nodes)[number]) =>
            (isCanvasImageNodeType(node.type) || node.type === CanvasNodeType.Video) && Boolean([node.metadata?.content, node.metadata?.serverUrl, node.metadata?.remoteUrl].find((value) => typeof value === "string" && value.trim())),
        [],
    );
    const agentReferenceSelectionCount = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id) && isCanvasAgentReferenceNode(node)).length, [isCanvasAgentReferenceNode, nodes, selectedNodeIds]);
    const promptComposerOpen = Boolean(activePromptNode || activeUpscaleNode);
    const showCanvasToolbar = !toolbarNode && !promptComposerOpen;
    const updateNodeTitle = useCallback(
        (nodeId: string, title: string) => {
            const next = title.trim();
            if (!next) return;
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title: next } : node)));
        },
        [setNodes],
    );
    const arrangeSelectedNodes = useCallback(() => {
        setNodes((current) => {
            const updates = resolveCanvasSelectionLayout(current, selectedNodeIdsRef.current);
            if (!updates.length) return current;
            const positions = new Map(updates.map((update) => [update.id, update.position]));
            return current.map((node) => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
        });
        setContextMenu(null);
    }, [selectedNodeIdsRef, setContextMenu, setNodes]);
    const confirmInteriorDesign = useCallback(
        (settings: CanvasInteriorDesignSettings, runningHubApp?: { id: string; name: string }) => {
            const target = interiorDesignTarget;
            if (!target) return;
            const compatibleModels = interiorDesignModels(effectiveConfig);
            if (target.mode === "config") {
                setNodes((current) =>
                    current.map((node) =>
                        node.id === target.nodeId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      ...interiorDesignNodePatch(settings, compatibleModels.includes(node.metadata?.model || "") ? node.metadata?.model || "" : compatibleModels[0] || "", node.metadata),
                                      runningHubAppId: runningHubApp?.id,
                                      runningHubAppName: runningHubApp?.name,
                                  },
                              }
                            : node,
                    ),
                );
                setInteriorDesignTarget(null);
                return;
            }
            const source = nodesRef.current.find((node) => node.id === target.nodeId && isCanvasImageNodeType(node.type) && Boolean(node.metadata?.content?.trim()));
            if (!source) {
                message.error("原图片不可用，请重新选择图片节点");
                setInteriorDesignTarget(null);
                return;
            }
            const created = createInteriorDesignConfigNode({ source, nodes: nodesRef.current, settings, model: compatibleModels[0] || "", nodeId: `config-${nanoid()}`, connectionId: nanoid() });
            if (runningHubApp) created.node.metadata = { ...created.node.metadata, runningHubAppId: runningHubApp.id, runningHubAppName: runningHubApp.name };
            setNodes((current) => [...current, created.node]);
            setConnections((current) => [...current, created.connection]);
            setSelectedNodeIds(new Set([created.node.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            setInteriorDesignTarget(null);
        },
        [effectiveConfig, interiorDesignTarget, message, nodesRef, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds],
    );
    const capturePreviewVideoFrame = useCallback(async () => {
        if (!previewNode || previewNode.type !== CanvasNodeType.Video) return;
        const storageKey = videoStorageKey(previewNode);
        if (!storageKey) {
            message.error("当前视频尚未保存到服务器，无法截取图片");
            return;
        }
        const currentTime = previewVideoRef.current?.currentTime;
        if (!Number.isFinite(currentTime)) {
            message.error("视频尚未准备好，请播放后再截取");
            return;
        }
        setCapturingVideoFrame(true);
        try {
            const { frame } = await extractCanvasVideoFrames({ storageKey, mode: "current", timeMs: Math.max(0, Math.round(currentTime! * 1000)) });
            if (!frame) throw new Error("视频截图保存失败");
            appendDerivedImageNode(
                previewNode,
                {
                    url: frame.serverUrl,
                    serverUrl: frame.serverUrl,
                    storageKey: frame.storageKey,
                    bytes: frame.bytes,
                    mimeType: frame.mimeType,
                    width: frame.width || previewNode.metadata?.naturalWidth || previewNode.width,
                    height: frame.height || previewNode.metadata?.naturalHeight || previewNode.height,
                },
                "视频截图",
                fitCanvasImageNodeSize(frame.width || previewNode.metadata?.naturalWidth || previewNode.width, frame.height || previewNode.metadata?.naturalHeight || previewNode.height),
            );
            message.success("已截取当前帧并创建图片节点");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频截图失败");
        } finally {
            setCapturingVideoFrame(false);
        }
    }, [appendDerivedImageNode, message, previewNode]);
    const addCapturedFrameNode = useCallback(
        (frame: CanvasVideoFrameAsset) => {
            const sourceNode = captureFrameNode;
            if (!sourceNode) return;
            appendDerivedImageNode(
                sourceNode,
                {
                    url: frame.serverUrl,
                    serverUrl: frame.serverUrl,
                    storageKey: frame.storageKey,
                    bytes: frame.bytes,
                    mimeType: frame.mimeType,
                    width: frame.width || sourceNode.metadata?.naturalWidth || sourceNode.width,
                    height: frame.height || sourceNode.metadata?.naturalHeight || sourceNode.height,
                },
                `视频帧 ${Math.max(0, frame.atMs / 1000).toFixed(1)}s`,
                fitCanvasImageNodeSize(frame.width || sourceNode.metadata?.naturalWidth || sourceNode.width, frame.height || sourceNode.metadata?.naturalHeight || sourceNode.height),
                { connect: false, openEditor: false, inheritPrompt: false },
            );
        },
        [appendDerivedImageNode, captureFrameNode],
    );
    const extractVideoDepth = useCallback(
        async (sourceNode: (typeof nodes)[number], retryNode?: (typeof nodes)[number]) => {
            if (sourceNode.type !== CanvasNodeType.Video || depthSourceNodeIds.has(sourceNode.id)) return;
            const storageKey = videoStorageKey(sourceNode);
            if (!storageKey) return message.error("当前视频尚未保存到服务器，无法提取深度");
            const id = retryNode?.id || `video-depth-${nanoid()}`;
            const size = fitNodeSize(sourceNode.metadata?.naturalWidth || sourceNode.width, sourceNode.metadata?.naturalHeight || sourceNode.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            const position = resolveCanvasNodePlacement(
                nodesRef.current,
                size,
                { x: sourceNode.position.x + sourceNode.width / 2, y: sourceNode.position.y + sourceNode.height / 2 },
                { x: sourceNode.position.x + sourceNode.width + CANVAS_NODE_GAP, y: sourceNode.position.y },
            );
            setDepthSourceNodeIds((current) => new Set(current).add(sourceNode.id));
            setNodes((current) =>
                retryNode
                    ? current.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item))
                    : [...current, { id, type: CanvasNodeType.Video, title: "深度提取", position, ...size, metadata: { status: NODE_STATUS_LOADING, derivedVideoOperation: "depth", derivedFromNodeId: sourceNode.id } }],
            );
            if (!retryNode) setConnections((current) => [...current, { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: id }]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            try {
                const video = await extractCanvasVideoDepth({ storageKey }, (progress) => {
                    setNodes((current) => current.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, generationProgress: progress.percent, generationStage: progress.stage } } : item)));
                });
                const resolvedSize = fitNodeSize(video.width || size.width, video.height || size.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((current) =>
                    current.map((item) =>
                        item.id === id
                            ? {
                                  ...item,
                                  ...resolvedSize,
                                  metadata: {
                                      ...item.metadata,
                                      content: video.serverUrl,
                                      serverUrl: video.serverUrl,
                                      storageKey: video.storageKey,
                                      mimeType: video.mimeType,
                                      bytes: video.bytes,
                                      durationMs: video.durationMs,
                                      naturalWidth: video.width,
                                      naturalHeight: video.height,
                                      status: NODE_STATUS_SUCCESS,
                                      errorDetails: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                message.success("深度视频已生成");
            } catch (error) {
                const detail = error instanceof Error ? error.message : "视频深度提取失败";
                setNodes((current) => current.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: detail } } : item)));
                message.error(detail);
            } finally {
                setDepthSourceNodeIds((current) => {
                    const next = new Set(current);
                    next.delete(sourceNode.id);
                    return next;
                });
            }
        },
        [depthSourceNodeIds, message, nodes, nodesRef, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds],
    );
    const retryCanvasNode = useCallback(
        (node: (typeof nodes)[number]) => {
            if (node.metadata?.derivedVideoOperation === "depth" || (node.title === "深度提取" && node.metadata?.status === NODE_STATUS_ERROR)) {
                const sourceNodeId = node.metadata?.derivedFromNodeId || connectionsRef.current.find((connection) => connection.toNodeId === node.id)?.fromNodeId;
                const sourceNode = nodesRef.current.find((item) => item.id === sourceNodeId);
                if (!sourceNode) return message.error("未找到深度视频对应的源视频节点");
                void extractVideoDepth(sourceNode, node);
                return;
            }
            void handleRetryNode(node);
        },
        [connectionsRef, extractVideoDepth, handleRetryNode, message, nodesRef],
    );
    const analyzeVideoNode = useCallback(
        async (sourceNode: (typeof nodes)[number]) => {
            if (sourceNode.type !== CanvasNodeType.Video || analysisSourceNodeIds.has(sourceNode.id)) return;
            const storageKey = videoStorageKey(sourceNode);
            if (!storageKey) return message.error("当前视频尚未保存到服务器，无法分析");
            const id = `text-video-analysis-${nanoid()}`;
            const size = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const position = resolveCanvasNodePlacement(
                nodesRef.current,
                size,
                { x: sourceNode.position.x + sourceNode.width / 2, y: sourceNode.position.y + sourceNode.height / 2 },
                { x: sourceNode.position.x + sourceNode.width + CANVAS_NODE_GAP, y: sourceNode.position.y },
            );
            setAnalysisSourceNodeIds((current) => new Set(current).add(sourceNode.id));
            setNodes((current) => [...current, { id, type: CanvasNodeType.Text, position, ...size, title: "视频分析", metadata: { content: "正在分析视频…", status: NODE_STATUS_LOADING, fontSize: 14 } }]);
            setConnections((current) => [...current, { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: id }]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            try {
                const result = await analyzeCanvasVideo({ storageKey, requestId: nanoid() });
                setNodes((current) => current.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, content: result.analysisText, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item)));
                message.success("视频分析已生成文本节点");
            } catch (error) {
                const detail = error instanceof Error ? error.message : "视频分析失败";
                setNodes((current) => current.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, content: "视频分析失败", status: NODE_STATUS_ERROR, errorDetails: detail } } : item)));
                message.error(detail);
            } finally {
                setAnalysisSourceNodeIds((current) => {
                    const next = new Set(current);
                    next.delete(sourceNode.id);
                    return next;
                });
            }
        },
        [analysisSourceNodeIds, message, nodes, nodesRef, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds],
    );
    const openNodeRename = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            setRenameDraft(node.title);
            setRenameNodeId(nodeId);
        },
        [nodesRef],
    );
    const startCanvasAgentReferencePicker = useCallback(() => {
        if (agentReferenceSelectionCount >= CANVAS_AGENT_REFERENCE_LIMIT) {
            message.warning(`本轮最多选择 ${CANVAS_AGENT_REFERENCE_LIMIT} 个画布素材`);
            return;
        }
        setNodeCreatePosition(null);
        setContextMenu(null);
        setToolbarNodeId(null);
        setHoveredNodeId(null);
        setAgentReferencePicking(true);
    }, [agentReferenceSelectionCount, message, setContextMenu, setHoveredNodeId, setToolbarNodeId]);
    const pickCanvasAgentReference = useCallback(
        (node: (typeof nodes)[number]) => {
            if (!isCanvasAgentReferenceNode(node)) return;
            if (selectedNodeIds.has(node.id)) {
                setSelectedNodeIds(new Set(Array.from(selectedNodeIds).filter((id) => id !== node.id)));
            } else if (agentReferenceSelectionCount >= CANVAS_AGENT_REFERENCE_LIMIT) {
                message.warning(`本轮最多选择 ${CANVAS_AGENT_REFERENCE_LIMIT} 个画布素材`);
                return;
            } else {
                setSelectedNodeIds(new Set([...selectedNodeIds, node.id]));
            }
            setSelectedConnectionId(null);
            setToolbarNodeId(null);
        },
        [agentReferenceSelectionCount, isCanvasAgentReferenceNode, message, selectedNodeIds, setSelectedConnectionId, setSelectedNodeIds, setToolbarNodeId],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;
    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.backdrop, color: theme.node.text }}>
            <CanvasAssetsPanel
                open={assetPickerOpen}
                projectId={projectId}
                projectTitle={currentProject?.title || "未命名画布"}
                nodes={nodes}
                onOpenProject={(id) => router.push(`/canvas/${id}`)}
                onOpenProjects={() => router.push("/canvas")}
                onCreateProject={createAndOpenProject}
                onInsertAsset={handleAssetInsert}
                onInsertPrompt={insertAssistantText}
                onLocateNode={locateCanvasNode}
                onClose={() => setAssetPickerOpen(false)}
            />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    projectId={projectId}
                    projectSummaries={projectSummaries}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    onSwitchProject={(id) => router.push(`/canvas/${id}`)}
                    saveState={projectSaveState}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onWorkbench={() => router.push("/create")}
                    onDeleteProject={deleteCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    assetsOpen={assetPickerOpen}
                    onToggleAssets={() => setAssetPickerOpen((value) => !value)}
                    agentOpen={assistantOpen}
                    onToggleAgent={() => (assistantOpen ? closeAgent() : openAgent())}
                />

                <CanvasSurface
                    containerRef={containerRef}
                    nodes={nodes}
                    hiddenNodeIds={hiddenCanvasNodeIds}
                    connections={connections}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    interactionMode={interactionMode}
                    minimapOpen={isMiniMapOpen && !promptComposerOpen}
                    focusNodeId={activePromptNode?.id}
                    promptComposer={
                        activePromptNode ? (
                            <CanvasNodePromptPanel
                                node={activePromptNode}
                                isRunning={runningNodeId === activePromptNode.id}
                                mentionReferences={mentionReferencesByNodeId.get(activePromptNode.id) || []}
                                onPromptChange={handleNodePromptChange}
                                onConfigChange={handleConfigNodeChange}
                                onGenerate={handleGenerateNode}
                                onStop={confirmStopGeneration}
                                onImageSettingsOpenChange={(open) => {
                                    setNodeImageSettingsOpen(open);
                                    if (open) setToolbarNodeId(null);
                                }}
                            />
                        ) : null
                    }
                    agentReferencePicker={agentReferencePicking}
                    agentReferenceSelectionCount={agentReferenceSelectionCount}
                    isAgentReferenceCandidate={isCanvasAgentReferenceNode}
                    onPickAgentReference={pickCanvasAgentReference}
                    onCancelAgentReferencePicker={() => setAgentReferencePicking(false)}
                    selectedNodeIds={selectedNodeIds}
                    selectedConnectionId={selectedConnectionId}
                    relatedNodeIds={relatedHighlight.nodeIds}
                    relatedConnectionIds={relatedHighlight.connectionIds}
                    nodeProps={{
                        onHoverStart: (nodeId) => {
                            if (nodeDraggingRef.current || agentReferencePicking) return;
                            setHoveredNodeId(nodeId);
                        },
                        onHoverEnd: (nodeId) => {
                            if (agentReferencePicking) return;
                            setHoveredNodeId((current) => (current === nodeId ? null : current));
                        },
                        onContentChange: handleNodeContentChange,
                        onTitleChange: updateNodeTitle,
                        onToggleBatch: toggleBatchExpanded,
                        onSetBatchPrimary: setBatchPrimary,
                        onRetry: retryCanvasNode,
                        onGenerateImage: generateImageFromTextNode,
                        onOpenPanel: (node) => {
                            setSelectedNodeIds(new Set([node.id]));
                            setSelectedConnectionId(null);
                            setDialogNodeId(node.id);
                        },
                        onImageDimensions: handleImageDimensions,
                        onViewImage: (node) => setPreviewNodeId(node.id),
                        onUpload: (node) => node.type === CanvasNodeType.Audio ? setAudioUploadNodeId(node.id) : handleUploadRequest(node.id),
                    }}
                    getNodeViewProps={(node) => ({
                        editRequestNonce: editingNodeId === node.id ? editRequestNonce : 0,
                        showPanel: dialogNodeId === node.id && ((node.type === CanvasNodeType.Config && !isInteriorDesignNode(node.metadata)) || (isDreaminaUpscaleImageNode(node) && Boolean(node.metadata?.content))),
                        batchCount: batchChildCountById.get(node.id) || 0,
                        batchExpanded: Boolean(node.metadata?.imageBatchExpanded),
                        batchClosing: Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId)),
                        batchOpening: openingBatchIds.has(node.id),
                        batchRecovering: collapsingBatchIds.has(node.id),
                        batchMotion: batchMotionById.get(node.id),
                        showImageInfo,
                        upscaleSourceUrl: resolveDreaminaUpscaleSourceNode(node, nodes)?.metadata?.content,
                        resourceLabel: resourceReferenceByNodeId.get(node.id),
                        mentionReferences: mentionReferencesByNodeId.get(node.id) || [],
                    })}
                    renderPanel={(panelNode) =>
                        panelNode.type === CanvasNodeType.Config ? (
                            <CanvasConfigComposer
                                value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                                inputs={configInputsById.get(panelNode.id) || []}
                                onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                                onClose={() => setDialogNodeId(null)}
                            />
                        ) : isDreaminaUpscaleImageNode(panelNode) ? (
                            <CanvasNodeUpscalePanel
                                node={panelNode}
                                sourceNode={resolveDreaminaUpscaleSourceNode(panelNode, nodes)}
                                onClose={() => setDialogNodeId(null)}
                                onConfirm={(params) => {
                                    const source = resolveDreaminaUpscaleSourceNode(panelNode, nodes);
                                    if (!source) return;
                                    setDialogNodeId(null);
                                    void upscaleImageNode(source, params).catch((error) => message.error(error instanceof Error ? error.message : "图片放大失败"));
                                }}
                            />
                        ) : null
                    }
                    renderNode={(contentNode) => (
                        <CanvasConfigNodePanel
                            node={contentNode}
                            isRunning={runningNodeId === contentNode.id}
                            inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                            references={mentionReferencesByNodeId.get(contentNode.id) || []}
                            onConfigChange={handleConfigNodeChange}
                            onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                            onInteriorDesignEdit={(nodeId) => setInteriorDesignTarget({ mode: "config", nodeId })}
                            onStop={confirmStopGeneration}
                            onGenerate={(nodeId) => {
                                const target = nodesRef.current.find((item) => item.id === nodeId);
                                const prompt = isInteriorDesignNode(target?.metadata) ? target?.metadata?.executionPrompt || "" : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                                void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", prompt);
                            }}
                        />
                    )}
                    onNodesCommit={(updates) => {
                        const updatesById = new Map(updates.map((update) => [update.id, update]));
                        setNodes((current) =>
                            current.map((node) => {
                                const update = updatesById.get(node.id);
                                return update
                                    ? {
                                          ...node,
                                          position: update.position ?? node.position,
                                          width: update.width ?? node.width,
                                          height: update.height ?? node.height,
                                      }
                                    : node;
                            }),
                        );
                    }}
                    onSelectionChange={(nodeIds, connectionId) => {
                        setSelectedNodeIds(nodeIds);
                        setSelectedConnectionId(connectionId);
                        setToolbarNodeId(nodeIds.size === 1 && !connectionId ? Array.from(nodeIds)[0] || null : null);
                        setContextMenu(null);
                    }}
                    onViewportCommit={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                        setNodeCreatePosition(null);
                    }}
                    onConnect={({ source, target }) => connectNodes({ nodeId: source, handleType: "source" }, target)}
                    onConnectionCreate={({ nodeId, handleType, position }) => setPendingConnectionCreate({ connection: { nodeId, handleType }, position })}
                    onPaneClick={() => {
                        setNodeCreatePosition(null);
                        setDialogNodeId(null);
                        setContextMenu(null);
                        if (agentReferencePicking) return;
                        deselectCanvas();
                    }}
                    onPaneDoubleClick={(position) => {
                        if (agentReferencePicking) return;
                        setContextMenu(null);
                        setNodeCreatePosition(position);
                    }}
                    onPaneContextMenu={(event) => preventCanvasContextMenu(event as React.MouseEvent)}
                    onNodeContextMenu={(event, id) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setEditingNodeId(null);
                        setToolbarNodeId(null);
                        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
                    }}
                    onEdgeContextMenu={(event, id) => {
                        setSelectedConnectionId(id);
                        setSelectedNodeIds(new Set());
                        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: id });
                    }}
                    onDrop={(event) => handleDrop(event as React.DragEvent<HTMLDivElement>)}
                    onDragStateChange={(dragging) => {
                        nodeDraggingRef.current = dragging;
                        setIsNodeDragging(dragging);
                    }}
                    overlay={
                        <>
                            {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} scale={viewport.k} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                            {nodeCreatePosition ? (
                                <NodeCreateMenu
                                    position={nodeCreatePosition}
                                    scale={viewport.k}
                                    onCreate={(type) => {
                                        createNode(type, nodeCreatePosition);
                                        setNodeCreatePosition(null);
                                    }}
                                    onClose={() => setNodeCreatePosition(null)}
                                />
                            ) : null}
                        </>
                    }
                />

                <CanvasNodeHoverToolbar
                    node={agentReferencePicking || isNodeDragging || nodeImageSettingsOpen ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onRename={(node) => openNodeRename(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => node.type === CanvasNodeType.Audio ? setAudioUploadNodeId(node.id) : handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node).catch((error) => message.error(error instanceof Error ? error.message : "素材保存失败"))}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setUpscaleNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onStoryboard={(node) => setStoryboardNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onReversePrompt={createImageReversePromptNodes}
                    onCaptureFrames={(node) => setCaptureFrameNodeId(node.id)}
                    onDepthExtract={(node) => void extractVideoDepth(node)}
                    onAnalyzeVideo={(node) => void analyzeVideoNode(node)}
                    onRetry={retryCanvasNode}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                {showCanvasToolbar ? (
                    <CanvasToolbar
                        selectedCount={selectedNodeIds.size}
                        canUndo={historyState.canUndo}
                        canRedo={historyState.canRedo}
                        agentOpen={assistantOpen}
                        composerOpen={promptComposerOpen}
                        backgroundMode={backgroundMode}
                        interactionMode={interactionMode}
                        showImageInfo={showImageInfo}
                        onAddImage={() => createNode(CanvasNodeType.Image)}
                        onAddPanorama={() => createNode(CanvasNodeType.Panorama)}
                        onAddVideo={() => createNode(CanvasNodeType.Video)}
                        onAddVideoRemake={() => createNode(CanvasNodeType.VideoRemake)}
                        onAddAudio={() => createNode(CanvasNodeType.Audio)}
                        onAddText={() => createNode(CanvasNodeType.Text)}
                        onAddConfig={() => createNode(CanvasNodeType.Config)}
                        onUndo={undoCanvas}
                        onRedo={redoCanvas}
                        onUpload={() => handleUploadRequest()}
                        onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                        onClear={() => setClearConfirmOpen(true)}
                        onInteractionModeChange={setInteractionMode}
                        onBackgroundModeChange={setBackgroundMode}
                        onShowImageInfoChange={setShowImageInfo}
                        onOpenAssets={() => {
                            setAssetPickerOpen(true);
                        }}
                    />
                ) : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canArrange={canArrangeContextSelection}
                        canInteriorDesign={Boolean(contextNode && isCanvasImageNodeType(contextNode.type) && contextNode.metadata?.content?.trim())}
                        canUpscale={Boolean(contextNode && isCanvasImageNodeType(contextNode.type) && contextNode.metadata?.content)}
                        canStoryboard={Boolean(contextNode && isCanvasImageNodeType(contextNode.type) && contextNode.metadata?.content?.trim())}
                        canUseVideoTools={Boolean(contextNode?.type === CanvasNodeType.Video && contextNode.metadata?.content)}
                        onClose={() => setContextMenu(null)}
                        onArrange={arrangeSelectedNodes}
                        onRename={() => {
                            if (contextMenu.type !== "node") return;
                            openNodeRename(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onInteriorDesign={() => {
                            if (!contextNode) return;
                            setInteriorDesignTarget({ mode: "source", nodeId: contextNode.id });
                            setContextMenu(null);
                        }}
                        onUpscale={() => {
                            if (!contextNode) return;
                            setUpscaleNodeId(contextNode.id);
                            setContextMenu(null);
                        }}
                        onStoryboard={() => {
                            if (!contextNode) return;
                            setStoryboardNodeId(contextNode.id);
                            setContextMenu(null);
                        }}
                        onCaptureFrames={() => {
                            if (!contextNode) return;
                            setCaptureFrameNodeId(contextNode.id);
                            setContextMenu(null);
                        }}
                        onDepthExtract={() => {
                            if (!contextNode) return;
                            void extractVideoDepth(contextNode);
                            setContextMenu(null);
                        }}
                        onAnalyzeVideo={() => {
                            if (!contextNode) return;
                            void analyzeVideoNode(contextNode);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                const selectedIds = selectedNodeIdsRef.current;
                                deleteNodes(selectedIds.has(contextMenu.nodeId) ? new Set(selectedIds) : new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <CanvasInteriorDesignDialog
                    open={Boolean(interiorDesignTarget)}
                    initialSettings={interiorDesignTarget?.mode === "config" ? interiorDesignTargetNode?.metadata?.interiorDesign : undefined}
                    initialRunningHubAppId={interiorDesignTarget?.mode === "config" ? interiorDesignTargetNode?.metadata?.runningHubAppId : undefined}
                    initialRunningHubAppName={interiorDesignTarget?.mode === "config" ? interiorDesignTargetNode?.metadata?.runningHubAppName : undefined}
                    onCancel={() => setInteriorDesignTarget(null)}
                    onConfirm={confirmInteriorDesign}
                />

                <CanvasVideoFrameCaptureDialog
                    node={captureFrameNode}
                    storageKey={captureFrameNode ? videoStorageKey(captureFrameNode) : undefined}
                    open={Boolean(captureFrameNode)}
                    onClose={() => setCaptureFrameNodeId(null)}
                    onAddFrame={addCapturedFrameNode}
                />

                <CanvasAudioUploadDialog open={Boolean(audioUploadNodeId)} nodeId={audioUploadNodeId} onClose={() => setAudioUploadNodeId(null)} onUpload={(nodeId, file) => replaceAudioNodeFile(nodeId, file)} />

                <input ref={imageInputRef} type="file" accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />

                <Modal
                    open={Boolean(renameNodeId)}
                    title="重命名节点"
                    centered
                    okText="保存"
                    cancelText="取消"
                    okButtonProps={{ disabled: !renameDraft.trim() }}
                    onOk={() => {
                        const next = renameDraft.trim();
                        if (renameNodeId) updateNodeTitle(renameNodeId, next);
                        setRenameNodeId(null);
                    }}
                    onCancel={() => setRenameNodeId(null)}
                >
                    <Input
                        autoFocus
                        value={renameDraft}
                        maxLength={64}
                        placeholder="请输入节点名称"
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setRenameDraft(event.target.value)}
                        onPressEnter={() => {
                            const next = renameDraft.trim();
                            if (renameNodeId) updateNodeTitle(renameNodeId, next);
                            setRenameNodeId(null);
                        }}
                    />
                </Modal>

                {cropNode?.metadata?.content ? (
                    <CanvasNodeCropDialog
                        dataUrl={cropNode.metadata.content}
                        open={Boolean(cropNode)}
                        onClose={() => setCropNodeId(null)}
                        onConfirm={(crop) => void cropImageNode(cropNode!, crop).catch((error) => message.error(error instanceof Error ? error.message : "图片裁剪失败"))}
                    />
                ) : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? (
                    <CanvasNodeSplitDialog
                        dataUrl={splitNode.metadata.content}
                        open={Boolean(splitNode)}
                        onClose={() => setSplitNodeId(null)}
                        onConfirm={(params) => void splitImageNode(splitNode!, params).catch((error) => message.error(error instanceof Error ? error.message : "图片切分失败"))}
                    />
                ) : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog
                        dataUrl={upscaleNode.metadata.content}
                        open={Boolean(upscaleNode)}
                        onClose={() => setUpscaleNodeId(null)}
                        onConfirm={(params) => void upscaleImageNode(upscaleNode!, params).catch((error) => message.error(error instanceof Error ? error.message : "图片放大失败"))}
                    />
                ) : null}

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {storyboardNode?.metadata?.content ? (
                    <CanvasStoryboardDialog
                        dataUrl={storyboardNode.metadata.content}
                        open={Boolean(storyboardNode)}
                        config={effectiveConfig}
                        initialModel={storyboardNode.metadata.model}
                        onClose={() => setStoryboardNodeId(null)}
                        onConfirm={(params) => void generateCharacterThreeViewNode(storyboardNode, params)}
                    />
                ) : null}

                <Modal
                    title={
                        previewNode ? (
                            <div className="flex min-w-0 items-center justify-between gap-3 pr-8">
                                <span className="truncate">{previewNode.type === CanvasNodeType.Video ? "视频详情" : "图片详情"}</span>
                                <div className="flex shrink-0 items-center gap-1">
                                    {previewNode.type === CanvasNodeType.Video ? (
                                        <Button type="text" size="small" icon={<Camera className="size-4" />} aria-label="截取当前帧" loading={capturingVideoFrame} onClick={() => void capturePreviewVideoFrame()}>
                                            截图
                                        </Button>
                                    ) : null}
                                    <Button type="text" size="small" icon={<Download className="size-4" />} aria-label={previewNode.type === CanvasNodeType.Video ? "下载视频" : "下载图片"} onClick={() => downloadNodeImage(previewNode)}>
                                        下载
                                    </Button>
                                </div>
                            </div>
                        ) : null
                    }
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? (
                        previewNode.type === CanvasNodeType.Video ? (
                            <video ref={previewVideoRef} src={previewNode.metadata.content} controls autoPlay className="max-h-[80vh] max-w-full bg-black object-contain" aria-label={previewNode.title || "视频"} />
                        ) : previewUpscaleSourceNode?.metadata?.content ? (
                            <CanvasImageComparison sourceUrl={previewUpscaleSourceNode.metadata.content} resultUrl={previewNode.metadata.content} alt={previewNode.title || "高清图片"} />
                        ) : (
                            <img src={imagePreviewUrl(previewNode.metadata.content, 1920)} alt={previewNode.title || "图片"} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
                        )
                    ) : null}
                </Modal>

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>
            </section>
            {assistantMounted ? (
                <CanvasAssistantPanel
                    nodes={nodes}
                    selectedNodeIds={selectedNodeIds}
                    snapshot={agentSnapshot}
                    sessions={chatSessions}
                    activeSessionId={activeChatId}
                    onSelectNodeIds={setSelectedNodeIds}
                    onSessionsChange={handleAssistantSessionsChange}
                    onApplyOps={applyAgentOps}
                    onLocateNode={locateCanvasNode}
                    onPasteMedia={pasteAssistantMedia}
                    canvasReferencePicking={agentReferencePicking}
                    onStartCanvasReferencePicker={startCanvasAgentReferencePicker}
                    onCancelCanvasReferencePicker={() => setAgentReferencePicking(false)}
                    closing={assistantClosing}
                    projectLoaded={projectLoaded}
                    onCollapse={() => {
                        setAgentReferencePicking(false);
                        closeAgent();
                    }}
                />
            ) : null}
        </main>
    );
}
