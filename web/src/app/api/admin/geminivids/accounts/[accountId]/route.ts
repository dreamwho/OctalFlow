import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, auditGeminiVidsAdminFailure, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { deleteGeminiVidsAccount, updateGeminiVidsAccount } from "@/lib/server/geminivids-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    const body = await readGeminiVidsAdminJson<{ name?: string; vidsDocId?: string; status?: "active" | "invalid" }>(request);
    try {
        const data = await updateGeminiVidsAccount(accountId, body);
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.accounts.update", { type: "geminivids_account", id: accountId });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiVidsAdminFailure(request, access.user, "admin.geminivids.accounts.update", { type: "geminivids_account", id: accountId });
        return geminiVidsRouteError(error, "更新 GeminiVids 账号失败");
    }
}

export async function DELETE(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const data = await deleteGeminiVidsAccount(accountId);
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.accounts.delete", { type: "geminivids_account", id: accountId });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiVidsAdminFailure(request, access.user, "admin.geminivids.accounts.delete", { type: "geminivids_account", id: accountId });
        return geminiVidsRouteError(error, "删除 GeminiVids 账号失败");
    }
}
