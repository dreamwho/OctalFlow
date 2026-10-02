import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, auditGeminiVidsAdminFailure, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { enableGeminiVidsChannel, getGeminiVidsOverview, setGeminiVidsChannelEnabled } from "@/lib/server/geminivids-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await getGeminiVidsOverview();
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.view", { type: "geminivids_provider", id: "primary" });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiVidsAdminFailure(request, access.user, "admin.geminivids.view", { type: "geminivids_provider", id: "primary" });
        return geminiVidsRouteError(error, "读取 GeminiVids 状态失败");
    }
}

export async function POST(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const body = await readGeminiVidsAdminJson<{ action?: string; enabled?: boolean }>(request);
    try {
        if (body.action === "enable") {
            const channel = await enableGeminiVidsChannel();
            await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.enable", { type: "geminivids_provider", id: channel.id });
            return apiSuccess({ channelId: channel.id });
        }
        if (body.action === "setEnabled" && typeof body.enabled === "boolean") {
            const result = await setGeminiVidsChannelEnabled(body.enabled);
            await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.setEnabled", { type: "geminivids_provider", id: "primary" }, { enabled: body.enabled });
            return apiSuccess(result);
        }
        return geminiVidsRouteError(new Error("action"), "不支持的操作");
    } catch (error) {
        await auditGeminiVidsAdminFailure(request, access.user, "admin.geminivids.post", { type: "geminivids_provider", id: "primary" });
        return geminiVidsRouteError(error, "更新 GeminiVids 配置失败");
    }
}
