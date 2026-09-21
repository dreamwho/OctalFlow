import { apiCompatError } from "@/app/api/_shared/api-response";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { DolaProviderError } from "./provider";

export async function requireDolaAdmin() {
    const user = await getCurrentUser();
    if (!user) return { error: apiCompatError(401, "请先登录") } as const;
    if (!hasAdminPermission(user, "upstream.manage")) return { error: apiCompatError(403, "需要管理员权限") } as const;
    return { user } as const;
}

export async function auditDolaAdminAction(request: Request, user: Awaited<ReturnType<typeof getCurrentUser>> & object, action: string, target: { type: string; id?: string; label?: string }, metadata?: Record<string, unknown>) {
    await safeRecordAuditLog({ action, actor: auditActorFromRequest(request, user), target, ...(metadata ? { metadata } : {}) });
}

export async function auditDolaAdminFailure(request: Request, user: Awaited<ReturnType<typeof getCurrentUser>>, action: string, target: { type: string; id?: string }, metadata?: Record<string, unknown>) {
    if (!user) return;
    await safeRecordAuditLog({ action, status: "failure", actor: auditActorFromRequest(request, user), target, metadata: metadata || { error: "request_failed" } });
}

export function dolaRouteError(error: unknown, fallback: string) {
    if (error instanceof DolaProviderError) return apiCompatError(error.status, error.message);
    return apiCompatError(500, fallback);
}
