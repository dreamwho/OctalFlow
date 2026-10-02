import { apiSuccess } from "@/app/api/_shared/api-response";
import { apiCompatError } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { deleteGeminiVidsApiKey, updateGeminiVidsApiKey } from "@/lib/server/geminivids-gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ keyId: string }> }) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const { keyId } = await context.params;
    const body = await readGeminiVidsAdminJson<{ name?: string; status?: "active" | "disabled"; expiresAt?: string; allowedIps?: string[] }>(request);
    const key = await updateGeminiVidsApiKey(keyId, body);
    if (!key) return apiCompatError(404, "密钥不存在");
    await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.keys.update", { type: "geminivids_api_key", id: keyId });
    return apiSuccess(key);
}

export async function DELETE(request: Request, context: { params: Promise<{ keyId: string }> }) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const { keyId } = await context.params;
    const deleted = await deleteGeminiVidsApiKey(keyId);
    if (!deleted) return apiCompatError(404, "密钥不存在");
    await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.keys.delete", { type: "geminivids_api_key", id: keyId });
    return apiSuccess({ ok: true });
}
