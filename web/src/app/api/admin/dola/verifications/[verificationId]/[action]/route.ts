import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { dolaRuntimeRequest } from "@/lib/server/dola/provider";
import { markDolaAccountReady, markDolaAccountUnusable, refreshDolaAccountCookieIfVersion, updateDolaAccountCredentials, updateDolaAccountQuota } from "@/lib/server/dola/account-service";
import { completeDolaGoogleLoginSession } from "@/lib/server/dola/service";
import type { DolaQuotaSnapshot } from "@/lib/server/dola/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ verificationId: string; action: string }> };

export async function POST(request: Request, context: Context) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const { verificationId, action } = await context.params;
    if (!/^(open|input|keyboard|finalize|google-finalize|resume|close)$/.test(action)) return apiCompatError(404, "验证操作不存在");
    let body: Record<string, unknown> = {};
    if (action !== "open") {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
        body = parsed.data;
        if (typeof body.leaseToken !== "string" || body.leaseToken.length < 16) return apiCompatError(400, "验证租约无效");
        if (action === "input" && (!["down", "move", "up", "wheel"].includes(String(body.action)) || typeof body.x !== "number" || typeof body.y !== "number" || (body.action === "wheel" && (typeof body.deltaY !== "number" || !Number.isFinite(body.deltaY))))) return apiCompatError(400, "页面坐标或动作无效");
        if (action === "keyboard" && (typeof body.text !== "string" || !body.text.length || body.text.length > 500)) return apiCompatError(400, "键盘输入无效");
    }
    if (action === "google-finalize") {
        try {
            const result = await completeDolaGoogleLoginSession(verificationId, String(body.leaseToken), typeof body.name === "string" ? body.name.trim().slice(0, 120) : undefined);
            if (result.status === "saved") await auditDolaAdminAction(request, access.user, "admin.dola.google_login.complete", { type: "dola_account", id: result.account?.id });
            return apiSuccess(result, result.status === "saved" ? "Google 授权账号已保存" : "Dola 登录尚未确认，浏览器保持打开");
        } catch (error) {
            await auditDolaAdminFailure(request, access.user, "admin.dola.google_login.complete", { type: "dola_verification", id: verificationId });
            return dolaRouteError(error, "保存 Google 授权账号失败，浏览器保持打开");
        }
    }
    try {
        const response = await dolaRuntimeRequest(`/v1/verifications/${encodeURIComponent(verificationId)}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const payload = parseRecord(bytes);
        const error = !response.ok ? stringValue(payload?.detail || payload?.error) || "Dola 验证操作失败" : "";
        const alreadyClosed = action === "close" && response.status === 404 && error === "verification_not_found";
        const succeeded = response.ok || alreadyClosed;
        if (!response.ok) {
            if (alreadyClosed) return apiSuccess({ verificationId, status: "closed" }, "授权浏览器已关闭");
            return apiCompatError(response.status, error);
        }
        if (action === "finalize") {
            if (payload?.status === "needs_login") {
                const loggedOutAccountId = stringValue(payload.accountId);
                // 有头测试确认 Cookie 已被上游踢出登录：立即落库并归入「登录失败」分类，
                // 浏览器保持打开以便重新登录后再次完成测试覆盖该状态。
                if (loggedOutAccountId) await markDolaAccountUnusable(loggedOutAccountId, "needs_login").catch(() => undefined);
                return apiSuccess(withoutCredential(payload), loggedOutAccountId ? "账号登录状态已失效，已保存并归入「登录失败」分类；可在当前窗口重新登录后再次完成测试" : "账号登录状态已失效；可在当前窗口重新登录后再次完成测试");
            }
            if (payload?.status !== "ready") return apiSuccess(withoutCredential(payload), "账号尚未确认登录，浏览器保持打开");
            const accountId = stringValue(payload.accountId);
            const cookie = typeof payload.cookie === "string" ? payload.cookie : "";
            if (!accountId || !cookie || !Number.isSafeInteger(payload.credentialVersion)) return apiCompatError(502, "未能取得有效账号 Cookie，浏览器保持打开");
            let changed = false;
            try { ({ changed } = await refreshDolaAccountCookieIfVersion(accountId, cookie, Number(payload.credentialVersion))); }
            catch (error) {
                if (error instanceof Error && error.message === "cookie_version_conflict") return apiCompatError(409, "账号 Cookie 已由其他操作更新，本次测试不会覆盖它；浏览器保持打开");
                throw error;
            }
            const closed = await dolaRuntimeRequest(`/v1/verifications/${encodeURIComponent(verificationId)}/close`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: body.leaseToken }),
            }).then((result) => result.ok).catch(() => false);
            return apiSuccess({ status: "saved", changed, windowClosed: closed }, closed ? "已保存当前账号 Cookie 并关闭浏览器" : "Cookie 已保存，请手动关闭仍在运行的浏览器");
        }
        if (action === "resume" && payload?.status === "accepted" && typeof payload.accountId === "string") {
            const accountId = payload.accountId;
            if (typeof payload.cookie === "string" && payload.cookie) {
                await updateDolaAccountCredentials(accountId, payload.cookie).catch(() => undefined);
            }
            if (Array.isArray(payload.quota)) {
                const quota: DolaQuotaSnapshot[] = payload.quota
                    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
                    .map((item) => ({
                        bucket: stringValue(item.bucket) || "video",
                        model: stringValue(item.model) || undefined,
                        unit: item.unit === "count" || item.unit === "credit" ? item.unit : "unknown",
                        remaining: nonNegativeNumber(item.remaining),
                        limit: nonNegativeNumber(item.limit),
                        observedAt: new Date().toISOString(),
                        source: item.source === "upstream" || item.source === "local" ? item.source : "unknown",
                        version: 1,
                    }));
                await updateDolaAccountQuota(accountId, quota).catch(() => undefined);
            }
            await markDolaAccountReady(accountId).catch(() => undefined);
        }
        return apiSuccess(withoutCredential(payload), action === "open" ? "已打开 Dola 验证窗口" : action === "resume" ? "已恢复 Dola 请求" : action === "close" ? "已关闭 Dola 验证" : "验证操作已发送");
    } catch (error) {
        return dolaRouteError(error, "Dola 验证操作失败");
    }
}

function parseRecord(bytes: Uint8Array) {
    try { const value = JSON.parse(new TextDecoder().decode(bytes)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function stringValue(value: unknown) { return typeof value === "string" ? value.slice(0, 800) : ""; }
function nonNegativeNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function withoutCredential(value: Record<string, unknown> | null) { if (!value) return value; const { cookie: _cookie, ...safe } = value; return safe; }
