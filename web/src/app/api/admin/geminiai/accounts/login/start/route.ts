import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { startGeminiAiLogin } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { name?: unknown; headless?: unknown; uiLocale?: unknown; ui_locale?: unknown };

export async function POST(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<Body>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const data = await startGeminiAiLogin({ ...parsed.data, uiLocale: parsed.data.uiLocale ?? parsed.data.ui_locale });
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.login_start", { type: "geminiai_login", id: data.sessionId }, { headless: parsed.data.headless === true });
        return apiSuccess(data, "Google 授权已启动");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.login_start", { type: "geminiai_login" });
        return geminiAiRouteError(error, "启动 Google 授权失败");
    }
}
