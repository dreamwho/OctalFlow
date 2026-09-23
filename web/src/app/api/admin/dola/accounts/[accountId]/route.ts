import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { deleteDolaAccount, editDolaAccount, normalizeDolaAccountStatus, renameDolaAccount, resetDolaAccountQuota, setDolaAccountEnabled, setDolaAccountGroup, setDolaAccountStatus } from "@/lib/server/dola/account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ accountId: string }> };

export async function PATCH(request: Request, context: Context) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    const parsed = await readJsonBodyResult<{ name?: unknown; email?: unknown; cookie?: unknown; enabled?: unknown; group?: unknown; status?: unknown; resetQuota?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const account = (
            parsed.data.resetQuota === true
                ? await resetDolaAccountQuota(accountId)
                : typeof parsed.data.email === "string" && typeof parsed.data.name === "string" && typeof parsed.data.group === "string" && (parsed.data.cookie === undefined || typeof parsed.data.cookie === "string")
                ? await editDolaAccount(accountId, { name: parsed.data.name, email: parsed.data.email, group: parsed.data.group, cookie: parsed.data.cookie })
                : typeof parsed.data.name === "string"
                ? await renameDolaAccount(accountId, parsed.data.name)
                : typeof parsed.data.enabled === "boolean"
                ? await setDolaAccountEnabled(accountId, parsed.data.enabled)
                : typeof parsed.data.group === "string"
                ? await setDolaAccountGroup(accountId, parsed.data.group)
                : typeof parsed.data.status === "string"
                ? await setDolaAccountStatus(accountId, normalizeDolaAccountStatus(parsed.data.status))
                : null
        ) as { name: string } | null;
        if (!account) return apiCompatError(400, "没有可更新的字段");
        await auditDolaAdminAction(request, access.user, "admin.dola.account.update", { type: "dola_account", id: accountId, label: account.name });
        return apiSuccess({ account }, "Dola 账号已更新");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.update", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "更新 Dola 账号失败");
    }
}

export async function DELETE(request: Request, context: Context) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const result = await deleteDolaAccount(accountId);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.delete", { type: "dola_account", id: accountId });
        return apiSuccess(result, "Dola 账号已删除");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.delete", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "删除 Dola 账号失败");
    }
}
