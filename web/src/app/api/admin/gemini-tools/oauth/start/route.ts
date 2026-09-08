import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { startGeminiToolsOAuth } from "@/lib/server/gemini-tools-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await startGeminiToolsOAuth(request);
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.oauth.start", { type: "google_oauth", id: "gemini-tools" });
        return apiSuccess(data);
    } catch (error) {
        return geminiToolsRouteError(error, "发起 Google 授权失败");
    }
}
