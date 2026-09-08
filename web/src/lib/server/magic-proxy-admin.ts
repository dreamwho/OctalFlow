import { apiCompatError } from "@/app/api/_shared/api-response";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import type { PublicUser } from "@/lib/auth/store";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { MagicProxyError } from "@/lib/server/magic-proxy-service";
import { readRequestBodyText, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

const MAX_MAGIC_PROXY_ADMIN_BODY_BYTES = 64 * 1024;

export async function requireMagicProxyAdmin() {
    const user = await getCurrentUser();
    if (!user) return { error: apiCompatError(401, "请先登录") } as const;
    if (!hasAdminPermission(user, "upstream.manage")) return { error: apiCompatError(403, "需要上游配置管理权限") } as const;
    return { user } as const;
}

export async function auditMagicProxyAction(request: Request, user: PublicUser, action: string, target: { type: string; id?: string }, metadata?: Record<string, unknown>) {
    await safeRecordAuditLog({ action, actor: auditActorFromRequest(request, user), target, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) });
}

export async function auditMagicProxyFailure(request: Request, user: PublicUser | undefined, action: string, target: { type: string; id?: string }) {
    if (!user) return;
    await safeRecordAuditLog({ action, status: "failure", actor: auditActorFromRequest(request, user), target, metadata: { error: "request_failed" } });
}

export function magicProxyRouteError(error: unknown, fallback: string) {
    if (error instanceof MagicProxyError) return apiCompatError(error.status, error.message);
    return apiCompatError(500, fallback);
}

export async function readMagicProxyAdminJson<T = Record<string, unknown>>(request: Request): Promise<T> {
    try {
        const raw = await readRequestBodyText(request, MAX_MAGIC_PROXY_ADMIN_BODY_BYTES);
        return JSON.parse(raw || "{}") as T;
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) throw new MagicProxyError("请求内容不能超过 64KB", error.status);
        if (error instanceof SyntaxError) throw new MagicProxyError("请求 JSON 格式无效", 400);
        throw error;
    }
}
