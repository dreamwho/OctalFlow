import { appendGeminiAiRequestLog, markGeminiAiRequestLogRunning, openGeminiAiRequestLog, settleGeminiAiRequestLog, type GeminiAiRequestCapability, type GeminiAiRequestSource, type GeminiAiRequestLog } from "@/lib/server/geminiai-request-log-store";
import { ensureMagicProxyProvider, MagicProxyError } from "@/lib/server/magic-proxy-service";

const GEMINIAI_REQUEST_PATHS = new Set(["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"]);

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

    const metadata = requestLogMetadata(normalizedPath, init, options.logSource);
    const startedAt = Date.now();
    const openLogId = metadata ? await safeOpenLog(metadata) : "";
    try {
        if (openLogId) await markGeminiAiRequestLogRunning(openLogId);
        const binding = await ensureMagicProxyProvider("geminiai");
        if (metadata && binding.egress) metadata.proxyEgress = binding.egress;
        const response = await fetch(sidecarUrl(config.baseUrl, normalizedPath), {
            ...init,
            headers,
            cache: "no-store",
            redirect: "error",
        });
        if (metadata) await recordRequestLog(config, metadata, response, startedAt, openLogId);
        return response;
    } catch (error) {
        if (metadata) await safeSettleError(openLogId, metadata, error, startedAt);
        if (error instanceof GeminiAiProviderError) throw error;
        if (error instanceof MagicProxyError) throw new GeminiAiProviderError(error.message, error.status);
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new GeminiAiProviderError("GeminiAI 服务请求超时", 504);
        throw new GeminiAiProviderError("GeminiAI 服务暂时不可用", 502);
    }
}

async function safeOpenLog(metadata: RequestLogMetadata) {
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
        });
        return openLogId || "";
    } catch (error) {
        console.error("Failed to open GeminiAIStudio request log", error);
        return "";
    }
}

async function safeSettleError(openLogId: string, metadata: RequestLogMetadata, error: unknown, startedAt: number) {
    const message = providerErrorMessage(error);
    const statusCode = error instanceof GeminiAiProviderError ? error.status : 502;
    if (openLogId) {
        try {
            await settleGeminiAiRequestLog(openLogId, { statusCode, durationMs: Date.now() - startedAt, error: message });
            return;
        } catch (persistError) {
            console.error("Failed to settle GeminiAIStudio request log", persistError);
        }
    }
    await safeAppendRequestLog({ ...metadata, statusCode, durationMs: Date.now() - startedAt, error: message });
}

let lastSyncedGeminiAiProxy: string | undefined;

export async function syncGeminiAiRuntimeProxy(proxyUrl: string) {
    const desired = proxyUrl.trim();
    if (lastSyncedGeminiAiProxy === desired) return;
    const config = readProviderConfig();
    if (!config) throw new GeminiAiProviderError("GeminiAI 服务尚未配置", 503);
    const response = await fetch(sidecarUrl(config.baseUrl, "/runtime/proxy"), {
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

export async function geminiAiRuntimeRequest(path: string, init: RequestInit = {}) {
    const normalizedPath = normalizeRuntimePath(path);
    if (!normalizedPath) throw new GeminiAiProviderError("GeminiAI 不支持该运行时接口", 404);
    return geminiAiSidecarRequest(normalizedPath, init, { logSource: "runtime" });
}

export function isGeminiAiRuntimePath(path: string) {
    return Boolean(normalizeRuntimePath(path));
}

export async function geminiAiHealth() {
    if (!geminiAiProviderConfigured()) return false;
    try {
        const response = await geminiAiSidecarRequest("/health", { signal: AbortSignal.timeout(10_000) }, { unauthenticated: true });
        return response.ok;
    } catch {
        return false;
    }
}

function readProviderConfig() {
    const value = process.env.OCTALAICANVAS_GEMINIAI_URL?.trim() || "";
    const apiKey = process.env.OCTALAICANVAS_GEMINIAI_API_KEY?.trim() || "";
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
            totalTokens = Number(usage.total_tokens) || (promptTokens + completionTokens);
        } else if (obj.usageMetadata && typeof obj.usageMetadata === "object") {
            const usage = obj.usageMetadata as Record<string, unknown>;
            promptTokens = Number(usage.promptTokenCount) || 0;
            completionTokens = Number(usage.candidatesTokenCount) || 0;
            totalTokens = Number(usage.totalTokenCount) || (promptTokens + completionTokens);
        }

        if (capability === "image") {
            if (Array.isArray(obj.data)) {
                imageRequestedCount = obj.data.length;
                imageSucceededCount = obj.data.filter((item) => {
                    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
                    const image = item as Record<string, unknown>;
                    return Boolean(image.url || image.b64_json);
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
        const response = await fetch(sidecarUrl(config.baseUrl, "/accounts/active"), {
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

async function recordRequestLog(config: NonNullable<ReturnType<typeof readProviderConfig>>, metadata: RequestLogMetadata, response: Response, startedAt: number, openLogId = "") {
    const responseAccountId = textValue(response.headers.get("x-aistudio-account-id"));
    const responseAccountEmail = textValue(response.headers.get("x-aistudio-account-email"));
    const account = responseAccountId || responseAccountEmail ? { id: responseAccountId, email: responseAccountEmail } : await activeAccount(config);
    const { preview: responsePreview, metrics } = await safeResponsePreviewAndMetrics(response, metadata.capability);
    const error = response.ok ? undefined : responsePreview || `上游返回 HTTP ${response.status}`;
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
        return Object.fromEntries(Object.entries(value).slice(0, 40).map(([entryKey, item]) => [entryKey, summarizeResponseValue(item, depth + 1, entryKey)]));
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
