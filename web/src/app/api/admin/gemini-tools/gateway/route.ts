import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { updateGeminiToolsGatewaySettings } from "@/lib/server/gemini-tools-store";

export async function PATCH(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const gateway = await updateGeminiToolsGatewaySettings(await readGeminiToolsAdminJson(request));
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.gateway.update", { type: "gemini_tools_gateway", id: "primary" });
        return apiSuccess(gateway, "网关设置已保存");
    } catch (error) {
        return geminiToolsRouteError(error, "保存网关设置失败");
    }
}
