import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";

import { getAuthSettings, setAuthSettings, type AuthSettings, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { GENERATION_TRANSPORT_TIMEOUT_MS } from "@/lib/server/generation-http-lifecycle";
import { normalizeModelId } from "@/lib/model-capability";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { ensureMagicProxyProvider, type MagicProxyEgressInfo } from "@/lib/server/magic-proxy-service";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { withTrafficContext, currentTrafficContext, updateTrafficContext, trafficBodyModel } from "@/lib/server/traffic-context";
import {
    appendGeminiToolsRequestLog,
    appendGeminiToolsRequestLifecycle,
    markGeminiToolsRequestLogRunning,
    openGeminiToolsRequestLog,
    settleGeminiToolsRequestLog,
    consumeGeminiToolsOAuthSession,
    createGeminiToolsOAuthSession,
    getGeminiToolsGatewaySettings,
    getGeminiToolsPrivateAccount,
    listGeminiToolsAccounts,
    listGeminiToolsApiKeys,
    listGeminiToolsCandidateAccounts,
    listGeminiToolsRequestLogs,
    recordGeminiToolsAccountUsage,
    recordGeminiToolsApiKeyTokens,
    type GeminiToolsPrivateAccount,
    type GeminiToolsQuota,
    type GeminiToolsLifecycleEntry,
    updateGeminiToolsAccount,
    updateGeminiToolsAccountCredentials,
    upsertGeminiToolsAccount,
} from "@/lib/server/gemini-tools-store";

export const GEMINI_TOOLS_PROTOCOL = "gemini-tools" as const;
export const GEMINI_TOOLS_CHANNEL_ID = "gemini-antigravity-tools";
export const GEMINI_TOOLS_CHANNEL_NAME = "Gemini Antigravity Tools";

// Antigravity Enterprise 桌面 OAuth 客户端凭据只从服务端环境变量读取，不写入仓库；
// 未显式配置回调地址时按内置客户端解析本机回环回调，配置了回调地址则按自定义客户端。
function oauthConfig() {
    const clientId = process.env.GEMINI_TOOLS_OAUTH_CLIENT_ID?.trim() || "";
    const clientSecret = process.env.GEMINI_TOOLS_OAUTH_CLIENT_SECRET?.trim() || "";
    if (!clientId || !clientSecret) return null;
    const redirectUri = process.env.GEMINI_TOOLS_OAUTH_REDIRECT_URI?.trim();
    return { clientId, clientSecret, builtIn: !redirectUri };
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const OAUTH_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];
const CLOUD_CODE_ENDPOINTS = ["https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal", "https://daily-cloudcode-pa.googleapis.com/v1internal", "https://cloudcode-pa.googleapis.com/v1internal"];
const MACHINE_ID = createHash("sha256").update(`${hostname()}|${platform()}|dreamyo`).digest("hex");
const SESSION_ID = randomUUID();
const magicProxyRequestContext = new AsyncLocalStorage<{ binding?: Promise<{ enabled: boolean; proxyUrl?: string; egress?: MagicProxyEgressInfo } | undefined> }>();

export class GeminiToolsError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "GeminiToolsError";
    }
}

export function geminiToolsOAuthConfigured() {
    return Boolean(oauthConfig());
}

export async function getGeminiToolsOverview() {
    const [accounts, apiKeys, gateway, logs, settings] = await Promise.all([listGeminiToolsAccounts(), listGeminiToolsApiKeys(), getGeminiToolsGatewaySettings(), listGeminiToolsRequestLogs({ page: 1, pageSize: 8 }), getAuthSettings()]);
    const models = catalogFromAccounts(accounts);
    const channel = settings.systemChannels.find((item) => item.advancedConfig?.protocol === GEMINI_TOOLS_PROTOCOL);
    return {
        configured: geminiToolsOAuthConfigured(),
        healthy: geminiToolsOAuthConfigured() && accounts.some((account) => account.status === "active" && account.proxyEnabled),
        accounts,
        apiKeys,
        gateway,
        logs,
        models: overviewModels(models, channel),
        channel: channel ? publicChannel(channel) : undefined,
        oauthRedirectUri: process.env.GEMINI_TOOLS_OAUTH_REDIRECT_URI?.trim() || undefined,
    };
}

export async function startGeminiToolsOAuth(request: Request) {
    const config = oauthConfig();
    if (!config) throw new GeminiToolsError("GeminiTools OAuth 未配置：请在服务端环境变量设置 GEMINI_TOOLS_OAUTH_CLIENT_ID 与 GEMINI_TOOLS_OAUTH_CLIENT_SECRET", 400);
    const openerOrigin = webOrigin(request.headers.get("x-dreamyo-browser-origin") || "") || resolvePublicRequestOrigin(request, "");
    const localOrigin = localOAuthOrigin(openerOrigin);
    if (config.builtIn && !localOrigin) throw new GeminiToolsError("内置 Antigravity OAuth 客户端仅支持从当前机器的 localhost 页面发起授权", 400);
    const redirectUri = config.builtIn ? `${localOrigin}/oauth/callback` : process.env.GEMINI_TOOLS_OAUTH_REDIRECT_URI?.trim() || `${resolvePublicRequestOrigin(request)}/oauth/callback`;
    const state = await createGeminiToolsOAuthSession(redirectUri, openerOrigin);
    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
    });
    return { authUrl: `${GOOGLE_AUTH_URL}?${params}`, redirectUri };
}

export async function completeGeminiToolsOAuth(input: { code: string; state: string }) {
    return withGeminiToolsMagicProxy(async () => {
        const session = await consumeGeminiToolsOAuthSession(input.state);
        if (!session) throw new GeminiToolsError("授权状态已过期，请重新发起授权", 400);
        const token = await exchangeCode(input.code, session.redirectUri);
        const user = await googleJson<{ email?: unknown; name?: unknown; picture?: unknown }>(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${token.accessToken}` } }, "读取 Google 账号资料失败");
        const email = text(user.email, 320);
        if (!email) throw new GeminiToolsError("Google 授权未返回邮箱，账号未保存", 502);
        const project = await loadCodeAssist(token.accessToken);
        const quotas = await fetchAvailableModels(token.accessToken, project.projectId);
        const account = await upsertGeminiToolsAccount({
            email,
            name: text(user.name, 120) || email,
            picture: text(user.picture, 1000) || undefined,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            projectId: project.projectId,
            planType: project.planType,
            quotas,
        });
        return { account, openerOrigin: session.openerOrigin };
    });
}

export async function refreshGeminiToolsAccount(accountId: string) {
    return withGeminiToolsMagicProxy(async () => {
        const account = await getGeminiToolsPrivateAccount(accountId);
        if (!account) throw new GeminiToolsError("Google 账号不存在", 404);
        try {
            const token = await validAccessToken(account, true);
            const project = account.projectId ? { projectId: account.projectId, planType: account.planType } : await loadCodeAssist(token.accessToken);
            const quotas = await fetchAvailableModels(token.accessToken, project.projectId);
            await updateGeminiToolsAccountCredentials(account.id, { ...token, projectId: project.projectId, planType: project.planType, quotas, status: "active" });
            return (await listGeminiToolsAccounts()).find((item) => item.id === account.id);
        } catch (error) {
            if (error instanceof GeminiToolsError && [400, 401, 403].includes(error.status)) await updateGeminiToolsAccount(account.id, { status: "invalid" });
            throw error;
        }
    });
}

export async function refreshAllGeminiToolsAccounts() {
    const accounts = await listGeminiToolsAccounts();
    const results = [];
    for (const account of accounts) {
        try {
            results.push({ id: account.id, ok: true, account: await refreshGeminiToolsAccount(account.id) });
        } catch (error) {
            results.push({ id: account.id, ok: false, error: error instanceof Error ? error.message : "刷新失败" });
        }
    }
    return results;
}

export async function syncGeminiToolsModelCatalog(input: { enableNewModels?: unknown } = {}) {
    const before = catalogFromAccounts(await listGeminiToolsAccounts());
    const accountResults = await refreshAllGeminiToolsAccounts();
    const after = catalogFromAccounts(await listGeminiToolsAccounts());
    const known = new Set(before.map((model) => normalizeModelId(model.id)));
    const newModels = after.filter((model) => !known.has(normalizeModelId(model.id)));
    let enabledNewModelIds: string[] = [];

    if (input.enableNewModels === true && newModels.length) {
        const settings = await getAuthSettings();
        const channel = geminiToolsChannel(settings);
        const saved = await saveGeminiToolsModelSelection({ models: [...(channel?.models || []), ...newModels.map((model) => model.id)] });
        enabledNewModelIds = newModels.filter((model) => saved.channel.models.some((selected) => sameModel(selected, model.id))).map((model) => model.id);
    }

    const overview = await getGeminiToolsOverview();
    return { accountResults, discoveredModels: after, newModels, enabledNewModelIds, overview };
}

export async function saveGeminiToolsModelSelection(input: { models?: unknown }) {
    const requested = uniqueStrings(input.models, 200);
    const [accounts, settings] = await Promise.all([listGeminiToolsAccounts(), getAuthSettings()]);
    const available = new Map(catalogFromAccounts(accounts).map((model) => [normalizeModelId(model.id), model]));
    const existing = geminiToolsChannel(settings);
    const existingModels = new Map((existing?.models || []).map((model) => [normalizeModelId(model), { id: model, name: model }]));
    const selected = requested.map((model) => available.get(normalizeModelId(model)) || existingModels.get(normalizeModelId(model))).filter((model): model is { id: string; name: string } => Boolean(model));
    if (selected.length !== requested.length) throw new GeminiToolsError("所选模型不在 Google 账号真实额度目录中", 422);

    const base = applyChannelProtocol(
        {
            ...(existing || defaultChannel()),
            id: GEMINI_TOOLS_CHANNEL_ID,
            name: GEMINI_TOOLS_CHANNEL_NAME,
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            models: selected.map((model) => model.id),
            enabled: true,
        },
        GEMINI_TOOLS_PROTOCOL,
    );
    const channel: SystemModelChannel = {
        ...base,
        apiKey: "",
        hasApiKey: false,
        advancedConfig: {
            ...base.advancedConfig!,
            modelCapabilities: Object.fromEntries(selected.map((model) => [normalizeModelId(model.id), "text"])),
            modelConfigs: Object.fromEntries(selected.map((model) => [normalizeModelId(model.id), protocolModelConfig(GEMINI_TOOLS_PROTOCOL, "text", model.id)!])),
        },
    };
    const channels = existing ? settings.systemChannels.map((item) => (item.id === existing.id ? channel : item)) : [...settings.systemChannels, channel];
    const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, channels);
    const defaultModels = normalizeDefaultModelsConfig(settings.defaultModels, logicalModels, channels);
    await setAuthSettings({ systemChannels: channels, logicalModels, defaultModels });
    return { channel: publicChannel(channel), models: selected.map((model) => ({ ...model, enabled: true, available: available.has(normalizeModelId(model.id)) })) };
}

export async function testGeminiToolsText(input: { model?: unknown; prompt?: unknown }) {
    const model = text(input.model, 200);
    const prompt = text(input.prompt, 20_000);
    if (!model || !prompt) throw new GeminiToolsError("请选择模型并输入测试内容", 400);
    const response = await geminiToolsRuntimeRequest(
        "/v1/chat/completions",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        },
        { protocol: "admin-test" },
    );
    const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    if (!response.ok) throw new GeminiToolsError(errorMessage(payload) || "GeminiTools 文本实测失败", response.status);
    return { model, text: payload?.choices?.[0]?.message?.content || "" };
}

export async function geminiToolsRuntimeRequest(path: string, init: RequestInit, context: { protocol?: "openai" | "gemini" | "anthropic" | "admin-test"; keyPrefix?: string; keyId?: string } = {}) {
    return withTrafficContext({ channelId: GEMINI_TOOLS_CHANNEL_ID, channelName: GEMINI_TOOLS_CHANNEL_NAME, protocol: GEMINI_TOOLS_PROTOCOL, model: trafficBodyModel(init.body), ...currentTrafficContext() }, () =>
        withGeminiToolsMagicProxy(() => geminiToolsRuntimeRequestInternal(path, init, context)),
    );
}

async function geminiToolsRuntimeRequestInternal(path: string, init: RequestInit, context: { protocol?: "openai" | "gemini" | "anthropic" | "admin-test"; keyPrefix?: string; keyId?: string } = {}) {
    const startedAt = Date.now();
    const normalizedPath = normalizeRuntimePath(path);
    if (!normalizedPath) return Response.json({ error: { message: "GeminiTools 不支持该接口" } }, { status: 404 });
    const gateway = await getGeminiToolsGatewaySettings();
    if (!gateway.enabled) return Response.json({ error: { message: "GeminiTools 网关已停用" } }, { status: 503 });

    if (normalizedPath === "/v1/models" && (init.method || "GET").toUpperCase() === "GET") {
        const data = catalogFromAccounts(await listGeminiToolsAccounts()).map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "google-antigravity" }));
        return Response.json({ object: "list", data });
    }

    if (normalizedPath === "/v1/messages/count_tokens" && (init.method || "POST").toUpperCase() === "POST") {
        const body = await requestJson(init.body);
        return Response.json({ input_tokens: estimateMessageTokens(body) });
    }

    const body = await requestJson(init.body);
    const protocol = context.protocol || protocolFromPath(normalizedPath);
    const model = text(body?.model, 200);
    if (!model) return Response.json({ error: { message: "缺少模型 ID" } }, { status: 400 });
    const clientIp = extractClientIp(init.headers);
    const userAgent = extractUserAgent(init.headers);
    const headers = sanitizeLogHeaders(init.headers);
    const method = (init.method || "POST").toUpperCase();

    const openLogId = await openGeminiToolsRequestLog({
        protocol,
        method,
        path: normalizedPath,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        ...(context.keyPrefix ? { keyPrefix: context.keyPrefix } : {}),
        requestPreview: previewRequest(body) || undefined,
        ...(clientIp ? { clientIp } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(headers ? { headers } : {}),
    }).catch(() => "");
    if (openLogId) updateTrafficContext({ requestId: openLogId, attemptId: openLogId });
    if (openLogId) await markGeminiToolsRequestLogRunning(openLogId).catch(() => undefined);
    // 每个阶段即时落库：请求可能耗时数分钟，否则后台在结束前只能看到「排队中」。
    const pushPhase = async (entry: GeminiToolsLifecycleEntry) => {
        lifecycle.push(entry);
        if (openLogId) await appendGeminiToolsRequestLifecycle(openLogId, entry).catch(() => undefined);
    };
    const egressNow = () => geminiToolsProxyEgress().catch(() => undefined);
    const egress = await egressNow();

    const lifecycle: GeminiToolsLifecycleEntry[] = [
        {
            phase: "queued",
            message: "接收到 API 请求并建立上下文",
            time: new Date(startedAt).toISOString(),
            durationMs: 0,
            detail: `协议: ${protocol.toUpperCase()}, 方法: ${method}, 路径: ${normalizedPath}, 模型: ${model}`,
        },
        {
            phase: "routing",
            message: egress ? "代理出口路由绑定完成" : "使用直接连接 (Direct)",
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: egress ? `模式: ${egress.mode === "magic" ? "魔法代理" : egress.mode === "chained" ? "链式代理" : "通用代理"}, 节点: ${egress.node_name || egress.address || "默认出口"}` : "未配置代理出口，直连 Google 官方服务",
        },
    ];

    const availableModels = new Set(catalogFromAccounts(await listGeminiToolsAccounts()).map((item) => normalizeModelId(item.id)));
    if (!availableModels.has(normalizeModelId(model))) {
        await pushPhase({
            phase: "failed",
            message: "模型不在当前 Google 账号额度目录中",
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: `请求模型: ${model}`,
        });
        if (openLogId) {
            await settleGeminiToolsRequestLog(openLogId, {
                statusCode: 404,
                durationMs: Date.now() - startedAt,
                error: "模型不在当前 Google 账号额度目录中",
                proxyEgress: egress,
                lifecycle,
            }).catch(() => undefined);
        }
        return Response.json({ error: { message: "模型不在当前 Google 账号额度目录中" } }, { status: 404 });
    }

    const candidates = await listGeminiToolsCandidateAccounts();
    const modelAccounts = candidates.filter((account) => account.quotas.some((quota) => normalizeModelId(quota.model) === normalizeModelId(model)));
    const withQuota = modelAccounts.filter((account) => account.quotas.some((quota) => normalizeModelId(quota.model) === normalizeModelId(model) && (quota.remainingPercent === undefined || quota.remainingPercent > 0)));
    const accounts = stickyAccounts(withQuota.length ? withQuota : modelAccounts, gateway.sessionStickiness ? sessionKey(init, body, context.keyPrefix) : "");
    if (!accounts.length) {
        await pushPhase({
            phase: "failed",
            message: "没有可用于调用的 Google 账号",
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: "无可用或具有额度的候选账号",
        });
        if (openLogId) {
            await settleGeminiToolsRequestLog(openLogId, {
                statusCode: 503,
                durationMs: Date.now() - startedAt,
                error: "没有可用于反代的 Google 账号",
                proxyEgress: egress,
                lifecycle,
            }).catch(() => undefined);
        }
        return Response.json({ error: { message: "没有可用于反代的 Google 账号" } }, { status: 503 });
    }
    let lastError: GeminiToolsError | null = null;
    let failedAccount: Pick<GeminiToolsPrivateAccount, "id" | "email"> | null = null;
    // 换号次数上限：rotationLimit=0/1 只用当前账号；N 最多依次尝试 N 个账号（认证失效/429 才切换，模糊失败立即停止避免重复生成）。
    const maxAccountTries = gateway.rotationLimit > 0 ? Math.min(gateway.rotationLimit, accounts.length) : 1;
    for (const account of accounts.slice(0, maxAccountTries)) {
        let attemptedGeneration = false;
        try {
            const token = await validAccessToken(account);
            const project = account.projectId ? { projectId: account.projectId, planType: account.planType } : await loadCodeAssist(token.accessToken);
            if (!account.projectId) await updateGeminiToolsAccountCredentials(account.id, { ...token, projectId: project.projectId, planType: project.planType });

            await pushPhase({
                phase: "auth",
                message: `验证账号 [${account.email || account.id}] 凭据与额度`,
                time: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                detail: `账号: ${account.email || account.id}, 项目: ${project.projectId || "-"}, 方案: ${project.planType || "standard"}`,
            });

            const session = sessionKey(init, body, context.keyPrefix);
            const nativePayload = protocolRequest(protocol, body || {}, session);
            const upstreamStart = Date.now();
            await pushPhase({
                phase: "upstream",
                message: "调用 Google Cloud Code 语言模型生成接口 (流式)",
                time: new Date(upstreamStart).toISOString(),
                durationMs: upstreamStart - startedAt,
                detail: `模型: ${model}, 项目: ${project.projectId}, 载荷大小: ${JSON.stringify(nativePayload).length} 字节`,
            });

            const settleSuccess = async (usage: { promptTokens: number; completionTokens: number; totalTokens: number }, previewText: string) => {
                const finishAt = Date.now();
                await pushPhase({
                    phase: "success",
                    message: "协议格式转换与 Token 统计完成",
                    time: new Date(finishAt).toISOString(),
                    durationMs: finishAt - startedAt,
                    detail: `Token 消耗: ${usage.totalTokens} (Prompt: ${usage.promptTokens}, Completion: ${usage.completionTokens}), 总耗时: ${finishAt - startedAt}ms`,
                });
                await Promise.all([
                    recordGeminiToolsAccountUsage(account.id, usage.totalTokens, false),
                    (async () => {
                        const settlePayload = {
                            protocol,
                            method,
                            path: normalizedPath,
                            model,
                            accountId: account.id,
                            accountEmail: account.email,
                            statusCode: 200,
                            durationMs: finishAt - startedAt,
                            promptTokens: usage.promptTokens,
                            completionTokens: usage.completionTokens,
                            totalTokens: usage.totalTokens,
                            keyPrefix: context.keyPrefix,
                            requestPreview: previewRequest(body),
                            responsePreview: previewText,
                            proxyEgress: egress,
                            lifecycle,
                            ...(clientIp ? { clientIp } : {}),
                            ...(userAgent ? { userAgent } : {}),
                            ...(headers ? { headers } : {}),
                        } as const;
                        if (openLogId) return settleGeminiToolsRequestLog(openLogId, settlePayload).catch(() => undefined);
                        return appendGeminiToolsRequestLog(settlePayload);
                    })(),
                    // 流式响应没有总 Token 响应头，API Key 用量在流结束时结算；非流式仍由路由按响应头记录，避免双份。
                    ...(context.keyId && streamingRequested(body) ? [recordGeminiToolsApiKeyTokens(context.keyId, usage.totalTokens)] : []),
                ]);
            };

            // 上游统一走 streamGenerateContent：非流式接口配额更严，且流式可在生成期间持续向下游交付数据，
            // 避免 Claude Code / ZCode 等 Agent CLI 因长时间无字节而触发请求看门狗断连。
            attemptedGeneration = true;
            const upstream = await cloudCodeStreamGenerate(token.accessToken, project.projectId, model, nativePayload, upstreamBetaHeaders(init.headers, model));

            if (streamingRequested(body)) {
                const streamStart = Date.now();
                await pushPhase({
                    phase: "response",
                    message: "Google Cloud Code 流式连接已建立，开始实时转发",
                    time: new Date(streamStart).toISOString(),
                    durationMs: streamStart - startedAt,
                    detail: `连接建立耗时: ${streamStart - upstreamStart}ms`,
                });
                return relayProtocolStream({
                    upstream,
                    session,
                    translator: new NativeStreamTranslator(protocol === "anthropic" ? "anthropic" : "openai", model),
                    onSettled: async (settlement) => {
                        if (settlement.ok) {
                            await settleSuccess(settlement, settlement.preview);
                            return;
                        }
                        // 中断发生在生成开始之后，属模糊失败：不换号重放，仅落库失败证据。
                        await pushPhase({
                            phase: "failed",
                            message: `上游流式转发中断: ${settlement.error}`,
                            time: new Date().toISOString(),
                            durationMs: Date.now() - startedAt,
                            detail: `账号: ${account.email || account.id}`,
                        });
                        await recordGeminiToolsAccountUsage(account.id, 0, true);
                        if (openLogId) {
                            await settleGeminiToolsRequestLog(openLogId, {
                                statusCode: 502,
                                durationMs: Date.now() - startedAt,
                                error: settlement.error,
                                accountId: account.id,
                                accountEmail: account.email,
                                proxyEgress: egress,
                                lifecycle,
                            }).catch(() => undefined);
                        }
                    },
                });
            }

            const native = await collectNativeFromStream(upstream);
            const responseEnd = Date.now();
            await pushPhase({
                phase: "response",
                message: "收到 Google Cloud Code 流式响应并聚合完成",
                time: new Date(responseEnd).toISOString(),
                durationMs: responseEnd - startedAt,
                detail: `上游调用耗时: ${responseEnd - upstreamStart}ms, 响应数据接收正常`,
            });

            const formatted = protocolResponse(protocol, native, model);
            const usage = usageFromNative(native);
            const content = textFromNative(native);
            const reasoning = reasoningFromNative(native);
            const functionCalls = functionCallsFromNative(native);
            const finishReason = finishReasonFromNative(native);
            const previewText = (content || reasoning || (functionCalls.length ? `[工具调用: ${functionCalls.map((c) => c.name).join(", ")}]` : finishReason ? `[结束原因: ${finishReason}]` : "")).slice(0, 500);
            await settleSuccess(usage, previewText);
            return Response.json(formatted, { headers: { "x-gemini-tools-total-tokens": String(usage.totalTokens) } });
        } catch (error) {
            lastError = error instanceof GeminiToolsError ? error : new GeminiToolsError(error instanceof Error ? error.message : "Google 上游请求失败");
            failedAccount = { id: account.id, email: account.email };
            await pushPhase({
                phase: "failed",
                message: `账号 [${account.email || account.id}] 处理失败: ${lastError.message}`,
                time: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                detail: `状态码: ${lastError.status || 500}, 异常原因: ${lastError.message}`,
            });
            await recordGeminiToolsAccountUsage(account.id, 0, true);
            if (lastError.status === 429) {
                // Google 返回 429 时后台显示的 remainingPercent 还是上次刷新的快照；
                // 立即异步刷新该账号额度目录，让轮询过滤与后台展示拿到真实剩余额度。
                void (async () => {
                    try {
                        const freshToken = await validAccessToken(account);
                        const quotas = await fetchAvailableModels(freshToken.accessToken, account.projectId);
                        await updateGeminiToolsAccountCredentials(account.id, { accessToken: freshToken.accessToken, expiresAt: freshToken.expiresAt, projectId: account.projectId, planType: account.planType, quotas });
                    } catch {
                        // 快照刷新失败不影响主流程与错误透出。
                    }
                })();
            }
            if (isDefiniteGoogleAuthFailure(lastError)) await updateGeminiToolsAccount(account.id, { status: "invalid" });
            // Do not replay a generation after an ambiguous upstream or
            // transport failure. Authentication and quota rejections are
            // definite non-executions, so only those may advance an account.
            if (attemptedGeneration && !isDefiniteGoogleAuthFailure(lastError) && lastError.status !== 429) break;
        }
    }
    const status = lastError?.status || 502;
    if (openLogId) {
        await settleGeminiToolsRequestLog(openLogId, {
            statusCode: status,
            durationMs: Date.now() - startedAt,
            error: lastError?.message || "Google 上游请求失败",
            accountId: failedAccount?.id,
            accountEmail: failedAccount?.email,
            proxyEgress: egress,
            lifecycle,
        }).catch(() => undefined);
    } else {
        await appendGeminiToolsRequestLog({
            protocol,
            method,
            path: normalizedPath,
            model,
            accountId: failedAccount?.id,
            accountEmail: failedAccount?.email,
            statusCode: status,
            durationMs: Date.now() - startedAt,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            error: lastError?.message || "Google 上游请求失败",
            keyPrefix: context.keyPrefix,
            requestPreview: previewRequest(body),
            proxyEgress: egress,
            lifecycle,
            ...(clientIp ? { clientIp } : {}),
            ...(userAgent ? { userAgent } : {}),
            ...(headers ? { headers } : {}),
        });
    }
    return Response.json({ error: { message: lastError?.message || "Google 上游请求失败" } }, { status });
}

export function isGeminiToolsRuntimePath(path: string) {
    return Boolean(normalizeRuntimePath(path));
}

async function validAccessToken(account: GeminiToolsPrivateAccount, forceRefresh = false) {
    if (!forceRefresh && account.accessToken && account.expiresAt > Date.now() + 60_000) return { accessToken: account.accessToken, refreshToken: account.refreshToken, expiresAt: account.expiresAt };
    if (!account.refreshToken) throw new GeminiToolsError("Google 授权已过期且没有刷新凭据，请重新授权", 401);
    const config = oauthConfig();
    if (!config) throw new GeminiToolsError("GeminiTools OAuth 未配置：请设置 GEMINI_TOOLS_OAUTH_CLIENT_ID 与 GEMINI_TOOLS_OAUTH_CLIENT_SECRET", 401);
    const payload = await googleJson<Record<string, unknown>>(
        GOOGLE_TOKEN_URL,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: account.refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token" }) },
        "刷新 Google 授权失败",
    );
    const accessToken = text(payload.access_token, 10_000);
    if (!accessToken) throw new GeminiToolsError("Google 未返回新的访问令牌", 502);
    const result = { accessToken, refreshToken: account.refreshToken, expiresAt: Date.now() + positiveNumber(payload.expires_in, 3600) * 1000 };
    await updateGeminiToolsAccountCredentials(account.id, result);
    return result;
}

async function exchangeCode(code: string, redirectUri: string) {
    const config = oauthConfig();
    if (!config) throw new GeminiToolsError("GeminiTools OAuth 未配置：请设置 GEMINI_TOOLS_OAUTH_CLIENT_ID 与 GEMINI_TOOLS_OAUTH_CLIENT_SECRET", 400);
    const payload = await googleJson<Record<string, unknown>>(
        GOOGLE_TOKEN_URL,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }) },
        "Google 授权码交换失败",
    );
    const accessToken = text(payload.access_token, 10_000);
    if (!accessToken) throw new GeminiToolsError("Google 未返回访问令牌", 502);
    return { accessToken, refreshToken: text(payload.refresh_token, 10_000), expiresAt: Date.now() + positiveNumber(payload.expires_in, 3600) * 1000 };
}

async function loadCodeAssist(accessToken: string) {
    let last: GeminiToolsError | null = null;
    for (const base of CLOUD_CODE_ENDPOINTS) {
        try {
            const payload = await cloudCodeJson(`${base}:loadCodeAssist`, accessToken, { metadata: { ideType: "ANTIGRAVITY" } });
            const projectId = text(payload.cloudaicompanionProject, 500);
            if (!projectId) throw new GeminiToolsError("Google 账号未返回 cloudaicompanionProject，无法建立 Antigravity 网关", 422);
            return { projectId, planType: subscriptionTier(payload) };
        } catch (error) {
            last = error instanceof GeminiToolsError ? error : new GeminiToolsError("解析 Google Antigravity 项目失败");
            if (![404, 408, 500, 502, 503, 504].includes(last.status)) break;
        }
    }
    throw last || new GeminiToolsError("Google Antigravity 项目解析失败");
}

export function parseGeminiToolsModelCatalog(payload: unknown) {
    const root = record(payload);
    const deprecatedModelIds = Object.fromEntries(
        Object.entries(record(root.deprecatedModelIds)).flatMap(([model, raw]) => {
            const replacement = text(record(raw).newModelId, 200);
            return model.trim() && replacement ? [[model.trim(), replacement]] : [];
        }),
    );
    const quotas = Object.entries(record(root.models)).flatMap(([model, raw]) => {
        const id = model.trim();
        if (!id) return [];
        const info = record(raw);
        const quota = record(info.quotaInfo);
        const fraction = optionalNumber(quota.remainingFraction);
        return [
            {
                model: id,
                displayName: text(info.displayName, 200) || id,
                ...(fraction !== undefined ? { remainingPercent: Math.max(0, Math.min(100, Math.round(fraction * 100))) } : {}),
                ...(text(quota.resetTime, 200) ? { resetTime: text(quota.resetTime, 200) } : {}),
                supportsImages: info.supportsImages === true,
                supportsThinking: info.supportsThinking === true,
            } satisfies GeminiToolsQuota,
        ];
    });
    return { quotas, deprecatedModelIds };
}

async function fetchAvailableModels(accessToken: string, projectId?: string) {
    let last: GeminiToolsError | null = null;
    for (const base of CLOUD_CODE_ENDPOINTS) {
        try {
            let payload: Record<string, unknown>;
            try {
                payload = await cloudCodeJson(`${base}:fetchAvailableModels`, accessToken, projectId ? { project: projectId } : {});
            } catch (error) {
                if (!(error instanceof GeminiToolsError) || error.status !== 403 || !projectId) throw error;
                payload = await cloudCodeJson(`${base}:fetchAvailableModels`, accessToken, {});
            }
            return parseGeminiToolsModelCatalog(payload).quotas;
        } catch (error) {
            last = error instanceof GeminiToolsError ? error : new GeminiToolsError("读取 Google 模型额度失败");
            if (![404, 408, 429, 500, 502, 503, 504].includes(last.status)) break;
        }
    }
    throw last || new GeminiToolsError("读取 Google 模型额度失败");
}

async function cloudCodeStreamGenerate(accessToken: string, projectId: string, model: string, payload: Record<string, unknown>, extraHeaders: Record<string, string>) {
    let last: GeminiToolsError | null = null;
    for (const base of CLOUD_CODE_ENDPOINTS) {
        try {
            let response: Response;
            try {
                response = await googleRawResponse(`${base}:streamGenerateContent?alt=sse`, accessToken, { project: projectId, request: payload, model }, projectId, extraHeaders);
            } catch (error) {
                if (!(error instanceof GeminiToolsError) || error.status !== 403) throw error;
                response = await googleRawResponse(`${base}:streamGenerateContent?alt=sse`, accessToken, { project: projectId, request: payload, model }, "", extraHeaders);
            }
            return response;
        } catch (error) {
            last = error instanceof GeminiToolsError ? error : new GeminiToolsError("Google 模型调用失败");
            // 生成请求的传输失败可能是模糊失败：Google 可能在连接中断前已受理。
            // 只有明确的 404 才允许换下一个已文档化的 Cloud Code 端点重试。
            if (last.status !== 404) throw last;
        }
    }
    throw last || new GeminiToolsError("Google 模型调用失败");
}

function cloudCodeHeaders(accessToken: string, projectId: string, extraHeaders: Record<string, string> = {}) {
    return {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": antigravityUserAgent(),
        "x-client-name": "antigravity",
        "x-client-version": "4.3.0",
        "x-machine-id": MACHINE_ID,
        "x-vscode-sessionid": SESSION_ID,
        ...(projectId ? { "x-goog-user-project": projectId } : {}),
        ...extraHeaders,
    };
}

async function googleRawResponse(url: string, accessToken: string, body: unknown, projectId: string, extraHeaders: Record<string, string>) {
    let response: Response;
    try {
        const proxyUrl = await geminiToolsMagicProxyUrl();
        const egress = await geminiToolsProxyEgress();
        const channel = geminiToolsChannel(await getAuthSettings());
        response = await fetchSafeOutbound(
            url,
            {
                method: "POST",
                headers: cloudCodeHeaders(accessToken, projectId, extraHeaders),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS),
                cache: "no-store",
                redirect: "error",
            },
            {
                allowProxyFakeIpSpace: true,
                ...(proxyUrl ? { proxyUrl } : {}),
                trafficContext: {
                    channelId: channel?.id || GEMINI_TOOLS_CHANNEL_ID,
                    channelName: channel?.name || GEMINI_TOOLS_CHANNEL_NAME,
                    model: trafficBodyModel(JSON.stringify(body)),
                    protocol: GEMINI_TOOLS_PROTOCOL,
                    ...currentTrafficContext(),
                    connectionMode: egress?.mode || (proxyUrl ? "generic" : "direct"),
                },
            },
        );
    } catch (error) {
        const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.message.toLowerCase().includes("timeout") || (error as { code?: string }).code === "UND_ERR_CONNECT_TIMEOUT");
        const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
        const detail = error instanceof Error ? `${error.message}${cause}` : String(error);
        throw new GeminiToolsError(isTimeout ? "Google Cloud Code 请求失败：请求超时" : `Google Cloud Code 请求失败：${detail}`, isTimeout ? 504 : 502);
    }
    if (!response.ok) {
        const raw = await response.text();
        throw new GeminiToolsError(safeGoogleError(raw ? safeJson(raw) : {}) || "Google Cloud Code 请求失败", response.status);
    }
    return response;
}

async function readUpstreamSseData(response: Response, onData: (data: string) => "continue" | "stop") {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    let stopped = false;
    const consumeLine = (line: string) => {
        if (stopped || !line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data && onData(data) === "stop") stopped = true;
    };
    while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            consumeLine(buffer.slice(0, index).trim());
            buffer = buffer.slice(index + 1);
            if (stopped) break;
        }
    }
    if (!stopped && buffer.trim().startsWith("data:")) consumeLine(buffer.trim());
    reader.cancel().catch(() => undefined);
}

function unwrapNativeChunk(chunk: Record<string, unknown>) {
    const inner = record(chunk.response);
    return Object.keys(inner).length ? inner : chunk;
}

// 非流式客户端同样通过流式上游调用（配额更宽松），在这里把增量分片聚合为完整原生响应。
async function collectNativeFromStream(response: Response) {
    let parts: unknown[] = [];
    let finishReason = "";
    let usage: Record<string, unknown> | null = null;
    let modelVersion = "";
    let responseId = "";
    await readUpstreamSseData(response, (data) => {
        if (data === "[DONE]") return "stop";
        const native = unwrapNativeChunk(record(safeJson(data)));
        if (!Object.keys(native).length) return "continue";
        const candidate = record((Array.isArray(native.candidates) ? native.candidates : [])[0]);
        const content = record(record(candidate.content));
        if (Array.isArray(content.parts)) parts = parts.concat(content.parts);
        const nextFinish = text(candidate.finishReason, 100);
        if (nextFinish) finishReason = nextFinish;
        const nextUsage = record(native.usageMetadata);
        if (Object.keys(nextUsage).length) usage = nextUsage;
        modelVersion = text(native.modelVersion, 200) || modelVersion;
        responseId = text(native.responseId, 200) || responseId;
        return "continue";
    });
    const native: Record<string, unknown> = {
        ...(responseId ? { responseId } : {}),
        ...(modelVersion ? { modelVersion } : {}),
        candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }],
        ...(usage ? { usageMetadata: usage } : {}),
    };
    if (!parts.length && !finishReason) throw new GeminiToolsError("Google 上游流式响应为空", 502);
    return native;
}

async function cloudCodeJson(url: string, accessToken: string, body: unknown, projectId = "") {
    return googleJson<Record<string, unknown>>(
        url,
        {
            method: "POST",
            headers: cloudCodeHeaders(accessToken, projectId),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(240_000),
        },
        "Google Cloud Code 请求失败",
    );
}

async function googleJson<T>(url: string, init: RequestInit, fallbackMessage: string): Promise<T> {
    let response: Response;
    try {
        const proxyUrl = await geminiToolsMagicProxyUrl();
        const egress = await geminiToolsProxyEgress();
        const channel = geminiToolsChannel(await getAuthSettings());
        response = await fetchSafeOutbound(
            url,
            { ...init, cache: "no-store", redirect: "error" },
            {
                allowProxyFakeIpSpace: true,
                ...(proxyUrl ? { proxyUrl } : {}),
                trafficContext: {
                    channelId: channel?.id || GEMINI_TOOLS_CHANNEL_ID,
                    channelName: channel?.name || GEMINI_TOOLS_CHANNEL_NAME,
                    model: trafficBodyModel(init.body),
                    protocol: GEMINI_TOOLS_PROTOCOL,
                    ...currentTrafficContext(),
                    connectionMode: egress?.mode || (proxyUrl ? "generic" : "direct"),
                },
            },
        );
    } catch (error) {
        const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.message.toLowerCase().includes("timeout") || (error as { code?: string }).code === "UND_ERR_CONNECT_TIMEOUT");
        const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
        const detail = error instanceof Error ? `${error.message}${cause}` : String(error);
        throw new GeminiToolsError(isTimeout ? `${fallbackMessage}：请求超时` : `${fallbackMessage}：${detail}`, isTimeout ? 504 : 502);
    }
    const raw = await response.text();
    const payload = raw ? safeJson(raw) : {};
    if (!response.ok) throw new GeminiToolsError(safeGoogleError(payload) || fallbackMessage, response.status);
    if (!payload || typeof payload !== "object") throw new GeminiToolsError(`${fallbackMessage}：响应格式无效`, 502);
    return payload as T;
}

async function withGeminiToolsMagicProxy<T>(callback: () => Promise<T>) {
    if (magicProxyRequestContext.getStore()) return callback();
    return magicProxyRequestContext.run({}, callback);
}

async function geminiToolsProxyBinding() {
    const context = magicProxyRequestContext.getStore();
    if (!context) return ensureMagicProxyProvider("geminiTools");
    context.binding ??= ensureMagicProxyProvider("geminiTools");
    return context.binding;
}

async function geminiToolsMagicProxyUrl() {
    return (await geminiToolsProxyBinding())?.proxyUrl;
}

async function geminiToolsProxyEgress(): Promise<MagicProxyEgressInfo | undefined> {
    return (await geminiToolsProxyBinding().catch(() => undefined))?.egress;
}

function protocolRequest(protocol: "openai" | "gemini" | "anthropic" | "admin-test", body: Record<string, unknown>, session = "") {
    if (protocol === "gemini") return record(body);
    const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const system = protocol === "anthropic" ? body.system : undefined;
    if (typeof system === "string" && system.trim()) systemInstruction = { parts: [{ text: system }] };
    // OpenAI 的 role:"tool" 消息只带 tool_call_id，需要回查它对应的上游函数名。
    const toolCallNames = new Map<string, string>();
    for (const raw of messages) {
        const message = record(raw);
        if (message.role === "system") {
            const value = messageText(message.content);
            if (value) systemInstruction = { parts: [{ text: value }] };
            continue;
        }
        if (message.role === "tool") {
            const callId = text(message.tool_call_id, 200);
            const output = messageText(message.content);
            contents.push({ role: "user", parts: [{ functionResponse: { name: toolCallNames.get(callId) || callId || "tool", response: { output: output || "Command executed successfully." } } }] });
            continue;
        }
        const isAssistant = message.role === "assistant";
        const parts: Array<Record<string, unknown>> = [];
        let lastSignature = "";
        const blocks = Array.isArray(message.content) ? message.content : [];
        if (typeof message.content === "string" && message.content.trim()) parts.push({ text: message.content });
        for (const rawBlock of blocks) {
            const block = record(rawBlock);
            const type = text(block.type, 40);
            // 思考块正文不上游，但其中的签名必须暂存，供紧随其后的工具调用回传给 Gemini。
            if (type === "thinking" || type === "reasoning") {
                lastSignature = text(block.signature, 100_000) || lastSignature;
                if (lastSignature) rememberSessionSignature(session, lastSignature);
                continue;
            }
            if (type === "tool_use") {
                const name = text(block.name, 200);
                if (!name) continue;
                const callId = text(block.id, 200);
                if (callId) toolCallNames.set(callId, name);
                const signature = lastSignature || cachedSessionSignature(session);
                if (signature) rememberSessionSignature(session, signature);
                parts.push({ functionCall: { name, args: record(block.input) }, ...(signature ? { thoughtSignature: signature } : {}) });
                continue;
            }
            if (type === "tool_result") {
                const callId = text(block.tool_use_id, 200);
                const result = toolResultText(block);
                parts.push({ functionResponse: { name: text(block.name, 200) || toolCallNames.get(callId) || callId || "tool", response: { output: result || "Command executed successfully." } } });
                continue;
            }
            if (type === "text" && text(block.text, 100_000)) {
                parts.push({ text: text(block.text, 100_000) });
                continue;
            }
            const image = record(block.image_url);
            const dataUrl = text(image.url, 20_000_000);
            const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
        if (isAssistant && Array.isArray(message.tool_calls)) {
            for (const rawCall of message.tool_calls) {
                const call = record(rawCall);
                const fn = record(call.function);
                const name = text(fn.name, 200);
                if (!name) continue;
                const callId = text(call.id, 200);
                if (callId) toolCallNames.set(callId, name);
                let args: Record<string, unknown> = {};
                try {
                    args = record(JSON.parse(String(fn.arguments || "{}")));
                } catch {
                    args = {};
                }
                const signature = lastSignature || cachedSessionSignature(session);
                if (signature) rememberSessionSignature(session, signature);
                parts.push({ functionCall: { name, args }, ...(signature ? { thoughtSignature: signature } : {}) });
            }
        }
        if (parts.length) contents.push({ role: isAssistant ? "model" : "user", parts });
    }
    if (!contents.length && typeof body.input === "string") contents.push({ role: "user", parts: [{ text: body.input }] });
    const generationConfig: Record<string, unknown> = {};
    if (optionalNumber(body.temperature) !== undefined) generationConfig.temperature = optionalNumber(body.temperature);
    if (optionalNumber(body.top_p) !== undefined) generationConfig.topP = optionalNumber(body.top_p);
    const maxTokens = optionalNumber(body.max_completion_tokens) ?? optionalNumber(body.max_tokens);
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    const tools = toolDeclarations(protocol, body);
    const toolConfig = toolCallingConfig(protocol, body.tool_choice);
    return {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        ...(tools ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
    };
}

function toolResultText(block: Record<string, unknown>) {
    const value = block.content;
    const join = (items: unknown[]) =>
        items
            .map((item) => text(record(item).text, 200_000))
            .filter(Boolean)
            .join("\n");
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return join(value);
    return "";
}

function toolDeclarations(protocol: "openai" | "gemini" | "anthropic" | "admin-test", body: Record<string, unknown>) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const declarations: Array<Record<string, unknown>> = [];
    for (const raw of tools) {
        const tool = record(raw);
        const fn = protocol === "anthropic" ? tool : record(tool.function);
        const name = text(fn.name, 200);
        if (protocol !== "anthropic" && tool.type !== "function") continue;
        if (!name) continue;
        const schema = geminiSchema(record(fn.input_schema ?? fn.parameters));
        declarations.push({ name, ...(text(fn.description, 8_000) ? { description: text(fn.description, 8_000) } : {}), ...(Object.keys(schema).length ? { parameters: schema } : {}) });
    }
    return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

// Anthropic/OpenAI 的 JSON Schema 需要归一为 Gemini 支持的形态：type 枚举大写，剔除上游不认的字段。
function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const unsupported = new Set(["$schema", "additionalProperties", "$defs", "definitions", "default", "examples", "exclusiveMaximum", "exclusiveMinimum", "format"]);
    const convert = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(convert);
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const input = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(input)) {
            if (unsupported.has(key)) continue;
            if (key === "type" && typeof item === "string") {
                result.type = item.toUpperCase();
                continue;
            }
            result[key] = convert(item);
        }
        return result;
    };
    return record(convert(schema));
}

function toolCallingConfig(protocol: "openai" | "gemini" | "anthropic" | "admin-test", choice: unknown): Record<string, unknown> | undefined {
    const config = (mode: string, allowed?: string[]) => ({ functionCallingConfig: { mode, ...(allowed ? { allowedFunctionNames: allowed } : {}) } });
    if (protocol === "anthropic") {
        const typed = record(choice);
        if (typed.type === "any") return config("ANY");
        if (typed.type === "tool" && text(typed.name, 200)) return config("ANY", [text(typed.name, 200)]);
        if (choice !== undefined && choice !== null) return config("AUTO");
        return undefined;
    }
    if (choice === "required") return config("ANY");
    if (choice === "none") return config("NONE");
    if (choice && typeof choice === "object") {
        const name = text(record(record(choice).function).name, 200);
        if (name) return config("ANY", [name]);
    }
    return undefined;
}

function upstreamBetaHeaders(headers: HeadersInit | null | undefined, model: string): Record<string, string> {
    const incoming = new Headers(headers ?? undefined).get("anthropic-beta") || "";
    const beta = new Set(
        incoming
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
    );
    if (/claude/i.test(model)) beta.add("claude-code-20250219");
    return beta.size ? { "anthropic-beta": [...beta].join(",") } : {};
}

type OpenAiResponse = {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: "assistant";
            content: string | null;
            reasoning_content?: string;
            tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

function functionCallsFromNative(native: Record<string, unknown>) {
    const candidates = Array.isArray(native.candidates) ? native.candidates : [];
    const content = record(record(candidates[0]).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const raw of parts) {
        const part = record(raw);
        if (part.functionCall && typeof part.functionCall === "object") {
            const call = record(part.functionCall);
            const name = text(call.name, 200);
            if (name) {
                calls.push({ name, args: record(call.args) });
            }
        }
    }
    return calls;
}

function finishReasonFromNative(native: Record<string, unknown>) {
    const candidates = Array.isArray(native.candidates) ? native.candidates : [];
    const candidate = record(candidates[0]);
    return text(candidate.finishReason, 100);
}

// Gemini 多轮 function calling 要求回传 thoughtSignature；取原生分片中的最后一个签名。
function signatureFromNative(native: Record<string, unknown>) {
    const candidates = Array.isArray(native.candidates) ? native.candidates : [];
    const content = record(record(record(candidates[0]).content));
    const parts = Array.isArray(content.parts) ? content.parts : [];
    let signature = "";
    for (const raw of parts) {
        const found = text(record(raw).thoughtSignature, 100_000);
        if (found) signature = found;
    }
    return signature;
}

function protocolResponse(protocol: "openai" | "gemini" | "anthropic" | "admin-test", native: Record<string, unknown>, model: string) {
    if (protocol === "gemini") return native;
    const content = textFromNative(native);
    const reasoning = reasoningFromNative(native);
    const usage = usageFromNative(native);
    const functionCalls = functionCallsFromNative(native);
    const finishReason = finishReasonFromNative(native);
    const signature = signatureFromNative(native);
    const effectiveText = content || (functionCalls.length === 0 && reasoning ? reasoning : "");

    if (protocol === "anthropic") {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (reasoning && content) {
            contentBlocks.push({ type: "thinking", thinking: reasoning, ...(signature ? { signature } : {}) });
            contentBlocks.push({ type: "text", text: content });
        } else if (effectiveText) {
            contentBlocks.push({ type: "text", text: effectiveText });
        }
        for (const call of functionCalls) {
            contentBlocks.push({
                type: "tool_use",
                id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                name: call.name,
                input: call.args,
            });
        }
        if (contentBlocks.length === 0) {
            contentBlocks.push({ type: "text", text: finishReason ? `[生成结束: ${finishReason}]` : "" });
        }
        const stopReason = functionCalls.length > 0 ? "tool_use" : finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
        return {
            id: `msg_${randomUUID()}`,
            type: "message",
            role: "assistant",
            model,
            content: contentBlocks,
            stop_reason: stopReason,
            usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens },
        };
    }

    const openAiToolCalls = functionCalls.map((call) => ({
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function" as const,
        function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
        },
    }));

    const openAiFinishReason = openAiToolCalls.length > 0 ? "tool_calls" : finishReason === "MAX_TOKENS" ? "length" : finishReason === "SAFETY" ? "content_filter" : "stop";

    return {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: effectiveText || (openAiToolCalls.length ? null : ""),
                    ...(reasoning ? { reasoning_content: reasoning } : {}),
                    ...(openAiToolCalls.length ? { tool_calls: openAiToolCalls } : {}),
                },
                finish_reason: openAiFinishReason,
            },
        ],
        usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens },
    } satisfies OpenAiResponse;
}

type StreamProtocol = "openai" | "anthropic";

type StreamSettlement = { ok: boolean; error: string; promptTokens: number; completionTokens: number; totalTokens: number; preview: string };

// 把 Google 流式增量分片实时翻译为 Anthropic / OpenAI 的标准 SSE 事件流。
// 分片语义：candidates[0].content.parts 为增量正文/思考/工具调用；usageMetadata 与 finishReason 随分片渐进到达。
class NativeStreamTranslator {
    private blockType: "" | "text" | "thinking" = "";
    private blockIndex = 0;
    private messageStarted = false;
    private pendingSignature = "";
    private sawToolCall = false;
    private finishReason = "";
    private promptTokens = 0;
    private completionTokens = 0;
    private totalTokens = 0;
    private contentPreview = "";
    private thinkingPreview = "";
    private toolPreview = "";
    private openAiToolIndex = 0;
    private readonly id: string;

    constructor(
        private readonly protocol: StreamProtocol,
        private readonly model: string,
    ) {
        this.id = `${protocol === "anthropic" ? "msg" : "chatcmpl"}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    }

    translate(chunk: Record<string, unknown>): string[] {
        const native = unwrapNativeChunk(chunk);
        const frames: string[] = [];
        const usage = record(native.usageMetadata);
        if (Object.keys(usage).length) {
            this.promptTokens = positiveNumber(usage.promptTokenCount, this.promptTokens);
            this.completionTokens = positiveNumber(usage.candidatesTokenCount, this.completionTokens);
            this.totalTokens = positiveNumber(usage.totalTokenCount, this.promptTokens + this.completionTokens);
        }
        if (!this.messageStarted && (Object.keys(usage).length || Array.isArray(native.candidates))) {
            this.messageStarted = true;
            frames.push(...this.messageStart());
        }
        const candidate = record((Array.isArray(native.candidates) ? native.candidates : [])[0]);
        const finishReason = text(candidate.finishReason, 100);
        if (finishReason) this.finishReason = finishReason;
        const content = record(record(candidate.content));
        const parts = Array.isArray(content.parts) ? content.parts : [];
        for (const rawPart of parts) {
            const part = record(rawPart);
            const signature = text(part.thoughtSignature, 100_000);
            if (signature) this.pendingSignature = signature;
            const call = record(part.functionCall);
            const callName = text(call.name, 200);
            if (callName) {
                frames.push(...this.functionCall(callName, record(call.args), signature));
                continue;
            }
            const piece = text(part.text, 1_000_000);
            if (!piece) continue;
            frames.push(...(part.thought === true ? this.thinking(piece) : this.text(piece)));
        }
        return frames;
    }

    finish(): string[] {
        if (!this.messageStarted) {
            // 上游没有产生任何分片：显式下发一条空消息，而不是静默挂断让客户端超时。
            return [...this.messageStart(), ...this.stopFrames()];
        }
        return this.stopFrames();
    }

    abort(message: string): string[] {
        if (this.protocol === "anthropic") return [...this.closeBlock(), this.frame("error", { type: "error", error: { type: "api_error", message } })];
        return [`data: ${JSON.stringify({ error: { type: "api_error", message } })}\n\n`, "data: [DONE]\n\n"];
    }

    // 记录本轮流式响应中实际下发给客户端的 thoughtSignature，供网关会话缓存回补。
    private emittedSignatures: string[] = [];
    takeSignatures() {
        const collected = this.emittedSignatures;
        this.emittedSignatures = [];
        return collected;
    }

    settlement(error: string): StreamSettlement {
        const preview = [this.contentPreview, this.thinkingPreview ? `[思考] ${this.thinkingPreview}` : "", this.toolPreview ? `[工具调用: ${this.toolPreview}]` : "", !this.contentPreview && !this.thinkingPreview && !this.toolPreview && this.finishReason ? `[结束原因: ${this.finishReason}]` : ""]
            .filter(Boolean)
            .join(" / ")
            .slice(0, 500);
        return { ok: !error, error, promptTokens: this.promptTokens, completionTokens: this.completionTokens, totalTokens: this.totalTokens || this.promptTokens + this.completionTokens, preview };
    }

    private messageStart(): string[] {
        if (this.protocol === "anthropic") {
            return [this.frame("message_start", { type: "message_start", message: { id: this.id, type: "message", role: "assistant", content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: this.promptTokens, output_tokens: 1 } } })];
        }
        return [this.openAiChunk({ role: "assistant" }, null)];
    }

    private stopFrames(): string[] {
        if (this.protocol === "anthropic") {
            const stopReason = this.sawToolCall ? "tool_use" : this.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
            return [...this.closeBlock(), this.frame("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: this.completionTokens } }), this.frame("message_stop", { type: "message_stop" })];
        }
        const finishReason = this.sawToolCall ? "tool_calls" : this.finishReason === "MAX_TOKENS" ? "length" : this.finishReason === "SAFETY" ? "content_filter" : "stop";
        return [this.openAiChunk({}, finishReason, true), "data: [DONE]\n\n"];
    }

    private thinking(piece: string): string[] {
        this.thinkingPreview = (this.thinkingPreview + piece).slice(0, 600);
        if (this.protocol === "openai") return [this.openAiChunk({ reasoning_content: piece }, null)];
        const frames: string[] = [];
        if (this.blockType !== "thinking") {
            frames.push(...this.closeBlock());
            frames.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "" } }));
            this.blockType = "thinking";
        }
        frames.push(this.blockDelta({ type: "thinking_delta", thinking: piece }));
        return frames;
    }

    private text(piece: string): string[] {
        this.contentPreview = (this.contentPreview + piece).slice(0, 600);
        if (this.protocol === "openai") return [this.openAiChunk({ content: piece }, null)];
        const frames: string[] = [];
        if (this.blockType !== "text") {
            frames.push(...this.closeBlock());
            frames.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } }));
            this.blockType = "text";
        }
        frames.push(this.blockDelta({ type: "text_delta", text: piece }));
        return frames;
    }

    private functionCall(name: string, args: Record<string, unknown>, signature: string): string[] {
        this.sawToolCall = true;
        this.toolPreview = this.toolPreview ? `${this.toolPreview}, ${name}` : name;
        if (this.protocol === "openai") {
            const index = this.openAiToolIndex++;
            return [this.openAiChunk({ tool_calls: [{ index, id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null)];
        }
        const frames: string[] = [];
        if (this.blockType) frames.push(...this.closeBlock());
        // Gemini 把签名直接挂在 functionCall 分片上，而 Anthropic 客户端只认思考块上的签名：
        // 追加一个自闭合思考块承载，保证下一轮历史能把它回传给上游。
        else if (signature) frames.push(...this.syntheticSignatureBlock(signature));
        frames.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`, name, input: {} } }));
        frames.push(this.blockDelta({ type: "input_json_delta", partial_json: JSON.stringify(args) }));
        frames.push(this.frame("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
        this.blockIndex += 1;
        return frames;
    }

    private closeBlock(): string[] {
        if (!this.blockType) return [];
        const frames: string[] = [];
        if (this.blockType === "thinking" && this.pendingSignature) {
            this.emittedSignatures.push(this.pendingSignature);
            frames.push(this.blockDelta({ type: "signature_delta", signature: this.pendingSignature }));
        }
        frames.push(this.frame("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
        this.blockIndex += 1;
        this.blockType = "";
        this.pendingSignature = "";
        return frames;
    }

    private syntheticSignatureBlock(signature: string): string[] {
        this.emittedSignatures.push(signature);
        const index = this.blockIndex;
        this.blockIndex += 1;
        return [
            this.frame("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
            this.at(index, { type: "thinking_delta", thinking: "" }),
            this.at(index, { type: "signature_delta", signature }),
            this.frame("content_block_stop", { type: "content_block_stop", index }),
        ];
    }

    private frame(event: string, data: Record<string, unknown>) {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    private blockDelta(delta: Record<string, unknown>) {
        return this.frame("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta });
    }

    private at(index: number, delta: Record<string, unknown>) {
        return this.frame("content_block_delta", { type: "content_block_delta", index, delta });
    }

    private openAiChunk(delta: Record<string, unknown>, finishReason: string | null, withUsage = false) {
        const chunk = { id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(withUsage ? { usage: { prompt_tokens: this.promptTokens, completion_tokens: this.completionTokens, total_tokens: this.totalTokens || this.promptTokens + this.completionTokens } } : {}) };
        return `data: ${JSON.stringify(chunk)}\n\n`;
    }
}

function relayProtocolStream(options: { upstream: Response; session?: string; translator: NativeStreamTranslator; onSettled: (settlement: StreamSettlement) => Promise<void> }) {
    const encoder = new TextEncoder();
    const { upstream, translator } = options;
    let settled = false;
    const settle = (settlement: StreamSettlement) => {
        if (settled) return undefined;
        settled = true;
        return options.onSettled(settlement);
    };
    return new Response(
        new ReadableStream<Uint8Array>({
            async start(controller) {
                let closed = false;
                const send = (frames: string[]) => {
                    if (closed) return;
                    try {
                        for (const frame of frames) controller.enqueue(encoder.encode(frame));
                    } catch {
                        closed = true;
                    }
                };
                // SSE 注释心跳：让 Agent CLI 与中间代理在首包前/思考间隙不因无字节而判死连接。
                // 立即下发首个 ping：实测传输层在出现首批业务字节前不会透出周期心跳，
                // 先发一帧把响应头与流通道激活，思考期的周期心跳才能正常到达下游。
                send([": ping\n\n"]);
                const heartbeat = setInterval(() => send([": ping\n\n"]), 3_000);
                let error = "";
                try {
                    await readUpstreamSseData(upstream, (data) => {
                        if (data === "[DONE]") return "stop";
                        const parsed = safeJson(data);
                        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "continue";
                        send(translator.translate(record(parsed)));
                        for (const signature of translator.takeSignatures()) rememberSessionSignature(options.session || "", signature);
                        return "continue";
                    });
                    send(translator.finish());
                } catch (cause) {
                    error = cause instanceof Error ? cause.message : String(cause);
                    send(translator.abort(`Google 上游流式响应中断: ${error}`));
                } finally {
                    clearInterval(heartbeat);
                    if (!closed) {
                        closed = true;
                        controller.close();
                    }
                    await settle(translator.settlement(error));
                }
            },
            cancel() {
                upstream.body?.cancel().catch(() => undefined);
            },
        }),
        {
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                "x-accel-buffering": "no",
            },
        },
    );
}

function catalogFromAccounts(accounts: Awaited<ReturnType<typeof listGeminiToolsAccounts>>) {
    const models = new Map<string, { id: string; name: string }>();
    for (const account of accounts.filter((item) => item.status === "active" && item.proxyEnabled)) {
        for (const quota of account.quotas) models.set(normalizeModelId(quota.model), { id: quota.model, name: quota.displayName || quota.model });
    }
    return Array.from(models.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function geminiToolsChannel(settings: AuthSettings) {
    return settings.systemChannels.find((item) => item.advancedConfig?.protocol === GEMINI_TOOLS_PROTOCOL);
}

function overviewModels(catalog: Array<{ id: string; name: string }>, channel: SystemModelChannel | undefined) {
    const selected = new Map((channel?.models || []).map((model) => [normalizeModelId(model), model]));
    const available = catalog.map((model) => ({ ...model, enabled: selected.has(normalizeModelId(model.id)), available: true }));
    const unavailable = Array.from(selected.entries())
        .filter(([id]) => !catalog.some((model) => normalizeModelId(model.id) === id))
        .map(([, id]) => ({ id, name: id, enabled: true, available: false }));
    return [...available, ...unavailable];
}

function usageFromNative(native: Record<string, unknown>) {
    const usage = record(native.usageMetadata);
    const promptTokens = positiveNumber(usage.promptTokenCount, 0);
    const completionTokens = positiveNumber(usage.candidatesTokenCount, 0);
    return { promptTokens, completionTokens, totalTokens: positiveNumber(usage.totalTokenCount, promptTokens + completionTokens) };
}

function textFromNative(native: Record<string, unknown>) {
    const candidates = Array.isArray(native.candidates) ? native.candidates : [];
    const content = record(record(candidates[0]).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts
        .map((part) => record(part))
        .filter((part) => part.thought !== true)
        .map((part) => text(part.text, 1_000_000))
        .join("");
}

function reasoningFromNative(native: Record<string, unknown>) {
    const candidates = Array.isArray(native.candidates) ? native.candidates : [];
    const content = record(record(candidates[0]).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts
        .map((part) => record(part))
        .filter((part) => part.thought === true)
        .map((part) => text(part.text, 1_000_000))
        .join("");
}

// Agent CLI 用 count_tokens 做上下文预算；网关本地按 CJK/ASCII 加权估算即可，无需上游调用。
function estimateMessageTokens(body: Record<string, unknown> | null) {
    if (!body) return 0;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const chars = [typeof body.system === "string" ? body.system : "", ...messages.map((item) => messageText(record(item).content))].join("\n");
    const cjk = (chars.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.max(1, Math.round(cjk * 0.7 + (chars.length - cjk) / 4));
}

function messageText(value: unknown) {
    return typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value
                .map((item) => text(record(item).text, 100_000))
                .filter(Boolean)
                .join("\n")
          : "";
}

function previewRequest(body: Record<string, unknown> | null) {
    if (!body) return "";
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages
        .map((item) => messageText(record(item).content))
        .filter(Boolean)
        .join("\n");
}

function normalizeRuntimePath(value: string) {
    const path = value.split("?")[0].replace(/\/+$/, "") || "/";
    if (path === "/chat/completions") return "/v1/chat/completions";
    if (path === "/messages") return "/v1/messages";
    if (path === "/messages/count_tokens") return "/v1/messages/count_tokens";
    if (path === "/models") return "/v1/models";
    return ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens"].includes(path) ? path : "";
}

function protocolFromPath(path: string): "openai" | "anthropic" {
    return path === "/v1/messages" ? "anthropic" : "openai";
}

function streamingRequested(body: Record<string, unknown> | null) {
    return body?.stream === true;
}

function stickyAccounts(accounts: GeminiToolsPrivateAccount[], key: string) {
    if (!key || accounts.length < 2) return accounts;
    const offset = createHash("sha256").update(key).digest().readUInt32BE(0) % accounts.length;
    return [...accounts.slice(offset), ...accounts.slice(0, offset)];
}

// 会话级 thoughtSignature 缓存：Gemini 多轮 function calling 要求回传签名，但部分 Agent 客户端
// 不回传 thinking 块；网关按会话记住最近下发的签名，在客户端未携带时自动补注到 functionCall。
const sessionSignatureCache = new Map<string, string>();
const SESSION_SIGNATURE_CACHE_LIMIT = 512;
function rememberSessionSignature(session: string, signature: string) {
    if (!session || !signature) return;
    if (sessionSignatureCache.size >= SESSION_SIGNATURE_CACHE_LIMIT && !sessionSignatureCache.has(session)) {
        const oldest = sessionSignatureCache.keys().next().value;
        if (oldest !== undefined) sessionSignatureCache.delete(oldest);
    }
    sessionSignatureCache.set(session, signature);
}
function cachedSessionSignature(session: string) {
    return sessionSignatureCache.get(session) || "";
}

function sessionKey(init: RequestInit, body: Record<string, unknown> | null, keyPrefix = "") {
    return new Headers(init.headers).get("x-session-id")?.trim().slice(0, 200) || text(body?.user, 200) || keyPrefix;
}

function antigravityUserAgent() {
    const system = platform() === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform() === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
    return `Antigravity/4.3.0 (${system}) Chrome/132.0.6834.160 Electron/39.2.3`;
}

async function requestJson(body: BodyInit | null | undefined) {
    if (!body) return null;
    try {
        if (typeof body === "string") return record(JSON.parse(body));
        if (body instanceof ArrayBuffer) return record(JSON.parse(new TextDecoder().decode(body)));
        if (ArrayBuffer.isView(body)) return record(JSON.parse(new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))));
    } catch {
        return null;
    }
    return null;
}

function localOAuthOrigin(origin: string) {
    try {
        const parsed = new URL(origin);
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return parsed.origin;
        if (["0.0.0.0", "::"].includes(hostname)) return `http://localhost${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
        return "";
    }
    return "";
}

function webOrigin(value: string) {
    try {
        const parsed = new URL(value.trim());
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
        return parsed.origin;
    } catch {
        return "";
    }
}

function extractClientIp(headers?: HeadersInit): string | undefined {
    if (!headers) return undefined;
    const h = new Headers(headers);
    return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
}

function extractUserAgent(headers?: HeadersInit): string | undefined {
    if (!headers) return undefined;
    const h = new Headers(headers);
    return h.get("user-agent") || undefined;
}

function sanitizeLogHeaders(headers?: HeadersInit): Record<string, string> | undefined {
    if (!headers) return undefined;
    const h = new Headers(headers);
    const result: Record<string, string> = {};
    const safeKeys = ["content-type", "accept", "user-agent", "x-session-id", "origin", "referer"];
    for (const key of safeKeys) {
        const val = h.get(key);
        if (val) result[key] = val;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function defaultChannel(): SystemModelChannel {
    return { id: GEMINI_TOOLS_CHANNEL_ID, name: GEMINI_TOOLS_CHANNEL_NAME, baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: true };
}

function publicChannel(channel: SystemModelChannel) {
    return { id: channel.id, name: channel.name, enabled: channel.enabled, models: [...channel.models] };
}

function subscriptionTier(payload: Record<string, unknown>) {
    for (const field of ["paidTier", "currentTier"]) {
        const value = record(payload[field]);
        const tier = text(value.name ?? value.id, 200);
        if (tier) return tier;
    }
    return undefined;
}

function uniqueStrings(value: unknown, limit: number) {
    return Array.from(
        new Set(
            (Array.isArray(value) ? value : [])
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean),
        ),
    ).slice(0, limit);
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return { error: { message: value.slice(0, 500) } };
    }
}

function safeGoogleError(value: unknown) {
    const root = record(value);
    const error = record(root.error);
    const code = text(typeof root.error === "string" ? root.error : (error.code ?? error.status), 100);
    const desc = text(error.message ?? root.error_description ?? root.message, 500);
    if (code && desc && code !== desc) return `${code}: ${desc}`;
    return desc || code || text(root.error, 500);
}

function isDefiniteGoogleAuthFailure(error: GeminiToolsError) {
    return [401, 403].includes(error.status) || (error.status === 400 && /invalid_grant|invalid_client|unauthorized_client|token.*expired|revoked/i.test(error.message.trim()));
}

function errorMessage(value: unknown) {
    const root = record(value);
    return text(record(root.error).message ?? root.error, 500);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function positiveNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function optionalNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function sameModel(left: string, right: string) {
    return normalizeModelId(left) === normalizeModelId(right);
}
