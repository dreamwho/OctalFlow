import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { dolaRuntimeRequest } from "@/lib/server/dola/provider";
import { openDolaRequestLog, settleDolaRequestLog, type DolaRequestLifecycleEntry } from "@/lib/server/dola/log-store";
import { markDolaAccountReady, updateDolaAccountCredentials, updateDolaAccountQuota } from "@/lib/server/dola/account-service";
import type { DolaQuotaSnapshot } from "@/lib/server/dola/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ verificationId: string; action: string }> };

export async function POST(request: Request, context: Context) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const { verificationId, action } = await context.params;
    if (!/^(open|input|resume|close)$/.test(action)) return apiCompatError(404, "验证操作不存在");
    let body: Record<string, unknown> = {};
    if (action !== "open") {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
        body = parsed.data;
        if (typeof body.leaseToken !== "string" || body.leaseToken.length < 16) return apiCompatError(400, "验证租约无效");
        if (action === "input" && (body.action !== "down" && body.action !== "move" && body.action !== "up" || typeof body.x !== "number" || typeof body.y !== "number")) return apiCompatError(400, "页面坐标或动作无效");
    }
    const started = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: `提交验证操作：${action}`, durationMs: 0, detail: `验证会话: ${verificationId}` }];
    let logId = "";
    try {
        logId = await openDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: `/v1/verifications/${encodeURIComponent(verificationId)}/${action}`, model: "", verificationId: verificationId.slice(0, 300), requestPreview: JSON.stringify(body), headers: { "content-type": "application/json" }, lifecycle });
    } catch (error) {
        console.error("Failed to open Dola verification request log", error);
    }
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Dola Provider 发起验证操作", durationMs: Date.now() - started, detail: "租约令牌仅用于服务端转发" });
    try {
        const response = await dolaRuntimeRequest(`/v1/verifications/${encodeURIComponent(verificationId)}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const payload = parseRecord(bytes);
        const error = !response.ok ? stringValue(payload?.detail || payload?.error) || "Dola 验证操作失败" : "";
        lifecycle.push({ time: new Date().toISOString(), phase: response.ok ? "success" : "failed", message: response.ok ? "验证操作已返回" : "验证操作失败", durationMs: Date.now() - started, detail: `HTTP ${response.status}` });
        if (logId) await settleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase: response.ok ? "success" : "failed", ...(error ? { error } : {}), responsePreview: summarizeResponse(payload, bytes), responseBytes: bytes.byteLength, contentType: response.headers.get("content-type") || undefined, verificationId: verificationId.slice(0, 300), lifecycle });
        if (!response.ok) {
            return apiCompatError(response.status, error);
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
        if (logId) await settleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: error instanceof Error ? error.message : "Dola 验证操作失败", verificationId: verificationId.slice(0, 300), lifecycle: [...lifecycle, { time: new Date().toISOString(), phase: "failed", message: error instanceof Error ? error.message : "Dola 验证操作失败", durationMs: Date.now() - started }] });
        return dolaRouteError(error, "Dola 验证操作失败");
    }
}

function parseRecord(bytes: Uint8Array) {
    try { const value = JSON.parse(new TextDecoder().decode(bytes)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function stringValue(value: unknown) { return typeof value === "string" ? value.slice(0, 800) : ""; }
function nonNegativeNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function withoutCredential(value: Record<string, unknown> | null) { if (!value) return value; const { cookie: _cookie, ...safe } = value; return safe; }
function summarizeResponse(value: Record<string, unknown> | null, bytes: Uint8Array) {
    if (!value) return bytes.byteLength ? "Dola 验证响应无法解析" : "";
    const summary = Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|token|secret|password|base64|dataurl|video_?url/i.test(key)));
    const rendered = JSON.stringify(summary, null, 2);
    return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}…` : rendered;
}
