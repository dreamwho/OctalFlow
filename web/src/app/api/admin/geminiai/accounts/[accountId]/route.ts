import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { deleteGeminiAiAccount, renameGeminiAiAccount } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ accountId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    const parsed = await readJsonBodyResult<{ name?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const account = await renameGeminiAiAccount(accountId, parsed.data.name);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.rename", { type: "geminiai_account", id: account.id, label: account.name });
        return apiSuccess({ account }, "账号名称已更新");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.rename", { type: "geminiai_account", id: accountId });
        return geminiAiRouteError(error, "更新 Google 账号失败");
    }
}

export async function DELETE(request: Request, context: RouteContext) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const data = await deleteGeminiAiAccount(accountId);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.delete", { type: "geminiai_account", id: data.id });
        return apiSuccess(data, "Google 账号已删除");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.delete", { type: "geminiai_account", id: accountId });
        return geminiAiRouteError(error, "删除 Google 账号失败");
    }
}
