import type { AiTextMessage } from "@/types/ai";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasConnection, type CanvasNodeData, type CanvasVideoFrameSelection } from "../types";
import { getGenerationResourceNodes } from "../utils/canvas-resource-references";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    /** A direct, unambiguous video-to-video handoff. The source video itself is
     * intentionally not sent as a regular video reference. */
    continuityFirstFrame?: CanvasVideoFrameSelection;
    /** The direct source is valid, but its server-side tail frame is not ready.
     * Callers must wait rather than silently downgrade it into a video reference. */
    continuityPending?: boolean;
    continuityError?: string;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
    continuityFirstFrame?: CanvasVideoFrameSelection;
    continuityPending?: boolean;
    continuityError?: string;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt);
    }

    const upstreamText = inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const continuityFirstFrame = inputs.find((input) => input.continuityFirstFrame)?.continuityFirstFrame;
    const pendingContinuity = inputs.find((input) => input.continuityPending);

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
        continuityFirstFrame,
        continuityPending: Boolean(pendingContinuity),
        continuityError: pendingContinuity?.continuityError,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const inputByMention = new Map<string, NodeGenerationInput>();
    const mentionCounts = { image: 0, video: 0, audio: 0, text: 0 };
    inputs.forEach((input) => inputByMention.set(`@${generationLabel(input.type, mentionCounts[input.type]++)}`, input));
    const selectedInputs: NodeGenerationInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]|@(图片|视频|音频|文本)(\d+)/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = match[1] ? inputByNodeId.get(match[1]) : inputByMention.get(match[0]);
        if (input) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = generationLabel(input.type, counts[input.type]++);
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else selectedInputs.push(input);
            }
            nextPrompt += input.type === "text" ? `【${label}】` : label;
        } else nextPrompt += match[0];
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    const resources = getGenerationResourceNodes(nodeId, nodes, connections);
    const target = nodes.find((node) => node.id === nodeId);
    const directInputs = connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node));
    const directVideoContinuation =
        target?.type === CanvasNodeType.Video &&
        !target.metadata?.videoFirstFrame &&
        !target.metadata?.videoLastFrame &&
        directInputs.length === 1 &&
        directInputs[0]?.type === CanvasNodeType.Video &&
        resources.some((node) => node.id === directInputs[0]?.id)
            ? directInputs[0]
            : undefined;

    return resources.flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
        const continuation = node.id === directVideoContinuation?.id ? readVideoTailFrame(node) : null;
        if (continuation) return [{ nodeId: node.id, type: "image" as const, title: node.title, image: continuation.image, continuityFirstFrame: continuation.selection }];
        if (node.id === directVideoContinuation?.id) {
            return [{ nodeId: node.id, type: "video" as const, title: node.title, continuityPending: true, continuityError: node.metadata?.videoFrameExtractionError }];
        }
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
        return [];
    });
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return seedanceReferenceLabel("video", index);
    if (type === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (!isCanvasImageNodeType(node.type) || !node.metadata?.content) return null;
    const content = node.metadata.content;
    const remoteUrl = isRemoteGeneratedUrl(node.metadata.remoteUrl || "") ? node.metadata.remoteUrl || "" : isRemoteGeneratedUrl(content) ? content : "";
    const serverUrl = isServerGeneratedUrl(node.metadata.serverUrl || "") ? node.metadata.serverUrl || "" : isServerGeneratedUrl(content) ? content : "";
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: content,
        storageKey: node.metadata.storageKey,
        url: serverUrl || remoteUrl || undefined,
        width: node.metadata.naturalWidth || node.width,
        height: node.metadata.naturalHeight || node.height,
    };
}

function isRemoteGeneratedUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

function isServerGeneratedUrl(value: string) {
    return value.startsWith("/api/generation-log-assets/");
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readVideoTailFrame(node: CanvasNodeData): { image: ReferenceImage; selection: CanvasVideoFrameSelection } | null {
    const selection = node.metadata?.videoFrameExtraction?.lastFrame;
    const source = selection?.serverUrl || selection?.remoteUrl || selection?.previewUrl || selection?.source || "";
    if (!selection || !source) return null;
    return {
        selection,
        image: {
            id: `${node.id}:tail-frame`,
            name: `${node.title || node.id} 尾帧.jpg`,
            type: selection.mimeType || "image/jpeg",
            dataUrl: source,
            url: selection.serverUrl || selection.remoteUrl || undefined,
            storageKey: selection.storageKey,
            remoteUrl: selection.remoteUrl,
            serverUrl: selection.serverUrl,
            width: selection.width,
            height: selection.height,
        },
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
