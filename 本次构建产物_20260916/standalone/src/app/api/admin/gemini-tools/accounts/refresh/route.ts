import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { refreshAllGeminiToolsAccounts } from "@/lib/server/gemini-tools-service";

export async function POST(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const results = await refreshAllGeminiToolsAccounts();
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.accounts.refresh", { type: "google_account_collection" }, { count: results.length });
        return apiSuccess(results, "账号额度刷新完成");
    } catch (error) {
        return geminiToolsRouteError(error, "刷新账号额度失败");
    }
}
