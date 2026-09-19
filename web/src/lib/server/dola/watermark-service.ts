import { authorizeCanvasVideoSource } from "@/lib/server/canvas-video-source-service";
import { resolveDolaProxyEgress } from "./proxy";
import { resolveDolaWatermarkUrlRemote } from "./watermark-url";

export async function createDolaWatermarkResolution(input: { ownerUserId: string; storageKey?: string; payload: unknown }) {
    if (input.storageKey) {
        try {
            await authorizeCanvasVideoSource({ ownerUserId: input.ownerUserId, storageKey: input.storageKey });
        } catch {
            if (!input.ownerUserId) throw new Error("未登录或无权操作");
        }
    } else if (!input.ownerUserId) {
        throw new Error("未登录或无权操作");
    }
    if (!input.payload || typeof input.payload !== "object") throw new Error("Dola 原始视频信息无效");
    let serialized = "";
    try {
        serialized = JSON.stringify(input.payload);
    } catch {
        throw new Error("Dola 原始视频信息无效");
    }
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("Dola 原始视频信息过大");
    const proxy = await resolveDolaProxyEgress();
    return resolveDolaWatermarkUrlRemote(input.payload, { proxyUrl: proxy.proxyUrl });
}
