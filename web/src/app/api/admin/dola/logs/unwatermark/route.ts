import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { DolaWatermarkError } from "@/lib/server/dola/watermark-url";
import { getDolaTaskVideoLinks } from "@/lib/server/dola/task-video-links";

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
        const links = await getDolaTaskVideoLinks(taskId);
        await auditDolaAdminAction(request, access.user, "admin.dola.log.unwatermark", { type: "dola_task", id: taskId });
        return apiSuccess(links, "已取回视频地址");
    } catch (error) {
        console.warn(`[dola-unwatermark] 任务 ${taskId} 取回失败：`, error instanceof Error ? error.message : error);
        await auditDolaAdminFailure(request, access.user, "admin.dola.log.unwatermark", { type: "dola_task", id: taskId });
        // 透出具体失败原因（错误码 + 说明），避免后台只有一句通用失败。
        if (error instanceof DolaWatermarkError) return apiCompatError(502, `取回失败：${error.message}`);
        return dolaRouteError(error, "取回无水印视频失败");
    }
}
