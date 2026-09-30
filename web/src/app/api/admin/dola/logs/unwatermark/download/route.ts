import { apiCompatError } from "@/app/api/_shared/api-response";
import { requireDolaAdmin } from "@/lib/server/dola/admin";
import { getDolaTaskVideoLinks } from "@/lib/server/dola/task-video-links";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

export async function GET(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access && access.error) return access.error;
    const taskId = new URL(request.url).searchParams.get("taskId") || "";
    if (!/^[\w-]{1,100}$/.test(taskId)) return apiCompatError(400, "任务 ID 无效");
    try {
        const { downloadUrl } = await getDolaTaskVideoLinks(taskId);
        const upstream = await fetchSafeOutbound(downloadUrl, { method: "GET", cache: "no-store" }, { allowProxyFakeIpSpace: true });
        if (!upstream.ok || !upstream.body) return apiCompatError(502, `视频下载失败（HTTP ${upstream.status}）`);
        const contentType = upstream.headers.get("content-type") || "";
        if (!/video\/|application\/octet-stream/i.test(contentType)) {
            await upstream.body.cancel();
            return apiCompatError(502, "上游返回的不是视频文件");
        }
        if (Number(upstream.headers.get("content-length") || 0) > MAX_VIDEO_BYTES) {
            await upstream.body.cancel();
            return apiCompatError(413, "视频文件超过下载限制");
        }
        let received = 0;
        const bounded = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > MAX_VIDEO_BYTES) throw new Error("视频文件超过下载限制");
                controller.enqueue(chunk);
            },
        }));
        return new Response(bounded, { headers: {
            "Content-Type": "video/mp4",
            "Content-Disposition": `attachment; filename="${taskId}.mp4"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        } });
    } catch (error) {
        return apiCompatError(502, error instanceof Error ? error.message : "视频下载失败");
    }
}
