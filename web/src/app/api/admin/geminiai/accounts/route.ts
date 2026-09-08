import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { listGeminiAiAccounts } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const accounts = await listGeminiAiAccounts();
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.accounts.view", { type: "geminiai_account_collection" });
        return apiSuccess({ accounts });
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.accounts.view", { type: "geminiai_account_collection" });
        return geminiAiRouteError(error, "读取 GeminiAI 账号失败");
    }
}
