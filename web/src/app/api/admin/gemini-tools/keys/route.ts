import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { createGeminiToolsApiKey, listGeminiToolsApiKeys } from "@/lib/server/gemini-tools-store";

export async function GET() {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    return apiSuccess(await listGeminiToolsApiKeys());
}

export async function POST(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await createGeminiToolsApiKey(await readGeminiToolsAdminJson(request));
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.key.create", { type: "api_key", id: data.key.id, label: data.key.name });
        return apiSuccess(data, "API 密钥已创建，仅本次显示明文");
    } catch (error) {
        return geminiToolsRouteError(error, "创建 API 密钥失败");
    }
}
