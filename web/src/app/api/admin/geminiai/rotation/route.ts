import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { getGeminiAiRotation, setGeminiAiRotation } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const rotation = await getGeminiAiRotation();
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.rotation.view", { type: "geminiai_rotation", id: "primary" });
        return apiSuccess({ rotation });
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.rotation.view", { type: "geminiai_rotation", id: "primary" });
        return geminiAiRouteError(error, "读取轮换配置失败");
    }
}

export async function PATCH(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ mode?: unknown; cooldownSeconds?: unknown; cooldown_seconds?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const rotation = await setGeminiAiRotation({ ...parsed.data, cooldownSeconds: parsed.data.cooldownSeconds ?? parsed.data.cooldown_seconds });
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.rotation.update", { type: "geminiai_rotation", id: "primary" }, { mode: rotation.mode || "" });
        return apiSuccess({ rotation }, "账号轮换配置已更新");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.rotation.update", { type: "geminiai_rotation", id: "primary" });
        return geminiAiRouteError(error, "更新轮换配置失败");
    }
}
