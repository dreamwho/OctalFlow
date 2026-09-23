import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { consumeUserPoints, getAuthSettings, isAdminUserId, isAuthInputError, isQuotaExceededError, refundUserPoints, type ApiCallFormat, type GenerationPointMultipliers, type PointUsageKind } from "@/lib/auth/store";
import { getCurrentUser } from "@/lib/auth/session";
import { roleModelAccessAllows } from "@/lib/user-roles";
import { DEFAULT_CHANNEL_CONNECT_ERROR } from "@/lib/server/generation-errors";
import { UnsupportedMediaContentError } from "@/lib/server/media-content-validation";
import { acquireMediaConcurrency, withMediaConcurrency } from "@/lib/server/media-concurrency";
import { MediaProxyResponseError, fetchSafeUpstreamMedia } from "@/lib/server/media-proxy-service";
import { MAX_MEDIA_PROXY_BYTES, MAX_MEDIA_PROXY_RANGE_BYTES, normalizeMediaProxyRange } from "@/lib/server/media-response-limit";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { checkMediaProxyRateLimit, isSafeOutboundUrl, rateLimitHeaders } from "@/lib/server/security";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";
import { resolveGlobalAiOpcPathPreset, resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { adaptGlobalAiOpcTextRequest, adaptGlobalAiOpcTextResponse, isGlobalAiOpcChannel } from "@/lib/server/globalaiopc-proxy";
import { readVerifiedSystemAiBusinessRequestId, SYSTEM_AI_LOGICAL_MODEL_HEADER, SYSTEM_AI_UPSTREAM_MODEL_HEADER, systemAiPointsIdempotencyKey, systemAiRequestFingerprint } from "@/lib/server/system-ai-billing";
import { isAgnesApiBaseUrl } from "@/lib/agnes-model-catalog";
import { channelConnectionReady, protocolAuthHeaders, resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { normalizeYumengModelCenterBaseUrl } from "@/lib/yumeng-model-center";
import { authorizedWorkerUserId } from "@/lib/server/maintenance-auth";
import { authorizeGenerationMediaProxyRequest } from "@/lib/server/generation-media-access";
import { userOwnsGenerationUpstreamTask } from "@/lib/server/generation-task-authorization";
import { authorizeSystemAiProxyRequest } from "@/lib/server/system-ai-proxy-policy";
import { chatGptErrorMessage, chatGptRuntimeRequest, getChatGptRuntimeConfig, resolveChatGptReferences, rewriteChatGptMedia, rewriteChatGptStream, syncChatGptMagicProxy } from "@/lib/server/chatgpt-api-service";
import { CHATGPT_API_PROTOCOL, normalizeChatGptApiRuntimePath } from "@/lib/server/chatgpt-api-models";
import { GEMINIAI_PROTOCOL, geminiAiProviderConfigured, geminiAiRuntimeRequest, isGeminiAiRuntimePath } from "@/lib/server/geminiai-provider";
import { GEMINI_TOOLS_PROTOCOL, geminiToolsOAuthConfigured, geminiToolsRuntimeRequest, isGeminiToolsRuntimePath } from "@/lib/server/gemini-tools-service";
import { DOLA_CHANNEL_ID, DOLA_PROTOCOL, dolaProviderConfigured, dolaRuntimeRequest, isDolaRuntimePath } from "@/lib/server/dola/provider";
import { getDolaAccount, getDolaAccountCookie, markDolaAccountQuotaExhausted, markDolaAccountRateLimited, markDolaAccountUsed, releaseDolaAccountAttempt, reserveDolaAccount, setDolaAccountStatus } from "@/lib/server/dola/account-service";
import { describeDolaFailure, isDolaQuotaExhaustedError, isDolaRateLimitError } from "@/lib/dola-errors";
import { getDolaGatewaySettings } from "@/lib/server/dola/gateway-store";
import { advanceDolaTaskLog, dolaTaskLogPhase, findDolaTaskLogIdByTaskId, openDolaRequestLog, markDolaRequestLogRunning, settleDolaRequestLog, type DolaRequestLifecycleEntry, type DolaRequestLogPhase } from "@/lib/server/dola/log-store";
import { dolaProviderProxyMode, resolveDolaProxyEgress } from "@/lib/server/dola/proxy";
import { appendGenerationLogProtocolTrace } from "@/lib/server/generation-log-task-service";
import type { GenerationLogProtocolTrace } from "@/lib/generation-log-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

configureServerProxyDispatcher();

type RouteContext = {
    params: Promise<{ channelId: string; path: string[] }>;
};
type PointsRequest = { model: string; amount: number; usageKind: PointUsageKind };
type ProxyRequestBody = { body?: BodyInit; pointsPayload?: ArrayBuffer | Record<string, unknown>; bodyDigest: string };
const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_MULTIPART_BYTES = 25 * 1024 * 1024;
const SYSTEM_MEDIA_TIMEOUT_MS = 30 * 1000;
const MAX_SYSTEM_MEDIA_REDIRECTS = 4;

export async function GET(request: Request, context: RouteContext) {
    return proxySystemRequest(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
    return proxySystemRequest(request, context);
}

export async function POST(request: Request, context: RouteContext) {
    return proxySystemRequest(request, context);
}

export async function PUT(request: Request, context: RouteContext) {
    return proxySystemRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
    return proxySystemRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
    return proxySystemRequest(request, context);
}

async function proxySystemRequest(request: Request, context: RouteContext) {
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id || authorizedWorkerUserId(request);
    if (!userId) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { channelId, path } = await context.params;
    const settings = await getAuthSettings();
    const channel = settings.systemChannels.find((item) => item.id === channelId && item.enabled);
    if (!channel || !channelConnectionReady(channel)) return NextResponse.json({ error: "默认接口未配置或已停用" }, { status: 404 });
    if (channel.advancedConfig?.protocol === "dreamina-cli") return NextResponse.json({ error: "即梦 CLI 仅可通过已持久化的图片或视频生成任务执行" }, { status: 404 });
    const isChatGptApiChannel = channel.advancedConfig?.protocol === CHATGPT_API_PROTOCOL;
    const chatGptCatalogPath = normalizeChatGptApiRuntimePath(`/${path.join("/")}${new URL(request.url).search}`);
    if (isChatGptApiChannel && request.method === "GET" && chatGptCatalogPath === "/v1/models") return proxyChatGptApiCatalogRequest(request, chatGptCatalogPath);

    if (isMediaProxyPath(path)) {
        const rate = await checkMediaProxyRateLimit(userId, request);
        if (!rate.allowed) return NextResponse.json({ error: "媒体访问过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
        return proxySystemMediaRequest(request, channel, userId);
    }

    const contentType = request.headers.get("content-type");
    const isMultipart = Boolean(contentType?.toLowerCase().includes("multipart/form-data"));
    const accept = request.headers.get("accept");

    let requestBody: ProxyRequestBody;
    try {
        requestBody = await readProxyRequestBody(request, isMultipart);
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
    const upstreamModel = readRequestModel(readRequestBody(contentType, requestBody.pointsPayload)) || request.headers.get(SYSTEM_AI_UPSTREAM_MODEL_HEADER)?.trim() || readPathModel(path);
    const modelConfig = upstreamModel ? resolveChannelModelConfig(channel.advancedConfig, upstreamModel) : undefined;
    const apiFormat = modelConfig?.apiFormat || channel.apiFormat;
    const globalChannel = isGlobalAiOpcChannel(channel.advancedConfig);
    const globalPreset = resolveGlobalAiOpcPreset(channel.advancedConfig, upstreamModel) || resolveGlobalAiOpcPathPreset(channel.advancedConfig, path);
    const globalAdaptation = adaptGlobalAiOpcTextRequest(channel.advancedConfig, path, requestBody.body);
    if (globalAdaptation === "responses-unsupported") return NextResponse.json({ error: "该 GlobalAiOpc 原生文本接口不支持 Responses，已切换 Chat 兼容回退。" }, { status: 404 });
    const pointsRequest =
        classifyPointsRequest(request.method, apiFormat, path, contentType, requestBody.pointsPayload, settings.generationPointMultipliers) ||
        classifyConfiguredPointsRequest(
            request.method,
            path,
            contentType,
            requestBody.pointsPayload,
            channel.id,
            [globalPreset?.createPath, modelConfig?.createPath, modelConfig?.editPath, modelConfig?.imageToVideoPath, channel.advancedConfig?.createPath, channel.advancedConfig?.editPath, channel.advancedConfig?.imageToVideoPath],
            upstreamModel,
            settings.logicalModels,
            settings.generationPointMultipliers,
        );
    if (pointsRequest?.model && !channelHasModel(channel.models, pointsRequest.model)) return NextResponse.json({ error: "该模型未在后台渠道中启用" }, { status: 403 });
    const access = authorizeSystemAiProxyRequest({
        method: request.method,
        path: globalAdaptation?.path || path,
        search: new URL(request.url).search,
        channelId: channel.id,
        upstreamModel,
        preferredLogicalModelId: request.headers.get(SYSTEM_AI_LOGICAL_MODEL_HEADER) || "",
        logicalModels: settings.logicalModels || [],
        apiFormat: globalPreset?.apiFormat || apiFormat,
        pointsUsageKind: pointsRequest?.usageKind,
        upstreamTaskIdHint: readRequestTaskId(readRequestBody(contentType, requestBody.pointsPayload)),
        paths: {
            create: [globalPreset?.createPath, modelConfig?.createPath, modelConfig?.editPath, modelConfig?.imageToVideoPath, channel.advancedConfig?.createPath, channel.advancedConfig?.editPath, channel.advancedConfig?.imageToVideoPath],
            query: [globalPreset?.queryPath, modelConfig?.queryPath, channel.advancedConfig?.queryPath],
            cancel: [
                { path: modelConfig?.cancelPath, method: modelConfig?.cancelMethod },
                { path: channel.advancedConfig?.cancelPath, method: channel.advancedConfig?.cancelMethod },
            ],
        },
    });
    if (!access.allowed) return NextResponse.json({ error: access.error }, { status: access.status });
    const role = currentUser?.role || ((await isAdminUserId(userId)) ? "admin" : "user");
    if (access.operation === "create" && !roleModelAccessAllows(settings.userRoles, role, access.logicalModelId || upstreamModel, access.capability)) return NextResponse.json({ error: "当前用户角色无权使用该模型" }, { status: 403 });
    if (access.operation !== "create") {
        const owned = await userOwnsGenerationUpstreamTask({ userId, capability: access.capability, channelId: channel.id, upstreamModel, upstreamTaskId: access.upstreamTaskId });
        if (!owned) return NextResponse.json({ error: "任务不存在或无权访问" }, { status: 404 });
    }

    const isGeminiAiChannel = channel.advancedConfig?.protocol === GEMINIAI_PROTOCOL;
    const isGeminiToolsChannel = channel.advancedConfig?.protocol === GEMINI_TOOLS_PROTOCOL;
    const isDolaChannel = channel.id === DOLA_CHANNEL_ID || channel.advancedConfig?.protocol === DOLA_PROTOCOL;
    const routedPath = globalAdaptation?.path || path;
    const requestSearch = new URL(request.url).search;
    const geminiAiPath = `/${routedPath.join("/")}${requestSearch}`;
    if (isGeminiAiChannel && !geminiAiProviderConfigured()) return NextResponse.json({ error: "GeminiAI 服务尚未配置或不可用" }, { status: 503 });
    if (isGeminiAiChannel && !isGeminiAiRuntimePath(geminiAiPath)) return NextResponse.json({ error: "GeminiAI 不支持该运行时接口" }, { status: 404 });
    if (isGeminiToolsChannel && !geminiToolsOAuthConfigured()) return NextResponse.json({ error: "GeminiTools OAuth 尚未配置" }, { status: 503 });
    if (isGeminiToolsChannel && !isGeminiToolsRuntimePath(geminiAiPath)) return NextResponse.json({ error: "GeminiTools 不支持该运行时接口" }, { status: 404 });
    if (isDolaChannel && !dolaProviderConfigured()) return NextResponse.json({ error: "Dola Camoufox Provider 尚未配置" }, { status: 503 });
    if (isDolaChannel && !isDolaRuntimePath(geminiAiPath)) return NextResponse.json({ error: "Dola 不支持该运行时接口" }, { status: 404 });
    const chatGptApiPath = normalizeChatGptApiRuntimePath(geminiAiPath);
    if (isChatGptApiChannel) {
        try {
            getChatGptRuntimeConfig();
        } catch (error) {
            return chatGptApiRuntimeErrorResponse(error);
        }
        if (!chatGptApiPath) return NextResponse.json({ error: "GPTAPI 不支持该运行时接口" }, { status: 404 });
    }
    const providerManaged = isGeminiAiChannel || isGeminiToolsChannel || isChatGptApiChannel || isDolaChannel;
    const target = providerManaged ? "" : targetUrl(globalPreset?.baseUrl || channel.baseUrl, globalPreset?.apiFormat || apiFormat, routedPath, requestSearch, globalChannel, modelConfig?.protocol || channel.advancedConfig?.protocol);
    if (!providerManaged && !(await isSafeOutboundUrl(target, { allowCredentials: false, allowProxyFakeIpSpace: true }))) return NextResponse.json({ error: "接口地址不允许访问内网或保留地址" }, { status: 400 });
    const headers = new Headers();
    if (contentType && !isMultipart) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim().slice(0, 200);
    const clientRequestId = request.headers.get("x-client-request-id")?.trim().slice(0, 200);
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    if (clientRequestId) headers.set("x-client-request-id", clientRequestId);
    const authConfig = modelConfig?.protocol ? { ...channel.advancedConfig, protocol: modelConfig.protocol } : channel.advancedConfig;
    Object.entries(protocolAuthHeaders(channel.apiKey, authConfig, globalChannel ? "openai" : apiFormat)).forEach(([key, value]) => headers.set(key, value));
    const callType = `${access.capability}:${access.operation}:/${(globalAdaptation?.path || path).join("/")}`;
    const businessRequestId = readVerifiedSystemAiBusinessRequestId(request.headers, access.logicalModelId, upstreamModel) || `direct:${randomUUID()}`;
    const pointsIdempotencyKey = pointsRequest ? systemAiPointsIdempotencyKey({ userId, businessRequestId, logicalModel: access.logicalModelId, channelId: channel.id, upstreamModel, callType }) : undefined;
    const requestFingerprint = pointsRequest
        ? systemAiRequestFingerprint({
              method: request.method,
              callType,
              logicalModel: access.logicalModelId,
              channelId: channel.id,
              upstreamModel,
              usageKind: pointsRequest.usageKind,
              amount: pointsRequest.amount,
              bodyDigest: requestBody.bodyDigest,
          })
        : undefined;
    let pointsResult: Awaited<ReturnType<typeof consumeUserPoints>> | null = null;
    let refundedPointsRemaining: number | null = null;
    let pointsSettled = false;
    let dolaAccountId = "";
    let dolaHold = false;
    let dolaProxyEgress: { mode: "direct" | "magic" | "generic" | "chained"; nodeName?: string; address?: string } = { mode: "direct" };
    const upstreamStartedAt = Date.now();
    let protocolRequestStartedAt = Date.now();
    const dolaLifecycle: DolaRequestLifecycleEntry[] = [{ time: new Date(upstreamStartedAt).toISOString(), phase: "queued", message: "接收到 Canvas Dola 请求", durationMs: 0, detail: `${request.method} ${geminiAiPath}, 模型: ${upstreamModel || "未声明"}` }];
    const dolaRequestParameters = isDolaChannel ? readDolaRequestParameters(requestBody.body) : {};
    const dolaPathOnly = geminiAiPath.split("?", 1)[0];
    const dolaCapability = isDolaChannel && dolaPathOnly.startsWith("/v1/images") ? ("image" as const) : ("video" as const);
    // Poll requests attach to the original create log by upstream task id instead of opening a row per poll.
    const dolaTaskQueryMatch = isDolaChannel && request.method === "GET" ? dolaPathOnly.match(/^\/v1\/(?:videos|images)\/([^/]+)$/) : null;
    // 换号重提的创建请求附带 x-dola-rotation-task（原任务 ID）：叠加写入原请求日志，而不是新开一行。
    const dolaRotationSourceTaskId = isDolaChannel && request.headers.get("x-dola-rotation-task")?.trim() || "";
    const dolaAttachedTaskLogId = (dolaTaskQueryMatch ? await safeFindDolaTaskLog(decodeURIComponent(dolaTaskQueryMatch[1])) : "") || (dolaRotationSourceTaskId ? await safeFindDolaTaskLog(dolaRotationSourceTaskId) : "");
    const dolaLogId = isDolaChannel && !dolaAttachedTaskLogId
        ? await safeOpenDolaLog({ source: "runtime", capability: dolaCapability, method: request.method, path: dolaPathOnly, model: upstreamModel || "", ...(dolaRequestParameters.requestedDuration !== undefined ? { requestedDuration: dolaRequestParameters.requestedDuration } : {}), ...(dolaRequestParameters.ratio ? { ratio: dolaRequestParameters.ratio } : {}), requestPreview: summarizeDolaSystemRequest(requestBody.body, contentType), requestBytes: bodyByteLength(requestBody.body), clientIp: request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || request.headers.get("x-real-ip") || undefined, userAgent: request.headers.get("user-agent") || undefined, headers: { accept: accept || "", "content-type": contentType || "" } }, dolaLifecycle)
        : "";
    const refundConsumedPoints = async () => {
        if (!pointsResult || pointsSettled) return;
        pointsSettled = true;
        const refundedUser = await refundUserPoints(userId, pointsResult.model, pointsResult.cost, pointsResult.usageKind, pointsResult.units, undefined, pointsResult.recordId);
        refundedPointsRemaining = typeof refundedUser?.pointsBalance === "number" ? refundedUser.pointsBalance : null;
    };
    if (pointsRequest && !(currentUser?.role === "admin" || (!currentUser && (await isAdminUserId(userId))))) {
        try {
            pointsResult = await consumeUserPoints(userId, access.logicalModelId, pointsRequest.amount, pointsRequest.usageKind, pointsIdempotencyKey, requestFingerprint);
        } catch (error) {
            if (isQuotaExceededError(error) || isAuthInputError(error)) {
                if (isDolaChannel) {
                    const errorMessage = error.message;
                    dolaLifecycle.push({ time: new Date().toISOString(), phase: "failed", message: errorMessage, durationMs: Date.now() - upstreamStartedAt });
                    await safeSettleDolaLog(dolaLogId, { statusCode: error.status, durationMs: Date.now() - upstreamStartedAt, phase: "failed", error: errorMessage, lifecycle: dolaLifecycle });
                }
                return NextResponse.json({ error: error.message }, { status: error.status });
            }
            throw error;
        }
    }
    request.signal.addEventListener("abort", () => void refundConsumedPoints(), { once: true });

    let upstream: Response;
    let dolaRuntimeBody = "";
    let protocolRuntimeBody: BodyInit | undefined;
    try {
        const upstreamBody = globalAdaptation?.body || requestBody.body;
        const runtimeBody = isChatGptApiChannel
            ? await prepareChatGptApiRuntimeBody(contentType, upstreamBody, request.signal)
            : isDolaChannel
              ? await prepareDolaRuntimeBody(contentType, upstreamBody, ["/v1/videos", "/v1/images"].includes(geminiAiPath.split("?", 1)[0]))
              : upstreamBody;
        protocolRuntimeBody = runtimeBody;
        if (isDolaChannel && typeof runtimeBody === "string") dolaRuntimeBody = runtimeBody;
        if (isDolaChannel) dolaAccountId = readDolaAccountId(runtimeBody);
        if (isDolaChannel) dolaHold = readDolaHold(runtimeBody);
        if (isDolaChannel) dolaProxyEgress = readDolaProxyEgress(runtimeBody);
        if (isDolaChannel) {
            dolaLifecycle.push({ time: new Date().toISOString(), phase: "routing", message: "Dola 账号与代理路由已准备", durationMs: Date.now() - upstreamStartedAt, detail: `账号: ${dolaAccountId || "未识别"}, 代理: ${dolaProxyEgress.mode}` });
            dolaLifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Dola Camoufox Provider 发起请求", durationMs: Date.now() - upstreamStartedAt, detail: "Cookie 和参考图已由服务端注入并脱敏" });
            await safeMarkDolaLog(dolaLogId, { phase: "upstream", message: "向 Dola Camoufox Provider 发起请求", detail: "Cookie 和参考图已由服务端注入并脱敏" });
        }
        if (isChatGptApiChannel) await syncChatGptMagicProxy();
        protocolRequestStartedAt = Date.now();
        upstream = isGeminiAiChannel
            ? await geminiAiRuntimeRequest(geminiAiPath, {
                  method: request.method,
                  headers,
                  body: runtimeBody,
                  signal: request.signal,
              })
            : isGeminiToolsChannel
              ? await geminiToolsRuntimeRequest(geminiAiPath, {
                    method: request.method,
                    headers,
                    body: runtimeBody,
                    signal: request.signal,
                })
              : isChatGptApiChannel
                ? await chatGptRuntimeRequest(chatGptApiPath, {
                      method: request.method,
                      headers: chatGptApiRuntimeHeaders(headers),
                      body: runtimeBody,
                      signal: request.signal,
                  })
                : isDolaChannel
                  ? await dolaRuntimeRequest(geminiAiPath, {
                        method: request.method,
                        headers,
                        body: runtimeBody,
                        signal: request.signal,
                    })
                : await fetchSafeOutbound(
                      target,
                      {
                          method: request.method,
                          headers,
                          body: runtimeBody,
                          cache: "no-store",
                          redirect: "manual",
                          signal: request.signal,
                      },
                      { allowProxyFakeIpSpace: true },
                  );
    } catch (error) {
        await refundConsumedPoints();
        if (isDolaChannel && dolaAccountId) await markDolaAccountUsed(dolaAccountId, false, true).catch(() => undefined);
        const errorMessage = error instanceof Error ? error.message : "Dola Provider 请求失败";
        await safeRecordSystemProtocolTrace({ request, userId, channelName: channel.name, protocol: modelConfig?.protocol || channel.advancedConfig?.protocol || (globalChannel ? "globalaiopc" : apiFormat), model: upstreamModel, path: geminiAiPath, body: protocolRuntimeBody ?? requestBody.body, requestContentType: contentType, durationMs: Date.now() - protocolRequestStartedAt, error: errorMessage });
        if (isDolaChannel) {
            dolaLifecycle.push({ time: new Date().toISOString(), phase: "failed", message: errorMessage, durationMs: Date.now() - upstreamStartedAt });
            await safeSettleDolaLog(dolaLogId, { statusCode: 502, durationMs: Date.now() - upstreamStartedAt, phase: "failed", error: errorMessage, accountId: dolaAccountId || undefined, proxyEgress: dolaProxyEgress, lifecycle: dolaLifecycle });
            if (!dolaAccountId && /没有可用的 Dola Cookie 账号|Dola 账号 Cookie 无法解密/.test(errorMessage)) {
                const response = NextResponse.json({ error: errorMessage, submissionState: "not_started" }, { status: 503 });
                response.headers.set("x-dreamyo-submission-state", "not-started");
                return response;
            }
        }
        if (isChatGptApiChannel) return chatGptApiRuntimeErrorResponse(error);
        if (!providerManaged) console.error("System API proxy request failed", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: DEFAULT_CHANNEL_CONNECT_ERROR }, { status: 502, headers: responseHeaders(new Headers(), null, refundedPointsRemaining) });
    }

    await safeRecordSystemProtocolTrace({ request, userId, channelName: channel.name, protocol: modelConfig?.protocol || channel.advancedConfig?.protocol || (globalChannel ? "globalaiopc" : apiFormat), model: upstreamModel, path: geminiAiPath, body: protocolRuntimeBody, requestContentType: contentType, response: upstream, durationMs: Date.now() - protocolRequestStartedAt });

    if (!upstream.ok && pointsResult) {
        await refundConsumedPoints();
        pointsResult = null;
    }
    if (isRedirectStatus(upstream.status)) {
        if (isDolaChannel) {
            const errorMessage = "Dola Provider 返回了不允许的重定向";
            dolaLifecycle.push({ time: new Date().toISOString(), phase: "failed", message: errorMessage, durationMs: Date.now() - upstreamStartedAt, detail: `HTTP ${upstream.status}` });
            await safeSettleDolaLog(dolaLogId, { statusCode: 502, durationMs: Date.now() - upstreamStartedAt, phase: "failed", error: errorMessage, accountId: dolaAccountId || undefined, proxyEgress: dolaProxyEgress, lifecycle: dolaLifecycle });
        }
        return NextResponse.json({ error: "上游接口不允许重定向，请检查后台渠道地址" }, { status: 502, headers: responseHeaders(new Headers(), null, refundedPointsRemaining) });
    }
    // 创建响应携带账号级限额（rate_limited / quota_exhausted）：标记当前账号临时冷却或额度用尽并按管理员配置换号。
    if (isDolaChannel && dolaAccountId && dolaRuntimeBody && request.method === "POST" && ["/v1/videos", "/v1/images"].includes(geminiAiPath.split("?", 1)[0])) {
        const { rotationLimit } = await getDolaGatewaySettings();
        let dolaRotations = 0;
        while (dolaRotations < rotationLimit) {
            const snapshot = await snapshotDolaResponse(upstream);
            const rateLimited = snapshot.value?.status === "failed" ? isDolaRateLimitError(snapshot.error) : upstream.status >= 400 && isDolaRateLimitError(snapshot.error);
            const quotaExhausted = snapshot.value?.status === "failed" ? isDolaQuotaExhaustedError(snapshot.error) : upstream.status >= 400 && isDolaQuotaExhaustedError(snapshot.error);
            if (!rateLimited && !quotaExhausted) break;
            const previousDolaAccountId = dolaAccountId;
            if (quotaExhausted) {
                await markDolaAccountQuotaExhausted(dolaAccountId, snapshot.error || `HTTP ${upstream.status}`).catch(() => undefined);
            } else {
                await markDolaAccountRateLimited(dolaAccountId, snapshot.error || `HTTP ${upstream.status}`).catch(() => undefined);
            }
            await markDolaAccountUsed(dolaAccountId, false, true).catch(() => undefined);
            const nextBody = await rotateDolaRuntimeBody(dolaRuntimeBody, upstreamModel);
            if (!nextBody) break;
            dolaRuntimeBody = nextBody;
            dolaAccountId = readDolaAccountId(dolaRuntimeBody);
            dolaProxyEgress = readDolaProxyEgress(dolaRuntimeBody);
            dolaRotations += 1;
            const rotationMessage = quotaExhausted
                ? "上游账号今日生成次数已达上限，已自动切换账号重试 (upstream account daily quota reached limit; auto-switched to another account)"
                : "上游账号触发限额（rate_limited），已自动切换账号重试 (upstream account rate-limited; auto-switched to another account)";
            dolaLifecycle.push({ time: new Date().toISOString(), phase: "routing", message: rotationMessage, durationMs: Date.now() - upstreamStartedAt, detail: `原账号 ${previousDolaAccountId} 已${quotaExhausted ? "标记为额度已用完" : "进入临时冷却"}；新账号: ${dolaAccountId}` });
            await safeMarkDolaLog(dolaLogId, { phase: "upstream", message: rotationMessage, detail: `新账号: ${dolaAccountId}` });
            try {
                const rotationStartedAt = Date.now();
                upstream = await dolaRuntimeRequest(geminiAiPath, { method: request.method, headers, body: dolaRuntimeBody, signal: request.signal });
                await safeRecordSystemProtocolTrace({ request, userId, channelName: channel.name, protocol: modelConfig?.protocol || channel.advancedConfig?.protocol || "dola", model: upstreamModel, path: geminiAiPath, body: dolaRuntimeBody, requestContentType: contentType, response: upstream, durationMs: Date.now() - rotationStartedAt });
            } catch {
                break;
            }
        }
    }
    if (upstream.ok) pointsSettled = true;
    if (isDolaChannel && dolaAccountId) {
        await markDolaAccountUsed(dolaAccountId, upstream.ok, !dolaHold).catch(() => undefined);
    }
    if (isDolaChannel) {
        const responseSnapshot = await snapshotDolaResponse(upstream);
        if (dolaAttachedTaskLogId) {
            // Poll responses advance the original create log through 排队中 → 生成中 → 生成完成/生成失败.
            const providerStatus = stringValue(responseSnapshot.value?.status);
            if (upstream.ok) {
                const phase = dolaTaskLogPhase(providerStatus, Boolean(responseSnapshot.verificationId));
                const errorText = stringValue(responseSnapshot.value?.error);
                await safeAdvanceDolaTaskLog(dolaAttachedTaskLogId, {
                    phase,
                    message:
                        phase === "success"
                            ? "生成完成，最终结果已返回"
                            : phase === "failed"
                              ? `生成失败${errorText ? `：${describeDolaFailure(errorText)}` : ""}`
                              : phase === "needs_review"
                                ? "任务等待人工确认（页面验证）"
                                : phase === "generating"
                                  ? "Dola 上游已受理，生成中"
                                  : "Dola 上游排队中，等待生成",
                    detail: dolaResultMediaDetail(responseSnapshot.value) || `上游任务状态: ${providerStatus || "unknown"}`,
                    statusCode: upstream.status,
                    responsePreview: responseSnapshot.preview,
                    responseBytes: responseSnapshot.bytes,
                    ...(phase === "failed" && errorText ? { error: errorText } : {}),
                    ...(responseSnapshot.verificationId ? { verificationId: responseSnapshot.verificationId } : {}),
                    ...(responseSnapshot.screenshotBase64 ? { screenshotBase64: responseSnapshot.screenshotBase64 } : {}),
                });
            } else if (upstream.status === 404) {
                await safeAdvanceDolaTaskLog(dolaAttachedTaskLogId, { phase: "failed", message: "生成失败：任务在 Provider 中不存在（可能已被重启清理）", statusCode: upstream.status, error: "task_not_found" });
            }
        } else {
            const responsePhase = dolaCreateResponsePhase(upstream, responseSnapshot.value);
            if (isDolaChannel && responsePhase === "needs_review" && dolaAccountId) {
                // 只有 Provider 返回真实 verificationId 才标记 verification_required。
                await setDolaAccountStatus(dolaAccountId, "verification_required").catch(() => undefined);
            }
            dolaLifecycle.push({ time: new Date().toISOString(), phase: responsePhase, message: responsePhase === "needs_review" ? "Dola 返回待人工确认状态" : responsePhase === "submitted" ? "已提交到 Dola 上游，任务排队中" : upstream.ok ? "Dola Provider 已返回响应" : "Dola Provider 返回失败", durationMs: Date.now() - upstreamStartedAt, detail: `HTTP ${upstream.status}${responseSnapshot.taskId ? `, 任务: ${responseSnapshot.taskId}` : ""}` });
            await safeSettleDolaLog(dolaLogId, { statusCode: upstream.status, durationMs: Date.now() - upstreamStartedAt, phase: responsePhase, ...(upstream.ok ? {} : { error: responseSnapshot.error || "Dola Provider 请求失败" }), responsePreview: responseSnapshot.preview, responseBytes: responseSnapshot.bytes, contentType: upstream.headers.get("content-type") || undefined, accountId: dolaAccountId || undefined, accountName: await dolaAccountDisplayName(dolaAccountId), taskId: responseSnapshot.taskId || undefined, verificationId: responseSnapshot.verificationId || undefined, screenshotBase64: responseSnapshot.screenshotBase64 || undefined, proxyEgress: dolaProxyEgress, lifecycle: dolaLifecycle });
        }
    }
    if (isChatGptApiChannel) return chatGptApiRuntimeResponse(upstream, request, pointsResult, refundedPointsRemaining);
    if (globalAdaptation && upstream.ok) {
        const payload = await upstream.json().catch(() => null);
        if (!payload) return NextResponse.json({ error: "上游文本接口返回了无效 JSON" }, { status: 502, headers: responseHeaders(upstream.headers, pointsResult, refundedPointsRemaining, providerManaged ? undefined : target) });
        return NextResponse.json(adaptGlobalAiOpcTextResponse(globalAdaptation.adapter, payload), { status: upstream.status, headers: responseHeaders(upstream.headers, pointsResult, refundedPointsRemaining, providerManaged ? undefined : target) });
    }

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers, pointsResult, refundedPointsRemaining, providerManaged ? undefined : target),
    });
}

async function prepareDolaRuntimeBody(contentType: string | null, body: BodyInit | undefined, holdAttempt = false) {
    if (!contentType?.toLowerCase().includes("application/json") || !body) return body;
    const source = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : "";
    if (!source) return body;
    let payload: Record<string, unknown>;
    try {
        const parsed = JSON.parse(source);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
        payload = { ...(parsed as Record<string, unknown>) };
    } catch {
        return body;
    }
    const proxy = await resolveDolaProxyEgress();
    const proxyFields = {
        proxyMode: dolaProviderProxyMode(proxy.egress),
        proxySource: proxy.egress.mode,
        proxyTarget: proxy.egress.target,
        proxyNodeName: proxy.egress.nodeName,
        proxyAddress: proxy.egress.address || proxy.egress.target,
        ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}),
    };
    // User-facing system requests may never choose a Dola Cookie/account or a
    // provider proxy. Those fields are injected from the server-side account
    // pool and the generic proxy binding below.
    delete payload.cookie;
    const model = typeof payload.model === "string" ? payload.model : "dola-seedance-2-5";
    const account = await reserveDolaAccount(model);
    if (!account) throw new Error("没有可用的 Dola Cookie 账号");
    const cookie = await getDolaAccountCookie(account.id);
    if (!cookie) {
        await releaseDolaAccountAttempt(account.id);
        throw new Error("Dola 账号 Cookie 无法解密");
    }
    return JSON.stringify({ ...payload, accountId: account.id, credentialVersion: account.credentialVersion, cookie, transport: "camoufox-page", ...proxyFields, ...(holdAttempt ? { dolaHold: true } : {}) });
}

/** 账号级限额换号：为已注入账号的 Dola 请求体换下一个可用账号，Cookie、凭据版本与代理快照同步更新 */
async function rotateDolaRuntimeBody(runtimeBody: string, model: string) {
    let payload: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(runtimeBody);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
        payload = { ...(parsed as Record<string, unknown>) };
    } catch {
        return "";
    }
    const account = await reserveDolaAccount(model);
    if (!account) return "";
    try {
        const cookie = await getDolaAccountCookie(account.id);
        if (!cookie) {
            await releaseDolaAccountAttempt(account.id);
            return "";
        }
        const proxy = await resolveDolaProxyEgress();
        return JSON.stringify({
            ...payload,
            accountId: account.id,
            credentialVersion: account.credentialVersion,
            cookie,
            transport: "camoufox-page",
            proxyMode: dolaProviderProxyMode(proxy.egress),
            proxySource: proxy.egress.mode,
            proxyTarget: proxy.egress.target,
            proxyNodeName: proxy.egress.nodeName,
            proxyAddress: proxy.egress.address || proxy.egress.target,
            ...(proxy.proxyUrl ? { proxyUrl: proxy.proxyUrl } : {}),
            dolaHold: true,
        });
    } catch {
        await releaseDolaAccountAttempt(account.id).catch(() => undefined);
        return "";
    }
}

function readDolaAccountId(body: BodyInit | undefined) {
    if (typeof body !== "string") return "";
    try {
        const value = JSON.parse(body) as Record<string, unknown>;
        return typeof value.accountId === "string" ? value.accountId.slice(0, 160) : "";
    } catch {
        return "";
    }
}

function readDolaHold(body: BodyInit | undefined) {
    if (typeof body !== "string") return false;
    try {
        const value = JSON.parse(body) as Record<string, unknown>;
        return value.dolaHold === true;
    } catch {
        return false;
    }
}

function readDolaProxyEgress(body: BodyInit | undefined): { mode: "direct" | "magic" | "generic" | "chained"; nodeName?: string; address?: string } {
    if (typeof body !== "string") return { mode: "direct" as const };
    try {
        const value = JSON.parse(body) as Record<string, unknown>;
        if (value.proxyMode === "managed") {
            const mode: "magic" | "generic" | "chained" = value.proxySource === "magic" || value.proxySource === "chained" || value.proxySource === "generic" ? value.proxySource : "generic";
            const nodeName = typeof value.proxyNodeName === "string" && value.proxyNodeName.trim()
                ? value.proxyNodeName.trim().slice(0, 160)
                : typeof value.proxyTarget === "string" && value.proxyTarget.trim()
                    ? value.proxyTarget.trim().slice(0, 160)
                    : undefined;
            const address = typeof value.proxyAddress === "string" && value.proxyAddress.trim()
                ? value.proxyAddress.trim().slice(0, 160)
                : undefined;
            return { mode, nodeName, address };
        }
    } catch {
        // Keep log redaction deterministic for malformed provider bodies.
    }
    return { mode: "direct" as const };
}

function channelHasModel(models: string[], requested: string) {
    const target = requested
        .trim()
        .replace(/^models\//, "")
        .toLowerCase();
    return models.some(
        (model) =>
            model
                .trim()
                .replace(/^models\//, "")
                .toLowerCase() === target,
    );
}

async function prepareChatGptApiRuntimeBody(contentType: string | null, body: BodyInit | undefined, signal: AbortSignal) {
    if (body instanceof FormData) {
        const resolved = new FormData();
        for (const [name, value] of body.entries()) resolved.append(name, typeof value === "string" ? String(await resolveChatGptReferences(value, name, signal)) : value);
        return resolved;
    }
    if (!contentType?.toLowerCase().includes("application/json") || !body) return body;
    const source = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : "";
    if (!source) return body;
    return JSON.stringify(await resolveChatGptReferences(JSON.parse(source), "", signal));
}

async function proxyChatGptApiCatalogRequest(request: Request, runtimePath: string) {
    try {
        getChatGptRuntimeConfig();
        const upstream = await chatGptRuntimeRequest(runtimePath, { method: "GET", headers: chatGptApiRuntimeHeaders(), signal: request.signal });
        return chatGptApiRuntimeResponse(upstream, request, null, null);
    } catch (error) {
        return chatGptApiRuntimeErrorResponse(error);
    }
}

function chatGptApiRuntimeHeaders(headers?: HeadersInit) {
    const runtimeHeaders = new Headers(headers);
    // This value is created only on a server-authorized system dispatch and is never relayed from the browser request.
    runtimeHeaders.set("x-dreamyo-internal-dispatch", "1");
    return runtimeHeaders;
}

function chatGptApiRuntimeErrorResponse(error: unknown) {
    const status = Number(error && typeof error === "object" && "status" in error ? error.status : 503);
    const message = error instanceof Error && error.message ? error.message : "GPTAPI 服务尚未配置或不可用";
    return NextResponse.json({ error: message }, { status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 503 });
}

async function chatGptApiRuntimeResponse(upstream: Response, request: Request, pointsResult: Awaited<ReturnType<typeof consumeUserPoints>> | null, refundedPointsRemaining: number | null) {
    const headers = responseHeaders(upstream.headers, pointsResult, refundedPointsRemaining);
    if (!upstream.ok) return NextResponse.json({ error: { message: chatGptErrorMessage(await upstream.json().catch(() => null)) } }, { status: upstream.status, headers });
    const origin = new URL(request.url).origin;
    if (upstream.headers.get("content-type")?.includes("text/event-stream") && upstream.body) {
        headers.set("x-accel-buffering", "no");
        return new Response(rewriteChatGptStream(upstream.body, origin), { status: upstream.status, statusText: upstream.statusText, headers });
    }
    const payload = await upstream.json().catch(() => null);
    if (payload === null) return NextResponse.json({ error: "GPTAPI 返回了无效 JSON" }, { status: 502, headers });
    return NextResponse.json(rewriteChatGptMedia(payload, origin), { status: upstream.status, headers });
}

type SystemMediaChannel = { id: string; baseUrl: string; apiFormat: ApiCallFormat; apiKey: string; advancedConfig?: import("@/lib/auth/store").SystemChannelAdvancedConfig };

async function proxySystemMediaRequest(request: Request, channel: SystemMediaChannel, userId: string) {
    if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.json({ error: "Media proxy only supports GET and HEAD" }, { status: 405 });
    const rawUrl = new URL(request.url).searchParams.get("url") || "";
    if (!(await authorizeGenerationMediaProxyRequest(request, { userId, channelId: channel.id, url: rawUrl }))) return NextResponse.json({ error: "媒体路径未获任务授权" }, { status: 403 });
    const target = channel.advancedConfig?.protocol === GEMINIAI_PROTOCOL ? geminiAiMediaTarget(rawUrl) : channel.advancedConfig?.protocol === DOLA_PROTOCOL ? dolaMediaTarget(rawUrl) : mediaTargetRequest(channel.baseUrl, channel.apiFormat, rawUrl, isGlobalAiOpcChannel(channel.advancedConfig));
    if (!target) return NextResponse.json({ error: "Invalid media url" }, { status: 400 });
    // 媒体地址来自上游任务结果，且本请求携带按 URL 绑定的生成媒体授权：允许代理工具 fake-IP 段（198.18/15），由本机 TUN 按 Host 路由到真实公网目标。
    const mediaOutboundOptions = { allowCredentials: false, allowProxyFakeIpSpace: true };
    if (!(await isSafeOutboundUrl(target.url, mediaOutboundOptions))) return NextResponse.json({ error: "媒体地址不允许访问内网或保留地址" }, { status: 400 });
    const range = normalizeMediaProxyRange(request.headers.get("range"));
    if (range === "invalid") return NextResponse.json({ error: "Invalid media range" }, { status: 416 });
    const permit = acquireMediaConcurrency("proxy", `user:${userId}`);
    if (!permit) return NextResponse.json({ error: "媒体并发访问过多，请稍后重试" }, { status: 429, headers: { "Retry-After": "2" } });

    const headers = new Headers();
    if (target.includeAuth) {
        Object.entries(protocolAuthHeaders(channel.apiKey, channel.advancedConfig, isGlobalAiOpcChannel(channel.advancedConfig) ? "openai" : channel.apiFormat)).forEach(([key, value]) => headers.set(key, value));
    }

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SYSTEM_MEDIA_TIMEOUT_MS)]);
    try {
        const maxBytes = range ? MAX_MEDIA_PROXY_RANGE_BYTES : MAX_MEDIA_PROXY_BYTES;
        const media = await fetchSafeUpstreamMedia({
            method: request.method,
            range,
            maxBytes,
            timeoutMs: SYSTEM_MEDIA_TIMEOUT_MS,
            fetcher: (nextMethod, nextRange) => {
                const requestHeaders = new Headers(headers);
                if (nextRange) requestHeaders.set("range", nextRange);
                return fetchSystemMedia(target, nextMethod, requestHeaders, signal);
            },
        });
        const response = new Response(media.body, {
            status: media.response.status,
            statusText: media.response.statusText,
            headers: mediaResponseHeaders(media.response.headers, media.mimeType),
        });
        if (request.method === "HEAD") {
            permit.release();
            return response;
        }
        return withMediaConcurrency(response, permit);
    } catch (error) {
        permit.release();
        if (error instanceof UnsupportedMediaContentError || error instanceof MediaProxyResponseError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("System media proxy request failed", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: DEFAULT_CHANNEL_CONNECT_ERROR }, { status: 502 });
    }
}

function geminiAiMediaTarget(value: string): { url: string; includeAuth: boolean } | null {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? { url: url.toString(), includeAuth: false } : null;
    } catch {
        return null;
    }
}

function dolaMediaTarget(value: string): { url: string; includeAuth: boolean } | null {
    // Dola images and videos are first-party media on signed CDN URLs; the
    // provider-managed channel has no upstream base URL to proxy against.
    try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol)) return null;
        const host = url.hostname.toLowerCase();
        const privateHosts = (process.env.DREAMYO_PRIVATE_UPSTREAM_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        const privateAllowed = process.env.DREAMYO_ALLOW_PRIVATE_UPSTREAMS === "1" && privateHosts.includes(host);
        const allowed = privateAllowed || host === "ibyteimg.com" || host.endsWith(".ibyteimg.com") || host === "dola.com" || host.endsWith(".dola.com") || host === "byteintlapi.com" || host.endsWith(".byteintlapi.com");
        return allowed ? { url: url.toString(), includeAuth: false } : null;
    } catch {
        return null;
    }
}

async function fetchSystemMedia(target: { url: string; includeAuth: boolean }, method: "GET" | "HEAD", baseHeaders: Headers, signal: AbortSignal) {
    let currentUrl = target.url;
    let includeAuth = target.includeAuth;
    for (let redirects = 0; redirects <= MAX_SYSTEM_MEDIA_REDIRECTS; redirects += 1) {
        if (!(await isSafeOutboundUrl(currentUrl, { allowCredentials: false, allowProxyFakeIpSpace: true }))) throw new Error("Unsafe media redirect");
        const headers = includeAuth ? new Headers(baseHeaders) : new Headers();
        const range = baseHeaders.get("range");
        if (range) headers.set("range", range);
        const upstream = await fetchSafeOutbound(currentUrl, { method, headers, cache: "no-store", redirect: "manual", signal }, { allowProxyFakeIpSpace: true });
        if (!isRedirectStatus(upstream.status)) return upstream;
        const location = upstream.headers.get("location");
        await upstream.body?.cancel().catch(() => undefined);
        if (!location || redirects === MAX_SYSTEM_MEDIA_REDIRECTS) throw new Error("Too many media redirects");
        currentUrl = new URL(location, currentUrl).toString();
        includeAuth = false;
    }
    throw new Error("Media redirect failed");
}

function isMediaProxyPath(path: string[]) {
    return path[0] === "_media" || ((path[0] === "v1" || path[0] === "v1beta") && path[1] === "_media");
}

function isRedirectStatus(status: number) {
    return [301, 302, 303, 307, 308].includes(status);
}

function mediaTargetRequest(baseUrl: string, apiFormat: ApiCallFormat, value: string, globalAiOpc = false): { url: string; includeAuth: boolean } | null {
    const mediaUrl = value.trim();
    if (!mediaUrl) return null;
    let apiBase: URL;
    try {
        apiBase = new URL(normalizeApiBaseUrl(baseUrl, apiFormat, globalAiOpc));
    } catch {
        return null;
    }
    try {
        if (mediaUrl.startsWith("/")) return { url: new URL(mediaUrl, apiBase.origin).toString(), includeAuth: true };
        const absolute = new URL(mediaUrl);
        if (!["http:", "https:"].includes(absolute.protocol)) return null;
        return { url: absolute.toString(), includeAuth: absolute.origin === apiBase.origin };
    } catch {
        return { url: new URL(mediaUrl, directoryBaseUrl(apiBase)).toString(), includeAuth: true };
    }
}

function directoryBaseUrl(url: URL) {
    const next = new URL(url.toString());
    if (!next.pathname.endsWith("/")) next.pathname = next.pathname.replace(/\/[^/]*$/, "/");
    next.search = "";
    next.hash = "";
    return next.toString();
}

function mediaResponseHeaders(headers: Headers, mimeType: string) {
    const nextHeaders = new Headers();
    ["content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"].forEach((key) => {
        const value = headers.get(key);
        if (value) nextHeaders.set(key, value);
    });
    nextHeaders.set("content-type", mimeType);
    nextHeaders.set("cache-control", "private, max-age=600");
    nextHeaders.set("cross-origin-resource-policy", "same-site");
    nextHeaders.set("x-content-type-options", "nosniff");
    nextHeaders.set("x-robots-tag", "noindex, nofollow, noarchive");
    return nextHeaders;
}

async function readProxyRequestBody(request: Request, isMultipart: boolean): Promise<ProxyRequestBody> {
    if (request.method === "GET" || request.method === "HEAD") return { bodyDigest: emptyBodyDigest() };
    const bytes = await readRequestBodyBytes(request, isMultipart ? MAX_PROXY_MULTIPART_BYTES : MAX_PROXY_BODY_BYTES);
    if (!isMultipart) {
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return { body, pointsPayload: body, bodyDigest: digestBytes(bytes) };
    }

    const formData = await new Request(request.url, { method: request.method, headers: { "Content-Type": request.headers.get("content-type") || "" }, body: bytes }).formData();
    const cloned = await cloneFormData(formData);
    return { body: cloned.body, pointsPayload: formDataFields(formData), bodyDigest: cloned.bodyDigest };
}

function formDataFields(formData: FormData): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const key of ["model", "n", "quality", "resolution_name", "resolution", "vquality", "seconds", "duration"]) {
        const value = formData.get(key);
        if (typeof value === "string" && value.trim()) fields[key] = value.trim();
    }
    return fields;
}

async function cloneFormData(formData: FormData) {
    const next = new FormData();
    const digest = createHash("sha256");
    for (const [key, value] of formData.entries()) {
        if (typeof value === "string") {
            next.append(key, value);
            updateMultipartDigest(digest, ["field", key, value]);
            continue;
        }
        const bytes = new Uint8Array(await value.arrayBuffer());
        const type = value.type || "application/octet-stream";
        const name = value.name || "file";
        next.append(key, new Blob([bytes], { type }), name);
        updateMultipartDigest(digest, ["file", key, name, type, String(bytes.byteLength), digestBytes(bytes)]);
    }
    return { body: next, bodyDigest: digest.digest("hex") };
}

function updateMultipartDigest(digest: ReturnType<typeof createHash>, parts: string[]) {
    for (const part of parts)
        digest
            .update(String(Buffer.byteLength(part)))
            .update(":")
            .update(part)
            .update("\0");
}

function digestBytes(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
}

function emptyBodyDigest() {
    return digestBytes(new Uint8Array());
}

function classifyPointsRequest(method: string, apiFormat: ApiCallFormat, path: string[], contentType: string | null, body?: ArrayBuffer | Record<string, unknown>, multipliers?: GenerationPointMultipliers): PointsRequest | null {
    if (method.toUpperCase() !== "POST") return null;
    const cleanPath = path[0] === "v1" || path[0] === "v1beta" ? path.slice(1) : path;
    const routePath = `/${cleanPath.join("/")}`.toLowerCase();
    const payload = readRequestBody(contentType, body);
    const model = readRequestModel(payload) || readPathModel(cleanPath);
    if (!model) return null;

    if (routePath === "/images/generations" || routePath === "/images/edits") {
        return { model, amount: readRequestCount(payload) * imageQualityMultiplier(payload, multipliers), usageKind: "image" };
    }
    if (routePath === "/audio/speech") return { model, amount: 1, usageKind: "audio" };
    if (routePath === "/videos" || routePath === "/video/generations" || routePath === "/videos/generations" || routePath === "/videos/videos" || routePath === "/contents/generations/tasks") {
        return { model, amount: videoParameterMultiplier(payload, multipliers), usageKind: "video" };
    }
    if (apiFormat === "gemini" && /^\/models\/[^/]+:predictlongrunning$/i.test(routePath)) {
        return { model, amount: videoParameterMultiplier(payload, multipliers), usageKind: "video" };
    }
    if (routePath === "/responses") {
        const isImage = hasResponsesImageGenerationTool(payload);
        return { model, amount: isImage ? imageQualityMultiplier(payload, multipliers) : 1, usageKind: isImage ? "image" : "text" };
    }
    if (routePath === "/chat/completions") return { model, amount: 1, usageKind: "text" };
    if (apiFormat === "gemini" && routePath.includes(":streamgeneratecontent")) return { model, amount: 1, usageKind: "text" };
    if (apiFormat === "gemini" && routePath.includes(":generatecontent")) return { model, amount: 1, usageKind: hasGeminiImageResponseModality(payload) ? "image" : "text" };

    return null;
}

function classifyConfiguredPointsRequest(
    method: string,
    path: string[],
    contentType: string | null,
    body: ArrayBuffer | Record<string, unknown> | undefined,
    channelId: string,
    createPaths: Array<string | undefined>,
    modelHint: string,
    logicalModels: Awaited<ReturnType<typeof getAuthSettings>>["logicalModels"],
    multipliers?: GenerationPointMultipliers,
): PointsRequest | null {
    if (method.toUpperCase() !== "POST") return null;
    const cleanPath = normalizedConfiguredProxyPath(`/${path.join("/")}`);
    if (!createPaths.some((createPath) => createPath && cleanPath === normalizedConfiguredProxyPath(createPath))) return null;
    const payload = readRequestBody(contentType, body);
    const model = readRequestModel(payload) || modelHint;
    if (!model) return null;
    const capability = logicalModels.find((logical) => logical.enabled && logical.bindings.some((binding) => binding.enabled && binding.channelId === channelId && sameModel(binding.upstreamModel, model)))?.capability;
    if (capability === "image") return { model, amount: readRequestCount(payload) * imageQualityMultiplier(payload, multipliers), usageKind: "image" };
    if (capability === "video") return { model, amount: videoParameterMultiplier(payload, multipliers), usageKind: "video" };
    if (capability === "audio") return { model, amount: 1, usageKind: "audio" };
    return capability === "text" ? { model, amount: 1, usageKind: "text" } : null;
}

function normalizedConfiguredProxyPath(value: string) {
    return `/${value
        .trim()
        .replace(/^\/+/, "")
        .replace(/^(?:v1|v1beta)\//i, "")
        .replace(/\/+$/, "")}`.toLowerCase();
}

function sameModel(left: string, right: string) {
    return (
        left
            .trim()
            .replace(/^models\//i, "")
            .toLowerCase() ===
        right
            .trim()
            .replace(/^models\//i, "")
            .toLowerCase()
    );
}

function readRequestModel(payload: Record<string, unknown>) {
    if (typeof payload.model === "string") return payload.model.trim();
    const overrideSettings = payload.override_settings;
    return overrideSettings && typeof overrideSettings === "object" && !Array.isArray(overrideSettings) && typeof (overrideSettings as Record<string, unknown>).sd_model_checkpoint === "string"
        ? String((overrideSettings as Record<string, unknown>).sd_model_checkpoint).trim()
        : "";
}

function readRequestTaskId(payload: Record<string, unknown>) {
    for (const key of ["task_id", "taskId", "id", "job_id", "jobId", "video_id", "videoId", "request_id", "requestId"]) {
        if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim().slice(0, 500);
    }
    return "";
}

function readPathModel(path: string[]) {
    const modelIndex = path.findIndex((item) => item === "models");
    if (modelIndex < 0) return "";
    return decodeURIComponent(path[modelIndex + 1] || "")
        .split(":")[0]
        .replace(/^models\//, "")
        .trim();
}

function readRequestCount(payload: Record<string, unknown>) {
    const count = Math.floor(Number(payload.n) || 1);
    return Math.max(1, Math.min(1000, count));
}

function imageQualityMultiplier(payload: Record<string, unknown>, multipliers?: GenerationPointMultipliers) {
    return multiplierValue(multipliers?.imageQuality, normalizeImageQualityKey(payload.quality));
}

function videoParameterMultiplier(payload: Record<string, unknown>, multipliers?: GenerationPointMultipliers) {
    const parameters = payload.parameters && typeof payload.parameters === "object" && !Array.isArray(payload.parameters) ? (payload.parameters as Record<string, unknown>) : {};
    return (
        multiplierValue(multipliers?.videoQuality, normalizeVideoQualityKey(payload.resolution_name || payload.resolution || payload.quality || payload.vquality || parameters.resolution || parameters.quality || parameters.resolution_name)) *
        multiplierValue(multipliers?.videoSeconds, normalizeVideoSecondsKey(payload.duration || payload.seconds || parameters.durationSeconds || parameters.duration || parameters.seconds))
    );
}

function multiplierValue(values: Record<string, number> | undefined, key: string) {
    const value = values?.[key];
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 1;
}

function normalizeImageQualityKey(value: unknown) {
    const key = String(value || "auto")
        .trim()
        .toLowerCase();
    if (key === "hd") return "high";
    if (key === "standard") return "medium";
    return key || "auto";
}

function normalizeVideoQualityKey(value: unknown) {
    const key = String(value || "720")
        .trim()
        .toLowerCase();
    if (key === "low") return "480";
    if (key === "auto" || key === "medium" || key === "high") return "720";
    return key.replace(/p$/, "") || "720";
}

function normalizeVideoSecondsKey(value: unknown) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return "5";
    return String(Math.max(-1, Math.floor(seconds)));
}

function hasGeminiImageResponseModality(payload: Record<string, unknown>) {
    const generationConfig = payload.generationConfig && typeof payload.generationConfig === "object" && !Array.isArray(payload.generationConfig) ? (payload.generationConfig as Record<string, unknown>) : {};
    const modalityValues = [generationConfig.responseModalities, generationConfig.response_modalities, payload.responseModalities, payload.response_modalities];
    return modalityValues.some((value) => Array.isArray(value) && value.some((item) => String(item).toLowerCase() === "image"));
}

function hasResponsesImageGenerationTool(payload: Record<string, unknown>) {
    const tools = payload.tools;
    return Array.isArray(tools) && tools.some((tool) => Boolean(tool && typeof tool === "object" && String((tool as Record<string, unknown>).type || "").toLowerCase() === "image_generation"));
}

function readRequestBody(contentType: string | null, body?: ArrayBuffer | Record<string, unknown>): Record<string, unknown> {
    if (!body) return {};
    if (!(body instanceof ArrayBuffer)) return body;
    const text = new TextDecoder().decode(body);
    if (!contentType?.toLowerCase().includes("application/json")) return readMultipartFields(text);
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function readMultipartFields(text: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const key of ["model", "n", "quality", "resolution_name", "resolution", "vquality", "seconds", "duration"]) {
        const match = text.match(new RegExp(`name="${key}"\\r?\\n\\r?\\n([^\\r\\n]+)`));
        if (match?.[1]) fields[key] = match[1].trim();
    }
    return fields;
}

function targetUrl(baseUrl: string, apiFormat: "openai" | "gemini", path: string[], search: string, globalAiOpc = false, protocol?: import("@/lib/auth/store").SystemChannelProtocol) {
    const usesLiteralPath =
        protocol === "seedance-special" || protocol === "stable-diffusion" || protocol === "yumeng" || protocol === "custom" || protocol === "minimax-h3-official" || protocol === "aliyun-bailian-audio" || protocol === "tencent-tokenhub-music";
    const cleanPath = !usesLiteralPath && (path[0] === "v1" || path[0] === "v1beta") ? path.slice(1) : path;
    const resolvedBaseUrl = protocol === "yumeng" ? normalizeYumengModelCenterBaseUrl(baseUrl) : baseUrl;
    if (isAgnesApiBaseUrl(resolvedBaseUrl) && cleanPath[0]?.toLowerCase() === "agnesapi") {
        const origin = new URL(resolvedBaseUrl).origin;
        return `${origin}/${cleanPath.map((segment) => encodeTargetPathSegment(segment, apiFormat)).join("/")}${search}`;
    }
    if (usesLiteralPath) return literalTargetUrl(resolvedBaseUrl, cleanPath, search, apiFormat);
    return `${normalizeApiBaseUrl(resolvedBaseUrl, apiFormat, globalAiOpc)}/${cleanPath.map((segment) => encodeTargetPathSegment(segment, apiFormat)).join("/")}${search}`;
}

function literalTargetUrl(baseUrl: string, path: string[], search: string, apiFormat: "openai" | "gemini") {
    const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
    const baseSegments = new URL(normalizedBase).pathname.split("/").filter(Boolean).map(safeDecodeURIComponent);
    const pathSegments = path.map(safeDecodeURIComponent);
    let overlap = Math.min(baseSegments.length, pathSegments.length);
    while (overlap > 0 && baseSegments.slice(-overlap).some((segment, index) => segment !== pathSegments[index])) overlap -= 1;
    const suffix = path
        .slice(overlap)
        .map((segment) => encodeTargetPathSegment(segment, apiFormat))
        .join("/");
    return `${normalizedBase}${suffix ? `/${suffix}` : ""}${search}`;
}

function encodeTargetPathSegment(segment: string, apiFormat: "openai" | "gemini") {
    const decoded = safeDecodeURIComponent(segment);
    const encoded = encodeURIComponent(decoded);
    return apiFormat === "gemini" ? encoded.replace(/%3A/gi, ":") : encoded;
}

function safeDecodeURIComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function normalizeApiBaseUrl(baseUrl: string, apiFormat: "openai" | "gemini", globalAiOpc = false) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    if (lower.endsWith("/v1") || lower.endsWith("/v1beta") || lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3")) return normalized;
    if (apiFormat === "gemini" && !globalAiOpc) return `${normalized}/v1beta`;
    return `${normalized}/v1`;
}

function responseHeaders(headers: Headers, pointsResult?: Awaited<ReturnType<typeof consumeUserPoints>> | null, refundedPointsRemaining?: number | null, upstreamUrl?: string) {
    const nextHeaders = new Headers();
    const passthrough = ["content-type", "cache-control", "content-disposition", "retry-after"];
    passthrough.forEach((key) => {
        const value = headers.get(key);
        if (value) nextHeaders.set(key, value);
    });
    if (upstreamUrl) nextHeaders.set("x-dreamyo-upstream-url", upstreamUrl);
    if (pointsResult) {
        nextHeaders.set("x-dreamyo-points-cost", String(pointsResult.cost));
        nextHeaders.set("x-dreamyo-points-remaining", String(pointsResult.remaining));
        nextHeaders.set("x-dreamyo-points-permanent", String(pointsResult.permanentRemaining));
        nextHeaders.set("x-dreamyo-points-daily", String(pointsResult.dailyRemaining));
        nextHeaders.set("x-dreamyo-points-daily-expires-at", pointsResult.dailyExpiresAt);
        if (pointsResult.recordId) nextHeaders.set("x-dreamyo-points-record-id", pointsResult.recordId);
    } else if (typeof refundedPointsRemaining === "number") {
        nextHeaders.set("x-dreamyo-points-remaining", String(refundedPointsRemaining));
    }
    return nextHeaders;
}

async function safeOpenDolaLog(input: Parameters<typeof openDolaRequestLog>[0], lifecycle: DolaRequestLifecycleEntry[]) {
    try { return await openDolaRequestLog({ ...input, lifecycle }); } catch (error) { console.error("Failed to open Canvas Dola request log", error); return ""; }
}
async function dolaAccountDisplayName(accountId: string | undefined) {
    if (!accountId) return undefined;
    try {
        const account = await getDolaAccount(accountId);
        return account?.name || undefined;
    } catch {
        return undefined;
    }
}

async function safeFindDolaTaskLog(taskId: string) {
    try { return await findDolaTaskLogIdByTaskId(taskId, "runtime"); } catch (error) { console.error("Failed to locate Canvas Dola task log", error); return ""; }
}
async function safeAdvanceDolaTaskLog(id: string, advance: Parameters<typeof advanceDolaTaskLog>[1]) {
    if (!id) return;
    try { await advanceDolaTaskLog(id, advance); } catch (error) { console.error("Failed to advance Canvas Dola task log", error); }
}
async function safeMarkDolaLog(id: string, entry: Parameters<typeof markDolaRequestLogRunning>[1]) {
    if (!id) return;
    try { await markDolaRequestLogRunning(id, entry); } catch (error) { console.error("Failed to update Canvas Dola request log", error); }
}
async function safeSettleDolaLog(id: string, settle: Parameters<typeof settleDolaRequestLog>[1]) {
    if (!id) return;
    try { await settleDolaRequestLog(id, settle); } catch (error) { console.error("Failed to settle Canvas Dola request log", error); }
}
function bodyByteLength(body: BodyInit | undefined) {
    if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
    if (body instanceof ArrayBuffer) return body.byteLength;
    return undefined;
}
async function safeRecordSystemProtocolTrace(input: {
    request: Request;
    userId: string;
    channelName: string;
    protocol: string;
    model: string;
    path: string;
    body?: BodyInit;
    requestContentType: string | null;
    response?: Response;
    durationMs: number;
    error?: string;
}) {
    const logId = input.request.headers.get("x-dreamyo-generation-log-id")?.trim() || "";
    const slotId = input.request.headers.get("x-dreamyo-generation-slot-id")?.trim() || "";
    if (!logId || !slotId) return;
    try {
        const responseContentType = input.response?.headers.get("content-type") || "";
        const trace: GenerationLogProtocolTrace = {
            createdAt: new Date().toISOString(),
            channel: input.channelName,
            protocol: input.protocol,
            method: input.request.method,
            path: input.path.split("?", 1)[0],
            ...(input.model ? { model: input.model } : {}),
            ...(input.response ? { statusCode: input.response.status } : input.error ? { statusCode: 502 } : {}),
            durationMs: input.durationMs,
            ...(bodyByteLength(input.body) !== undefined ? { requestBytes: bodyByteLength(input.body) } : {}),
            ...(Number(input.response?.headers.get("content-length")) > 0 ? { responseBytes: Number(input.response?.headers.get("content-length")) } : {}),
            ...(input.requestContentType ? { requestContentType: input.requestContentType.split(";", 1)[0].trim() } : {}),
            ...(responseContentType ? { responseContentType: responseContentType.split(";", 1)[0].trim() } : {}),
            requestHeaders: safeProtocolRequestHeaders(input.request),
            responseHeaders: input.response ? safeProtocolResponseHeaders(input.response) : undefined,
            requestPreview: summarizeProtocolRequest(input.body, input.requestContentType),
            responsePreview: input.response ? await summarizeProtocolResponse(input.response) : undefined,
            ...(input.error ? { error: redactProtocolText(input.error) } : {}),
        };
        await appendGenerationLogProtocolTrace({ userId: input.userId, logId, slotId, trace });
    } catch (error) {
        console.warn("Unable to attach built-in protocol diagnostics to generation log", error instanceof Error ? error.message : "unknown error");
    }
}

function safeProtocolRequestHeaders(request: Request) {
    return Object.fromEntries(["accept", "content-type", "idempotency-key", "x-client-request-id"].flatMap((name) => {
        const value = request.headers.get(name);
        return value ? [[name, value.slice(0, 240)]] : [];
    }));
}

function safeProtocolResponseHeaders(response: Response) {
    return Object.fromEntries(["content-type", "retry-after", "x-request-id", "request-id", "x-goog-request-id", "x-openai-request-id"].flatMap((name) => {
        const value = response.headers.get(name);
        return value ? [[name, value.slice(0, 240)]] : [];
    }));
}

function summarizeProtocolRequest(body: BodyInit | undefined, contentType: string | null) {
    if (!body) return undefined;
    if (/multipart\/form-data|application\/octet-stream|image\/|video\/|audio\//i.test(contentType || "")) return "媒体或二进制请求体已省略";
    if (body instanceof FormData) return "multipart/form-data（媒体内容已省略）";
    const text = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : "";
    if (!text) return "二进制请求体已省略";
    try {
        return compactProtocolPreview(JSON.stringify(redactProtocolValue(JSON.parse(text))));
    } catch {
        return contentType?.toLowerCase().includes("json") ? "请求体无法解析为 JSON" : compactProtocolPreview(redactProtocolText(text));
    }
}

async function summarizeProtocolResponse(response: Response) {
    const contentType = response.headers.get("content-type") || "";
    if (/event-stream|image\/|video\/|audio\/|octet-stream/i.test(contentType)) return "流式或媒体响应体已省略";
    if (!/(?:json|text\/)/i.test(contentType)) return undefined;
    const text = await readBoundedProtocolResponse(response);
    if (!text) return undefined;
    try {
        return compactProtocolPreview(JSON.stringify(redactProtocolValue(JSON.parse(text))));
    } catch {
        return compactProtocolPreview(redactProtocolText(text));
    }
}

async function readBoundedProtocolResponse(response: Response) {
    const reader = response.clone().body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
        while (total < 5000) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = 5000 - total;
            chunks.push(value.subarray(0, remaining));
            total += Math.min(value.byteLength, remaining);
            if (value.byteLength > remaining) {
                truncated = true;
                await reader.cancel();
                break;
            }
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return `${new TextDecoder().decode(bytes)}${truncated ? "…（已截断）" : ""}`;
}

function redactProtocolValue(value: unknown, key = "", depth = 0): unknown {
    if (/authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret|credential|signature|proxyurl/i.test(key)) return "[已脱敏]";
    if (typeof value === "string") {
        if (/^(?:inline[_-]?data|b64[_-]?json|base64)$/i.test(key) || (/^(?:image|audio|video|file|data)$/i.test(key) && !/^https?:\/\//i.test(value))) return "[媒体内容已省略]";
        if (/^data:/i.test(value) || value.length > 1600) return "[媒体或长内容已省略]";
        return redactProtocolText(value);
    }
    if (Array.isArray(value)) return value.map((item) => redactProtocolValue(item, key, depth + 1));
    if (value && typeof value === "object") return depth < 12 ? Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactProtocolValue(item, childKey, depth + 1)])) : "[嵌套内容已省略]";
    return value;
}

function redactProtocolText(value: string) {
    return value
        .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [已脱敏]")
        .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret|credential|signature)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1=[已脱敏]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
            try {
                const url = new URL(raw);
                return `${url.origin}${url.pathname}`;
            } catch {
                return "[URL 已脱敏]";
            }
        });
}

function compactProtocolPreview(value: string) {
    return value.length > 5000 ? `${value.slice(0, 5000)}…（已截断）` : value;
}

function summarizeDolaSystemRequest(body: BodyInit | undefined, contentType: string | null) {
    if (typeof body !== "string" && !(body instanceof ArrayBuffer)) return "";
    try {
        const parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as Record<string, unknown>;
        return JSON.stringify({ model: typeof parsed.model === "string" ? parsed.model : undefined, duration: numberValue(parsed.duration ?? parsed.seconds), ratio: typeof parsed.ratio === "string" ? parsed.ratio : undefined, referenceCount: Array.isArray(parsed.references) ? parsed.references.length : 0, promptLength: typeof parsed.prompt === "string" ? parsed.prompt.length : 0, contentType: contentType || undefined });
    } catch { return contentType?.includes("json") ? "请求体无法解析为 JSON 摘要" : "请求体已接收（非 JSON 摘要）"; }
}
function readDolaRequestParameters(body: BodyInit | undefined) {
    if (typeof body !== "string" && !(body instanceof ArrayBuffer)) return {} as { requestedDuration?: number; ratio?: string };
    try {
        const parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as Record<string, unknown>;
        const requestedDuration = numberValue(parsed.duration ?? parsed.seconds);
        const ratio = typeof parsed.ratio === "string" ? parsed.ratio.trim().slice(0, 32) : "";
        return { ...(requestedDuration !== undefined ? { requestedDuration } : {}), ...(ratio ? { ratio } : {}) };
    } catch {
        return {} as { requestedDuration?: number; ratio?: string };
    }
}
async function snapshotDolaResponse(response: Response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) return { preview: "流式响应内容未写入日志", bytes: undefined as number | undefined, error: "", taskId: "", verificationId: "", screenshotBase64: "", value: null };
    try {
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        const value = parseDolaJson(bytes);
        const taskId = stringValue(value?.taskId || value?.id);
        const verificationId = stringValue(value?.verificationId || value?.verification_id);
        const screenshotBase64 = typeof value?.screenshotBase64 === "string" ? value.screenshotBase64 : typeof value?.screenshot_base64 === "string" ? value.screenshot_base64 : "";
        const error = stringValue(value?.error || value?.detail);
        if (!value) return { preview: bytes.byteLength ? "Dola Provider 返回了无法解析的响应" : "", bytes: bytes.byteLength, error, taskId, verificationId, screenshotBase64, value: null };
        // Media result URLs stay visible: they are the deliverable the admin needs to see in the log detail.
        const summary = Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|token|secret|password|base64|dataurl/i.test(key)).map(([key, item]) => [key, typeof item === "string" && item.length > 500 ? `${item.slice(0, 500)}…` : item]));
        const rendered = JSON.stringify(summary, null, 2);
        return { preview: rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}…` : rendered, bytes: bytes.byteLength, error, taskId, verificationId, screenshotBase64, value };
    } catch {
        return { preview: "Dola Provider 响应无法读取", bytes: undefined as number | undefined, error: "响应无法读取", taskId: "", verificationId: "", screenshotBase64: "", value: null };
    }
}
function parseDolaJson(bytes: Uint8Array) {
    try { const value = JSON.parse(new TextDecoder().decode(bytes)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function numberValue(value: unknown) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function stringValue(value: unknown) { return typeof value === "string" ? value.slice(0, 500) : ""; }
function dolaCreateResponsePhase(response: Response, value: Record<string, unknown> | null): DolaRequestLogPhase {
    const status = stringValue(value?.status).toLowerCase();
    const hasVerification = Boolean(stringValue(value?.verificationId || value?.verification_id));
    if (hasVerification) return "needs_review";
    if (!response.ok) return "failed";
    const taskId = stringValue(value?.taskId || value?.id);
    // Async task creation only means the upstream accepted the job; it is queued, not finished.
    if (taskId && status !== "completed" && status !== "failed") return "submitted";
    if (taskId) return dolaTaskLogPhase(status, hasVerification);
    return "success";
}
function dolaResultMediaDetail(value: Record<string, unknown> | null) {
    const videoUrl = stringValue(value?.videoUrl || value?.video_url);
    const imageUrls = Array.isArray(value?.imageUrls) ? value.imageUrls.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
    const urls = videoUrl ? [videoUrl] : imageUrls;
    if (!urls.length) return "";
    return urls.length === 1 ? `结果地址: ${urls[0]}` : `结果地址 (${urls.length}): ${urls.slice(0, 3).join(", ")}${urls.length > 3 ? " …" : ""}`;
}
