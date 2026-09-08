import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { syncGeminiToolsModelCatalog } from "@/lib/server/gemini-tools-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await syncGeminiToolsModelCatalog(await readGeminiToolsAdminJson(request));
        await auditGeminiToolsAction(
            request,
            access.user,
            "admin.gemini_tools.models.sync",
            { type: "gemini_tools_model_catalog" },
            {
                accountCount: data.accountResults.length,
                refreshedAccountCount: data.accountResults.filter((item) => item.ok).length,
                discoveredCount: data.discoveredModels.length,
                newModelCount: data.newModels.length,
                enabledNewModelCount: data.enabledNewModelIds.length,
            },
        );
        return apiSuccess(data, "GeminiTools 最新模型目录已获取");
    } catch (error) {
        return geminiToolsRouteError(error, "获取 GeminiTools 最新模型目录失败");
    }
}
