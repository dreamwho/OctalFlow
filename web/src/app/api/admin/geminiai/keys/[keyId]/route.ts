import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiAiAdminAction, geminiAiRouteError, readGeminiAiAdminJson, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { deleteGeminiAiApiKey, updateGeminiAiApiKey } from "@/lib/server/geminiai-gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ keyId: string }> };

export async function PATCH(request: Request, context: Context) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { keyId } = await context.params;
    try {
        const key = await updateGeminiAiApiKey(keyId, await readGeminiAiAdminJson(request));
        if (!key) return Response.json({ code: 404, data: null, msg: "API 密钥不存在" }, { status: 404 });
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.key.update", { type: "api_key", id: keyId, label: key.name });
        return apiSuccess(key, "API 密钥已更新");
    } catch (error) {
        return geminiAiRouteError(error, "更新 API 密钥失败");
    }
}

export async function DELETE(request: Request, context: Context) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const { keyId } = await context.params;
    try {
        const deleted = await deleteGeminiAiApiKey(keyId);
        if (!deleted) return Response.json({ code: 404, data: null, msg: "API 密钥不存在" }, { status: 404 });
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.key.delete", { type: "api_key", id: keyId });
        return apiSuccess({ deleted: true }, "API 密钥已删除");
    } catch (error) {
        return geminiAiRouteError(error, "删除 API 密钥失败");
    }
}
