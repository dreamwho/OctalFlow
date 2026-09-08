import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiToolsAction, geminiToolsRouteError, readGeminiToolsAdminJson, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { deleteGeminiToolsApiKey, updateGeminiToolsApiKey } from "@/lib/server/gemini-tools-store";

type Context = { params: Promise<{ keyId: string }> };

export async function PATCH(request: Request, context: Context) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    const { keyId } = await context.params;
    try {
        const key = await updateGeminiToolsApiKey(keyId, await readGeminiToolsAdminJson(request));
        if (!key) return Response.json({ code: 404, data: null, msg: "API 密钥不存在" }, { status: 404 });
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.key.update", { type: "api_key", id: keyId, label: key.name });
        return apiSuccess(key, "API 密钥已更新");
    } catch (error) {
        return geminiToolsRouteError(error, "更新 API 密钥失败");
    }
}

export async function DELETE(request: Request, context: Context) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return access.error;
    const { keyId } = await context.params;
    try {
        const deleted = await deleteGeminiToolsApiKey(keyId);
        if (!deleted) return Response.json({ code: 404, data: null, msg: "API 密钥不存在" }, { status: 404 });
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.key.delete", { type: "api_key", id: keyId });
        return apiSuccess({ deleted: true }, "API 密钥已删除");
    } catch (error) {
        return geminiToolsRouteError(error, "删除 API 密钥失败");
    }
}
