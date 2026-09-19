import { randomUUID } from "node:crypto";

import { getAuthSettings, setAuthSettings, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, channelProtocolDefinition, emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { getDolaGatewaySettings, listDolaApiKeys } from "./gateway-store";
import { getDolaAccount, getDolaAccountCookie, listDolaAccounts, markDolaAccountUsed, releaseDolaAccountAttempt, reserveDolaAccount, setDolaAccountStatus, updateDolaAccountQuota } from "./account-service";
import { advanceDolaTaskLog, appendDolaRequestLog, dolaTaskLogPhase, findDolaTaskLogIdByTaskId, markDolaRequestLogRunning, openDolaRequestLog, settleDolaRequestLog, type DolaRequestLifecycleEntry, type DolaRequestLogPhase } from "./log-store";
import { dolaProviderProxyMode, getDolaProxyBinding, resolveDolaProxyEgress, type DolaProxyEgress } from "./proxy";
import { dolaHealth, dolaProviderConfigured, dolaRuntimeRequest, validateDolaVideoRequest } from "./provider";
import { dolaPublicModels } from "./types";

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
        activeAccountId: accounts.find((account) => account.enabled && account.status === "ready")?.id || "",
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

export async function testDolaVideo(input: { model: string; prompt: string; duration: number; ratio: string; references?: Array<{ dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }> }) {
    let profile: ReturnType<typeof validateDolaVideoRequest>["profile"];
    try {
        profile = validateDolaVideoRequest(input).profile;
    } catch (error) {
        const statusCode = typeof error === "object" && error && "status" in error && Number.isInteger(Number(error.status)) ? Number(error.status) : 422;
        await safeAppendDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/videos", model: input.model, statusCode, durationMs: 0, phase: "failed", error: error instanceof Error ? error.message : "Dola 视频参数无效", requestPreview: summarizeVideoRequest(input), requestedDuration: Number.isSafeInteger(input.duration) ? input.duration : undefined, ratio: input.ratio || "16:9", proxyEgress: { mode: "direct" } });
        throw error;
    }
    const account = await reserveDolaAccount(input.model);
    if (!account) {
        await safeAppendDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/videos", model: profile.id, statusCode: 503, durationMs: 0, phase: "failed", error: "没有可用的 Dola 账号，请先导入并验证 Cookie", requestPreview: summarizeVideoRequest(input), requestedDuration: input.duration, ratio: input.ratio || "16:9", proxyEgress: { mode: "direct" } });
        throw new Error("没有可用的 Dola 账号，请先导入并验证 Cookie");
    }
    const started = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: "接收到后台 Dola 视频测试请求", durationMs: 0, detail: `模型: ${profile.id}, 时长: ${input.duration}s, 比例: ${input.ratio || "16:9"}` }];
    const logId = await safeOpenDolaRequestLog({ source: "admin-test", capability: profile.capability === "image" ? "image" : "video", method: "POST", path: "/v1/videos", model: profile.id, accountId: account.id, accountName: account.name, requestedDuration: input.duration, ratio: input.ratio || "16:9", requestPreview: summarizeVideoRequest(input), headers: { "content-type": "application/json" } }, lifecycle);
    const cookie = await getDolaAccountCookie(account.id);
    if (!cookie) {
        await releaseDolaAccountAttempt(account.id);
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error: "Dola 账号 Cookie 无法解密", accountId: account.id, accountName: account.name, lifecycle: [...lifecycle, lifecycleEntry("failed", "账号 Cookie 无法解密", started)] });
        throw new Error("Dola 账号 Cookie 无法解密");
    }
    let proxy: Awaited<ReturnType<typeof resolveDolaProxyEgress>>;
    try {
        proxy = await resolveDolaProxyEgress();
    } catch (error) {
        await releaseDolaAccountAttempt(account.id);
        const message = error instanceof Error ? error.message : "Dola 代理出口不可用";
        await safeSettleDolaRequestLog(logId, { statusCode: 503, durationMs: Date.now() - started, phase: "failed", error: message, accountId: account.id, accountName: account.name, proxyEgress: { mode: "direct" }, lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    lifecycle.push({ time: new Date().toISOString(), phase: "routing", message: "代理出口路由绑定完成", durationMs: Date.now() - started, detail: proxy.egress.mode === "direct" ? "直连" : `模式: ${proxy.egress.mode}, 节点: ${proxy.egress.nodeName || proxy.egress.target || "已配置"}` });
    const payload = { model: profile.id, prompt: input.prompt.trim(), duration: profile.capability === "image" ? 0 : input.duration, ratio: input.ratio || (profile.capability === "image" ? "1:1" : "16:9"), references: input.references || [], transport: "camoufox-page", accountId: account.id, credentialVersion: account.credentialVersion, proxyMode: dolaProviderProxyMode(proxy.egress), proxySource: proxy.egress.mode, proxyTarget: proxy.egress.target, ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}), cookie, requestId: randomUUID() };
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Camoufox Provider 提交视频请求", durationMs: Date.now() - started, detail: "Cookie、参考图和代理凭据仅在 Provider 请求体内传输，不写入日志" });
    await safeMarkDolaRequestLogRunning(logId, { phase: "upstream", message: "向 Camoufox Provider 提交视频请求", detail: "请求体已脱敏" });
    let response: Response;
    try {
        response = await dolaRuntimeRequest("/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch (error) {
        await markDolaAccountUsed(account.id, false);
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
    await markDolaAccountUsed(account.id, response.ok);
    const error = response.ok ? undefined : stringValue(result?.error) || "Provider 请求失败";
    await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase: responsePhase, ...(error ? { error } : {}), responsePreview, responseBytes: responseBytes.byteLength, contentType: response.headers.get("content-type") || undefined, accountId: account.id, accountName: account.name, ...(taskId ? { taskId } : {}), ...(verificationId ? { verificationId } : {}), ...observedQuota, proxyEgress: proxyEgress(proxy.egress), lifecycle });
    return { status: responsePhase, model: profile.id, ...(taskId ? { taskId } : {}), channelId: "dola", statusUrl: stringValue(result?.statusUrl), elapsedMs: Date.now() - started, ...(verificationId ? { verificationId } : {}), ...(conversationId ? { conversationId } : {}), ...(videoUrl ? { videoUrl } : {}), ...(error ? { error } : {}) };
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
        if (attachedLogId) {
            if (response.ok) {
                const phase = dolaTaskLogPhase(stringValue(value.status), Boolean(verificationId));
                const errorText = stringValue(value.error);
                await safeAdvanceDolaTaskLog(attachedLogId, {
                    phase,
                    message: phase === "success" ? "生成完成，最终结果已返回" : phase === "failed" ? `生成失败${errorText ? `：${errorText}` : ""}` : phase === "needs_review" ? "任务等待人工确认（滑块验证）" : phase === "generating" ? "Dola 上游已受理，生成中" : "Dola 上游排队中，等待生成",
                    detail: dolaResultMediaDetail(value) || `上游任务状态: ${stringValue(value.status) || "unknown"}`,
                    statusCode: response.status,
                    responsePreview: summarizeResponse(value, bytes),
                    responseBytes: bytes.byteLength,
                    ...(phase === "failed" && errorText ? { error: errorText } : {}),
                    ...(verificationId ? { verificationId } : {}),
                });
            } else if (response.status === 404) {
                await safeAdvanceDolaTaskLog(attachedLogId, { phase: "failed", message: "生成失败：任务在 Provider 中不存在（可能已被重启清理）", statusCode: response.status, error: "task_not_found" });
            }
        } else {
            const phase = classifyResponsePhase(response, value, verificationId);
            const observedQuota = quotaObservation(value);
            lifecycle.push({ time: new Date().toISOString(), phase, message: phase === "needs_review" ? "任务仍待人工确认" : response.ok ? "任务状态已返回" : "任务查询失败", durationMs: Date.now() - started, detail: `HTTP ${response.status}` });
            await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase, responsePreview: summarizeResponse(value, bytes), responseBytes: bytes.byteLength, contentType: response.headers.get("content-type") || undefined, ...(verificationId ? { verificationId } : {}), ...observedQuota, lifecycle });
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

export async function refreshDolaAccount(id: string) {
    const account = await getDolaAccount(id);
    if (!account) throw new Error("Dola 账号不存在");
    const started = Date.now();
    const lifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(started).toISOString(), phase: "queued", message: "后台刷新 Dola 账号额度", durationMs: 0, detail: `账号: ${account.name}` }];
    const logId = await safeOpenDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/accounts/inspect", model: "", accountId: id, accountName: account.name, requestPreview: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, proxyMode: "按代理管理解析" }), headers: { "content-type": "application/json" } }, lifecycle);
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
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Provider 读取账号额度", durationMs: Date.now() - started });
    await safeMarkDolaRequestLogRunning(logId, { phase: "upstream", message: "向 Provider 读取账号额度" });
    let response: Response;
    try {
        response = await dolaRuntimeRequest("/v1/accounts/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, proxyMode: dolaProviderProxyMode(proxy.egress), proxySource: proxy.egress.mode, proxyTarget: proxy.egress.target, ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}), cookie }) });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Dola 账号额度查询失败";
        await safeSettleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: message, accountId: id, accountName: account.name, proxyEgress: proxyEgress(proxy.egress), lifecycle: [...lifecycle, lifecycleEntry("failed", message, started)] });
        throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = parseRecord(bytes);
    const status = stringValue(payload?.status);
    const inspectPhase = classifyResponsePhase(response, payload, stringValue(payload?.verificationId ?? payload?.verification_id));
    const observedQuota = quotaObservation(payload);
    lifecycle.push({ time: new Date().toISOString(), phase: inspectPhase, message: response.ok ? "Provider 已返回账号额度" : "Provider 账号额度查询失败", durationMs: Date.now() - started, detail: `HTTP ${response.status}` });
    await safeSettleDolaRequestLog(logId, { statusCode: response.status, durationMs: Date.now() - started, phase: inspectPhase, ...(response.ok ? {} : { error: stringValue(payload?.error) || "Dola 账号额度查询失败" }), responsePreview: summarizeResponse(payload, bytes), responseBytes: bytes.byteLength, contentType: response.headers.get("content-type") || undefined, accountId: id, accountName: account.name, ...observedQuota, proxyEgress: proxyEgress(proxy.egress), lifecycle });
    if (!response.ok || status === "verification_required") {
        await setDolaAccountStatus(id, status === "verification_required" ? "verification_required" : "needs_login");
        return { account: await getDolaAccount(id), status: status || "needs_login", quota: [] };
    }
    const quota = Array.isArray(payload?.quota)
        ? payload.quota
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
              .map((item) => ({ bucket: stringValue(item.bucket) || "video", model: stringValue(item.model) || undefined, unit: (item.unit === "count" || item.unit === "credit" ? item.unit : "unknown") as "count" | "credit" | "unknown", remaining: numberOrNull(item.remaining), limit: numberOrNull(item.limit), observedAt: new Date().toISOString(), source: "upstream" as const, version: 1 }))
        : [];
    if (quota.length) await updateDolaAccountQuota(id, quota);
    else await setDolaAccountStatus(id, status === "ready" ? "ready" : "unverified");
    return { account: await getDolaAccount(id), status: status || "ready", quota };
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
    if (verificationId || ["needs_review", "verification_required", "submission_unknown", "pending_verification"].some((marker) => status.includes(marker) || error.includes(marker))) return "needs_review" as const;
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
function proxyEgress(value: DolaProxyEgress) { return value.mode === "direct" ? { mode: "direct" as const } : { mode: value.mode, nodeName: value.nodeName || value.target }; }
