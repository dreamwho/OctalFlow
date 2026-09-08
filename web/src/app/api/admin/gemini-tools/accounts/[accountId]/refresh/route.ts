import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { refreshGeminiToolsAccount } from "@/lib/server/gemini-tools-service";

type Context = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, context: Context) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const account = await refreshGeminiToolsAccount(accountId);
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.account.refresh", { type: "google_account", id: accountId, label: account?.email });
        return apiSuccess(account, "账号额度已刷新");
    } catch (error) {
        return geminiToolsRouteError(error, "刷新账号额度失败");
    }
}
