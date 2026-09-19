"use client";

import { mediaDownloadFileName } from "@/lib/media-file";
import { getServerMediaBlob } from "@/services/server-media-storage";
import type { CanvasNodeData } from "../types";

export async function prepareCanvasNodeDownload(node: CanvasNodeData) {
    const metadata = node.metadata;
    const fallback = metadata?.serverUrl || metadata?.content || "";
    const source = metadata?.storageKey || fallback;
    if (!source) throw new Error("没有可下载的媒体文件");

    const blob = await getServerMediaBlob(source, fallback);
    if (!blob?.size) throw new Error("媒体文件读取失败");

    const mimeType = blob.type || metadata?.mimeType || "application/octet-stream";
    return {
        blob: blob.type ? blob : new Blob([blob], { type: mimeType }),
        fileName: mediaDownloadFileName(node.id, mimeType, metadata?.storageKey || fallback),
    };
}
