import { dolaRuntimeRequest } from "@/lib/server/dola/provider";
import { resolveDolaWatermarkUrlRemote } from "@/lib/server/dola/watermark-url";

export async function getDolaTaskVideoLinks(taskId: string) {
    const response = await dolaRuntimeRequest(`/v1/videos/${encodeURIComponent(taskId)}`, { method: "GET" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") throw new Error(`Dola 任务查询失败（HTTP ${response.status}）`);
    const record = payload as Record<string, unknown>;
    // The top-level videoUrl is the playback link; the VOD metadata signs the original download.
    const resolved = await resolveDolaWatermarkUrlRemote(record.vodPayload ?? payload);
    return {
        taskId,
        videoUrl: typeof record.videoUrl === "string" ? record.videoUrl : typeof record.video_url === "string" ? record.video_url : "",
        downloadUrl: resolved.downloadUrl,
        definition: resolved.variant.definition || "",
        codecType: resolved.variant.codecType || "",
    };
}
