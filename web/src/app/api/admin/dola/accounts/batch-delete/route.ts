import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { deleteDolaAccounts } from "@/lib/server/dola/account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ ids?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const ids = Array.isArray(parsed.data.ids) ? parsed.data.ids.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, 200) : [];
    if (!ids.length) return apiCompatError(400, "请选择要删除的账号");
    try {
        const result = await deleteDolaAccounts(ids);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.batchDelete", { type: "dola_account", label: `${result.deleted} 个账号` }, { requested: ids.length, skipped: result.skipped });
        return apiSuccess(result, result.skipped ? `已删除 ${result.deleted} 个账号，${result.skipped} 个因仍有运行中任务被跳过` : `已删除 ${result.deleted} 个账号`);
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.batchDelete", { type: "dola_account" });
        return dolaRouteError(error, "批量删除 Dola 账号失败");
    }
}
