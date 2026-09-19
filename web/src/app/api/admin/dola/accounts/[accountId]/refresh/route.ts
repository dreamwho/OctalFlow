import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { refreshDolaAccount } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const accountId = (await context.params).accountId;
    try {
        const result = await refreshDolaAccount(accountId);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.refresh", { type: "dola_account", id: accountId });
        return apiSuccess(result, "Dola 账号状态已刷新");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.refresh", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "刷新 Dola 账号失败");
    }
}
