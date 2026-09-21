import { randomUUID } from "node:crypto";

import { getAuthSettings, setAuthSettings, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, channelProtocolDefinition, emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { getDolaGatewaySettings, listDolaApiKeys } from "./gateway-store";
import { addOrUpdateGoogleDolaAccount, getDolaAccount, getDolaAccountCookie, listDolaAccounts, markDolaAccountRateLimited, markDolaAccountReady, markDolaAccountUnusable, markDolaAccountUsed, releaseDolaAccountAttempt, reserveDolaAccount, setDolaAccountStatus, updateDolaAccountGenerationValidation, updateDolaAccountLoginState, updateDolaAccountQuota, updateDolaAccountValidation } from "./account-service";
import { advanceDolaTaskLog, appendDolaRequestLog, dolaTaskLogPhase, findDolaTaskLogIdByTaskId, listDolaRequestLogs, markDolaRequestLogRunning, openDolaRequestLog, settleDolaRequestLog, type DolaRequestLifecycleEntry, type DolaRequestLogPhase } from "./log-store";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import type { VideoTask } from "@/lib/server/video-task-store";
import { dolaProviderProxyMode, getDolaProxyBinding, resolveDolaProxyEgress, type DolaProxyEgress } from "./proxy";
import { dolaHealth, dolaProviderConfigured, dolaRuntimeRequest, validateDolaVideoRequest } from "./provider";
import { dolaPublicModels, type DolaAccountValidation, type DolaQuotaSnapshot } from "./types";

export async function getDolaOverview() {
    const settings = await getAuthSettings();
    const channel = await ensureDolaChannel(settings.systemChannels);
    const [accounts, gateway, apiKeys, proxy] = await Promise.all([listDolaAccounts(), getDolaGatewaySettings(), listDolaApiKeys(), getDolaProxyBinding()]);
    return {
        configured: dolaProviderConfigured(),
        healthy: dolaProviderConfigured() ? await dolaHealth() : false,
        transport: "camoufox-page" as const,
        defaultProxyMode: proxy.mode,
        proxy,
        accounts,
        accountsAvailable: accounts.length > 0,
        activeAccountId: accounts.find((account) => account.enabled && account.status === "ready" && account.validation?.ready)?.id || "",
        models: dolaPublicModels(),
        channel: publicChannel(channel),
        channels: [publicChannel(channel)],
        gateway,
        apiKeys,
        stats: {
            totalAccounts: accounts.length,
            readyAccounts: accounts.filter((account) => account.status === "ready").length,
            requestCount: accounts.reduce((sum, account) => sum + account.requestCount, 0),
            successCount: accounts.reduce((sum, account) => sum + account.successCount, 0),
            errorCount: accounts.reduce((sum, account) => sum + account.errorCount, 0),
        },
    };
}

async function ensureDolaChannel(channels: SystemModelChannel[]) {
    const existing = channels.find((item) => item.id === "dola" || item.advancedConfig?.protocol === "dola");
    if (existing) return applyChannelProtocol(existing, "dola");
    const channel = applyChannelProtocol({ id: "dola", name: "Dola API", baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: true, advancedConfig: emptyAdvancedConfig() }, "dola");
    const nextChannels = [...channels, channel];
    const logicalModels = synchronizeLogicalModelsWithChannels([], nextChannels);
    const defaultModels = normalizeDefaultModelsConfig(undefined, logicalModels, nextChannels);
    await setAuthSettings({ systemChannels: nextChannels, logicalModels, defaultModels });
    return channel;
}

export async function saveDolaModels(models: string[]) {
    const settings = await getAuthSettings();
    const existing = settings.systemChannels.find((item) => item.id === "dola");
    const base: SystemModelChannel = existing || { id: "dola", name: "Dola API", baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: true, advancedConfig: emptyAdvancedConfig() };
    const channel = applyChannelProtocol({ ...base, name: "Dola API", enabled: true, models: models.length ? models : dolaPublicModels().map((item) => item.id) }, "dola");
    const channels = [...settings.systemChannels.filter((item) => item.id !== "dola"), channel];
    const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels || [], channels);
    const defaultModels = normalizeDefaultModelsConfig(settings.defaultModels, logicalModels, channels);
    await setAuthSettings({ systemChannels: channels, logicalModels, defaultModels });
    return { models: channel.models, channel: publicChannel(channel) };
}

export async function testDolaVideo(input: {
    model: string;
    prompt: string;
    duration: number;
    ratio: string;
    references?: Array<{ dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }>;
    headless?: boolean;
    customCookie?: string;
    accountId?: string;
}) {
    let profile: ReturnType<typeof validateDolaVideoRequest>["profile"];
    try {
        profile = validateDolaVideoRequest(input).profile;
    } catch (error) {
        const statusCode = typeof error === "object" && error && "status" in error && Number.isInteger(Number(error.status)) ? Number(error.status) : 422;
        await safeAppendDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/videos", model: input.model, statusCode, durationMs: 0, phase: "failed", error: error instanceof Error ? error.message : "Dola 视频参数无效", requestPreview: summarizeVideoRequest(input), requestedDuration: Number.isSafeInteger(input.duration) ? input.duration : undefined, ratio: input.ratio || "16:9", proxyEgress: { mode: "direct" } });
        throw error;
    }
    const started = Date.now();
    let account: Awaited<ReturnType<typeof getDolaAccount>> | null = null;
    let cookie = "";
    let isTemporaryAccount = false;

    if (input.customCookie?.trim()) {
        cookie = input.customCookie.trim();
        account = {
            id: input.accountId || `dola-custom-${randomUUID()}`,
            name: "临时自定义 Cookie",
            status: "ready",
            enabled: true,
            credentialVersion: 1,
            requestCount: 0,
            successCount: 0,
            errorCount: 0,
            activeAttempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        isTemporaryAccount = true;
    } else if (input.accountId?.trim()) {
        const found = await getDolaAccount(input.accountId.trim());
        if (!found) throw new Error("指定的 Dola 账号不存在");
        account = found;
        cookie = (await getDolaAccountCookie(found.id)) || "";
    } else {
        const reserved = await reserveDolaAccount(input.model);
        if (!reserved) {
            await safeAppendDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/videos", model: profile.id, statusCode: 503, durationMs: 0, phase: "failed", error: "没有可用的 Dola 账号，请先导入并验证 Cookie", requestPreview: summarizeVideoRequest(input), requestedDuration: input.duration, ratio: input.ratio || "16:9", proxyEgress: { mode: "direct" } });
            throw new Error("没有可用的 Dola 账号，请先导入并验证 Cookie");
        }
        account = reserved;
        cookie = (await getDolaAccountCookie(reserved.id)) || "";
    }

    if (!account) {
        throw new Error("无法获取 Dola 账号");
    }
    if (!cookie) {
        if (!isTemporaryAccount) await releaseDolaAccountAttempt(account.id);
        const error = "Dola 账号 Cookie 无法解密";
        throw new Error(error);
    }

    const isHeadless = input.headless !== false;
    const lifecycle: DolaRequestLifecycleEntry[] = [{
        time: new Date(started).toISOString(),
        phase: "queued",
        message: isHeadless ? "接收到后台 Dola 视频测试请求" : "接收到后台 Dola 有头浏览器测试请求（本地桌面窗口）",
        durationMs: 0,
        detail: `模型: ${profile.id}, 账号: ${account.name}${!isHeadless ? " (已启用有头桌面调试)" : ""}`,
    }];
    const logId = await safeOpenDolaRequestLog({ source: "admin-test", capability: profile.capability === "image" ? "image" : "video", method: "POST", path: "/v1/videos", model: profile.id, accountId: account.id, accountName: account.name, requestedDuration: input.duration, ratio: input.ratio || "16:9", requestPreview: summarizeVideoRequest(input), headers: { "content-type": "application/json" } }, lifecycle);

    let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
    try {
        proxy = await resolveDolaProxyEgress();
    } catch (error) {
        if (!isTemporaryAccount) await releaseDolaAccountAttempt(account.id);
        const message = error instanceof Error ? error.message : "Dola 代理出口不可用";
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error: message, accountId: account.id, accountName: account.name, proxyEgress: { mode: "direct" }, lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    lifecycle.push({ time: new Date().toISOString(), phase: "routing", message: "代理出口路由绑定完成", durationMs: Date.now() - started, detail: proxy.egress.mode === "direct" ? "直连" : `模式: ${proxy.egress.mode}, 节点: ${proxy.egress.nodeName || proxy.egress.target || "已配置"}` });
    const payload = {
        model: profile.id,
        prompt: input.prompt.trim(),
        duration: profile.capability === "image" ? 0 : input.duration,
        ratio: input.ratio || (profile.capability === "image" ? "1:1" : "16:9"),
        references: input.references || [],
        transport: "camoufox-page",
        accountId: account.id,
        credentialVersion: account.credentialVersion,
        proxyMode: dolaProviderProxyMode(proxy.egress),
        proxySource: proxy.egress.mode,
        proxyTarget: proxy.egress.target,
        ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}),
        cookie,
        requestId: randomUUID(),
        headless: isHeadless,
    };
    lifecycle.push({
        time: new Date().toISOString(),
        phase: "upstream",
        message: isHeadless ? "向 Camoufox Provider 提交视频请求" : "向 Camoufox Provider 提交请求（有头浏览器桌面窗口）",
        durationMs: Date.now() - started,
        detail: isHeadless ? "Cookie、参考图和代理凭据仅在 Provider 请求体内传输，不写入日志" : "已启动本地有头窗口，环境完全隔离，直接在页面内完成签名与协议提交",
    });
    await safeMarkDolaRequestLogRunning(logId, { phase: "upstream", message: isHeadless ? "向 Camoufox Provider 提交视频请求" : "向 Camoufox Provider 提交视频请求（有头模式）", detail: "请求体已脱敏" });
    let response: Response;
    try {
        response = await dolaRuntimeRequest("/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch (error) {
        if (!isTemporaryAccount) await markDolaAccountUsed(account.id, false);
        const message = error instanceof Error ? error.message : "Provider 请求失败";
        await safeSettleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: message, accountId: account.id, accountName: account.name, proxyEgress: proxyEgress(proxy.egress), lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    const result = parseRecord(responseBytes);
    const taskId = stringValue(result?.taskId ?? result?.id);
    const verificationId = stringValue(result?.verificationId ?? result?.verification_id);
    const conversationId = stringValue(result?.conversationId ?? result?.conversation_id);
    const videoUrl = stringValue(result?.videoUrl ?? result?.video_url);
    const responsePreview = summarizeResponse(result, responseBytes);
    const responsePhase = classifyResponsePhase(response, result, verificationId);
    const observedQuota = quotaObservation(result);
    lifecycle.push({ time: new Date().toISOString(), phase: responsePhase, message: responsePhase === "needs_review" ? "Provider 返回待人工确认状态" : responsePhase === "submitted" ? "已提交到 Dola 上游，任务排队中" : responsePhase === "generating" ? "Dola 上游已受理，生成中" : response.ok ? "Provider 已受理请求" : "Provider 返回失败", durationMs: Date.now() - started, detail: `HTTP ${response.status}${taskId ? `, 任务: ${taskId}` : ""}${verificationId ? ", 已提供验证会话" : ""}` });
    if (!isTemporaryAccount) await markDolaAccountUsed(account.id, response.ok);
    const error = response.ok ? undefined : stringValue(result?.error) || "Provider 请求失败";
    await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase: responsePhase, ...(error ? { error } : {}), responsePreview, responseBytes: responseBytes.byteLength, contentType: response.headers.get("content-type") || undefined, accountId: account.id, accountName: account.name, ...(taskId ? { taskId } : {}), ...(verificationId ? { verificationId } : {}), ...observedQuota, proxyEgress: proxyEgress(proxy.egress), lifecycle });
    return { status: responsePhase, model: profile.id, ...(taskId ? { taskId } : {}), channelId: "dola", statusUrl: stringValue(result?.statusUrl), elapsedMs: Date.now() - started, ...(verificationId ? { verificationId } : {}), ...(conversationId ? { conversationId } : {}), ...(videoUrl ? { videoUrl } : {}), ...(error ? { error } : {}) };
}

export async function startDolaGoogleLogin(input?: { manualCookie?: string; email?: string; name?: string; timeoutSeconds?: number }) {
    if (input?.manualCookie?.trim()) {
        const account = await addOrUpdateGoogleDolaAccount({
            cookie: input.manualCookie.trim(),
            email: input.email?.trim() || undefined,
            name: input.name?.trim() || undefined,
        });
        await refreshDolaAccount(account.id).catch(() => undefined);
        return { account: await getDolaAccount(account.id), status: "success" };
    }

    let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
    try {
        proxy = await resolveDolaProxyEgress();
    } catch {
        proxy = { egress: { mode: "direct" } };
    }
    const timeoutSeconds = input?.timeoutSeconds || 180;
    const response = await dolaRuntimeRequest("/v1/accounts/google-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            proxyMode: dolaProviderProxyMode(proxy.egress),
            proxySource: proxy.egress.mode,
            proxyTarget: proxy.egress.target,
            ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}),
            timeoutSeconds,
        }),
    });

    const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = parseRecord(bytes);
    if (!response.ok || !payload || payload.status !== "success" || !payload.cookie) {
        throw new Error(stringValue(payload?.error ?? payload?.detail) || "Google 授权登录未完成或已超时");
    }

    const cookie = stringValue(payload.cookie);
    const email = stringValue(payload.email) || input?.email?.trim() || undefined;
    const name = stringValue(payload.name) || input?.name?.trim() || undefined;

    const account = await addOrUpdateGoogleDolaAccount({ cookie, email, name });
    await refreshDolaAccount(account.id).catch(() => undefined);
    return { account: await getDolaAccount(account.id), status: "success" };
}

export async function queryDolaTask(taskId: string) {
    const started = Date.now();
    // 后台轮询复用原测试日志，按 排队中 → 生成中 → 生成完成/失败 推进同一条记录。
    const attachedLogId = await safeFindAdminTaskLog(taskId);
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: "查询 Dola 视频任务", durationMs: 0, detail: `任务: ${taskId}` }];
    const logId = attachedLogId || (await safeOpenDolaRequestLog({ source: "admin-test", capability: "video", method: "GET", path: `/v1/videos/${encodeURIComponent(taskId)}`, model: "", taskId: taskId.slice(0, 300), requestPreview: JSON.stringify({ taskId }) }));
    if (!attachedLogId) {
        lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Provider 查询视频任务", durationMs: Date.now() - started });
        await safeMarkDolaRequestLogRunning(logId, { phase: "upstream", message: "向 Provider 查询视频任务" });
    }
    try {
        const response = await dolaRuntimeRequest(`/v1/videos/${encodeURIComponent(taskId)}`, { method: "GET" });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const value = parseRecord(bytes) || {};
        const verificationId = stringValue(value.verificationId ?? value.verification_id);
        const taskPhase = response.ok ? dolaTaskLogPhase(stringValue(value.status), Boolean(verificationId)) : "failed";
        const taskAccountId = stringValue(value.accountId);
        const taskError = stringValue(value.error);
        const screenshotBase64 = stringValue(value.screenshotBase64);
        if (taskAccountId && (taskPhase === "success" || taskPhase === "failed")) {
            await updateDolaAccountGenerationValidation(taskAccountId, {
                status: taskPhase === "success" ? "success" : taskError === "submission_unknown" ? "unknown" : "failed",
                checkedAt: new Date().toISOString(),
                taskId,
                model: stringValue(value.model) || undefined,
                error: taskError || undefined,
            }).catch(() => undefined);
            if (taskError === "rate_limited") {
                await markDolaAccountRateLimited(taskAccountId, "Dola 返回限流错误，但提交后登录态仍有效").catch(() => undefined);
            } else if (taskError === "needs_login") {
                await markDolaAccountUnusable(taskAccountId, "needs_login").catch(() => undefined);
            }
        }
        if (attachedLogId) {
            if (response.ok) {
                const phase = taskPhase;
                const errorText = taskError;
                await safeAdvanceDolaTaskLog(attachedLogId, {
                    phase,
                    message: phase === "success" ? "生成完成，最终结果已返回" : phase === "failed" ? `生成失败${errorText ? `：${errorText}` : ""}` : phase === "needs_review" ? "任务等待人工确认（页面验证）" : phase === "generating" ? "Dola 上游已受理，生成中" : "Dola 上游排队中，等待生成",
                    detail: dolaResultMediaDetail(value) || `上游任务状态: ${stringValue(value.status) || "unknown"}`,
                    statusCode: response.status,
                    responsePreview: summarizeResponse(value, bytes),
                    responseBytes: bytes.byteLength,
                    ...(phase === "failed" && errorText ? { error: errorText } : {}),
                    ...(verificationId ? { verificationId } : {}),
                    ...(screenshotBase64 ? { screenshotBase64 } : {}),
                });
            } else if (response.status === 404) {
                await safeAdvanceDolaTaskLog(attachedLogId, { phase: "failed", message: "生成失败：任务在 Provider 中不存在（可能已被重启清理）", statusCode: response.status, error: "task_not_found" });
            }
        } else {
            const phase = classifyResponsePhase(response, value, verificationId);
            const observedQuota = quotaObservation(value);
            lifecycle.push({ time: new Date().toISOString(), phase, message: phase === "needs_review" ? "任务仍待人工确认" : response.ok ? "任务状态已返回" : "任务查询失败", durationMs: Date.now() - started, detail: `HTTP ${response.status}` });
            await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase, responsePreview: summarizeResponse(value, bytes), responseBytes: bytes.byteLength, contentType: response.headers.get("content-type") || undefined, ...(verificationId ? { verificationId } : {}), ...(screenshotBase64 ? { screenshotBase64 } : {}), ...observedQuota, lifecycle });
        }
        return { status: response.ok ? stringValue(value.status) || "running" : "failed", taskId, ...value, ...(typeof value.taskId === "string" || typeof value.id !== "string" ? {} : { taskId: value.id }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : "Dola 任务查询失败";
        if (!attachedLogId) {
            lifecycle.push(lifecycleEntry("failed", message, started));
            await safeSettleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: message, lifecycle });
        }
        throw error;
    }
}

export async function refreshDolaAccount(id: string, options: { loginOnly?: boolean } = {}) {
    const account = await getDolaAccount(id);
    if (!account) throw new Error("Dola 账号不存在");
    const loginOnly = options.loginOnly === true;
    const started = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: loginOnly ? "检测 Dola Cookie 登录态" : "后台验证 Dola 账号协议与额度", durationMs: 0, detail: `账号: ${account.name}` }];
    const logId = await safeOpenDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/accounts/inspect", model: "", accountId: id, accountName: account.name, requestPreview: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, loginOnly, proxyMode: "按代理管理解析" }), headers: { "content-type": "application/json" } }, lifecycle);
    const cookie = await getDolaAccountCookie(id);
    if (!cookie) {
        const error = "Dola 账号 Cookie 无法解密";
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error, accountId: id, accountName: account.name, lifecycle: [...lifecycle, lifecycleEntry("failed", error, started)] });
        throw new Error(error);
    }
    let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
    try {
        proxy = await resolveDolaProxyEgress();
    } catch (error) {
        const message = error instanceof Error ? error.message : "Dola 代理出口不可用";
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error: message, accountId: id, accountName: account.name, lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    const upstreamMessage = loginOnly ? "通过启动协议检测 Cookie 登录态" : "向 Provider 验证登录、签名协议与额度";
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: upstreamMessage, durationMs: Date.now() - started });
    await safeMarkDolaRequestLogRunning(logId, { phase: "upstream", message: upstreamMessage });
    let response: Response;
    try {
        response = await dolaRuntimeRequest("/v1/accounts/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, authOnly: loginOnly, proxyMode: dolaProviderProxyMode(proxy.egress), proxySource: proxy.egress.mode, proxyTarget: proxy.egress.target, ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}), cookie }) });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Dola 账号额度查询失败";
        await safeSettleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: message, accountId: id, accountName: account.name, proxyEgress: proxyEgress(proxy.egress), lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = parseRecord(bytes);
    const status = stringValue(payload?.status);
    const loginProbe = payload?.loginProbe && typeof payload.loginProbe === "object" ? payload.loginProbe as Record<string, unknown> : null;
    const loginState = stringValue(loginProbe?.state);
    if (loginState === "ready" || loginState === "needs_login" || loginState === "unknown") {
        await updateDolaAccountLoginState(id, loginState, typeof loginProbe?.code === "number" ? loginProbe.code : undefined);
    }
    const inspectPhase = classifyResponsePhase(response, payload, stringValue(payload?.verificationId ?? payload?.verification_id));
    const observedQuota = quotaObservation(payload);
    const validation = protocolValidation(payload, proxy.egress);
    lifecycle.push({ time: new Date().toISOString(), phase: inspectPhase, message: loginOnly ? (loginState === "ready" ? "启动协议确认 Cookie 登录有效" : loginState === "needs_login" ? "启动协议确认 Cookie 登录失效" : "启动协议未能确认登录态") : validation.ready ? "账号登录、页面签名和只读协议验证均已通过" : response.ok ? "账号页面已打开，但协议可用性未通过" : "Provider 账号检测失败", durationMs: Date.now() - started, detail: loginOnly ? `HTTP ${response.status} · 业务码: ${typeof loginProbe?.code === "number" ? loginProbe.code : "未知"}` : `HTTP ${response.status} · 签名请求: ${validation.signed ? "已确认" : "未确认"}` });
    await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase: inspectPhase, ...(response.ok ? {} : { error: stringValue(payload?.error) || "Dola 账号额度查询失败" }), responsePreview: summarizeResponse(payload, bytes), responseBytes: bytes.byteLength, contentType: response.headers.get("content-type") || undefined, accountId: id, accountName: account.name, ...observedQuota, proxyEgress: proxyEgress(proxy.egress), lifecycle });
    if (loginOnly) {
        if (!response.ok) return { account: await getDolaAccount(id), status: "provider_error", quota: [], loginProbe };
        if (loginState === "needs_login") await markDolaAccountUnusable(id, "needs_login");
        return { account: await getDolaAccount(id), status: loginState === "ready" ? "login_ready" : loginState === "needs_login" ? "needs_login" : "login_unknown", quota: [], loginProbe };
    }
    await updateDolaAccountValidation(id, validation);
    if (!response.ok) {
        return { account: await getDolaAccount(id), status: status || "provider_error", quota: [], protocol: validation, loginProbe };
    }
    if (status === "verification_required" || status === "needs_login") {
        await markDolaAccountUnusable(id, status);
        return { account: await getDolaAccount(id), status, quota: [], protocol: validation, loginProbe };
    }
    const quota: DolaQuotaSnapshot[] = Array.isArray(payload?.quota)
        ? payload.quota
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
              .map((item) => ({ bucket: stringValue(item.bucket) || "video", model: stringValue(item.model) || undefined, unit: (item.unit === "count" || item.unit === "credit" ? item.unit : "unknown") as "count" | "credit" | "unknown", remaining: numberOrNull(item.remaining), limit: numberOrNull(item.limit), observedAt: new Date().toISOString(), source: (item.source === "upstream" || item.source === "local" ? item.source : "unknown") as DolaQuotaSnapshot["source"], version: 1 }))
        : [];
    if (quota.length) await updateDolaAccountQuota(id, quota);
    if (status === "ready" && validation.login) await markDolaAccountReady(id, quota);
    return { account: await getDolaAccount(id), status: status === "ready" && validation.login ? "ready" : "unverified", quota, protocol: validation, loginProbe };
}

export async function startDolaAccountVerification(id: string) {
    const account = await getDolaAccount(id);
    if (!account) throw new Error("Dola 账号不存在");
    const started = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: "启动 Dola 账号页面诊断", durationMs: 0, detail: `账号: ${account.name}` }];
    const logId = await safeOpenDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/accounts/verify", model: "", accountId: id, accountName: account.name, requestPreview: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, proxyMode: "按代理管理解析" }), headers: { "content-type": "application/json" } }, lifecycle);
    const cookie = await getDolaAccountCookie(id);
    if (!cookie) {
        const error = "Dola 账号 Cookie 无法解密";
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error, accountId: id, accountName: account.name, lifecycle: [...lifecycle, lifecycleEntry("failed", error, started)] });
        throw new Error(error);
    }
    let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
    try {
        proxy = await resolveDolaProxyEgress();
    } catch (error) {
        const message = error instanceof Error ? error.message : "Dola 代理出口不可用";
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error: message, accountId: id, accountName: account.name, lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Provider 打开账号验证会话", durationMs: Date.now() - started });
    await safeMarkDolaRequestLogRunning(logId, { phase: "upstream", message: "向 Provider 打开账号验证会话" });
    let response: Response;
    try {
        response = await dolaRuntimeRequest("/v1/accounts/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                accountId: id,
                credentialVersion: account.credentialVersion,
                proxyMode: dolaProviderProxyMode(proxy.egress),
                proxySource: proxy.egress.mode,
                proxyTarget: proxy.egress.target,
                ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}),
                cookie,
            }),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "启动 Dola 账号验证失败";
        await safeSettleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: message, accountId: id, accountName: account.name, proxyEgress: proxyEgress(proxy.egress), lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = parseRecord(bytes);
    const status = stringValue(payload?.status);
    const verificationId = stringValue(payload?.verificationId ?? payload?.verification_id);
    const inspectPhase = classifyResponsePhase(response, payload, verificationId);
    const observedQuota = quotaObservation(payload);
    const validation = protocolValidation(payload, proxy.egress);
    lifecycle.push({ time: new Date().toISOString(), phase: inspectPhase, message: verificationId ? (status === "verification_required" ? "已捕获真实安全验证挑战" : validation.ready ? "已打开账号页面，页面签名协议验证通过" : "已打开账号页面，协议验证未通过") : validation.ready ? "账号协议状态正常" : "Provider 账号页面检测失败", durationMs: Date.now() - started, detail: `HTTP ${response.status} · 签名请求: ${validation.signed ? "已确认" : "未确认"}` });
    await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase: inspectPhase, ...(response.ok ? {} : { error: stringValue(payload?.error) || "Dola 账号验证请求失败" }), responsePreview: summarizeResponse(payload, bytes), responseBytes: bytes.byteLength, contentType: response.headers.get("content-type") || undefined, accountId: id, accountName: account.name, verificationId: verificationId || undefined, ...observedQuota, proxyEgress: proxyEgress(proxy.egress), lifecycle });
    await updateDolaAccountValidation(id, validation);

    if (verificationId) {
        return {
            status: status || "diagnostic_ready",
            verificationId,
            pageState: stringValue(payload?.pageState) || undefined,
            screenshotBase64: stringValue(payload?.screenshotBase64) || undefined,
            protocol: validation,
            account: await getDolaAccount(id),
        };
    }
    if (status === "needs_login") {
        await markDolaAccountUnusable(id, "needs_login");
        return { status: "needs_login", account: await getDolaAccount(id), quota: [], protocol: validation };
    }
    const quota: DolaQuotaSnapshot[] = Array.isArray(payload?.quota)
        ? payload.quota
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
              .map((item) => ({ bucket: stringValue(item.bucket) || "video", model: stringValue(item.model) || undefined, unit: (item.unit === "count" || item.unit === "credit" ? item.unit : "unknown") as "count" | "credit" | "unknown", remaining: numberOrNull(item.remaining), limit: numberOrNull(item.limit), observedAt: new Date().toISOString(), source: (item.source === "upstream" || item.source === "local" ? item.source : "unknown") as DolaQuotaSnapshot["source"], version: 1 }))
        : [];
    if (quota.length) await updateDolaAccountQuota(id, quota);
    if (validation.login) await markDolaAccountReady(id, quota);
    return { status: validation.login ? "ready" : "unverified", account: await getDolaAccount(id), quota, protocol: validation };
}

export async function resolveDolaTaskVerification(task: VideoTask): Promise<string | undefined> {
    const schedule = await getStoredGenerationTaskRecord("video", task.id);
    if (typeof schedule?.resultPayload?.verificationId === "string" && schedule.resultPayload.verificationId.trim()) {
        return schedule.resultPayload.verificationId.trim();
    }
    const upstreamTaskId = task.upstream?.id || task.id;
    if (upstreamTaskId) {
        const logs = await listDolaRequestLogs({ keyword: upstreamTaskId, pageSize: 10 }).catch(() => null);
        const match = logs?.items.find((item) => item.verificationId && (item.taskId === upstreamTaskId || item.phase === "needs_review"));
        if (match?.verificationId) {
            if (schedule) {
                await scheduleGenerationTask("video", task.id, {
                    ...schedule,
                    resultPayload: {
                        ...(schedule.resultPayload || {}),
                        verificationId: match.verificationId,
                    },
                }).catch(() => undefined);
            }
            return match.verificationId;
        }
    }
    const accountId = task.upstream?.accountId;
    if (accountId) {
        const logs = await listDolaRequestLogs({ accountId, pageSize: 10 }).catch(() => null);
        const match = logs?.items.find((item) => item.verificationId && item.phase === "needs_review");
        if (match?.verificationId) {
            if (schedule) {
                await scheduleGenerationTask("video", task.id, {
                    ...schedule,
                    resultPayload: {
                        ...(schedule.resultPayload || {}),
                        verificationId: match.verificationId,
                    },
                }).catch(() => undefined);
            }
            return match.verificationId;
        }
    }
    return undefined;
}

function publicChannel(channel: SystemModelChannel) {
    const { apiKey: _apiKey, ...safe } = channel;
    return { ...safe, hasApiKey: Boolean(channel.apiKey) };
}
async function safeOpenDolaRequestLog(input: Parameters<typeof openDolaRequestLog>[0], lifecycle?: DolaRequestLifecycleEntry[]) {
    try {
        return await openDolaRequestLog({ ...input, ...(lifecycle?.length ? { lifecycle } : {}) });
    } catch (error) {
        console.error("Failed to open Dola request log", error);
        return "";
    }
}
async function safeMarkDolaRequestLogRunning(id: string, entry: Parameters<typeof markDolaRequestLogRunning>[1]) {
    if (!id) return;
    try {
        await markDolaRequestLogRunning(id, entry);
    } catch (error) {
        console.error("Failed to update Dola request log", error);
    }
}
async function safeSettleDolaRequestLog(id: string, settle: Parameters<typeof settleDolaRequestLog>[1]) {
    if (!id) return;
    try {
        await settleDolaRequestLog(id, settle);
    } catch (error) {
        console.error("Failed to settle Dola request log", error);
    }
}
async function safeAppendDolaRequestLog(input: Parameters<typeof appendDolaRequestLog>[0]) {
    try {
        await appendDolaRequestLog(input);
    } catch (error) {
        console.error("Failed to persist Dola request log", error);
    }
}
function lifecycleEntry(phase: DolaRequestLogPhase, message: string, startedAt: number): DolaRequestLifecycleEntry {
    return { time: new Date().toISOString(), phase, message, durationMs: Date.now() - startedAt };
}
function summarizeVideoRequest(input: { model: string; prompt: string; duration: number; ratio: string; references?: Array<unknown> }) {
    return JSON.stringify({ model: input.model, duration: input.duration, ratio: input.ratio || "16:9", referenceCount: input.references?.length || 0, promptLength: input.prompt.trim().length });
}
function parseRecord(bytes: Uint8Array) {
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}
function summarizeResponse(value: Record<string, unknown> | null, bytes: Uint8Array) {
    if (!value) return bytes.byteLength ? "Provider 返回了无法解析的响应" : "";
    // Media result URLs stay visible: they are the deliverable the admin needs to see in the log detail.
    const summary = Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|token|secret|password|base64|dataurl/i.test(key)).map(([key, item]) => [key, typeof item === "string" && item.length > 500 ? `${item.slice(0, 500)}…` : item]));
    const rendered = JSON.stringify(summary, null, 2);
    return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}…` : rendered;
}
function classifyResponsePhase(response: Response, value: Record<string, unknown> | null, verificationId: string) {
    const status = stringValue(value?.status).toLowerCase();
    const error = stringValue(value?.error).toLowerCase();
    if (verificationId || ["needs_review", "verification_required", "pending_verification"].some((marker) => status.includes(marker) || error.includes(marker))) return "needs_review" as const;
    if (status.includes("submission_unknown") || error.includes("submission_unknown")) return "failed" as const;
    if (!response.ok) return "failed" as const;
    const taskId = stringValue(value?.taskId ?? value?.id);
    // Async task creation only means the upstream queued the job, not that generation finished.
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
async function safeFindAdminTaskLog(taskId: string) {
    try {
        return await findDolaTaskLogIdByTaskId(taskId, "admin-test");
    } catch (error) {
        console.error("Failed to locate Dola admin-test task log", error);
        return "";
    }
}
async function safeAdvanceDolaTaskLog(id: string, advance: Parameters<typeof advanceDolaTaskLog>[1]) {
    if (!id) return;
    try {
        await advanceDolaTaskLog(id, advance);
    } catch (error) {
        console.error("Failed to advance Dola admin-test task log", error);
    }
}
function stringValue(value: unknown) { return typeof value === "string" ? value.slice(0, 400) : ""; }
function numberOrNull(value: unknown) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function quotaObservation(value: Record<string, unknown> | null | undefined) {
    const item = Array.isArray(value?.quota) ? value.quota.find((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object")) : value;
    if (!item || typeof item !== "object") return {};
    const hasRemaining = Object.prototype.hasOwnProperty.call(item, "remaining");
    const hasLimit = Object.prototype.hasOwnProperty.call(item, "limit");
    return { ...(hasRemaining ? { quotaRemaining: numberOrNull(item.remaining) } : {}), ...(hasLimit ? { quotaLimit: numberOrNull(item.limit) } : {}) };
}
function protocolValidation(value: Record<string, unknown> | null | undefined, egress: DolaProxyEgress): DolaAccountValidation {
    const protocol = value?.protocol && typeof value.protocol === "object" && !Array.isArray(value.protocol) ? value.protocol as Record<string, unknown> : {};
    const login = protocol.login === true || stringValue(value?.status) === "ready" || stringValue(value?.pageState) === "ready";
    const signed = protocol.signed === true;
    const requestObserved = protocol.requestObserved === true;
    const httpStatus = Number.isInteger(Number(protocol.httpStatus)) ? Number(protocol.httpStatus) : 0;
    const ready = protocol.ready === true && login && signed && requestObserved && httpStatus >= 200 && httpStatus < 300;
    return {
        checkedAt: new Date().toISOString(),
        ready,
        login,
        signerReady: protocol.signerReady === true,
        requestObserved,
        signed,
        httpStatus,
        identitySource: stringValue(protocol.identitySource) || undefined,
        proxyMode: egress.mode,
        proxyTarget: egress.mode === "direct" ? undefined : egress.nodeName || egress.target,
        error: stringValue(protocol.error) || (ready ? undefined : "signed_protocol_probe_failed"),
    };
}
function proxyEgress(value: DolaProxyEgress) { return value.mode === "direct" ? { mode: "direct" as const } : { mode: value.mode, nodeName: value.nodeName || value.target }; }
