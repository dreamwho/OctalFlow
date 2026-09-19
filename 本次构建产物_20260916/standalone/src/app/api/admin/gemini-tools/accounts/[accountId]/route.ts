import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { deleteGeminiToolsAccount, updateGeminiToolsAccount } from "@/lib/server/gemini-tools-store";

type Context = { params: Promise<{ accountId: string }> };

export async function PATCH(request: Request, context: Context) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const body = await readGeminiToolsAdminJson(request);
        const account = await updateGeminiToolsAccount(accountId, body);
        if (!account) return Response.json({ code: 404, data: null, msg: "Google 账号不存在" }, { status: 404 });
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.account.update", { type: "google_account", id: accountId, label: account.email });
        return apiSuccess(account, "Google 账号已更新");
    } catch (error) {
        return geminiToolsRouteError(error, "更新 Google 账号失败");
    }
}

export async function DELETE(request: Request, context: Context) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const deleted = await deleteGeminiToolsAccount(accountId);
        if (!deleted) return Response.json({ code: 404, data: null, msg: "Google 账号不存在" }, { status: 404 });
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.account.delete", { type: "google_account", id: accountId });
        return apiSuccess({ deleted: true }, "Google 账号已删除");
    } catch (error) {
        return geminiToolsRouteError(error, "删除 Google 账号失败");
    }
}
