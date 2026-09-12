import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, geminiAiRouteError, readGeminiAiAdminJson, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { getGeminiAiGatewaySettings, updateGeminiAiGatewaySettings } from "@/lib/server/geminiai-gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    return apiSuccess(await getGeminiAiGatewaySettings());
}

export async function PATCH(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const gateway = await updateGeminiAiGatewaySettings(await readGeminiAiAdminJson(request));
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.gateway.update", { type: "geminiai_gateway", id: "primary" });
        return apiSuccess(gateway, "网关设置已保存");
    } catch (error) {
        return geminiAiRouteError(error, "保存网关设置失败");
    }
}
