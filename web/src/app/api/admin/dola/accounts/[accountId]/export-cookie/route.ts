import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { getDolaAccount, getDolaAccountCookie } from "@/lib/server/dola/account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const account = await getDolaAccount(accountId);
        if (!account) return apiCompatError(404, "Dola 账号不存在");
        if (account.authType !== "google") return apiCompatError(422, "仅 Google 授权账号可从此处导出");
        const cookie = await getDolaAccountCookie(accountId);
        if (!cookie) return apiCompatError(404, "该账号没有可导出的 Dola Cookie");
        await auditDolaAdminAction(request, access.user, "admin.dola.account.export_cookie", { type: "dola_account", id: accountId });
        return apiSuccess({ cookie }, "Dola Cookie 已取回", { headers: { "Cache-Control": "private, no-store, max-age=0" } });
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.export_cookie", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "导出 Dola Cookie 失败");
    }
}
