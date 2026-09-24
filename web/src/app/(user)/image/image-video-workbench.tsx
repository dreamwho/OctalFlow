"use client";

import { App, Dropdown, Modal, Popover } from "antd";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, Clapperboard, Diamond, Download, Ellipsis, FileImage, House, ImagePlus, Images, LoaderCircle, Maximize2, Minus, Moon, Plus, RectangleHorizontal, RectangleVertical, Sparkles, Square, Sun, Upload, Video, X, ZoomIn } from "lucide-react";
import { saveAs } from "file-saver";

import { ModelPicker } from "@/components/model-picker";
import { imageRatios, videoQualityOptions as canvasVideoQualityOptions, videoRatios } from "@/components/creative-generation-preferences";
import { chatGptApiImageSizes, isChatGptApiModelConfig } from "@/app/(user)/canvas/components/canvas-image-settings-popover";
import { canvasDreaminaImageProfile, canvasDreaminaVideoProfile, resolveCanvasDreaminaModelId } from "@/app/(user)/canvas/utils/canvas-dreamina-cli";
import { compileInteriorDesignPrompt, interiorDesignModels, isInteriorDesignModel } from "@/app/(user)/canvas/utils/canvas-interior-design";
import type { CanvasInteriorDesignSettings } from "@/app/(user)/canvas/types";
import { canvasDolaVideoProfile, resolveCanvasDolaModelId } from "@/app/(user)/canvas/utils/canvas-dola";
import { formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { SiteLogo } from "@/components/layout/site-logo";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { generationLogPublicPrompt } from "@/lib/generation-log-snapshot";
import { mediaDownloadFileName } from "@/lib/media-file";
import { imagePreviewUrl, originalImageDownloadUrl, originalMediaDownloadUrl } from "@/lib/media-image-url";
import { canvasSelectionBorderStyle, canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useMediaWorkbenchDraftStore } from "@/stores/use-media-workbench-draft-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { createCanvasProject } from "@/services/api/canvas-projects";
import { createImageGenerationTask, waitForImageGenerationTask, type ImageGenerationTask } from "@/services/api/image";
import { createVideoGenerationTask, waitForVideoGenerationTask, type VideoGenerationTask } from "@/services/api/video";
import { uploadImage } from "@/services/image-storage";
import { listLibraryAssetPage } from "@/services/api/library-assets";
import type { Asset } from "@/lib/library-asset-contract";
import { estimateCanvasProgress } from "@/app/(user)/canvas/utils/canvas-generation-progress";
import type { ReferenceImage } from "@/types/image";
import type { GenerationLogRequestSnapshot, GenerationLogSlotSnapshot } from "@/lib/generation-log-snapshot";
import { createWorkbenchCanvasNode } from "./image-video-workbench-utils";
import { ImageVideoInteriorDesignPanel } from "./image-video-interior-design-panel";
import styles from "./image-video-workbench.module.css";

type WorkMode = "image" | "video";
type LogAsset = { type: "image" | "video"; url: string; remoteUrl?: string; serverUrl?: string; mimeType?: string; width?: number; height?: number; bytes?: number };
type GenerationLog = {
    id: string; kind: "image" | "video"; status: "pending" | "success" | "failed"; title: string; prompt: string; model: string;
    assets: LogAsset[]; requestSnapshot?: GenerationLogRequestSnapshot; createdAt: string; durationMs: number;
};
type ResultCard = { key: string; log: GenerationLog; slot: GenerationLogSlotSnapshot; asset?: LogAsset };
type LightboxItem = { kind: "image" | "video"; url: string; mimeType?: string; title: string };

const qualityOptions = ["low", "medium", "high"];
export function ImageVideoWorkbench() {
    const { message, modal } = App.useApp();
    const router = useRouter();
    const themeName = useThemeStore((state) => state.theme);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const takeDraft = useMediaWorkbenchDraftStore((state) => state.takeDraft);
    const [mode, setMode] = useState<WorkMode>("image");
    const [resultKind, setResultKind] = useState<"image" | "video">("image");
    const [prompt, setPrompt] = useState("");
    const [model, setModel] = useState("");
    const [ratio, setRatio] = useState("16:9");
    const [count, setCount] = useState(1);
    const [quality, setQuality] = useState("low");
    const [videoQuality, setVideoQuality] = useState("720");
    const [seconds, setSeconds] = useState("5");
    const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
    const [referenceAssets, setReferenceAssets] = useState<Asset[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<{ key: string; url: string; name: string }[]>([]);
    const [referenceModalOpen, setReferenceModalOpen] = useState(false);
    const [interiorModalOpen, setInteriorModalOpen] = useState(false);
    const [interiorSettings, setInteriorSettings] = useState<CanvasInteriorDesignSettings>();
    const [interiorApp, setInteriorApp] = useState<{ id: string; name: string }>();
    const [referencePlacement, setReferencePlacement] = useState({ left: 12, top: 60, width: 600, height: 650 });
    const [interiorPlacement, setInteriorPlacement] = useState({ left: 12, top: 60, width: 780, height: 650 });
    const [assetTab, setAssetTab] = useState<"library" | "upload">("library");
    const [libraryAssets, setLibraryAssets] = useState<Asset[]>([]);
    const [libraryLoading, setLibraryLoading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [activeOption, setActiveOption] = useState<"ratio" | "quality" | "count" | "videoQuality" | "seconds" | null>(null);
    const [now, setNow] = useState(Date.now());
    const [durationStats, setDurationStats] = useState<Record<string, { avgDurationMs: number; samples: number }>>({});
    const [submitting, setSubmitting] = useState(false);
    const [statusFilter, setStatusFilter] = useState("all");
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [lightbox, setLightbox] = useState<LightboxItem>();
    const [autoSubmit, setAutoSubmit] = useState(false);
    const [promptExpanded, setPromptExpanded] = useState(false);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const promptInputRef = useRef<HTMLTextAreaElement>(null);
    const promptPanelRef = useRef<HTMLElement>(null);
    const activePromptInput = useRef<HTMLTextAreaElement | null>(null);
    const composing = useRef(false);
    const mounted = useRef(false);
    const autoSubmitted = useRef(false);

    const capability: "image" | "video" = mode === "image" ? "image" : "video";
    const currentKind = capability;
    const selectedModel = model || (currentKind === "image" ? config.imageModel : config.videoModel);
    const modelPickerConfig = useMemo(() => ({ ...config, model: selectedModel }), [config, selectedModel]);
    const dreamina = canvasDreaminaImageProfile(resolveCanvasDreaminaModelId(config, selectedModel));
    const videoCommand = referenceFiles.length + referenceAssets.length > 1 ? "multiframe2video" : referenceFiles.length + referenceAssets.length ? "image2video" : "text2video";
    const dolaVideo = canvasDolaVideoProfile(resolveCanvasDolaModelId(modelPickerConfig, selectedModel));
    const dreaminaVideo = canvasDreaminaVideoProfile(resolveCanvasDreaminaModelId(modelPickerConfig, selectedModel), videoCommand);
    const videoProfile = dolaVideo || dreaminaVideo;
    const chatGptApi = currentKind === "image" && isChatGptApiModelConfig(config, selectedModel);
    const ratioOptions = (currentKind === "video" ? videoProfile?.fixedRatio ? [{ value: "auto" }] : videoProfile?.ratios || videoRatios : chatGptApi ? chatGptApiImageSizes : dreamina?.ratios || imageRatios).map((option) => option.value);
    const currentQualityOptions = currentKind === "image" ? dreamina?.qualities.map((option) => option.value) || qualityOptions : [];
    const qualityLabels: Record<string, string> = Object.fromEntries((dreamina?.qualities || [{ value: "low", shortLabel: "1K" }, { value: "medium", shortLabel: "2K" }, { value: "high", shortLabel: "4K" }]).map((option) => [option.value, `${option.value === "low" ? "低" : option.value === "medium" ? "中" : option.value === "high" ? "高" : "智能"} · ${option.shortLabel || option.value}`]));
    const currentVideoQualities = videoProfile?.qualities || canvasVideoQualityOptions;
    const currentVideoQualityOptions = currentVideoQualities.map((option) => option.value);
    const videoQualityLabels = Object.fromEntries(currentVideoQualities.map((option) => [option.value, option.shortLabel || option.label]));
    const durationRange = videoProfile?.durationRange || { min: 5, max: 15 };
    const durationSnapPoints = dolaVideo?.durations.map((option) => option.value);
    const referenceMentions = [...referenceAssets.filter((asset) => asset.kind === "image").map((asset) => ({ id: asset.id, name: asset.title, url: imagePreviewUrl(asset.coverUrl || asset.data.serverUrl || asset.data.dataUrl, 200) })), ...referencePreviews.map((preview) => ({ id: preview.key, name: preview.name, url: preview.url }))];
    const mentionOptions = referenceMentions.map((item, index) => ({ ...item, label: `图片${index + 1}` })).filter((item) => mentionQuery !== null && (`${item.label} ${item.name}`).toLowerCase().includes(mentionQuery.toLowerCase()));
    const maxCount = Math.max(1, config.imageMaxCount);
    const credits = requestCreditCost({ apiSource: config.apiSource, modelPointCosts: config.modelPointCosts, generationPointMultipliers: config.generationPointMultipliers, kind: currentKind, model: selectedModel, count: currentKind === "image" ? count : 1, quality, videoQuality, videoSeconds: seconds });
    const addReferenceFiles = useCallback((files: File[]) => {
        const images = files.filter((file) => file.type.startsWith("image/"));
        if (images.length) setReferenceFiles((previous) => Array.from(new Map([...previous, ...images].map((file) => [`${file.name}:${file.lastModified}:${file.size}`, file])).values()));
        setReferenceModalOpen(false);
    }, []);

    const placeReferenceModal = useCallback(() => {
        const panel = promptPanelRef.current?.getBoundingClientRect();
        if (!panel) return;
        const compact = window.innerWidth <= 720;
        const left = compact ? 12 : panel.right + (window.innerWidth <= 1050 || window.innerHeight <= 820 ? 8 : 12);
        const top = compact ? 12 : panel.top;
        const placement = {
            left,
            top,
            width: Math.min(600, window.innerWidth - left - 12),
            height: Math.min(680, window.innerHeight - top - 12),
        };
        setReferencePlacement(placement);
        setInteriorPlacement({ ...placement, width: Math.min(780, window.innerWidth - left - 12) });
    }, []);

    useEffect(() => {
        if (!referenceModalOpen && !interiorModalOpen) return;
        window.addEventListener("resize", placeReferenceModal);
        return () => window.removeEventListener("resize", placeReferenceModal);
    }, [referenceModalOpen, interiorModalOpen, placeReferenceModal]);

    useEffect(() => {
        mounted.current = true;
        const queryMode = new URLSearchParams(window.location.search).get("mode");
        if (queryMode === "video") {
            setMode("video");
            setResultKind("video");
        }
        const incoming = takeDraft();
        if (incoming) {
            setMode(incoming.mode === "video" ? "video" : "image");
            setResultKind(incoming.mode);
            setPrompt(incoming.prompt);
            setModel(incoming.modelId || "");
            setRatio(incoming.aspectRatio || "16:9");
            setSeconds(incoming.duration || "5");
            setReferenceFiles(incoming.referenceFile ? [incoming.referenceFile] : []);
            setAutoSubmit(Boolean(incoming.autoSubmit));
        }
        return () => { mounted.current = false; };
    }, [takeDraft]);

    useEffect(() => {
        const previews = referenceFiles.map((file) => ({ key: `${file.name}:${file.lastModified}:${file.size}`, url: URL.createObjectURL(file), name: file.name }));
        setReferencePreviews(previews);
        return () => previews.forEach((item) => URL.revokeObjectURL(item.url));
    }, [referenceFiles]);

    useEffect(() => {
        if (!referenceModalOpen) return;
        setLibraryLoading(true);
        void listLibraryAssetPage({ page: 1, pageSize: 100, kind: "image" }).then((page) => setLibraryAssets(page.assets)).catch((error) => message.error(error instanceof Error ? error.message : "素材加载失败")).finally(() => setLibraryLoading(false));
    }, [referenceModalOpen, message]);

    useEffect(() => {
        if (!referenceModalOpen || assetTab !== "upload") return;
        const pasteImage = (event: ClipboardEvent) => {
            const file = Array.from(event.clipboardData?.files || []).find((item) => item.type.startsWith("image/"));
            if (!file) return;
            event.preventDefault();
            addReferenceFiles([file]);
        };
        document.addEventListener("paste", pasteImage);
        return () => document.removeEventListener("paste", pasteImage);
    }, [referenceModalOpen, assetTab, addReferenceFiles]);

    useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), 1000);
        void fetch("/api/model-generation-stats").then((response) => response.ok ? response.json() : null).then((data: { data?: typeof durationStats } | null) => { if (data?.data) setDurationStats(data.data); }).catch(() => undefined);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        setModel((previous) => {
            const available = currentKind === "image" ? config.imageModels : config.videoModels;
            if (previous && available.includes(previous)) return previous;
            return currentKind === "image" ? config.imageModel : config.videoModel;
        });
    }, [config.imageModel, config.imageModels, config.videoModel, config.videoModels, currentKind]);

    useEffect(() => {
        if (!ratioOptions.includes(ratio)) setRatio(ratioOptions.includes("16:9") ? "16:9" : ratioOptions[0] || "auto");
        if (currentKind === "image" && !currentQualityOptions.includes(quality)) setQuality(currentQualityOptions[0] || "low");
        if (currentKind === "video") {
            if (!currentVideoQualityOptions.includes(videoQuality)) setVideoQuality(currentVideoQualityOptions[0] || "auto");
            if (Number(seconds) < durationRange.min || Number(seconds) > durationRange.max || durationSnapPoints && !durationSnapPoints.includes(Number(seconds))) setSeconds(String(durationSnapPoints?.[0] || Math.max(durationRange.min, Math.min(durationRange.max, Number(seconds) || durationRange.min))));
        }
    }, [currentKind, currentQualityOptions.join("|"), currentVideoQualityOptions.join("|"), durationRange.min, durationRange.max, durationSnapPoints?.join("|"), quality, ratio, ratioOptions.join("|"), seconds, videoQuality]);
    useEffect(() => setCount((previous) => Math.min(previous, maxCount)), [maxCount]);

    const updatePrompt = (value: string, input: HTMLTextAreaElement) => {
        setPrompt(value);
        activePromptInput.current = input;
        if (composing.current) return;
        const match = value.slice(0, input.selectionStart).match(/@([^@\s]*)$/);
        setMentionQuery(referenceMentions.length && match ? match[1] : null);
    };
    const insertMention = (label: string) => {
        const input = activePromptInput.current || promptInputRef.current;
        if (!input) return;
        const before = prompt.slice(0, input.selectionStart);
        const from = before.lastIndexOf("@");
        if (from < 0) return;
        const next = `${prompt.slice(0, from)}@${label} ${prompt.slice(input.selectionStart)}`;
        setPrompt(next);
        setMentionQuery(null);
        requestAnimationFrame(() => { input.focus(); input.setSelectionRange(from + label.length + 2, from + label.length + 2); });
    };

    const loadLogs = useCallback(async (kind: "image" | "video" = resultKind) => {
        setLogsLoading(true);
        try {
            const search = new URLSearchParams({ kind, source: kind === "image" ? "image-workbench" : "video-workbench", page: "1", pageSize: "100" });
            const response = await fetch(`/api/generation-logs?${search}`, { cache: "no-store" });
            const data = (await response.json()) as { items?: GenerationLog[]; error?: string };
            if (!response.ok) throw new Error(data.error || "生成记录加载失败");
            if (mounted.current) setLogs(data.items || []);
        } catch (error) {
            if (mounted.current) message.error(error instanceof Error ? error.message : "生成记录加载失败");
        } finally {
            if (mounted.current) setLogsLoading(false);
        }
    }, [message, resultKind]);

    useEffect(() => { void loadLogs(resultKind); }, [loadLogs, resultKind]);
    useEffect(() => {
        if (!logs.some((log) => log.requestSnapshot?.slots.some((slot) => slot.status === "pending" && !slot.needsReview))) return;
        const interval = window.setInterval(() => void loadLogs(resultKind), 3000);
        return () => window.clearInterval(interval);
    }, [logs, loadLogs, resultKind]);
    useEffect(() => {
        const onVisibility = () => { if (document.visibilityState === "visible") void loadLogs(); };
        window.addEventListener("focus", onVisibility);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("focus", onVisibility);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [loadLogs]);

    const resultCards = useMemo<ResultCard[]>(() => logs.flatMap((log) => {
        const slots = log.requestSnapshot?.slots || [];
        return slots.map((slot) => ({ key: `${log.id}:${slot.id}`, log, slot, asset: slot.assetIndex === undefined ? undefined : log.assets[slot.assetIndex] }));
    }).filter((item) => statusFilter === "all" || item.slot.status === (statusFilter === "failed" ? "failed" : statusFilter)), [logs, statusFilter]);

    const submit = useCallback(async (regenerate?: ResultCard) => {
        const kind = regenerate?.log.kind || currentKind;
        const interior = kind === "image" && !regenerate ? interiorSettings : undefined;
        const nextPrompt = regenerate ? generationLogPublicPrompt(regenerate.log) : prompt.trim() || (interior ? "SU直出摄影级照片" : "");
        const nextModel = regenerate?.log.model || selectedModel;
        const parameters = regenerate?.slot.parameters || regenerate?.log.requestSnapshot?.parameters;
        const nextRatio = parameters?.size || ratio;
        const nextQuality = kind === "image" ? parameters?.quality || quality : parameters?.quality || videoQuality;
        const executionPrompt = regenerate?.slot.prompt || (interior ? `${compileInteriorDesignPrompt({ ...interior, aspectRatio: nextRatio, resolution: qualityLabels[nextQuality]?.split("·").at(-1)?.trim() || nextQuality })}${prompt.trim() ? `\n\n补充要求：${prompt.trim()}` : ""}` : nextPrompt);
        const nextSeconds = parameters?.seconds || seconds;
        const nextCount = regenerate ? 1 : kind === "image" ? count : 1;
        const nextSource = kind === "image" ? "image-workbench" : "video-workbench";
        const runningHubAppId = parameters?.runningHubAppId || (interior ? interiorApp?.id : undefined);
        if (!nextPrompt) return message.warning("请先描述你想生成的内容");
        if (interior && !referenceFiles.length && !referenceAssets.length) return message.warning("室内设计需要至少一张参考图片");
        if (interior && !runningHubAppId && !isInteriorDesignModel(config, nextModel)) return message.warning("室内设计仅支持已启用的 Gemini Nano Banana 生图模型");
        if (kind === "image" && nextCount > maxCount) return message.warning(`单次最多生成 ${maxCount} 张图片`);
        if (!nextModel || !runningHubAppId && !useConfigStore.getState().isAiConfigReady(config, nextModel)) {
            openConfigDialog(true);
            return;
        }
        setSubmitting(true);
        const logId = `${nextSource}:${nanoid()}`;
        try {
            const uploadedImages: ReferenceImage[] = regenerate ? (regenerate.log.requestSnapshot?.references || []).filter((item) => item.kind === "image" && item.url).map((item) => ({ id: item.id, name: item.name, type: item.mimeType, dataUrl: item.url!, url: item.url!, serverUrl: item.serverUrl || item.url, storageKey: item.storageKey, width: item.width, height: item.height })) : referenceAssets.filter((asset) => asset.kind === "image").map((asset) => ({ id: asset.id, name: asset.title, type: asset.data.mimeType, dataUrl: asset.data.serverUrl || asset.data.dataUrl, url: asset.data.serverUrl || asset.data.dataUrl, serverUrl: asset.data.serverUrl || asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height }));
            for (const file of regenerate ? [] : referenceFiles) {
                const uploaded = await uploadImage(file);
                uploadedImages.push({ id: nanoid(), name: file.name, type: file.type, dataUrl: uploaded.url, url: uploaded.url, serverUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height });
            }
            const taskCount = nextCount;
            const slots = Array.from({ length: taskCount }, (_, index) => ({
                id: nanoid(), index, status: "pending" as const, clientRequestId: `${nextSource}:${logId}:${index}:${nanoid()}`,
                prompt: executionPrompt, taskKind: interior || runningHubAppId || regenerate?.slot.taskKind === "edit" ? "edit" as const : "generation" as const, taskModel: nextModel, startedAt: Date.now(),
                parameters: { size: nextRatio, ...(kind === "image" ? { quality: nextQuality, ...(runningHubAppId ? { runningHubAppId } : {}) } : { quality: nextQuality, seconds: nextSeconds }) },
                referenceIds: uploadedImages.map((image) => image.id),
            }));
            const snapshot: GenerationLogRequestSnapshot = {
                version: 1,
                userPrompt: nextPrompt,
                parameters: { model: nextModel, size: nextRatio, count: String(taskCount), ...(kind === "image" ? { quality: nextQuality, ...(runningHubAppId ? { runningHubAppId } : {}) } : { quality: nextQuality, seconds: nextSeconds, generateAudio: parameters?.generateAudio || config.videoGenerateAudio, watermark: parameters?.watermark || config.videoWatermark }) },
                references: uploadedImages.map((image) => ({ id: image.id, kind: "image" as const, name: image.name, mimeType: image.type, url: image.serverUrl, storageKey: image.storageKey, width: image.width, height: image.height })),
                slots,
            };
            const createLog = await fetch("/api/generation-logs", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: logId, kind, source: nextSource, status: "pending", title: nextPrompt.slice(0, 80), prompt: nextPrompt, model: nextModel, count: taskCount, requestSnapshot: snapshot }),
            });
            const createdLog = (await createLog.json()) as { error?: string };
            if (!createLog.ok) throw new Error(createdLog.error || "生成记录创建失败");
            const requestConfig: AiConfig = { ...config, model: nextModel, imageModel: kind === "image" ? nextModel : config.imageModel, videoModel: kind === "video" ? nextModel : config.videoModel, size: nextRatio, quality: kind === "image" ? nextQuality : config.quality, count: String(taskCount), videoSeconds: nextSeconds, vquality: kind === "video" ? nextQuality : videoQuality };
            const watchers = slots.map(async (slot) => {
                const options = { clientRequestId: slot.clientRequestId, generationLogId: logId, generationSlotId: slot.id, logSource: "image-workbench" as const, source: "video-workbench" as const, logTitle: nextPrompt, publicPrompt: nextPrompt, ...(runningHubAppId ? { runningHubAppId } : {}) };
                try {
                    if (kind === "image") {
                        const task: ImageGenerationTask = await createImageGenerationTask(requestConfig, executionPrompt, uploadedImages, undefined, options);
                        void waitForImageGenerationTask(requestConfig, task, options).then(() => loadLogs("image")).catch(() => loadLogs("image"));
                    } else {
                        const task: VideoGenerationTask = await createVideoGenerationTask(requestConfig, nextPrompt, uploadedImages, [], [], options);
                        void waitForVideoGenerationTask(requestConfig, task, options).then(() => loadLogs("video")).catch(() => loadLogs("video"));
                    }
                } catch (error) {
                    if (error instanceof Error && "status" in error && Number((error as Error & { status?: number }).status) >= 400 && Number((error as Error & { status?: number }).status) < 500) {
                        await fetch("/api/generation-logs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "fail-draft-slot", id: logId, slotId: slot.id, clientRequestId: slot.clientRequestId, error: error.message }) }).catch(() => undefined);
                    }
                    message.error(error instanceof Error ? error.message : "生成任务创建失败");
                }
            });
            await Promise.all(watchers);
            setResultKind(kind);
            await loadLogs(kind);
            if (!regenerate) { setPrompt(""); setReferenceFiles([]); setReferenceAssets([]); }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成任务创建失败");
        } finally {
            setSubmitting(false);
        }
    }, [config, count, currentKind, interiorApp, interiorSettings, loadLogs, maxCount, message, openConfigDialog, prompt, quality, qualityLabels, ratio, seconds, selectedModel, videoQuality, referenceFiles, referenceAssets]);

    useEffect(() => {
        if (!autoSubmit || autoSubmitted.current) return;
        autoSubmitted.current = true;
        setAutoSubmit(false);
        void submit();
    }, [autoSubmit, submit]);

    const changeMode = (next: WorkMode) => {
        setMode(next);
        setResultKind(next);
        setModel(next === "image" ? config.imageModel : config.videoModel);
        window.history.replaceState(null, "", `/create?mode=${next}`);
    };

    const downloadOriginal = (item: LightboxItem | ResultCard) => {
        const asset = "asset" in item ? item.asset : undefined;
        const url = asset?.url || ("url" in item ? item.url : "");
        const mimeType = asset?.mimeType || ("mimeType" in item ? item.mimeType : undefined);
        if (!url) return;
        const downloadUrl = (asset?.type || ("kind" in item ? item.kind : "image")) === "image" ? originalImageDownloadUrl(url) : originalMediaDownloadUrl(url);
        saveAs(downloadUrl, mediaDownloadFileName("key" in item ? item.key : "dreamyo-result", mimeType, url));
    };

    const createCanvas = async (card: ResultCard) => {
        if (!card.asset?.url) return;
        try {
            const node = createWorkbenchCanvasNode({
                id: `${card.asset.type}-${nanoid()}`,
                asset: card.asset,
                prompt: generationLogPublicPrompt(card.log),
                model: card.log.model,
                size: card.log.requestSnapshot?.parameters.size || "1:1",
            });
            const project = await createCanvasProject({ title: (generationLogPublicPrompt(card.log) || "生成结果").slice(0, 32), project: { nodes: [node] } });
            router.push(`/canvas/${project.id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建画布失败");
        }
    };

    const deleteResult = (card: ResultCard) => {
        if (card.slot.status === "pending") return;
        modal.confirm({
            title: "删除这条生成结果？",
            content: "删除后无法从生成记录中恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                const response = await fetch("/api/generation-logs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete-results", id: card.log.id, slotIds: [card.slot.id] }) });
                if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "删除失败");
                await loadLogs(card.log.kind);
                message.success("已删除生成结果");
            },
        });
    };

    const setTheme = () => useThemeStore.getState().setTheme(themeName === "dark" ? "light" : "dark");
    return (
        <main className={styles.root} data-testid="image-video-workbench" data-theme={themeName}>
            <div className={styles.cosmicBackground} aria-hidden="true" /><div className={styles.cosmicGlow} aria-hidden="true" />
            <header className={styles.topbar}>
                <div className={styles.brandGroup}>
                    <button type="button" onClick={() => router.push("/")} className={styles.iconButton} aria-label="返回首页" title="返回首页"><ArrowLeft /></button>
                    <SiteLogo logoUrl="/brand/dreamyo/mark.png" className="size-7" />
                    <span className={styles.brandTitle}>图片 / 视频生成</span>
                </div>
                <div className={styles.topbarActions}>
                    <button type="button" className={styles.topLink} onClick={() => router.push("/canvas")}><Clapperboard />画布</button>
                    <button type="button" className={styles.topLink} onClick={() => router.push("/assets")}><FileImage />素材库</button>
                    <button type="button" className={styles.iconButton} onClick={setTheme} aria-label={themeName === "dark" ? "切换浅色主题" : "切换深色主题"} title="切换主题">{themeName === "dark" ? <Sun /> : <Moon />}</button>
                    <UserStatusActions variant="canvas" />
                </div>
            </header>

            <div className={styles.workspace}>
                <aside ref={promptPanelRef} className={styles.promptPanel}>
                    <div className={styles.panelHeading}>
                        <span className={styles.headingIcon}><ImagePlus /></span>
                        <div><h1>图像 / 视频生成</h1><p>用文字描述，创作静态图像与动态内容</p></div>
                    </div>
                    <div className={styles.modeTabs} role="group" aria-label="生成类型">
                        <button type="button" aria-pressed={mode === "image"} className={mode === "image" ? styles.activeTab : ""} onClick={() => changeMode("image")}>图片</button>
                        <button type="button" aria-pressed={mode === "video"} className={mode === "video" ? styles.activeTab : ""} onClick={() => changeMode("video")}>视频</button>
                    </div>
                    {mode === "image" ? <div className={styles.interiorEntryRow}><button type="button" className={styles.interiorEntry} onClick={() => { placeReferenceModal(); setInteriorModalOpen(true); }}><House /><span><strong>{interiorSettings ? interiorApp?.name || "SU直出摄影级照片" : "室内设计"}</strong><small>{interiorSettings ? "已配置 · 点击调整参数" : "SU 直出与摄影级空间渲染"}</small></span><ChevronDown /></button>{interiorSettings ? <button type="button" className={styles.interiorEntryClear} aria-label="移除室内设计配置" title="移除室内设计配置" onClick={() => { setInteriorSettings(undefined); setInteriorApp(undefined); }}><X /></button> : null}</div> : null}
                    <div className={styles.referenceRow}>
                        <div className={styles.referenceItems}>
                            {referenceAssets.map((asset) => asset.kind === "image" ? <div className={styles.referencePreview} key={asset.id}><img src={imagePreviewUrl(asset.coverUrl || asset.data.serverUrl || asset.data.dataUrl, 200)} alt={asset.title} /><button type="button" onClick={() => setReferenceAssets((items) => items.filter((item) => item.id !== asset.id))} aria-label={`移除参考素材 ${asset.title}`}><X /></button></div> : null)}
                            {referencePreviews.map((preview) => <div className={styles.referencePreview} key={preview.key}><img src={preview.url} alt={preview.name} /><button type="button" onClick={() => setReferenceFiles((items) => items.filter((item) => `${item.name}:${item.lastModified}:${item.size}` !== preview.key))} aria-label={`移除参考素材 ${preview.name}`}><X /></button></div>)}
                            <button type="button" className={styles.referenceButton} onClick={() => { placeReferenceModal(); setReferenceModalOpen(true); }}><span className={styles.referenceButtonIcons}><FileImage /><ImagePlus /></span><strong>{referenceAssets.length || referenceFiles.length ? "继续添加参考图" : "添加参考图片"}</strong><small>可添加多张图片</small></button>
                        </div>
                    </div>
                    <div className={styles.promptEditor}>
                        <textarea ref={promptInputRef} id="workbench-prompt" aria-label="提示词" className={styles.promptInput} value={prompt} maxLength={5000} onFocus={(event) => { activePromptInput.current = event.currentTarget; }} onChange={(event) => updatePrompt(event.target.value, event.target)} onCompositionStart={() => { composing.current = true; setMentionQuery(null); }} onCompositionEnd={(event) => { composing.current = false; updatePrompt(event.currentTarget.value, event.currentTarget); }} onKeyDown={(event) => { if (event.key === "Escape") setMentionQuery(null); }} placeholder={mode === "image" && interiorSettings ? "可选：补充室内设计要求… 输入 @ 引用参考图" : "描述你想创作的画面、风格、光线或镜头… 输入 @ 引用参考图"} />
                        <button type="button" className={styles.expandPrompt} aria-label="展开提示词" title="展开提示词" onClick={() => { setPromptExpanded(true); setMentionQuery(null); }}><Maximize2 /></button>
                        {mentionQuery !== null && mentionOptions.length ? <div className={styles.mentionMenu} role="listbox" aria-label="引用参考图片">{mentionOptions.map((item) => <button key={item.id} type="button" role="option" aria-selected={false} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(item.label)}><img src={item.url} alt="" /><span><strong>@{item.label}</strong><small>{item.name}</small></span></button>)}</div> : null}
                    </div>
                    <div className={styles.fieldBlock}>
                        <ModelPicker headerLabel="模型选择" popupTheme={themeName} popupPlacement="rightTop" config={modelPickerConfig} value={selectedModel} capability={capability} fullWidth className={styles.modelTrigger} onChange={setModel} onMissingConfig={() => openConfigDialog(true)} />
                    </div>
                    <div className={styles.compactOptions} aria-label="生成参数">
                        <WorkbenchOption name={currentKind === "image" ? "图片比例" : "视频比例"} value={ratio} open={activeOption === "ratio"} onOpen={(value) => setActiveOption(value ? "ratio" : null)} values={ratioOptions} selected={ratio} onSelect={setRatio} icon={ratioIcon(ratio)} optionIcon={ratioIcon} />
                        {currentKind === "image" ? <>
                            <WorkbenchOption name="画质" value={qualityLabels[quality] || quality} open={activeOption === "quality"} onOpen={(value) => setActiveOption(value ? "quality" : null)} values={currentQualityOptions} selected={quality} labels={qualityLabels} onSelect={setQuality} icon={<Diamond />} />
                            <CountOption count={count} max={maxCount} open={activeOption === "count"} onOpen={(value) => setActiveOption(value ? "count" : null)} onChange={setCount} />
                        </> : <>
                            <WorkbenchOption name="清晰度" value={videoQualityLabels[videoQuality] || videoQuality} open={activeOption === "videoQuality"} onOpen={(value) => setActiveOption(value ? "videoQuality" : null)} values={currentVideoQualityOptions} selected={videoQuality} labels={videoQualityLabels} onSelect={setVideoQuality} icon={<Diamond />} />
                            <DurationOption seconds={Number(seconds)} range={durationRange} snapPoints={durationSnapPoints} open={activeOption === "seconds"} onOpen={(value) => setActiveOption(value ? "seconds" : null)} onChange={(value) => setSeconds(String(value))} />
                        </>}
                    </div>
                    <div className={styles.submitArea}>
                        <button type="button" className={styles.generateButton} onClick={() => void submit()} disabled={submitting}>
                            {submitting ? <LoaderCircle className={styles.spin} /> : <Sparkles />}{submitting ? "正在提交…" : "立即生成"}<span className={styles.creditCost}>{formatCreditAmount(credits)} 积分</span>
                        </button>
                    </div>
                </aside>

                <section className={styles.resultsPanel} aria-label="生成结果">
                    <div className={styles.resultsHeader}>
                        <div className={styles.resultTabs} role="group" aria-label="结果类型">
                            <button type="button" aria-pressed={resultKind === "image"} className={resultKind === "image" ? styles.activeResultTab : ""} onClick={() => setResultKind("image")}><FileImage />图片生成</button>
                            <button type="button" aria-pressed={resultKind === "video"} className={resultKind === "video" ? styles.activeResultTab : ""} onClick={() => setResultKind("video")}><Video />视频生成</button>
                        </div>
                        <div className={styles.resultTools}><span>{resultCards.length} 项</span><select aria-label="生成状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="pending">生成中</option><option value="success">已完成</option><option value="failed">失败</option></select><button type="button" className={styles.refreshButton} onClick={() => void loadLogs()} aria-label="刷新生成列表"><LoaderCircle className={logsLoading ? styles.spin : ""} /></button></div>
                    </div>
                    <div className={styles.resultScroll} aria-busy={logsLoading}>
                        {resultCards.length ? <div className={styles.resultGrid}>
                            {resultCards.map((card) => <ResultTile key={card.key} card={card} now={now} averageMs={durationStats[card.log.model]?.avgDurationMs} onPreview={(item) => setLightbox(item)} onCreateCanvas={() => void createCanvas(card)} onDownload={() => downloadOriginal(card)} onRegenerate={() => void submit(card)} onDelete={() => void deleteResult(card)} />)}
                        </div> : <div className={styles.emptyState}><div><ImagePlus /></div><strong>{logsLoading ? "正在读取生成记录" : "这里会显示你的生成内容"}</strong><span>{logsLoading ? "正在从服务器恢复记录…" : "提交创作后，图片和视频会保存在此处"}</span></div>}
                    </div>
                </section>
            </div>

            <WorkbenchSideModal open={referenceModalOpen} onCancel={() => setReferenceModalOpen(false)} title="添加参考图片" themeName={themeName} placement={referencePlacement}>
                <div className={styles.assetTabs}><button type="button" aria-pressed={assetTab === "library"} onClick={() => setAssetTab("library")}>我的素材库</button><button type="button" aria-pressed={assetTab === "upload"} onClick={() => setAssetTab("upload")}>本机上传</button></div>
                {assetTab === "library" ? <div className={styles.assetGrid}>{libraryLoading ? <p>正在读取素材…</p> : libraryAssets.length ? libraryAssets.map((asset) => asset.kind === "image" ? <button key={asset.id} type="button" aria-pressed={referenceAssets.some((item) => item.id === asset.id)} onClick={() => setReferenceAssets((items) => items.some((item) => item.id === asset.id) ? items.filter((item) => item.id !== asset.id) : [...items, asset])}><img src={imagePreviewUrl(asset.coverUrl || asset.data.serverUrl || asset.data.dataUrl, 300)} alt={asset.title} /><span>{asset.title}</span></button> : null) : <p>素材库暂无图片，可切换到本机上传</p>}</div> : <div className={`${styles.uploadZone} ${dragging ? styles.uploadZoneActive : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addReferenceFiles(Array.from(event.dataTransfer.files)); }} onPaste={(event) => { addReferenceFiles(Array.from(event.clipboardData.files)); }} tabIndex={0}><Upload /><strong>拖拽、粘贴或选择图片</strong><span>支持 PNG、JPEG、WebP</span><label htmlFor="workbench-reference-file">选择文件</label><input id="workbench-reference-file" type="file" accept="image/*" multiple onChange={(event) => addReferenceFiles(Array.from(event.target.files || []))} hidden /></div>}
                {assetTab === "library" && referenceAssets.length ? <button type="button" className={styles.assetDone} onClick={() => setReferenceModalOpen(false)}>使用所选图片（{referenceAssets.length}）</button> : null}
            </WorkbenchSideModal>
            <WorkbenchSideModal open={interiorModalOpen} onCancel={() => setInteriorModalOpen(false)} title={<span className={styles.interiorModalTitle}><House />室内设计</span>} themeName={themeName} placement={interiorPlacement}>
                <ImageVideoInteriorDesignPanel initialSettings={interiorSettings} initialApp={interiorApp} onConfirm={(settings, app) => {
                    const available = interiorDesignModels(config);
                    if (!app && !available.length) return message.error("请先启用 Gemini Nano Banana 生图模型，再使用 SU 直出功能");
                    setInteriorSettings(settings);
                    setInteriorApp(app);
                    if (!app && !available.includes(selectedModel)) setModel(available[0]);
                    setInteriorModalOpen(false);
                }} />
            </WorkbenchSideModal>
            <Modal open={promptExpanded} onCancel={() => { setPromptExpanded(false); setMentionQuery(null); }} footer={null} title="编辑提示词" width="min(760px, calc(100vw - 24px))" centered destroyOnHidden className={`${styles.referenceModal} ${themeName === "dark" ? styles.lightboxModalDark : ""}`}>
                <div className={styles.expandedPromptWrap}>
                    <textarea aria-label="展开的提示词" className={styles.expandedPrompt} value={prompt} maxLength={5000} onFocus={(event) => { activePromptInput.current = event.currentTarget; }} onChange={(event) => updatePrompt(event.target.value, event.target)} onCompositionStart={() => { composing.current = true; setMentionQuery(null); }} onCompositionEnd={(event) => { composing.current = false; updatePrompt(event.currentTarget.value, event.currentTarget); }} placeholder="描述画面与镜头；输入 @ 引用参考图片" />
                    {mentionQuery !== null && mentionOptions.length ? <div className={styles.mentionMenu} role="listbox" aria-label="引用参考图片">{mentionOptions.map((item) => <button key={item.id} type="button" role="option" aria-selected={false} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(item.label)}><img src={item.url} alt="" /><span><strong>@{item.label}</strong><small>{item.name}</small></span></button>)}</div> : null}
                </div>
            </Modal>
            <Modal open={Boolean(lightbox)} onCancel={() => setLightbox(undefined)} footer={null} closable={false} width="min(1680px, calc(100vw - 24px))" centered destroyOnHidden className={styles.lightboxModal} styles={{ container: { padding: 0, background: "transparent", boxShadow: "none" }, body: { padding: 0 } }}>
                {lightbox ? <div className={styles.lightboxContent}>
                    <div className={styles.lightboxToolbar}><strong title={lightbox.title}>{lightbox.title}</strong><div className={styles.lightboxActions}><button type="button" onClick={() => downloadOriginal(lightbox)}><Download />下载原图</button><button type="button" aria-label="关闭预览" onClick={() => setLightbox(undefined)}><X /></button></div></div>
                    {lightbox.kind === "image" ? <img src={imagePreviewUrl(lightbox.url, 2000)} alt={lightbox.title} /> : <video src={lightbox.url} controls autoPlay />}
                </div> : null}
            </Modal>
        </main>
    );
}

function ratioIcon(value: string) {
    if (value === "auto" || value === "1:1" || value === "1024x1024") return <Square />;
    if (["9:16", "3:4", "2:3", "4:5", "1024x1536"].includes(value)) return <RectangleVertical />;
    return <RectangleHorizontal />;
}

function WorkbenchSideModal({ open, onCancel, title, themeName, placement, children }: { open: boolean; onCancel: () => void; title: ReactNode; themeName: "light" | "dark"; placement: { left: number; top: number; width: number; height: number }; children: ReactNode }) {
    return <Modal open={open} onCancel={onCancel} footer={null} title={title} width={placement.width} mask={false} destroyOnHidden className={`${styles.referenceModal} ${themeName === "dark" ? styles.lightboxModalDark : ""}`} style={{ top: placement.top, marginLeft: placement.left, marginRight: 0, paddingBottom: 0 }} styles={{ container: { height: placement.height, display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--wb-border)", borderRadius: 20, background: "var(--wb-surface)", boxShadow: "0 22px 70px rgba(6, 10, 28, .28)" }, header: { background: "transparent" }, title: { color: "var(--wb-text)" }, close: { color: "var(--wb-text)" }, body: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" } }}>{children}</Modal>;
}

function OptionPopover({ open, onOpen, children, content }: { open: boolean; onOpen: (open: boolean) => void; children: ReactNode; content: ReactNode }) {
    return <Popover open={open} onOpenChange={onOpen} trigger="click" placement="topLeft" arrow={false} autoAdjustOverflow getPopupContainer={() => document.body} zIndex={1200} styles={{ container: { padding: 0, border: 0, background: "transparent", boxShadow: "none", overflow: "visible" } }} content={content}>{children}</Popover>;
}

function WorkbenchOption<T extends string | number>({ name, value, open, onOpen, values, selected, labels, onSelect, icon, optionIcon }: { name: string; value: string; open: boolean; onOpen: (open: boolean) => void; values: T[]; selected: T; labels?: Record<string, string>; onSelect: (value: T) => void; icon?: ReactNode; optionIcon?: (value: string) => ReactNode }) {
    const themeName = useThemeStore((state) => state.theme);
    const ratio = name.includes("比例");
    const content = <div className={`${styles.optionMenu} ${themeName === "dark" ? styles.optionMenuDark : ""} ${ratio ? styles.ratioMenu : ""}`} style={canvasSelectionBorderStyle(canvasThemes[themeName].toolbar.panel)} role="listbox" aria-label={name}>{values.map((option) => <button key={String(option)} type="button" role="option" aria-selected={option === selected} onClick={() => { onSelect(option); onOpen(false); }}>{optionIcon?.(String(option))}<span>{labels?.[String(option)] || (ratio && option === "auto" ? "自适应" : String(option))}</span>{option === selected ? <Check /> : null}</button>)}</div>;
    return <OptionPopover open={open} onOpen={onOpen} content={content}><button type="button" className={styles.optionTrigger} aria-expanded={open} aria-label={`${name}：${value}`}>{icon}<strong>{value}</strong><ChevronDown /></button></OptionPopover>;
}

function CountOption({ count, max, open, onOpen, onChange }: { count: number; max: number; open: boolean; onOpen: (open: boolean) => void; onChange: (count: number) => void }) {
    const themeName = useThemeStore((state) => state.theme);
    const content = <div className={`${styles.optionMenu} ${styles.countMenu} ${themeName === "dark" ? styles.optionMenuDark : ""}`} style={canvasSelectionBorderStyle(canvasThemes[themeName].toolbar.panel)} aria-label="生成数量"><button type="button" aria-label="减少数量" disabled={count <= 1} onClick={() => onChange(Math.max(1, count - 1))}><Minus /></button><input aria-label="自定义生成数量" type="number" min={1} max={max} value={count} onChange={(event) => onChange(Math.min(max, Math.max(1, Number(event.target.value) || 1)))} /><button type="button" aria-label="增加数量" disabled={count >= max} onClick={() => onChange(Math.min(max, count + 1))}><Plus /></button><small>最多 {max} 张</small></div>;
    return <OptionPopover open={open} onOpen={onOpen} content={content}><button type="button" className={styles.optionTrigger} aria-expanded={open} aria-label={`生成数量：${count}`}><Images /><strong>{count} 张</strong><ChevronDown /></button></OptionPopover>;
}

function DurationOption({ seconds, range, snapPoints, open, onOpen, onChange }: { seconds: number; range: { min: number; max: number }; snapPoints?: readonly number[]; open: boolean; onOpen: (open: boolean) => void; onChange: (value: number) => void }) {
    const themeName = useThemeStore((state) => state.theme);
    const clamp = (value: number) => Math.min(range.max, Math.max(range.min, Math.round(value)));
    const snap = (value: number) => snapPoints?.length ? snapPoints.reduce((nearest, point) => Math.abs(point - value) < Math.abs(nearest - value) ? point : nearest) : clamp(value);
    const content = <div className={`${styles.optionMenu} ${styles.durationMenu} ${themeName === "dark" ? styles.optionMenuDark : ""}`} style={canvasSelectionBorderStyle(canvasThemes[themeName].toolbar.panel)} role="dialog" aria-label="选择视频时长"><div className={styles.durationHeading}><strong>视频时长</strong><span>{seconds} 秒</span></div><input aria-label="拖动选择视频时长" type="range" min={range.min} max={range.max} step={1} value={seconds} onChange={(event) => onChange(snap(Number(event.target.value)))} /><div className={styles.durationMarks}><span>{range.min}s</span>{snapPoints?.filter((point) => point > range.min && point < range.max).map((point) => <span key={point}>{point}s</span>)}<span>{range.max}s</span></div><label>自定义秒数<input aria-label="输入视频时长" type="number" inputMode="numeric" min={range.min} max={range.max} value={seconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) onChange(snap(clamp(value))); }} /></label></div>;
    return <OptionPopover open={open} onOpen={onOpen} content={content}><button type="button" className={styles.optionTrigger} aria-expanded={open} aria-label={`视频时长：${seconds} 秒`}><Video /><strong>{seconds} 秒</strong><ChevronDown /></button></OptionPopover>;
}

function ResultTile({ card, now, averageMs, onPreview, onCreateCanvas, onDownload, onRegenerate, onDelete }: { card: ResultCard; now: number; averageMs?: number; onPreview: (item: LightboxItem) => void; onCreateCanvas: () => void; onDownload: () => void; onRegenerate: () => void; onDelete: () => void }) {
    const { log, slot, asset } = card;
    const status = slot.status;
    const prompt = generationLogPublicPrompt(log);
    const mediaUrl = asset?.url || "";
    const preview = () => { if (asset) onPreview({ kind: asset.type, url: asset.url, mimeType: asset.mimeType, title: prompt || log.title }); };
    const progress = estimateCanvasProgress(now - (slot.startedAt || new Date(log.createdAt).getTime()), log.kind, averageMs);
    const statusLabel = slot.needsReview ? "结果待确认" : status === "success" ? "已完成" : status === "failed" ? "生成失败" : slot.displayPhase === "preparing" ? "准备中" : slot.displayPhase === "queued" ? "排队中" : "生成中";
    return <article className={styles.resultCard} data-status={status}>
        <div className={styles.mediaFrame}>
            {asset && mediaUrl ? asset.type === "image" ? <img src={imagePreviewUrl(mediaUrl, 1000)} alt={prompt || log.title} loading="lazy" /> : <video src={mediaUrl} controls preload="metadata" aria-label={prompt || log.title} /> : <div className={styles.pendingMedia}>{status === "pending" && !slot.needsReview ? <><video src="/animations/generation-loading-animation.mp4" autoPlay loop muted playsInline aria-hidden="true" /><span className={styles.progressRing}>{progress.percent}%</span></> : <ImagePlus />}<strong>{statusLabel}</strong>{slot.needsReview ? <small>{slot.reviewReason}</small> : status === "pending" ? <small>已等待 {progress.elapsed}{averageMs ? ` · 平均 ${Math.round(averageMs / 1000)} 秒` : ""}</small> : slot.error ? <small>{slot.error}</small> : null}</div>}
            <span className={`${styles.statusBadge} ${status === "success" ? styles.statusSuccess : status === "failed" ? styles.statusFailed : styles.statusPending}`}>{status === "success" ? <Check /> : status === "pending" ? <LoaderCircle className={styles.spin} /> : <X />}{statusLabel}</span>
            {asset ? <>
                <div className={styles.mediaOverlay}>
                    <button type="button" onClick={preview} data-tooltip="查看大图" aria-label="查看大图"><ZoomIn /></button>
                    <button type="button" onClick={onCreateCanvas} data-tooltip="创建画布" aria-label="创建画布"><Clapperboard /></button>
                    <button type="button" onClick={onDownload} data-tooltip="下载原图" aria-label="下载原图"><Download /></button>
                </div>
            </> : null}
        </div>
        <div className={styles.cardMeta}><div className={styles.cardText}><div className={styles.cardTitle} title={prompt || log.title}>{prompt || log.title || "生成任务"}</div><time dateTime={log.createdAt}>{new Date(log.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></div><Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: [
            { key: "canvas", label: "导入画布", disabled: !asset },
            { key: "download", label: "下载原图", disabled: !asset },
            { key: "regenerate", label: "重新生成", disabled: status === "pending" },
            { key: "delete", label: "删除", danger: true, disabled: status === "pending" },
        ], onClick: ({ key }) => { if (key === "canvas") onCreateCanvas(); else if (key === "download") onDownload(); else if (key === "regenerate") onRegenerate(); else if (key === "delete") onDelete(); } }}><button type="button" className={styles.cardMenuButton} aria-label="生成结果操作" title="更多操作"><Ellipsis /></button></Dropdown></div>
    </article>;
}
