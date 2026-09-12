import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, geminiAiRouteError, readGeminiAiAdminJson, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { createGeminiAiApiKey, listGeminiAiApiKeys } from "@/lib/server/geminiai-gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    return apiSuccess(await listGeminiAiApiKeys());
}

export async function POST(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await createGeminiAiApiKey(await readGeminiAiAdminJson(request));
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.key.create", { type: "api_key", id: data.key.id, label: data.key.name });
        return apiSuccess(data, "API 密钥已创建，仅本次显示明文");
    } catch (error) {
        return geminiAiRouteError(error, "创建 API 密钥失败");
    }
}
