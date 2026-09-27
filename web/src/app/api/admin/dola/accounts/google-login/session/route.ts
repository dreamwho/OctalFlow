import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { startDolaGoogleLoginSession } from "@/lib/server/dola/service";
import { dolaGoogleLoginMode } from "@/lib/server/dola/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ timeoutSeconds?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const timeoutSeconds = parsed.data.timeoutSeconds;
    if (!Number.isSafeInteger(timeoutSeconds) || Number(timeoutSeconds) <= 0) return apiCompatError(400, "授权窗口保留时间必须为正整数秒");
    try {
        const mode = dolaGoogleLoginMode(request.url);
        const result = await startDolaGoogleLoginSession(access.user.id, Number(timeoutSeconds), mode);
        await auditDolaAdminAction(request, access.user, "admin.dola.google_login.start", { type: "dola_verification", id: result.verificationId }, { mode });
        return apiSuccess(result, mode === "native" ? "已打开本机 Google 授权浏览器" : "已启动远程 Google 授权浏览器");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.google_login.start", { type: "dola_verification", id: "google" });
        return dolaRouteError(error, "启动远程 Google 授权失败");
    }
}
