import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { listGeminiAiCatalog } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const models = await listGeminiAiCatalog();
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.models.sync", { type: "geminiai_model_catalog" }, { discoveredCount: models.length });
        return apiSuccess({ models }, "GeminiAI 模型目录已同步");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.models.sync", { type: "geminiai_model_catalog" });
        return geminiAiRouteError(error, "同步 GeminiAI 模型目录失败");
    }
}
