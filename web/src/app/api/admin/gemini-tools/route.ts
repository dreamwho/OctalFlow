import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { getGeminiToolsOverview } from "@/lib/server/gemini-tools-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await getGeminiToolsOverview();
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.view", { type: "gemini_tools_gateway", id: "primary" });
        return apiSuccess(data);
    } catch (error) {
        return geminiToolsRouteError(error, "读取 GeminiTools 状态失败");
    }
}
