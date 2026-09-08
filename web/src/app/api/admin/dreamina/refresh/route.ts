import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDreaminaCliAction, dreaminaCliRouteError, requireDreaminaCliAdmin } from "@/lib/server/dreamina-cli-admin";
import { refreshDreaminaCliRuntime } from "@/lib/server/dreamina-cli-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDreaminaCliAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await refreshDreaminaCliRuntime();
        await auditDreaminaCliAction(request, access.user, "admin.dreamina.refresh", { type: "dreamina_cli_account", id: "default" });
        return apiSuccess(data, "即梦 CLI 账户状态已刷新");
    } catch (error) {
        return dreaminaCliRouteError(error, "刷新即梦 CLI 账户失败");
    }
}
