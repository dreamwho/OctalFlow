import { apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBody } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { refreshDolaAccount } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 先走只读 HTTP 登录态协议；状态明确失效时不会启动 Camoufox，其他状态再进入完整协议检测。
export const maxDuration = 2400;

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const accountId = (await context.params).accountId;
    try {
        const body = await readJsonBody<{ loginOnly?: unknown }>(request);
        const loginOnly = body.loginOnly === true;
        const result = await refreshDolaAccount(accountId, { loginOnly });
        await auditDolaAdminAction(request, access.user, "admin.dola.account.refresh", { type: "dola_account", id: accountId, label: loginOnly ? "login_only" : "full_protocol" });
        return apiSuccess(result, "Dola 账号状态已刷新");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.refresh", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "刷新 Dola 账号失败");
    }
}
