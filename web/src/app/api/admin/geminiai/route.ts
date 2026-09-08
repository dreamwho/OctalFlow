import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { getGeminiAiOverview } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await getGeminiAiOverview();
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.view", { type: "geminiai_provider", id: "primary" });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.view", { type: "geminiai_provider", id: "primary" });
        return geminiAiRouteError(error, "读取 GeminiAI 状态失败");
    }
}
