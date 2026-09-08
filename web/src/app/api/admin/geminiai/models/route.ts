import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { listGeminiAiCatalog, saveGeminiAiModelSelection } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const models = await listGeminiAiCatalog();
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.models.view", { type: "geminiai_model_catalog" });
        return apiSuccess({ models });
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.models.view", { type: "geminiai_model_catalog" });
        return geminiAiRouteError(error, "读取 GeminiAI 模型目录失败");
    }
}

export async function PUT(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ models?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const data = await saveGeminiAiModelSelection(parsed.data);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.models.update", { type: "system_model_channel", id: data.channel.id, label: data.channel.name }, { modelCount: data.models.length });
        return apiSuccess(data, "GeminiAI 模型渠道已更新");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.models.update", { type: "system_model_channel", id: "geminiai" });
        return geminiAiRouteError(error, "更新 GeminiAI 模型失败");
    }
}
