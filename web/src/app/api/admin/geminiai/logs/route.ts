import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { clearGeminiAiRequestLogs, listGeminiAiRequestLogs, type GeminiAiRequestCapability } from "@/lib/server/geminiai-request-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const search = new URL(request.url).searchParams;
        const capability = search.get("capability");
        const data = await listGeminiAiRequestLogs({
            page: numberParam(search.get("page"), 1),
            pageSize: numberParam(search.get("pageSize"), 20),
            keyword: search.get("keyword") || undefined,
            status: search.get("status") === "success" || search.get("status") === "failed" ? (search.get("status") as "success" | "failed") : undefined,
            capability: capability === "text" || capability === "image" || capability === "search" ? (capability as GeminiAiRequestCapability) : undefined,
        });
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.logs.view", { type: "geminiai_request_log" });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.logs.view", { type: "geminiai_request_log" });
        return geminiAiRouteError(error, "读取 GeminiAIStudio 请求日志失败");
    }
}

export async function DELETE(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const deletedCount = await clearGeminiAiRequestLogs();
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.logs.clear", { type: "geminiai_request_log" }, { deletedCount });
        return apiSuccess({ deletedCount }, "GeminiAIStudio 请求日志已清空");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.logs.clear", { type: "geminiai_request_log" });
        return geminiAiRouteError(error, "清空 GeminiAIStudio 请求日志失败");
    }
}

function numberParam(value: string | null, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
