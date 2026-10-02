import { apiSuccess } from "@/app/api/_shared/api-response";
import { apiCompatError } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { syncGeminiVidsProxy } from "@/lib/server/geminivids-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const body = await readGeminiVidsAdminJson<{ proxyUrl?: string }>(request);
    const proxyUrl = (body.proxyUrl || "").trim();
    if (proxyUrl && !/^(https?|socks5):\/\/.+/i.test(proxyUrl)) return apiCompatError(400, "代理地址必须是 http(s):// 或 socks5:// 开头");
    try {
        await syncGeminiVidsProxy(proxyUrl);
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.proxy.update", { type: "geminivids_provider", id: "primary" }, { mode: proxyUrl ? "custom" : "direct" });
        return apiSuccess({ ok: true, proxyUrl: proxyUrl || "" });
    } catch (error) {
        return geminiVidsRouteError(error, "更新 GeminiVids 代理失败");
    }
}
