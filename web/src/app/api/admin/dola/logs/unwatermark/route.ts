import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { dolaRuntimeRequest } from "@/lib/server/dola/provider";
import { DolaWatermarkError, resolveDolaWatermarkUrlRemote } from "@/lib/server/dola/watermark-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 生成完成后前端未正常取回的视频，可在请求日志里按上游任务 ID 重新取回无水印地址。 */
export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ taskId?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const taskId = typeof parsed.data.taskId === "string" ? parsed.data.taskId.trim().slice(0, 300) : "";
    if (!taskId) return apiCompatError(400, "缺少上游任务 ID");
    try {
        const response = await dolaRuntimeRequest(`/v1/videos/${encodeURIComponent(taskId)}`, { method: "GET" });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let payload: unknown;
        try {
            payload = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            payload = null;
        }
        if (!response.ok || !payload || typeof payload !== "object") {
            console.warn(`[dola-unwatermark] 任务 ${taskId} Provider 查询失败：HTTP ${response.status}`);
            return apiCompatError(502, `Dola 任务查询失败（HTTP ${response.status}），无法取回视频`);
        }
        // 与生成链路 resolveDolaResultUrl 对齐：优先用 vodPayload 子对象解析。
        // 若传完整响应，extractDolaFallbackApi 的深度优先遍历会先命中顶层 videoUrl
        //（带水印播放地址）并误当 fallback_api，导致 CDN 回 MP4 而非 JSON 变体列表。
        const record = payload as Record<string, unknown>;
        const vodPayload = record.vodPayload ?? payload;
        const resolved = await resolveDolaWatermarkUrlRemote(vodPayload);
        await auditDolaAdminAction(request, access.user, "admin.dola.log.unwatermark", { type: "dola_task", id: taskId });
        return apiSuccess({ taskId, downloadUrl: resolved.downloadUrl, definition: resolved.variant.definition || "", codecType: resolved.variant.codecType || "" }, "已取回无水印视频地址");
    } catch (error) {
        console.warn(`[dola-unwatermark] 任务 ${taskId} 取回失败：`, error instanceof Error ? error.message : error);
        await auditDolaAdminFailure(request, access.user, "admin.dola.log.unwatermark", { type: "dola_task", id: taskId });
        // 透出具体失败原因（错误码 + 说明），避免后台只有一句通用失败。
        if (error instanceof DolaWatermarkError) return apiCompatError(502, `取回失败：${error.message}`);
        return dolaRouteError(error, "取回无水印视频失败");
    }
}
