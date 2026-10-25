import type { Asset } from "@/lib/library-asset-contract";
import type { GenerationLogReferenceSnapshot } from "@/lib/generation-log-snapshot";
import type { CanvasResourceReference } from "@/app/(user)/canvas/utils/canvas-resource-references";

export function workbenchMediaKind(mimeType: string): "image" | "video" | "audio" | undefined {
    return mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : undefined;
}

export function workbenchAssetReference(asset: Exclude<Asset, { kind: "text" }>): GenerationLogReferenceSnapshot {
    return { id: asset.id, kind: asset.kind, name: asset.title, mimeType: asset.data.mimeType, url: asset.data.serverUrl || (asset.kind === "image" ? asset.data.dataUrl : asset.data.url), storageKey: asset.data.storageKey, bytes: asset.data.bytes, ...("width" in asset.data ? { width: asset.data.width, height: asset.data.height } : { durationMs: asset.data.durationMs }) };
}

export function labelWorkbenchReferences(references: CanvasResourceReference[]) {
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    const labels = { image: "图片", video: "视频", audio: "音频", text: "文本" };
    return references.map((item) => ({ ...item, label: `${labels[item.kind]}${++counts[item.kind]}` }));
}

export function workbenchVideoReferences(references: GenerationLogReferenceSnapshot[]) {
    return {
        images: references.filter((item) => item.kind === "image" && item.url).map((item) => ({ id: item.id, name: item.name, type: item.mimeType, videoRole: item.role, dataUrl: item.url!, url: item.url, serverUrl: item.serverUrl || item.url, storageKey: item.storageKey, width: item.width, height: item.height })),
        videos: references.filter((item) => item.kind === "video" && item.url).map((item) => ({ id: item.id, name: item.name, type: item.mimeType, role: item.role, url: item.url!, storageKey: item.storageKey, width: item.width, height: item.height, bytes: item.bytes, durationMs: item.durationMs })),
        audios: references.filter((item) => item.kind === "audio" && item.url).map((item) => ({ id: item.id, name: item.name, type: item.mimeType, role: item.role, url: item.url!, storageKey: item.storageKey, durationMs: item.durationMs })),
    };
}
