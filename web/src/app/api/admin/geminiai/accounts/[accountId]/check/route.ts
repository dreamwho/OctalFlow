import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { checkGeminiAiAccount } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, context: RouteContext) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const account = await checkGeminiAiAccount(accountId);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.check", { type: "geminiai_account", id: account.id, label: account.name });
        return apiSuccess({ account }, "账号状态检测完成");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.check", { type: "geminiai_account", id: accountId });
        return geminiAiRouteError(error, "检测 Google 账号状态失败");
    }
}
