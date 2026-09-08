import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDreaminaCliAction, dreaminaCliRouteError, requireDreaminaCliAdmin } from "@/lib/server/dreamina-cli-admin";
import { clearDreaminaCliRequestLogs, listDreaminaCliRequestLogs, type DreaminaCliRequestCommand, type DreaminaCliRequestStatus } from "@/lib/server/dreamina-cli-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireDreaminaCliAdmin();
    if ("error" in access) return access.error;
    try {
        const search = new URL(request.url).searchParams;
        const data = await listDreaminaCliRequestLogs({
            page: numberParam(search.get("page"), 1),
            pageSize: numberParam(search.get("pageSize"), 20),
            ...(requestStatus(search.get("status")) ? { status: requestStatus(search.get("status"))! } : {}),
            ...(requestCommand(search.get("command")) ? { command: requestCommand(search.get("command"))! } : {}),
        });
        await auditDreaminaCliAction(request, access.user, "admin.dreamina.logs.view", { type: "dreamina_cli_request_log" });
        return apiSuccess(data);
    } catch (error) {
        return dreaminaCliRouteError(error, "读取即梦 CLI 请求日志失败");
    }
}

export async function DELETE(request: Request) {
    const access = await requireDreaminaCliAdmin();
    if ("error" in access) return access.error;
    try {
        const deletedCount = await clearDreaminaCliRequestLogs();
        await auditDreaminaCliAction(request, access.user, "admin.dreamina.logs.clear", { type: "dreamina_cli_request_log" }, { deletedCount });
        return apiSuccess({ deletedCount }, "即梦 CLI 请求日志已清空");
    } catch (error) {
        return dreaminaCliRouteError(error, "清空即梦 CLI 请求日志失败");
    }
}

function numberParam(value: string | null, fallback: number) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestStatus(value: string | null): DreaminaCliRequestStatus | undefined {
    return value === "started" || value === "success" || value === "failed" || value === "needs_review" || value === "deferred" ? value : undefined;
}

function requestCommand(value: string | null): DreaminaCliRequestCommand | undefined {
    return value === "version" ||
        value === "user_credit" ||
        value === "text2image" ||
        value === "image2image" ||
        value === "image_upscale" ||
        value === "text2video" ||
        value === "image2video" ||
        value === "frames2video" ||
        value === "multiframe2video" ||
        value === "multimodal2video" ||
        value === "query_result" ||
        value === "download"
        ? value
        : undefined;
}
