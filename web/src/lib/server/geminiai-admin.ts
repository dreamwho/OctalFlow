import { apiCompatError } from "@/app/api/_shared/api-response";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { type PublicUser } from "@/lib/auth/store";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { GeminiAiProviderError } from "@/lib/server/geminiai-provider";

export async function requireGeminiAiAdmin() {
    const user = await getCurrentUser();
    if (!user) return { error: apiCompatError(401, "请先登录") } as const;
    if (!hasAdminPermission(user, "upstream.manage")) return { error: apiCompatError(403, "需要管理员权限") } as const;
    return { user } as const;
}

export async function auditGeminiAiAdminAction(request: Request, user: PublicUser, action: string, target: { type: string; id?: string; label?: string }, metadata?: Record<string, unknown>) {
    await safeRecordAuditLog({ action, actor: auditActorFromRequest(request, user), target, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) });
}

export async function auditGeminiAiAdminFailure(request: Request, user: PublicUser | undefined, action: string, target: { type: string; id?: string; label?: string }) {
    if (!user) return;
    await safeRecordAuditLog({ action, status: "failure", actor: auditActorFromRequest(request, user), target, metadata: { error: "request_failed" } });
}

export function geminiAiRouteError(error: unknown, fallback: string) {
    if (error instanceof GeminiAiProviderError) return apiCompatError(error.status, error.message);
    return apiCompatError(500, fallback);
}
