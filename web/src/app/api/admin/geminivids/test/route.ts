import { apiSuccess } from "@/app/api/_shared/api-response";
import { apiCompatError } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { geminiVidsVideoStatus, geminiVidsVideoTest } from "@/lib/server/geminivids-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const body = await readGeminiVidsAdminJson<{ prompt?: string; aspectRatio?: string; resolution?: string; durationSeconds?: number; imageDataUrl?: string }>(request);
    try {
        const data = await geminiVidsVideoTest(body);
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.test.create", { type: "geminivids_provider", id: "primary" });
        return apiSuccess(data);
    } catch (error) {
        return geminiVidsRouteError(error, "创建 GeminiVids 测试任务失败");
    }
}

export async function GET(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId") || "";
    if (!taskId) return apiCompatError(400, "缺少 taskId");
    if (url.searchParams.get("media") === "1") {
        // 管理员直连测试任务不经过生成任务管道，媒体预览走专用流式端点
        try {
            const { geminiVidsSidecarRequest } = await import("@/lib/server/geminivids-provider");
            const upstream = await geminiVidsSidecarRequest(`/v1/videos/${encodeURIComponent(taskId)}/content`, { method: "GET" }, { skipLog: true });
            if (!upstream.ok) return apiCompatError(upstream.status, "测试视频尚未就绪");
            return new Response(upstream.body, { headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
        } catch (error) {
            return geminiVidsRouteError(error, "读取测试视频失败");
        }
    }
    try {
        return apiSuccess(await geminiVidsVideoStatus(taskId));
    } catch (error) {
        return geminiVidsRouteError(error, "查询 GeminiVids 测试任务失败");
    }
}
