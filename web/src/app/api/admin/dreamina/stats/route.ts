import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { auditDreaminaCliAction, dreaminaCliRouteError, requireDreaminaCliAdmin } from "@/lib/server/dreamina-cli-admin";
import { getDreaminaCliStats } from "@/lib/server/dreamina-cli-service";
import type { DreaminaCliStatsRange } from "@/lib/server/dreamina-cli-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireDreaminaCliAdmin();
    if ("error" in access) return access.error;
    const range = statsRange(new URL(request.url).searchParams.get("range"));
    if (!range) return apiCompatError(400, "即梦 CLI 积分统计时间范围无效");
    try {
        const data = await getDreaminaCliStats(range);
        await auditDreaminaCliAction(request, access.user, "admin.dreamina.stats.view", { type: "dreamina_cli_request_log" }, { range });
        return apiSuccess(data);
    } catch (error) {
        return dreaminaCliRouteError(error, "读取即梦 CLI 积分统计失败");
    }
}

function statsRange(value: string | null): DreaminaCliStatsRange | undefined {
    return value === null || value === "" || value === "all" ? "all" : value === "week" || value === "month" || value === "year" ? value : undefined;
}
