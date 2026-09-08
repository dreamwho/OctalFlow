import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { testGeminiToolsText } from "@/lib/server/gemini-tools-service";

export async function POST(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await testGeminiToolsText(await readGeminiToolsAdminJson(request));
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.test", { type: "model", id: data.model });
        return apiSuccess(data, "模型测试成功");
    } catch (error) {
        return geminiToolsRouteError(error, "GeminiTools 模型测试失败");
    }
}
