import { apiCompatError } from "@/app/api/_shared/api-response";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import type { PublicUser } from "@/lib/auth/store";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { RunningHubError } from "@/lib/server/runninghub-service";

export async function requireRunningHubAdmin(request?: Request) {
    const user = await getCurrentUser(request);
    if (!user) return { error: apiCompatError(401, "请先登录") } as const;
    if (!hasAdminPermission(user, "upstream.manage")) return { error: apiCompatError(403, "需要上游配置管理权限") } as const;
    return { user } as const;
}

export async function auditRunningHubAction(request: Request, user: PublicUser, action: string, target: { type: string; id?: string; label?: string }, metadata?: Record<string, unknown>) {
    await safeRecordAuditLog({ action, actor: auditActorFromRequest(request, user), target, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) });
}

export function runningHubRouteError(error: unknown, fallback: string) {
    if (error instanceof RunningHubError) return apiCompatError(error.status, error.message);
    return apiCompatError(500, error instanceof Error ? error.message : fallback);
}
