import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";

import { getAuthSettings, setAuthSettings, type AuthSettings, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { normalizeModelId } from "@/lib/model-capability";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { ensureMagicProxyProvider, type MagicProxyEgressInfo } from "@/lib/server/magic-proxy-service";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import {
    appendGeminiToolsRequestLog,
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
    type GeminiToolsPrivateAccount,
    type GeminiToolsQuota,
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
const MACHINE_ID = createHash("sha256").update(`${hostname()}|${platform()}|octalflow`).digest("hex");
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
    const openerOrigin = webOrigin(request.headers.get("x-octalflow-browser-origin") || "") || resolvePublicRequestOrigin(request, "");
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

export async function geminiToolsRuntimeRequest(path: string, init: RequestInit, context: { protocol?: "openai" | "gemini" | "anthropic" | "admin-test"; keyPrefix?: string } = {}) {
    return withGeminiToolsMagicProxy(() => geminiToolsRuntimeRequestInternal(path, init, context));
}

async function geminiToolsRuntimeRequestInternal(path: string, init: RequestInit, context: { protocol?: "openai" | "gemini" | "anthropic" | "admin-test"; keyPrefix?: string } = {}) {
    const startedAt = Date.now();
    const normalizedPath = normalizeRuntimePath(path);
    if (!normalizedPath) return Response.json({ error: { message: "GeminiTools 不支持该接口" } }, { status: 404 });
    const gateway = await getGeminiToolsGatewaySettings();
    if (!gateway.enabled) return Response.json({ error: { message: "GeminiTools 网关已停用" } }, { status: 503 });

    if (normalizedPath === "/v1/models" && (init.method || "GET").toUpperCase() === "GET") {
        const data = catalogFromAccounts(await listGeminiToolsAccounts()).map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "google-antigravity" }));
        return Response.json({ object: "list", data });
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
    if (openLogId) await markGeminiToolsRequestLogRunning(openLogId).catch(() => undefined);
    const egressNow = () => geminiToolsProxyEgress().catch(() => undefined);
    const availableModels = new Set(catalogFromAccounts(await listGeminiToolsAccounts()).map((item) => normalizeModelId(item.id)));
    if (!availableModels.has(normalizeModelId(model))) return Response.json({ error: { message: "模型不在当前 Google 账号额度目录中" } }, { status: 404 });

    const candidates = await listGeminiToolsCandidateAccounts();
    const modelAccounts = candidates.filter((account) => account.quotas.some((quota) => normalizeModelId(quota.model) === normalizeModelId(model)));
    const withQuota = modelAccounts.filter((account) => account.quotas.some((quota) => normalizeModelId(quota.model) === normalizeModelId(model) && (quota.remainingPercent === undefined || quota.remainingPercent > 0)));
    const accounts = stickyAccounts(withQuota.length ? withQuota : modelAccounts, gateway.sessionStickiness ? sessionKey(init, body, context.keyPrefix) : "");
    if (!accounts.length) return Response.json({ error: { message: "没有可用于反代的 Google 账号" } }, { status: 503 });
    let lastError: GeminiToolsError | null = null;
    let failedAccount: Pick<GeminiToolsPrivateAccount, "id" | "email"> | null = null;
    for (const account of accounts) {
        try {
            const token = await validAccessToken(account);
            const project = account.projectId ? { projectId: account.projectId, planType: account.planType } : await loadCodeAssist(token.accessToken);
            if (!account.projectId) await updateGeminiToolsAccountCredentials(account.id, { ...token, projectId: project.projectId, planType: project.planType });
            const nativePayload = protocolRequest(protocol, body || {});
            const native = await cloudCodeGenerate(token.accessToken, project.projectId, model, nativePayload);
            const formatted = protocolResponse(protocol, native, model);
            const usage = usageFromNative(native);
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
                        durationMs: Date.now() - startedAt,
                        promptTokens: usage.promptTokens,
                        completionTokens: usage.completionTokens,
                        totalTokens: usage.totalTokens,
                        keyPrefix: context.keyPrefix,
                        requestPreview: previewRequest(body),
                        responsePreview: textFromNative(native).slice(0, 500),
                        proxyEgress: (await egressNow()) || undefined,
                        ...(clientIp ? { clientIp } : {}),
                        ...(userAgent ? { userAgent } : {}),
                        ...(headers ? { headers } : {}),
                    } as const;
                    if (openLogId) return settleGeminiToolsRequestLog(openLogId, settlePayload).catch(() => undefined);
                    return appendGeminiToolsRequestLog(settlePayload);
                })(),
            ]);
            return streamingRequested(body) && protocol === "openai" ? openAiSseResponse(formatted as OpenAiResponse, usage.totalTokens) : Response.json(formatted, { headers: { "x-gemini-tools-total-tokens": String(usage.totalTokens) } });
        } catch (error) {
            lastError = error instanceof GeminiToolsError ? error : new GeminiToolsError(error instanceof Error ? error.message : "Google 上游请求失败");
            failedAccount = { id: account.id, email: account.email };
            await recordGeminiToolsAccountUsage(account.id, 0, true);
            if (isDefiniteGoogleAuthFailure(lastError)) await updateGeminiToolsAccount(account.id, { status: "invalid" });
            // Do not replay a generation after an ambiguous upstream or
            // transport failure. Authentication and quota rejections are
            // definite non-executions, so only those may advance an account.
            if (!isDefiniteGoogleAuthFailure(lastError) && lastError.status !== 429) break;
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
            proxyEgress: (await egressNow()) || undefined,
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
            proxyEgress: (await egressNow()) || undefined,
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

async function cloudCodeGenerate(accessToken: string, projectId: string, model: string, payload: Record<string, unknown>) {
    let last: GeminiToolsError | null = null;
    for (const base of CLOUD_CODE_ENDPOINTS) {
        try {
            let result: Record<string, unknown>;
            try {
                result = await cloudCodeJson(`${base}:generateContent`, accessToken, { project: projectId, request: payload, model }, projectId);
            } catch (error) {
                if (!(error instanceof GeminiToolsError) || error.status !== 403) throw error;
                result = await cloudCodeJson(`${base}:generateContent`, accessToken, { project: projectId, request: payload, model });
            }
            const response = record(result.response);
            return Object.keys(response).length ? response : result;
        } catch (error) {
            last = error instanceof GeminiToolsError ? error : new GeminiToolsError("Google 模型调用失败");
            // A generation transport failure can be ambiguous: Google may have
            // accepted it before the connection failed. Only a definite 404 is
            // safe to try against the next documented Cloud Code endpoint.
            if (last.status !== 404) throw last;
        }
    }
    throw last || new GeminiToolsError("Google 模型调用失败");
}

async function cloudCodeJson(url: string, accessToken: string, body: unknown, projectId = "") {
    return googleJson<Record<string, unknown>>(
        url,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
                "user-agent": antigravityUserAgent(),
                "x-client-name": "antigravity",
                "x-client-version": "4.3.0",
                "x-machine-id": MACHINE_ID,
                "x-vscode-sessionid": SESSION_ID,
                ...(projectId ? { "x-goog-user-project": projectId } : {}),
            },
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
        response = await fetchSafeOutbound(url, { ...init, cache: "no-store", redirect: "error" }, { allowProxyFakeIpSpace: true, ...(proxyUrl ? { proxyUrl } : {}) });
    } catch (error) {
        throw new GeminiToolsError(error instanceof Error && error.name === "TimeoutError" ? `${fallbackMessage}：请求超时` : fallbackMessage, error instanceof Error && error.name === "TimeoutError" ? 504 : 502);
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

function protocolRequest(protocol: "openai" | "gemini" | "anthropic" | "admin-test", body: Record<string, unknown>) {
    if (protocol === "gemini") return record(body);
    const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const system = protocol === "anthropic" ? body.system : undefined;
    if (typeof system === "string" && system.trim()) systemInstruction = { parts: [{ text: system }] };
    for (const raw of messages) {
        const message = record(raw);
        if (message.role === "system") {
            const value = messageText(message.content);
            if (value) systemInstruction = { parts: [{ text: value }] };
            continue;
        }
        const parts = messageParts(message.content);
        if (parts.length) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
    }
    if (!contents.length && typeof body.input === "string") contents.push({ role: "user", parts: [{ text: body.input }] });
    const generationConfig: Record<string, unknown> = {};
    if (optionalNumber(body.temperature) !== undefined) generationConfig.temperature = optionalNumber(body.temperature);
    if (optionalNumber(body.top_p) !== undefined) generationConfig.topP = optionalNumber(body.top_p);
    const maxTokens = optionalNumber(body.max_completion_tokens) ?? optionalNumber(body.max_tokens);
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    return { contents, ...(systemInstruction ? { systemInstruction } : {}), ...(Object.keys(generationConfig).length ? { generationConfig } : {}) };
}

type OpenAiResponse = {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{ index: number; message: { role: "assistant"; content: string; reasoning_content?: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

function protocolResponse(protocol: "openai" | "gemini" | "anthropic" | "admin-test", native: Record<string, unknown>, model: string) {
    if (protocol === "gemini") return native;
    const content = textFromNative(native);
    const reasoning = reasoningFromNative(native);
    const usage = usageFromNative(native);
    if (protocol === "anthropic") {
        return { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "text", text: content }], stop_reason: "end_turn", usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens } };
    }
    return {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: "stop" }],
        usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens },
    } satisfies OpenAiResponse;
}

function openAiSseResponse(payload: OpenAiResponse, totalTokens: number) {
    const message = payload.choices[0]?.message;
    const chunk = {
        id: payload.id,
        object: "chat.completion.chunk",
        created: payload.created,
        model: payload.model,
        choices: [{ index: 0, delta: { role: "assistant", content: message?.content || "", ...(message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }, finish_reason: null }],
    };
    const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: payload.usage };
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-gemini-tools-total-tokens": String(totalTokens) } },
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

function messageParts(value: unknown): Array<Record<string, unknown>> {
    if (typeof value === "string") return value.trim() ? [{ text: value }] : [];
    if (!Array.isArray(value)) return [];
    const parts: Array<Record<string, unknown>> = [];
    for (const raw of value) {
        const part = record(raw);
        if (part.type === "text" && text(part.text, 100_000)) {
            parts.push({ text: text(part.text, 100_000) });
            continue;
        }
        const image = record(part.image_url);
        const dataUrl = text(image.url, 20_000_000);
        const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    return parts;
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
        .join("\n")
        .slice(0, 500);
}

function normalizeRuntimePath(value: string) {
    const path = value.split("?")[0].replace(/\/+$/, "") || "/";
    if (path === "/chat/completions") return "/v1/chat/completions";
    if (path === "/messages") return "/v1/messages";
    if (path === "/models") return "/v1/models";
    return ["/v1/models", "/v1/chat/completions", "/v1/messages"].includes(path) ? path : "";
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
    return text(error.message ?? root.error_description ?? root.message ?? root.error, 500);
}

function isDefiniteGoogleAuthFailure(error: GeminiToolsError) {
    return [401, 403].includes(error.status) || (error.status === 400 && /^(invalid_grant|invalid_client|unauthorized_client)$/i.test(error.message.trim()));
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
