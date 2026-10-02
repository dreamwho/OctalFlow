import { apiSuccess } from "@/app/api/_shared/api-response";
import { apiCompatError } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { getGeminiVidsGatewaySettings, updateGeminiVidsGatewaySettings } from "@/lib/server/geminivids-gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    return apiSuccess(await getGeminiVidsGatewaySettings());
}

export async function PUT(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const body = await readGeminiVidsAdminJson<{ enabled?: unknown }>(request);
    if (typeof body.enabled !== "boolean") return apiCompatError(400, "enabled 必须为布尔值");
    try {
        const data = await updateGeminiVidsGatewaySettings({ enabled: body.enabled });
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.gateway.update", { type: "geminivids_gateway", id: "primary" }, { enabled: body.enabled });
        return apiSuccess(data);
    } catch (error) {
        return geminiVidsRouteError(error, "更新 GeminiVids 网关设置失败");
    }
}
