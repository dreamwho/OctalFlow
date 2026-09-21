import { Agent, fetch as undiciFetch } from "undici";

import { GENERATION_TRANSPORT_TIMEOUT_MS } from "@/lib/server/generation-http-lifecycle";
import { toUndiciRequestBody } from "@/lib/server/undici-request-body";
import {
    appendGeminiAiRequestLog,
    markGeminiAiRequestLogRunning,
    openGeminiAiRequestLog,
    settleGeminiAiRequestLog,
    type GeminiAiRequestCapability,
    type GeminiAiRequestSource,
    type GeminiAiRequestLog,
    type GeminiAiRequestLifecycleEntry,
} from "@/lib/server/geminiai-request-log-store";
import { ensureMagicProxyProvider, MagicProxyError } from "@/lib/server/magic-proxy-service";
import { getGeminiAiGatewaySettings } from "@/lib/server/geminiai-gateway-store";

const GEMINIAI_REQUEST_PATHS = new Set(["/v1/models", "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"]);
const GEMINIAI_GENERATION_PATHS = new Set(["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"]);

export const GEMINIAI_PROTOCOL = "geminiai" as const;
export const GEMINIAI_CHANNEL_ID = "geminiai";
export const GEMINIAI_CHANNEL_NAME = "Gemini AI Studio";

export class GeminiAiProviderError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "GeminiAiProviderError";
    }
}

export function geminiAiProviderConfigured() {
    return Boolean(readProviderConfig());
}

/* Sidecar 长请求（生图大 base64 经慢速代理）必须使用专用 dispatcher，
 * 否则 undici 全局默认 300s headersTimeout 会在上游仍在生成时掐断连接（表现为 fetch failed）。 */
const sidecarDispatcher = new Agent({ headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS, bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS });

export async function geminiAiSidecarRequest(path: string, init: RequestInit = {}, options: { unauthenticated?: boolean; logSource?: GeminiAiRequestSource } = {}) {
    const config = readProviderConfig();
    if (!config) throw new GeminiAiProviderError("GeminiAI 服务尚未配置", 503);
    const normalizedPath = normalizeSidecarPath(path);
    if (!normalizedPath) throw new GeminiAiProviderError("GeminiAI 服务请求路径无效", 400);

    const headers = new Headers(init.headers);
    // Sidecar credentials are owned exclusively by this server. Never forward
    // browser/request credentials to it, including on multipart image edits.
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("cookie");
    if (!options.unauthenticated) headers.set("authorization", `Bearer ${config.apiKey}`);
    // 方案A：生成请求把后台配置的换号次数预算下发给 sidecar，sidecar 在限流/鉴权类错误时自动切换账号。
    if (GEMINIAI_GENERATION_PATHS.has(normalizedPath)) {
        const gateway = await getGeminiAiGatewaySettings().catch(() => ({ enabled: true, rotationLimit: 2 }));
        const rotationLimit = Number(gateway.rotationLimit);
        headers.set("x-aistudio-rotation-limit", String(Number.isFinite(rotationLimit) && rotationLimit > 0 ? Math.floor(rotationLimit) : 1));
    }

    const metadata = requestLogMetadata(normalizedPath, init, options.logSource);
    const startedAt = Date.now();
    const lifecycle: GeminiAiRequestLifecycleEntry[] = [
        {
            phase: "queued",
            message: "受理 GeminiAIStudio 请求并建立调用上下文",
            time: new Date(startedAt).toISOString(),
            durationMs: 0,
            detail: `来源: ${options.logSource || "admin-test"}, 能力: ${metadata?.capability || "text"}, 方法: ${(init.method || "GET").toUpperCase()}, 路径: ${normalizedPath}${metadata?.model ? `, 模型: ${metadata.model}` : ""}`,
        },
    ];
    const openLogId = metadata ? await safeOpenLog(metadata, lifecycle) : "";
    try {
        const binding = await ensureMagicProxyProvider("geminiai");
        if (metadata && binding.egress) metadata.proxyEgress = binding.egress;
        lifecycle.push({
            phase: "routing",
            message: binding.egress ? "代理出口路由绑定完成" : "使用直接连接 (Direct)",
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: binding.egress
                ? `模式: ${binding.egress.mode === "magic" ? "魔法代理" : binding.egress.mode === "chained" ? "链式代理" : "通用代理"}, 节点: ${binding.egress.node_name || binding.egress.address || "默认出口"}`
                : "未配置代理出口，直接连接 sidecar / Google 官方网关",
        });

        lifecycle.push({
            phase: "upstream",
            message: "向 GeminiAI sidecar 发起实际请求",
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: `目标地址: ${sidecarUrl(config.baseUrl, normalizedPath)}, 认证: ${options.unauthenticated ? "未鉴权请求" : "Bearer Token 授权"}`,
        });

        // 必须用 npm undici 的 fetch：Node 内置 fetch 的 dispatcher 与 npm undici Agent 接口不兼容
        // （报 invalid onRequestStart method / fetch failed）。
        const response = await undiciFetch(sidecarUrl(config.baseUrl, normalizedPath), {
            method: init.method,
            headers,
            body: await toUndiciRequestBody(init.body),
            redirect: "error",
            signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS)]) : AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS),
            dispatcher: sidecarDispatcher,
        } as never);

        const rotations = Number(response.headers.get("x-aistudio-rotations"));
        lifecycle.push({
            phase: "response",
            message: `收到上游响应 HTTP ${response.status}`,
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: `状态码: ${response.status}, Content-Type: ${response.headers.get("content-type") || "未知"}${Number.isFinite(rotations) && rotations > 0 ? `, 已自动换号 ${Math.floor(rotations)} 次` : ""}`,
        });

        if (metadata) await recordRequestLog(config, metadata, response as unknown as Response, startedAt, openLogId, lifecycle);
        return response as unknown as Response;
    } catch (error) {
        // undici 的 "fetch failed" 只有 cause 才带真实原因（ECONNREFUSED/ECONNRESET 等），必须单独记录。
        const cause = (error as { cause?: unknown })?.cause;
        lifecycle.push({
            phase: "failed",
            message: providerErrorMessage(error),
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: `${error instanceof Error ? error.stack || error.message : String(error)}${cause ? `\ncause: ${cause instanceof Error ? `${(cause as { code?: string }).code || ""} ${cause.message}` : String(cause)}` : ""}`,
        });
        if (metadata) await safeSettleError(openLogId, metadata, error, startedAt, lifecycle);
        if (error instanceof GeminiAiProviderError) throw error;
        if (error instanceof MagicProxyError) throw new GeminiAiProviderError(error.message, error.status);
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new GeminiAiProviderError("GeminiAI 服务请求超时", 504);
        const causeText = (error as { cause?: unknown })?.cause;
        const causeTextMessage = causeText instanceof Error ? causeText.message : causeText ? String(causeText) : "";
        throw new GeminiAiProviderError(causeTextMessage ? `GeminiAI 服务暂时不可用（${causeTextMessage}）` : "GeminiAI 服务暂时不可用", 502);
    }
}

async function safeOpenLog(metadata: RequestLogMetadata, lifecycle?: GeminiAiRequestLifecycleEntry[]) {
    try {
        const openLogId = await openGeminiAiRequestLog({
            source: metadata.source,
            capability: metadata.capability,
            method: metadata.method,
            path: metadata.path,
            model: metadata.model,
            ...(metadata.requestPreview ? { requestPreview: metadata.requestPreview } : {}),
            ...(metadata.clientIp ? { clientIp: metadata.clientIp } : {}),
            ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
            ...(metadata.headers ? { headers: metadata.headers } : {}),
            ...(lifecycle ? { lifecycle } : {}),
        });
        return openLogId || "";
    } catch (error) {
        console.error("Failed to open GeminiAIStudio request log", error);
        return "";
    }
}

async function safeSettleError(openLogId: string, metadata: RequestLogMetadata, error: unknown, startedAt: number, lifecycle?: GeminiAiRequestLifecycleEntry[]) {
    const message = providerErrorMessage(error);
    const statusCode = error instanceof GeminiAiProviderError ? error.status : 502;
    if (openLogId) {
        try {
            await settleGeminiAiRequestLog(openLogId, { statusCode, durationMs: Date.now() - startedAt, error: message, lifecycle });
            return;
        } catch (persistError) {
            console.error("Failed to settle GeminiAIStudio request log", persistError);
        }
    }
    await safeAppendRequestLog({ ...metadata, statusCode, durationMs: Date.now() - startedAt, error: message, lifecycle });
}

let lastSyncedGeminiAiProxy: string | undefined;

export async function syncGeminiAiRuntimeProxy(proxyUrl: string) {
    const desired = proxyUrl.trim();
    if (lastSyncedGeminiAiProxy === desired) return;
    const config = readProviderConfig();
    if (!config) throw new GeminiAiProviderError("GeminiAI 服务尚未配置", 503);
    const response = await undiciFetch(sidecarUrl(config.baseUrl, "/runtime/proxy"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ proxy_url: desired }),
        cache: "no-store",
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof payload?.detail === "string" ? payload.detail : "GeminiAI 代理切换失败";
        throw new GeminiAiProviderError(detail, response.status);
    }
    lastSyncedGeminiAiProxy = desired;
}

export async function geminiAiRuntimeRequest(path: string, init: RequestInit = {}, options: { logSource?: GeminiAiRequestSource } = {}) {
    const normalizedPath = normalizeRuntimePath(path);
    if (!normalizedPath) throw new GeminiAiProviderError("GeminiAI 不支持该运行时接口", 404);
    return geminiAiSidecarRequest(normalizedPath, init, { logSource: options.logSource || "runtime" });
}

export function isGeminiAiRuntimePath(path: string) {
    return Boolean(normalizeRuntimePath(path));
}

export async function geminiAiHealth() {
    if (!geminiAiProviderConfigured()) return false;
    try {
        const response = await geminiAiSidecarRequest("/health", { signal: AbortSignal.timeout(10_000) }, { unauthenticated: true });
        return response.ok;
    } catch (error) {
        const cause = (error as { cause?: unknown })?.cause;
        console.warn("[geminiai] sidecar health check failed:", error instanceof Error ? error.message : error, cause ? `cause: ${cause instanceof Error ? `${(cause as { code?: string }).code || ""} ${cause.message}` : String(cause)}` : "");
        return false;
    }
}

function readProviderConfig() {
    const value = process.env.DREAMYO_GEMINIAI_URL?.trim() || "";
    const apiKey = process.env.DREAMYO_GEMINIAI_API_KEY?.trim() || "";
    if (!value || !apiKey) return null;
    try {
        const baseUrl = new URL(value);
        if (!isHttpUrl(baseUrl) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return null;
        return { baseUrl, apiKey };
    } catch {
        return null;
    }
}

function sidecarUrl(baseUrl: URL, path: string) {
    const basePath = baseUrl.pathname.replace(/\/+$/, "");
    return new URL(`${basePath}${path}`, baseUrl.origin).toString();
}

function normalizeRuntimePath(value: string) {
    const normalized = normalizeSidecarPath(value);
    if (!normalized) return "";
    const path = normalized.startsWith("/v1/") ? normalized : `/v1${normalized}`;
    return GEMINIAI_REQUEST_PATHS.has(path.split("?")[0]) ? path : "";
}

function normalizeSidecarPath(value: string) {
    const input = value.trim();
    if (!input || !input.startsWith("/") || input.startsWith("//") || /(?:^|\/)\.\.?\//.test(input)) return "";
    try {
        const url = new URL(input, "http://geminiai.local");
        if (url.origin !== "http://geminiai.local") return "";
        return `${url.pathname}${url.search}`;
    } catch {
        return "";
    }
}

function isHttpUrl(url: URL) {
    return url.protocol === "http:" || url.protocol === "https:";
}

type RequestLogMetadata = {
    source: GeminiAiRequestSource;
    capability: GeminiAiRequestCapability;
    method: string;
    path: string;
    model: string;
    requestPreview?: string;
    proxyEgress?: { mode: "magic" | "generic" | "chained"; node_name?: string; address?: string };
    clientIp?: string;
    userAgent?: string;
    headers?: Record<string, string>;
};

function sanitizeLogHeaders(headers?: HeadersInit): Record<string, string> | undefined {
    if (!headers) return undefined;
    const h = new Headers(headers);
    const result: Record<string, string> = {};
    for (const [key, value] of h.entries()) {
        const lower = key.toLowerCase();
        if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") {
            result[key] = "[REDACTED]";
        } else {
            result[key] = value;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
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

function requestLogMetadata(path: string, init: RequestInit, source?: GeminiAiRequestSource): RequestLogMetadata | null {
    const pathname = path.split("?")[0] || "";
    const runtimeCapability = pathname === "/v1/images/generations" || pathname === "/v1/images/edits" ? "image" : pathname === "/v1/chat/completions" ? "text" : null;
    const nativeMatch = pathname.match(/^\/v1beta\/models\/([^/:]+):(streamGenerateContent|generateContent)$/);
    if (!runtimeCapability && !nativeMatch) return null;
    const body = requestBodySummary(init.body);
    const model = body.model || (nativeMatch ? decodeURIComponent(nativeMatch[1] || "") : "");
    if (!model) return null;
    const capability = runtimeCapability === "image" ? "image" : body.googleSearch ? "search" : "text";
    return {
        source: source || "admin-test",
        capability,
        method: (init.method || "GET").toUpperCase(),
        path: pathname,
        model,
        ...(body.preview ? { requestPreview: body.preview } : {}),
        ...(extractClientIp(init.headers) ? { clientIp: extractClientIp(init.headers) } : {}),
        ...(extractUserAgent(init.headers) ? { userAgent: extractUserAgent(init.headers) } : {}),
        ...(sanitizeLogHeaders(init.headers) ? { headers: sanitizeLogHeaders(init.headers) } : {}),
    };
}

function requestBodySummary(body: RequestInit["body"]) {
    if (body instanceof FormData) {
        const model = textValue(body.get("model"));
        const prompt = textValue(body.get("prompt"));
        return { model, preview: prompt ? truncate(prompt) : undefined, googleSearch: false };
    }
    if (typeof body !== "string") {
        // The system-proxy route forwards JSON bodies as ArrayBuffer/Uint8Array.
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
            try {
                const decoded = new TextDecoder().decode(body);
                return requestBodySummary(decoded);
            } catch {
                return { model: "", preview: undefined, googleSearch: false };
            }
        }
        return { model: "", preview: undefined, googleSearch: false };
    }
    try {
        const value = JSON.parse(body) as Record<string, unknown>;
        const text = collectText(value);
        const tools = JSON.stringify(value.tools || value.generationConfig || "").toLowerCase();
        return { model: textValue(value.model), preview: text ? truncate(text) : undefined, googleSearch: tools.includes("google_search") || tools.includes("googlesearch") };
    } catch {
        return { model: "", preview: undefined, googleSearch: false };
    }
}

function collectText(value: Record<string, unknown>) {
    const parts: string[] = [];
    const add = (entry: unknown) => {
        if (typeof entry === "string") parts.push(entry);
        else if (Array.isArray(entry)) entry.forEach(add);
        else if (entry && typeof entry === "object") {
            const object = entry as Record<string, unknown>;
            if (typeof object.text === "string") parts.push(object.text);
            if (typeof object.content === "string") parts.push(object.content);
            else if (Array.isArray(object.content)) add(object.content);
            if (Array.isArray(object.parts)) add(object.parts);
            if (object.message) add(object.message);
            if (object.delta) add(object.delta);
            if (Array.isArray(object.choices)) add(object.choices);
            if (Array.isArray(object.candidates)) add(object.candidates);
        }
    };
    add(value.prompt);
    add(value.messages);
    add(value.contents);
    add(value.choices);
    add(value.candidates);
    return parts.join("\n").trim();
}

function extractResponseMetrics(value: unknown, capability: GeminiAiRequestCapability) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let imageRequestedCount = 0;
    let imageSucceededCount = 0;
    let imageFailedCount = 0;

    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (obj.usage && typeof obj.usage === "object") {
            const usage = obj.usage as Record<string, unknown>;
            promptTokens = Number(usage.prompt_tokens) || 0;
            completionTokens = Number(usage.completion_tokens) || 0;
            totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
        } else if (obj.usageMetadata && typeof obj.usageMetadata === "object") {
            const usage = obj.usageMetadata as Record<string, unknown>;
            promptTokens = Number(usage.promptTokenCount) || 0;
            completionTokens = Number(usage.candidatesTokenCount) || 0;
            totalTokens = Number(usage.totalTokenCount) || promptTokens + completionTokens;
        }

        if (capability === "image") {
            if (Array.isArray(obj.data)) {
                imageRequestedCount = obj.data.length;
                imageSucceededCount = obj.data.filter((item) => {
                    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
                    return Boolean(entry && (entry.url || entry.b64_json));
                }).length;
                imageFailedCount = imageRequestedCount - imageSucceededCount;
            } else if (Array.isArray(obj.images)) {
                imageRequestedCount = obj.images.length;
                imageSucceededCount = obj.images.filter((img) => Boolean(img)).length;
                imageFailedCount = imageRequestedCount - imageSucceededCount;
            }
        }
    }
    return {
        promptTokens,
        completionTokens,
        totalTokens,
        imageRequestedCount,
        imageSucceededCount,
        imageFailedCount,
    };
}

async function activeAccount(config: NonNullable<ReturnType<typeof readProviderConfig>>) {
    try {
        const response = await undiciFetch(sidecarUrl(config.baseUrl, "/accounts/active"), {
            headers: { authorization: `Bearer ${config.apiKey}` },
            cache: "no-store",
        });
        if (!response.ok) return null;
        const payload = (await response.json().catch(() => null)) as { id?: string; email?: string } | null;
        return payload?.id || payload?.email ? { id: payload.id, email: payload.email } : null;
    } catch {
        return null;
    }
}

async function recordRequestLog(config: NonNullable<ReturnType<typeof readProviderConfig>>, metadata: RequestLogMetadata, response: Response, startedAt: number, openLogId = "", lifecycle?: GeminiAiRequestLifecycleEntry[]) {
    const responseAccountId = textValue(response.headers.get("x-aistudio-account-id"));
    const responseAccountEmail = textValue(response.headers.get("x-aistudio-account-email"));
    const account = responseAccountId || responseAccountEmail ? { id: responseAccountId, email: responseAccountEmail } : await activeAccount(config);
    const { preview: responsePreview, metrics } = await safeResponsePreviewAndMetrics(response, metadata.capability);
    const error = response.ok ? undefined : responsePreview || `上游返回 HTTP ${response.status}`;

    if (lifecycle) {
        lifecycle.push({
            phase: response.ok ? "success" : "failed",
            message: response.ok ? "请求处理完成并成功交付客户端" : `上游调用异常: ${error || "HTTP " + response.status}`,
            time: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            detail: response.ok ? `总耗时: ${Date.now() - startedAt}ms, 消耗 Tokens: ${metrics.totalTokens || 0}${account?.email ? `, 账号: ${account.email}` : ""}` : `错误详情: ${error || "上游未返回成功响应"}`,
        });
    }

    const settle: Parameters<typeof settleGeminiAiRequestLog>[1] = {
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
        ...(responsePreview ? { responsePreview } : {}),
        ...(account?.id ? { accountId: account.id } : {}),
        ...(account?.email ? { accountEmail: account.email } : {}),
        ...(metadata.proxyEgress ? { proxyEgress: metadata.proxyEgress satisfies GeminiAiRequestLog["proxyEgress"] } : {}),
        ...(metrics.promptTokens ? { promptTokens: metrics.promptTokens } : {}),
        ...(metrics.completionTokens ? { completionTokens: metrics.completionTokens } : {}),
        ...(metrics.totalTokens ? { totalTokens: metrics.totalTokens } : {}),
        ...(metrics.imageRequestedCount ? { imageRequestedCount: metrics.imageRequestedCount } : {}),
        ...(metrics.imageSucceededCount ? { imageSucceededCount: metrics.imageSucceededCount } : {}),
        ...(metrics.imageFailedCount ? { imageFailedCount: metrics.imageFailedCount } : {}),
        ...(lifecycle ? { lifecycle } : {}),
    };
    if (openLogId) {
        try {
            await settleGeminiAiRequestLog(openLogId, settle);
            return;
        } catch (persistError) {
            console.error("Failed to settle GeminiAIStudio request log", persistError);
        }
    }
    await safeAppendRequestLog({
        ...metadata,
        ...settle,
    });
}

async function safeResponsePreviewAndMetrics(response: Response, capability: GeminiAiRequestCapability) {
    if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
        return { preview: "流式响应内容未写入日志", metrics: extractResponseMetrics(null, capability) };
    }
    try {
        const text = await response.clone().text();
        if (!text) return { preview: "", metrics: extractResponseMetrics(null, capability) };
        const value = JSON.parse(text) as Record<string, unknown>;
        const metrics = extractResponseMetrics(value, capability);
        if (capability === "image") {
            const summarized = summarizeResponseValue(value);
            const rendered = JSON.stringify(summarized, null, 2);
            return {
                preview: rendered.length > 4000 ? `${rendered.slice(0, 4000)}…（结构摘要已截断）` : rendered,
                metrics,
            };
        }
        const summary = collectText(value) || errorText(value) || text;
        return {
            preview: truncate(summary),
            metrics,
        };
    } catch {
        return { preview: "响应内容无法解析", metrics: extractResponseMetrics(null, capability) };
    }
}

function summarizeResponseValue(value: unknown, depth = 0, key = ""): unknown {
    if (typeof value === "string") {
        if (/^data:image\//i.test(value)) return `〔base64 图片数据，约 ${formatByteSize(value.length)}〕`;
        if (/b64|base64/i.test(key)) return `〔base64 图片数据，约 ${formatByteSize(value.length)}〕`;
        if (value.length > 512 && /^[a-z0-9+/=_-]+$/i.test(value.replace(/\s/g, ""))) return `〔base64 数据，约 ${formatByteSize(value.length)}〕`;
        if (value.length > 400) return `${value.slice(0, 400)}…（截断，共 ${value.length} 字符）`;
        return value;
    }
    if (Array.isArray(value)) return value.slice(0, 12).map((item) => summarizeResponseValue(item, depth + 1, key));
    if (value && typeof value === "object" && depth < 6) {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, 40)
                .map(([entryKey, item]) => [entryKey, summarizeResponseValue(item, depth + 1, entryKey)]),
        );
    }
    return value;
}

function formatByteSize(size: number) {
    if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
}

function errorText(value: Record<string, unknown>) {
    const error = value.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") return textValue((error as Record<string, unknown>).message);
    const detail = value.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") return textValue((detail as Record<string, unknown>).message);
    return "";
}

async function safeAppendRequestLog(input: Parameters<typeof appendGeminiAiRequestLog>[0]) {
    try {
        await appendGeminiAiRequestLog(input);
    } catch (error) {
        console.error("Failed to persist GeminiAIStudio request log", error);
    }
}

function providerErrorMessage(error: unknown) {
    return error instanceof Error ? truncate(error.message) : "GeminiAI 服务请求失败";
}

function textValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 800 ? `${normalized.slice(0, 800)}…` : normalized;
}
