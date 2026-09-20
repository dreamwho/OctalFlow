import { NextResponse } from "next/server";

import { authorizeDolaApiKey, getDolaGatewaySettings } from "@/lib/server/dola/gateway-store";
import { getDolaAccountCookie, markDolaAccountRateLimited, markDolaAccountUsed, releaseDolaAccountAttempt, reserveDolaAccount } from "@/lib/server/dola/account-service";
import { bindDolaExternalTask, getDolaExternalTask, releaseDolaExternalTask, resolveDolaExternalTask, updateDolaExternalTask } from "@/lib/server/dola/external-task-store";
import { advanceDolaTaskLog, dolaTaskLogPhase, findDolaTaskLogIdByTaskId, markDolaRequestLogRunning, openDolaRequestLog, settleDolaRequestLog, type DolaRequestLifecycleEntry, type DolaRequestLogPhase } from "@/lib/server/dola/log-store";
import { dolaProviderProxyMode, resolveDolaProxyEgress } from "@/lib/server/dola/proxy";
import { dolaRuntimeRequest, isDolaPublicRuntimePath } from "@/lib/server/dola/provider";
import { isSafeOutboundUrl } from "@/lib/server/security";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { fetchSafeUpstreamMedia, MediaProxyResponseError } from "@/lib/server/media-proxy-service";
import { MAX_MEDIA_PROXY_BYTES, MAX_MEDIA_PROXY_RANGE_BYTES, normalizeMediaProxyRange } from "@/lib/server/media-response-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: Context) { return proxy(request, context); }
export async function HEAD(request: Request, context: Context) { return proxy(request, context); }
export async function POST(request: Request, context: Context) { return proxy(request, context); }


/** 识别上游账号级限流错误（Dola 协议约定错误码：rate_limited / too many requests） */
function isDolaRateLimitError(text: string) {
    return /rate[_ ]?limited|rate limit|too many requests/i.test(text || "");
}

/** Dola 协议错误码中英双语说明，便于第一时间定位问题 */
function describeDolaFailure(code: string) {
    const raw = (code || "").trim() || "unknown";
    const table: Array<[RegExp, string]> = [
        [/rate[_ ]?limited|rate limit|too many requests/i, "上游账号触发生成频率/数量限制 (upstream account rate-limited)"],
        [/quota/i, "上游账号配额已耗尽 (upstream account quota exhausted)"],
        [/login|auth|cookie|credential/i, "账号登录态失效，请重新验证 Cookie (account session expired; re-verify the cookie)"],
        [/task[_ ]?not[_ ]?found/i, "任务不存在或已被 Provider 清理 (task not found; it may have been cleaned up)"],
        [/timeout|timed out/i, "上游处理超时 (upstream timeout)"],
        [/sensitive|risk|moderation|blocked/i, "内容被上游风控拦截 (content blocked by upstream risk control)"],
    ];
    const hit = table.find(([re]) => re.test(raw));
    return `${raw}${hit ? `（${hit[1]}）` : "（上游返回未知错误 unknown upstream error）"}`;
}

const DOLA_MAX_ACCOUNT_ROTATIONS = 2;

/** 上游账号触发限额：标记账号冷却，并自动用下一个可用账号重新提交同一请求 */
async function rotateDolaRateLimitedTask(input: { taskId: string; principalId: string; accountId: string; rotations: number; originalPayload?: Record<string, unknown>; model: string }) {
    await markDolaAccountRateLimited(input.accountId).catch(() => undefined);
    if (!input.originalPayload || input.rotations >= DOLA_MAX_ACCOUNT_ROTATIONS) return null;
    const newAccount = await reserveDolaAccount(input.model || undefined);
    if (!newAccount) return null;
    const cookie = await getDolaAccountCookie(newAccount.id);
    if (!cookie) return null;
    let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
    try {
        proxy = await resolveDolaProxyEgress();
    } catch {
        return null;
    }
    const body = JSON.stringify({
        ...input.originalPayload,
        accountId: newAccount.id,
        credentialVersion: newAccount.credentialVersion,
        cookie,
        transport: "camoufox-page",
        proxyMode: dolaProviderProxyMode(proxy.egress),
        proxySource: proxy.egress.mode,
        proxyTarget: proxy.egress.target,
        ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}),
        dolaHold: true,
    });
    let upstream: Response;
    try {
        upstream = await dolaRuntimeRequest("/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch {
        return null;
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    let parsed: Record<string, unknown> | null = null;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
        parsed = null;
    }
    const newTaskId = stringValue(parsed?.taskId || parsed?.id);
    if (!upstream.ok || !newTaskId) return null;
    await updateDolaExternalTask(input.taskId, input.principalId, { redirectToTaskId: newTaskId, accountId: newAccount.id, rotations: input.rotations + 1 });
    await releaseDolaAccountAttempt(input.accountId).catch(() => undefined);
    return {
        newTaskId,
        newAccountId: newAccount.id,
        payload: parsed,
        status: upstream.status,
        responseBytes: bytes.byteLength,
        responsePreview: summarizeResponse(parsed, bytes),
        message: "上游账号触发限额（rate_limited），已自动切换账号重试 (upstream account rate-limited; auto-switched to another account)",
        detail: `原账号已标记限额并冷却 10 分钟 (previous account marked and cooling down)；新账号 (new account): ${newAccount.id}，新任务 (new task): ${newTaskId}`,
    };
}

async function proxy(request: Request, context: Context) {
    const gateway = await getDolaGatewaySettings();
    if (!gateway.enabled) return NextResponse.json({ error: "Dola API 网关未启用" }, { status: 503 });
    const key = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || request.headers.get("x-api-key")?.trim() || "";
    const clientIp = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || request.headers.get("x-real-ip")?.trim() || undefined;
    const principal = key ? await authorizeDolaApiKey(key, clientIp) : null;
    if (!principal) return NextResponse.json({ error: "Dola API 密钥无效或来源地址未授权" }, { status: 401 });
    const principalId = (principal as { id: string }).id;
    const { path } = await context.params;
    const runtimePath = `/${path.join("/")}${new URL(request.url).search}`;
    if (!isDolaPublicRuntimePath(runtimePath)) return NextResponse.json({ error: "Dola API 不支持该路径" }, { status: 404 });
    const normalizedPath = runtimePath.split("?", 1)[0].replace(/\/+$/, "") || "/";
    const contentMatch = normalizedPath.match(/^\/v1\/videos\/([^/]+)\/content$/);
    const queryMatch = normalizedPath.match(/^\/v1\/(?:videos|images)\/([^/]+)$/);
    let effectiveTaskId = "";
    let externalTaskRow: Awaited<ReturnType<typeof resolveDolaExternalTask>> = null;
    if (contentMatch || queryMatch) {
        const taskId = decodeURIComponent((contentMatch || queryMatch)![1]);
        const externalTask = await getDolaExternalTask(taskId, principalId);
        if (!externalTask) return NextResponse.json({ error: "任务不存在或无权访问" }, { status: 404 });
        if (contentMatch) return serveDolaVideoContent(request, taskId, principalId, externalTask.accountId);
        // 账号限额自动换号后，旧任务 id 会重定向到新任务：查询与日志都跟随旧 id，对调用方透明
        const resolved = await resolveDolaExternalTask(taskId, principalId);
        externalTaskRow = resolved;
        effectiveTaskId = resolved?.effectiveTaskId || taskId;
    }
    let upstreamPath = runtimePath;
    if (effectiveTaskId && queryMatch) {
        const queriedTaskId = decodeURIComponent(queryMatch[1]);
        if (effectiveTaskId !== queriedTaskId) upstreamPath = normalizedPath.replace(queriedTaskId, effectiveTaskId) + (runtimePath.split("?")[1] ? `?${runtimePath.split("?")[1]}` : "");
    }
    const startedAt = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(startedAt).toISOString(), phase: "queued", message: "接收到 Dola 外部 API 请求", durationMs: 0, detail: `${request.method} ${normalizedPath}` }];
    // Polls attach to the original external create log by task id so one task stays one log row with a full lifecycle.
    const attachedTaskLogId = queryMatch ? await safeFindTaskLog(decodeURIComponent(queryMatch[1])) : "";
    const capability = runtimePath.split("?", 1)[0] === "/v1/images" ? ("image" as const) : ("video" as const);
    const logId = attachedTaskLogId ? "" : await safeOpenLog({ source: "external", capability, method: request.method, path: normalizedPath, model: "", clientIp, userAgent: request.headers.get("user-agent") || undefined, headers: { accept: request.headers.get("accept") || "", "content-type": request.headers.get("content-type") || "" } }, lifecycle);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    let body: BodyInit | undefined;
    let requestPreview = "";
    let requestBytes = 0;
    let requestModel = "";
    let requestedDuration: number | undefined;
    let requestedRatio = "";
    let accountId = "";
    const videoCreate = request.method === "POST" && ["/v1/videos", "/v1/images"].includes(runtimePath.split("?", 1)[0]);
    let holdAccountAttempt = false;
    let requestProxyEgress: { mode: "direct" | "magic" | "generic" | "chained"; nodeName?: string } = { mode: "direct" };
    if (request.method !== "GET" && request.method !== "HEAD") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        requestBytes = bytes.byteLength;
        if (bytes.byteLength > 4 * 1024 * 1024) {
            await safeSettleLog(logId, { statusCode: 413, durationMs: Date.now() - startedAt, phase: "failed", error: "Dola API 请求体过大", requestBytes: bytes.byteLength, lifecycle: [...lifecycle, logLifecycleEntry("failed", "Dola API 请求体过大", startedAt)] });
            return NextResponse.json({ error: "Dola API 请求体过大" }, { status: 413 });
        }
        requestPreview = summarizeRequest(bytes);
        if (videoCreate && headers.get("content-type")?.toLowerCase().includes("application/json")) {
            let payload: Record<string, unknown>;
            try {
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object_required");
                payload = { ...(parsed as Record<string, unknown>) };
            } catch {
                await safeSettleLog(logId, { statusCode: 400, durationMs: Date.now() - startedAt, phase: "failed", error: "Dola 视频请求必须是有效 JSON", requestBytes: bytes.byteLength, requestPreview, lifecycle: [...lifecycle, logLifecycleEntry("failed", "Dola 视频请求必须是有效 JSON", startedAt)] });
                return NextResponse.json({ error: "Dola 视频请求必须是有效 JSON" }, { status: 400 });
            }
            requestModel = stringValue(payload.model);
            requestedDuration = numberValue(payload.duration);
            requestedRatio = stringValue(payload.ratio);
            await safeMarkLog(logId, { phase: "auth", message: "选择可用 Cookie 账号", detail: `模型: ${typeof payload.model === "string" ? payload.model : "未声明"}` });
            const account = await reserveDolaAccount(typeof payload.model === "string" ? payload.model : undefined);
            if (!account) {
                await safeSettleLog(logId, { statusCode: 503, durationMs: Date.now() - startedAt, phase: "failed", error: "没有可用的 Dola Cookie 账号", model: requestModel || undefined, requestedDuration, ratio: requestedRatio || undefined, requestBytes: bytes.byteLength, requestPreview, lifecycle: [...lifecycle, logLifecycleEntry("failed", "没有可用的 Dola Cookie 账号", startedAt)] });
                return NextResponse.json({ error: "没有可用的 Dola Cookie 账号" }, { status: 503 });
            }
            accountId = account.id;
            const cookie = await getDolaAccountCookie(account.id);
            if (!cookie) {
                await releaseDolaAccountAttempt(account.id);
                await safeSettleLog(logId, { statusCode: 503, durationMs: Date.now() - startedAt, phase: "failed", error: "Dola 账号 Cookie 无法解密", model: requestModel || undefined, requestedDuration, ratio: requestedRatio || undefined, accountId, accountName: account.name, requestBytes: bytes.byteLength, requestPreview, lifecycle: [...lifecycle, logLifecycleEntry("failed", "Dola 账号 Cookie 无法解密", startedAt)] });
                return NextResponse.json({ error: "Dola 账号 Cookie 无法解密" }, { status: 503 });
            }
            let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
            try {
                proxy = await resolveDolaProxyEgress();
            } catch (error) {
                await releaseDolaAccountAttempt(account.id);
                await safeSettleLog(logId, { statusCode: 503, durationMs: Date.now() - startedAt, phase: "failed", error: error instanceof Error ? error.message : "Dola 通用代理出口不可用", model: requestModel || undefined, requestedDuration, ratio: requestedRatio || undefined, accountId, accountName: account.name, requestBytes: bytes.byteLength, requestPreview, lifecycle: [...lifecycle, logLifecycleEntry("failed", error instanceof Error ? error.message : "Dola 通用代理出口不可用", startedAt)] });
                return NextResponse.json({ error: error instanceof Error ? error.message : "Dola 通用代理出口不可用" }, { status: 503 });
            }
            delete payload.cookie;
            holdAccountAttempt = true;
            body = JSON.stringify({ ...payload, accountId: account.id, credentialVersion: account.credentialVersion, cookie, transport: "camoufox-page", proxyMode: dolaProviderProxyMode(proxy.egress), proxySource: proxy.egress.mode, proxyTarget: proxy.egress.target, ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}), dolaHold: true });
            requestProxyEgress = proxy.egress.mode === "direct" ? { mode: "direct" } : { mode: proxy.egress.mode, nodeName: proxy.egress.nodeName || proxy.egress.target };
            lifecycle.push({ time: new Date().toISOString(), phase: "routing", message: "代理出口路由绑定完成", durationMs: Date.now() - startedAt, detail: proxy.egress.mode === "direct" ? "直连" : `模式: ${proxy.egress.mode}` });
            lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Dola Provider 发起视频请求", durationMs: Date.now() - startedAt, detail: "授权 Cookie 和参考图仅在服务端转发" });
            await safeMarkLog(logId, { phase: "upstream", message: "向 Dola Provider 发起视频请求", detail: "授权 Cookie 和参考图仅在服务端转发" });
        } else {
            body = bytes;
        }
        if (!videoCreate) await safeMarkLog(logId, { phase: "upstream", message: "向 Dola Provider 发起请求" });
        headers.delete("content-length");
        headers.delete("transfer-encoding");
    }
    let upstream: Response;
    try {
        upstream = await dolaRuntimeRequest(upstreamPath, { method: request.method, headers, body, signal: request.signal });
    } catch (error) {
        if (accountId) await markDolaAccountUsed(accountId, false).catch(() => undefined);
        await safeSettleLog(logId, { statusCode: 502, durationMs: Date.now() - startedAt, phase: "failed", error: error instanceof Error ? error.message : "Dola Provider 请求失败", model: requestModel || undefined, accountId: accountId || undefined, requestedDuration, ratio: requestedRatio || undefined, proxyEgress: requestProxyEgress, lifecycle: [...lifecycle, logLifecycleEntry("failed", error instanceof Error ? error.message : "Dola Provider 请求失败", startedAt)] });
        return NextResponse.json({ error: error instanceof Error ? error.message : "Dola Provider 请求失败" }, { status: 502 });
    }
    if (accountId) await markDolaAccountUsed(accountId, upstream.ok, !(holdAccountAttempt && upstream.ok)).catch(() => undefined);
    if (videoCreate || queryMatch) {
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        const payload = parseJsonRecord(bytes);
        const taskId = stringValue(payload?.taskId || payload?.id);
        const verificationId = stringValue(payload?.verificationId || payload?.verification_id);
        if (attachedTaskLogId) {
            if (upstream.ok) {
                const phase = dolaTaskLogPhase(stringValue(payload?.status), Boolean(verificationId));
                const errorText = stringValue(payload?.error);
                if (phase === "failed" && isDolaRateLimitError(errorText) && externalTaskRow) {
                    // 账号级限额：标记当前账号冷却，并自动用下一个可用账号重新提交同一请求
                    const rotation = await rotateDolaRateLimitedTask({
                        taskId: decodeURIComponent(queryMatch![1]),
                        principalId,
                        accountId: externalTaskRow.record.accountId,
                        rotations: externalTaskRow.record.rotations || 0,
                        originalPayload: externalTaskRow.record.originalPayload,
                        model: requestModel,
                    });
                    if (rotation) {
                        await safeAdvanceTaskLog(attachedTaskLogId, {
                            phase: "generating",
                            message: rotation.message,
                            detail: rotation.detail,
                            statusCode: upstream.status,
                            responsePreview: rotation.responsePreview,
                        });
                        return new Response(JSON.stringify({ ...(rotation.payload || {}), taskId }), { status: upstream.status, headers: { "content-type": "application/json" } });
                    }
                }
                await safeAdvanceTaskLog(attachedTaskLogId, {
                    phase,
                    message:
                        phase === "success"
                            ? "生成完成，最终结果已返回"
                            : phase === "failed"
                              ? `生成失败：${errorText ? describeDolaFailure(errorText) : "上游未返回错误原因 (no error detail from upstream)"}`
                              : phase === "needs_review"
                                ? "任务等待人工确认（滑块验证）"
                                : phase === "generating"
                                  ? "Dola 上游已受理，生成中"
                                  : "Dola 上游排队中，等待生成",
                    detail: dolaResultMediaDetail(payload) || `上游任务状态: ${stringValue(payload?.status) || "unknown"}`,
                    statusCode: upstream.status,
                    responsePreview: summarizeResponse(payload, bytes),
                    responseBytes: bytes.byteLength,
                    ...(phase === "failed" && errorText ? { error: errorText } : {}),
                    ...(verificationId ? { verificationId } : {}),
                });
            } else if (upstream.status === 404) {
                await safeAdvanceTaskLog(attachedTaskLogId, { phase: "failed", message: "生成失败：任务在 Provider 中不存在（可能已被重启清理）", statusCode: upstream.status, error: "task_not_found" });
            }
        } else {
            const phase = classifyDolaPhase(upstream, payload, verificationId);
            if (upstream.ok && stringValue(payload?.status) === "failed" && isDolaRateLimitError(stringValue(payload?.error)) && accountId) {
                await markDolaAccountRateLimited(accountId).catch(() => undefined);
            }
            lifecycle.push({ time: new Date().toISOString(), phase, message: phase === "needs_review" ? "Provider 返回待人工确认状态" : phase === "submitted" ? "已提交到 Dola 上游，任务排队中" : upstream.ok ? "Provider 已返回任务响应" : "Provider 请求失败", durationMs: Date.now() - startedAt, detail: `HTTP ${upstream.status}${taskId ? `, 任务: ${taskId}` : ""}` });
            await safeSettleLog(logId, { statusCode: upstream.status, durationMs: Date.now() - startedAt, phase, ...(upstream.ok ? {} : { error: stringValue(payload?.error) ? describeDolaFailure(stringValue(payload?.error)) : "Dola Provider 请求失败" }), model: requestModel || stringValue(payload?.model) || undefined, requestBytes, requestPreview, responseBytes: bytes.byteLength, contentType: upstream.headers.get("content-type") || undefined, accountId: accountId || undefined, taskId: taskId || undefined, verificationId: verificationId || undefined, requestedDuration: requestedDuration || numberValue(payload?.duration), ratio: requestedRatio || stringValue(payload?.ratio) || undefined, ...quotaObservation(payload), proxyEgress: requestProxyEgress, responsePreview: summarizeResponse(payload, bytes), lifecycle });
        }
        if (videoCreate && upstream.ok && taskId) await bindDolaExternalTask({ taskId, apiKeyId: principalId, accountId });
        if (queryMatch && upstream.ok && terminalDolaStatus(stringValue(payload?.status))) {
            const releasedAccountId = await releaseDolaExternalTask(decodeURIComponent(queryMatch[1]), principalId);
            if (releasedAccountId) await releaseDolaAccountAttempt(releasedAccountId).catch(() => undefined);
        }
        return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    }
    lifecycle.push({ time: new Date().toISOString(), phase: upstream.ok ? "success" : "failed", message: upstream.ok ? "Provider 响应已交付" : "Provider 请求失败", durationMs: Date.now() - startedAt, detail: `HTTP ${upstream.status}` });
    await safeSettleLog(logId, { statusCode: upstream.status, durationMs: Date.now() - startedAt, phase: upstream.ok ? "success" : "failed", ...(upstream.ok ? {} : { error: "Dola Provider 请求失败" }), model: requestModel || undefined, requestedDuration, ratio: requestedRatio || undefined, requestBytes, requestPreview, contentType: upstream.headers.get("content-type") || undefined, accountId: accountId || undefined, proxyEgress: requestProxyEgress, lifecycle });
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}

async function serveDolaVideoContent(request: Request, taskId: string, apiKeyId: string, accountId: string) {
    const started = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: "读取 Dola 视频内容", durationMs: 0, detail: `任务: ${taskId}` }];
    const logId = await safeOpenLog({ source: "external", capability: "video", method: request.method, path: `/v1/videos/${encodeURIComponent(taskId)}/content`, model: "", accountId, taskId }, lifecycle);
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "查询 Provider 视频地址", durationMs: Date.now() - started });
    await safeMarkLog(logId, { phase: "upstream", message: "查询 Provider 视频地址" });
    let upstream: Response;
    try {
        upstream = await dolaRuntimeRequest(`/v1/videos/${encodeURIComponent(taskId)}`, { method: "GET", signal: request.signal });
    } catch (error) {
        await safeSettleLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: error instanceof Error ? error.message : "Dola 任务查询失败", accountId, taskId, lifecycle: [...lifecycle, logLifecycleEntry("failed", "Dola 任务查询失败", started)] });
        return NextResponse.json({ error: error instanceof Error ? error.message : "Dola 任务查询失败" }, { status: 502 });
    }
    const queryBytes = new Uint8Array(await upstream.arrayBuffer());
    const payload = parseJsonRecord(queryBytes);
    if (!upstream.ok) {
        const error = stringValue(payload?.error) || "Dola 任务查询失败";
        await safeSettleLog(logId, { statusCode: upstream.status, durationMs: Date.now() - started, phase: "failed", error, responsePreview: summarizeResponse(payload, queryBytes), responseBytes: queryBytes.byteLength, accountId, taskId, lifecycle: [...lifecycle, logLifecycleEntry("failed", error, started)] });
        return NextResponse.json({ error }, { status: upstream.status });
    }
    const status = stringValue(payload?.status);
    const queryPhase = status === "completed" ? "success" : status === "failed" ? "failed" : "running";
    lifecycle.push(logLifecycleEntry(queryPhase, `任务状态：${status || "running"}`, started));
    if (terminalDolaStatus(status)) {
        const releasedAccountId = await releaseDolaExternalTask(taskId, apiKeyId);
        if (releasedAccountId) await releaseDolaAccountAttempt(releasedAccountId).catch(() => undefined);
    }
    if (status !== "completed") {
        const error = status === "failed" ? stringValue(payload?.error) || "Dola 视频生成失败" : "Dola 视频尚未完成";
        if (status === "failed") lifecycle.push(logLifecycleEntry("failed", error, started));
        await safeSettleLog(logId, { statusCode: status === "failed" ? 502 : 409, durationMs: Date.now() - started, phase: status === "failed" ? "failed" : "running", error: status === "failed" ? error : undefined, responsePreview: summarizeResponse(payload, queryBytes), responseBytes: queryBytes.byteLength, accountId, taskId, ...quotaObservation(payload), lifecycle });
        return NextResponse.json({ error, status: status || "running" }, { status: status === "failed" ? 502 : 409 });
    }
    const videoUrl = stringValue(payload?.videoUrl || payload?.video_url);
    if (!videoUrl || !(await isSafeDolaVideoUrl(videoUrl))) {
        const error = "Dola 任务没有可用的视频地址";
        lifecycle.push(logLifecycleEntry("failed", error, started));
        await safeSettleLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error, responsePreview: summarizeResponse(payload, queryBytes), responseBytes: queryBytes.byteLength, accountId, taskId, ...quotaObservation(payload), lifecycle });
        return NextResponse.json({ error }, { status: 502 });
    }
    const range = normalizeMediaProxyRange(request.headers.get("range"));
    if (range === "invalid") {
        const error = "Invalid media range";
        lifecycle.push(logLifecycleEntry("failed", error, started));
        await safeSettleLog(logId, { statusCode: 416, durationMs: Date.now() - started, phase: "failed", error, responsePreview: summarizeResponse(payload, queryBytes), responseBytes: queryBytes.byteLength, accountId, taskId, ...quotaObservation(payload), lifecycle });
        return NextResponse.json({ error }, { status: 416 });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    try {
        const maxBytes = range ? MAX_MEDIA_PROXY_RANGE_BYTES : MAX_MEDIA_PROXY_BYTES;
        const media = await fetchSafeUpstreamMedia({
            method: request.method === "HEAD" ? "HEAD" : "GET",
            range,
            maxBytes,
            timeoutMs: 30_000,
            fetcher: (method, nextRange) => fetchDolaUrl(videoUrl, method, nextRange, signal),
        });
        const headers = new Headers();
        for (const key of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
            const value = media.response.headers.get(key);
            if (value) headers.set(key, value);
        }
        headers.set("content-type", media.mimeType);
        headers.set("cache-control", "private, max-age=600");
        headers.set("cross-origin-resource-policy", "same-site");
        headers.set("x-content-type-options", "nosniff");
        lifecycle.push(logLifecycleEntry("success", "视频内容已准备并交付", started));
        const contentLength = Number(media.response.headers.get("content-length"));
        await safeSettleLog(logId, { statusCode: media.response.status, durationMs: Date.now() - started, phase: "success", responsePreview: summarizeResponse(payload, queryBytes), responseBytes: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : queryBytes.byteLength, contentType: media.mimeType, accountId, taskId, ...quotaObservation(payload), lifecycle });
        return new Response(media.body, { status: media.response.status, statusText: media.response.statusText, headers });
    } catch (error) {
        const statusCode = error instanceof MediaProxyResponseError ? error.status : 502;
        const message = error instanceof MediaProxyResponseError ? error.message : "Dola 视频下载失败";
        lifecycle.push(logLifecycleEntry("failed", message, started));
        await safeSettleLog(logId, { statusCode, durationMs: Date.now() - started, phase: "failed", error: message, responsePreview: summarizeResponse(payload, queryBytes), responseBytes: queryBytes.byteLength, accountId, taskId, ...quotaObservation(payload), lifecycle });
        return NextResponse.json({ error: message }, { status: statusCode });
    }
}

async function fetchDolaUrl(initialUrl: string, method: "GET" | "HEAD", range: string | null, signal: AbortSignal) {
    let currentUrl = initialUrl;
    for (let index = 0; index <= 4; index += 1) {
        const headers = new Headers();
        if (range) headers.set("range", range);
        const response = await fetchSafeOutbound(currentUrl, { method, headers, cache: "no-store", redirect: "manual", signal }, { allowProxyFakeIpSpace: true });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || index === 4) return response;
        currentUrl = new URL(location, currentUrl).toString();
        if (!(await isSafeDolaVideoUrl(currentUrl))) return new Response(null, { status: 502 });
    }
    return new Response(null, { status: 502 });
}

async function isSafeDolaVideoUrl(value: string) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        const allowedHost = host === "dola.com" || host.endsWith(".dola.com") || host === "byteintlapi.com" || host.endsWith(".byteintlapi.com");
        if (!["http:", "https:"].includes(url.protocol) || !allowedHost) return false;
        return await isSafeOutboundUrl(url.toString(), { allowCredentials: false, allowProxyFakeIpSpace: true });
    } catch {
        return false;
    }
}

function parseJsonRecord(value: Uint8Array) {
    try {
        const parsed = JSON.parse(new TextDecoder().decode(value));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function stringValue(value: unknown) { return typeof value === "string" ? value.slice(0, 500) : ""; }
function numberValue(value: unknown) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function quotaObservation(value: Record<string, unknown> | null) {
    const item = Array.isArray(value?.quota) ? value.quota.find((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object")) : value;
    if (!item || typeof item !== "object") return {};
    const hasRemaining = Object.prototype.hasOwnProperty.call(item, "remaining");
    const hasLimit = Object.prototype.hasOwnProperty.call(item, "limit");
    return { ...(hasRemaining ? { quotaRemaining: numberOrNull(item.remaining) } : {}), ...(hasLimit ? { quotaLimit: numberOrNull(item.limit) } : {}) };
}
function numberOrNull(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }
function terminalDolaStatus(value: string) { return value === "completed" || value === "failed"; }

async function safeOpenLog(input: Parameters<typeof openDolaRequestLog>[0], lifecycle: DolaRequestLifecycleEntry[]) {
    try { return await openDolaRequestLog({ ...input, lifecycle }); } catch (error) { console.error("Failed to open Dola external request log", error); return ""; }
}
async function safeMarkLog(id: string, entry: Parameters<typeof markDolaRequestLogRunning>[1]) {
    if (!id) return;
    try { await markDolaRequestLogRunning(id, entry); } catch (error) { console.error("Failed to update Dola external request log", error); }
}
async function safeSettleLog(id: string, settle: Parameters<typeof settleDolaRequestLog>[1]) {
    if (!id) return;
    try { await settleDolaRequestLog(id, settle); } catch (error) { console.error("Failed to settle Dola external request log", error); }
}
function logLifecycleEntry(phase: DolaRequestLogPhase, message: string, startedAt: number): DolaRequestLifecycleEntry { return { time: new Date().toISOString(), phase, message, durationMs: Date.now() - startedAt }; }
function summarizeRequest(bytes: Uint8Array) {
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        return JSON.stringify({ model: typeof value.model === "string" ? value.model : undefined, duration: numberValue(value.duration), ratio: typeof value.ratio === "string" ? value.ratio : undefined, referenceCount: Array.isArray(value.references) ? value.references.length : 0, promptLength: typeof value.prompt === "string" ? value.prompt.length : 0 });
    } catch { return "请求体无法解析为 JSON 摘要"; }
}
function summarizeResponse(value: Record<string, unknown> | null, bytes: Uint8Array) {
    if (!value) return bytes.byteLength ? "Provider 返回了无法解析的响应" : "";
    // Media result URLs stay visible: they are the deliverable the admin needs to see in the log detail.
    const summary = Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|token|secret|password|base64|dataurl/i.test(key)).map(([key, item]) => [key, typeof item === "string" && item.length > 500 ? `${item.slice(0, 500)}…` : item]));
    const rendered = JSON.stringify(summary, null, 2);
    return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}…` : rendered;
}
function classifyDolaPhase(response: Response, value: Record<string, unknown> | null, verificationId: string) {
    const status = stringValue(value?.status).toLowerCase();
    const error = stringValue(value?.error).toLowerCase();
    if (verificationId || ["needs_review", "verification_required", "submission_unknown", "pending_verification"].some((marker) => status.includes(marker) || error.includes(marker))) return "needs_review" as const;
    if (!response.ok) return "failed" as const;
    const taskId = stringValue(value?.taskId || value?.id);
    // Task creation responses mean the upstream queued the job, not that generation finished.
    if (taskId && status !== "completed" && status !== "failed") return "submitted" as const;
    if (taskId) return dolaTaskLogPhase(status);
    return "success" as const;
}
function dolaResultMediaDetail(value: Record<string, unknown> | null) {
    const videoUrl = stringValue(value?.videoUrl || value?.video_url);
    const imageUrls = Array.isArray(value?.imageUrls) ? value.imageUrls.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
    const urls = videoUrl ? [videoUrl] : imageUrls;
    if (!urls.length) return "";
    return urls.length === 1 ? `结果地址: ${urls[0]}` : `结果地址 (${urls.length}): ${urls.slice(0, 3).join(", ")}${urls.length > 3 ? " …" : ""}`;
}
async function safeFindTaskLog(taskId: string) {
    try { return await findDolaTaskLogIdByTaskId(taskId, "external"); } catch (error) { console.error("Failed to locate Dola external task log", error); return ""; }
}
async function safeAdvanceTaskLog(id: string, advance: Parameters<typeof advanceDolaTaskLog>[1]) {
    if (!id) return;
    try { await advanceDolaTaskLog(id, advance); } catch (error) { console.error("Failed to advance Dola external task log", error); }
}
