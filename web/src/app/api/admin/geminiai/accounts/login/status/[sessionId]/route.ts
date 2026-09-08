import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { getGeminiAiLoginStatus } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: RouteContext) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { sessionId } = await context.params;
    try {
        const data = await getGeminiAiLoginStatus(sessionId);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.login_status", { type: "geminiai_login", id: data.sessionId });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.login_status", { type: "geminiai_login", id: sessionId });
        return geminiAiRouteError(error, "读取 Google 授权状态失败");
    }
}
