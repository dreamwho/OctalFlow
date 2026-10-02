import { apiSuccess } from "@/app/api/_shared/api-response";
import { geminiVidsRouteError, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { clearGeminiVidsRequestLogs, listGeminiVidsRequestLogs } from "@/lib/server/geminivids-request-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const url = new URL(request.url);
    try {
        const data = await listGeminiVidsRequestLogs({
            keyword: url.searchParams.get("keyword") || undefined,
            status: url.searchParams.get("status") || undefined,
            source: url.searchParams.get("source") || undefined,
            model: url.searchParams.get("model") || undefined,
            accountId: url.searchParams.get("accountId") || undefined,
            page: Number(url.searchParams.get("page")) || undefined,
            pageSize: Number(url.searchParams.get("pageSize")) || undefined,
        });
        return apiSuccess(data);
    } catch (error) {
        return geminiVidsRouteError(error, "读取 GeminiVids 请求日志失败");
    }
}

export async function DELETE() {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    try {
        await clearGeminiVidsRequestLogs();
        return apiSuccess({ ok: true });
    } catch (error) {
        return geminiVidsRouteError(error, "清空 GeminiVids 请求日志失败");
    }
}
