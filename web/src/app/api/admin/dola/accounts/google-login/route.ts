import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { startDolaGoogleLogin } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{
        manualCookie?: unknown;
        email?: unknown;
        name?: unknown;
        timeoutSeconds?: unknown;
    }>(request);
    const data = parsed.ok ? parsed.data : {};
    const manualCookie = typeof data.manualCookie === "string" && data.manualCookie.trim() ? data.manualCookie.trim() : undefined;
    const email = typeof data.email === "string" && data.email.trim() ? data.email.trim() : undefined;
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
    const timeoutSeconds = typeof data.timeoutSeconds === "number" && data.timeoutSeconds > 0 ? data.timeoutSeconds : undefined;

    try {
        const result = await startDolaGoogleLogin({ manualCookie, email, name, timeoutSeconds });
        await auditDolaAdminAction(request, access.user, "admin.dola.google_login", { type: "dola_account", id: result.account?.id || "google" });
        return apiSuccess(result, "Google 授权账号绑定成功");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.google_login", { type: "dola_account", id: "google" }, { error: error instanceof Error ? error.message : "Google 登录失败" });
        return dolaRouteError(error, "Google 授权登录失败");
    }
}
