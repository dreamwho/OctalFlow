import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { saveGeminiToolsModelSelection } from "@/lib/server/gemini-tools-service";

export async function PUT(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const body = await readGeminiToolsAdminJson(request);
        const data = await saveGeminiToolsModelSelection(body);
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.models.update", { type: "system_model_channel", id: "gemini-antigravity-tools", label: "Gemini Antigravity Tools" }, { modelCount: data.models.length });
        return apiSuccess(data, "Gemini Antigravity Tools 渠道已更新");
    } catch (error) {
        return geminiToolsRouteError(error, "更新 GeminiTools 模型渠道失败");
    }
}
