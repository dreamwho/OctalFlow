import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { activateGeminiAiAccount } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: Request, context: RouteContext) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { accountId } = await context.params;
    try {
        const account = await activateGeminiAiAccount(accountId);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.activate", { type: "geminiai_account", id: account.id, label: account.name });
        return apiSuccess({ account }, "已切换 Google 授权账号");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.activate", { type: "geminiai_account", id: accountId });
        return geminiAiRouteError(error, "切换 Google 账号失败");
    }
}
