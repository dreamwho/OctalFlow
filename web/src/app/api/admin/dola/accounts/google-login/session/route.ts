import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { startDolaGoogleLoginSession } from "@/lib/server/dola/service";
import { dolaGoogleLoginMode } from "@/lib/server/dola/provider";
import type { DolaLoginProxySelection } from "@/lib/server/dola/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ timeoutSeconds?: unknown; proxySelection?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const timeoutSeconds = parsed.data.timeoutSeconds;
    if (!Number.isSafeInteger(timeoutSeconds) || Number(timeoutSeconds) <= 0) return apiCompatError(400, "授权窗口保留时间必须为正整数秒");
    const rawSelection = parsed.data.proxySelection;
    if (rawSelection !== undefined && (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection))) return apiCompatError(400, "请选择授权代理方式");
    const raw = rawSelection as Record<string, unknown> | undefined;
    const proxyMode = raw?.mode ?? "default";
    if (proxyMode !== "default" && proxyMode !== "direct" && proxyMode !== "generic" && proxyMode !== "magic" && proxyMode !== "chained") return apiCompatError(400, "请选择授权代理方式");
    const target = typeof raw?.target === "string" ? raw.target.trim() : "";
    if (target.length > 256 || ((proxyMode === "default" || proxyMode === "direct") && target)) return apiCompatError(400, "授权代理节点无效");
    if (proxyMode === "generic" && (!target.startsWith("node:") || target.length <= 5)) return apiCompatError(400, "请选择通用代理节点");
    if ((proxyMode === "magic" || proxyMode === "chained") && !target) return apiCompatError(400, "请选择 Dola 已绑定的代理节点");
    const selection: DolaLoginProxySelection = { mode: proxyMode, ...(target ? { target } : {}) };
    try {
        const mode = dolaGoogleLoginMode(request.url);
        const result = await startDolaGoogleLoginSession(access.user.id, Number(timeoutSeconds), mode, selection);
        await auditDolaAdminAction(request, access.user, "admin.dola.google_login.start", { type: "dola_verification", id: result.verificationId }, { mode, proxyMode, target });
        return apiSuccess(result, mode === "native" ? "已打开本机 Google 授权浏览器" : "已启动远程 Google 授权浏览器");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.google_login.start", { type: "dola_verification", id: "google" });
        return dolaRouteError(error, "启动远程 Google 授权失败");
    }
}
