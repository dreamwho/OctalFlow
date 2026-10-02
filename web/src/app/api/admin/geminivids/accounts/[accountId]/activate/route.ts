import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, auditGeminiVidsAdminFailure, geminiVidsRouteError, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { activateGeminiVidsAccount } from "@/lib/server/geminivids-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const data = await activateGeminiVidsAccount(accountId);
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.accounts.activate", { type: "geminivids_account", id: accountId });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiVidsAdminFailure(request, access.user, "admin.geminivids.accounts.activate", { type: "geminivids_account", id: accountId });
        return geminiVidsRouteError(error, "激活 GeminiVids 账号失败");
    }
}
