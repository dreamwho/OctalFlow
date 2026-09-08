import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDreaminaCliAction, dreaminaCliRouteError, requireDreaminaCliAdmin } from "@/lib/server/dreamina-cli-admin";
import { getDreaminaCliOverview } from "@/lib/server/dreamina-cli-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireDreaminaCliAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await getDreaminaCliOverview();
        await auditDreaminaCliAction(request, access.user, "admin.dreamina.view", { type: "dreamina_cli", id: "default" });
        return apiSuccess(data);
    } catch (error) {
        return dreaminaCliRouteError(error, "读取即梦 CLI 状态失败");
    }
}
