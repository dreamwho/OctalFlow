import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { clearDolaRequestLogs, listDolaRequestLogs, type DolaRequestLogPhase, type DolaRequestLogSource, type DolaRequestLogStatus } from "@/lib/server/dola/log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    try {
        const search = new URL(request.url).searchParams;
        const status = search.get("status");
        const phase = search.get("phase");
        const source = search.get("source");
        const proxyMode = search.get("proxyMode");
        const data = await listDolaRequestLogs({
            page: numberParam(search.get("page"), 1),
            pageSize: numberParam(search.get("pageSize"), 20),
            keyword: search.get("keyword") || undefined,
            status: isDolaStatus(status) ? status : undefined,
            phase: isDolaPhase(phase) ? phase : undefined,
            source: isDolaSource(source) ? source : undefined,
            proxyMode: proxyMode === "direct" || proxyMode === "magic" || proxyMode === "generic" || proxyMode === "chained" ? proxyMode : undefined,
            model: search.get("model") || undefined,
            accountId: search.get("accountId") || undefined,
        });
        await auditDolaAdminAction(request, access.user, "admin.dola.logs.view", { type: "dola_request_log" });
        return apiSuccess(data);
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.logs.view", { type: "dola_request_log" });
        return dolaRouteError(error, "读取 Dola 请求日志失败");
    }
}
export async function DELETE(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    try {
        const deletedCount = await clearDolaRequestLogs();
        await auditDolaAdminAction(request, access.user, "admin.dola.logs.clear", { type: "dola_request_log" }, { deletedCount });
        return apiSuccess({ deletedCount }, "Dola 请求日志已清空");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.logs.clear", { type: "dola_request_log" });
        return dolaRouteError(error, "清空 Dola 请求日志失败");
    }
}

function numberParam(value: string | null, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function isDolaStatus(value: string | null): value is DolaRequestLogStatus {
    return value === "success" || value === "failed" || value === "needs_review" || value === "pending";
}
function isDolaPhase(value: string | null): value is DolaRequestLogPhase {
    return value === "queued" || value === "routing" || value === "auth" || value === "upstream" || value === "response" || value === "running" || value === "success" || value === "failed" || value === "needs_review";
}
function isDolaSource(value: string | null): value is DolaRequestLogSource {
    return value === "runtime" || value === "admin-test" || value === "external";
}
