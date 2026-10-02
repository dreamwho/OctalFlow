import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { createGeminiVidsApiKey, listGeminiVidsApiKeys } from "@/lib/server/geminivids-gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    return apiSuccess(await listGeminiVidsApiKeys());
}

export async function POST(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const body = await readGeminiVidsAdminJson<{ name?: string; expiresAt?: string; allowedIps?: string[] }>(request);
    try {
        const data = await createGeminiVidsApiKey({ name: body.name || "", ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}), ...(Array.isArray(body.allowedIps) ? { allowedIps: body.allowedIps } : {}) });
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.keys.create", { type: "geminivids_api_key", id: data.key.id });
        return apiSuccess(data);
    } catch (error) {
        return geminiVidsRouteError(error, "创建 GeminiVids API 密钥失败");
    }
}
