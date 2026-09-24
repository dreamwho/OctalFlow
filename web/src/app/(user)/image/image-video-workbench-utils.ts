import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";

export type WorkbenchCanvasAsset = {
    type: "image" | "video";
    url: string;
    remoteUrl?: string;
    serverUrl?: string;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
};

export function createWorkbenchCanvasNode(input: { id: string; asset: WorkbenchCanvasAsset; prompt: string; model: string; size: string }): CanvasNodeData {
    const isVideo = input.asset.type === "video";
    const measuredWidth = positiveDimension(input.asset.width);
    const measuredHeight = positiveDimension(input.asset.height);
    const scale = measuredWidth && measuredHeight ? Math.min(420 / measuredWidth, 420 / measuredHeight) : 1;
    const width = measuredWidth && measuredHeight ? Math.round(measuredWidth * scale) : isVideo ? 420 : 340;
    const height = measuredWidth && measuredHeight ? Math.round(measuredHeight * scale) : isVideo ? 236 : 340;

    return {
        id: input.id,
        type: isVideo ? CanvasNodeType.Video : CanvasNodeType.Image,
        title: isVideo ? "生成视频" : "生成图片",
        position: { x: 260, y: 220 },
        width,
        height,
        metadata: {
            content: input.asset.url,
            serverUrl: input.asset.serverUrl,
            remoteUrl: input.asset.remoteUrl,
            storageKey: input.asset.storageKey,
            bytes: input.asset.bytes,
            naturalWidth: measuredWidth,
            naturalHeight: measuredHeight,
            prompt: input.prompt,
            model: input.model,
            size: input.size,
            status: "success",
            mimeType: input.asset.mimeType,
        },
    };
}

function positiveDimension(value: number | undefined) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
