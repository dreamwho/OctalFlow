import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { clearGeminiToolsRequestLogs, listGeminiToolsRequestLogs } from "@/lib/server/gemini-tools-store";

export async function GET(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    const url = new URL(request.url);
    const model = url.searchParams.get("model")?.trim() || undefined;
    const accountId = url.searchParams.get("accountId")?.trim() || undefined;
    const protocol = url.searchParams.get("protocol")?.trim() || undefined;
    return apiSuccess(
        await listGeminiToolsRequestLogs({
            page: Number(url.searchParams.get("page") || 1),
            pageSize: Number(url.searchParams.get("pageSize") || 20),
            keyword: url.searchParams.get("keyword") || undefined,
            status: url.searchParams.get("status") === "success" || url.searchParams.get("status") === "failed" ? (url.searchParams.get("status") as "success" | "failed") : undefined,
            model,
            accountId,
            protocol,
        }),
    );
}

export async function DELETE(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const count = await clearGeminiToolsRequestLogs();
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.logs.clear", { type: "request_log_collection" }, { count });
        return apiSuccess({ count }, "请求日志已清空");
    } catch (error) {
        return geminiToolsRouteError(error, "清空请求日志失败");
    }
}
