import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDreaminaCliAction, dreaminaCliRouteError, requireDreaminaCliAdmin } from "@/lib/server/dreamina-cli-admin";
import { saveDreaminaCliModelSelection } from "@/lib/server/dreamina-cli-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
    const access = await requireDreaminaCliAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ modelIds?: unknown }>(request, 64 * 1024);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const data = await saveDreaminaCliModelSelection(parsed.data);
        await auditDreaminaCliAction(request, access.user, "admin.dreamina.models.update", { type: "system_model_channel", id: "dreamina-cli", label: "即梦 CLI" }, { modelCount: data.enabledModelIds.length });
        return apiSuccess({ enabledModelIds: data.enabledModelIds }, "即梦 CLI 模型配置已更新");
    } catch (error) {
        return dreaminaCliRouteError(error, "更新即梦 CLI 模型失败");
    }
}
