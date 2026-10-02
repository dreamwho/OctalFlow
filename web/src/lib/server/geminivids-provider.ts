import { Agent, fetch as undiciFetch } from "undici";

import { GENERATION_TRANSPORT_TIMEOUT_MS } from "@/lib/server/generation-http-lifecycle";
import { toUndiciRequestBody } from "@/lib/server/undici-request-body";
import {
    appendGeminiVidsRequestLog,
    settleGeminiVidsRequestLog,
    type GeminiVidsRequestLog,
    type GeminiVidsRequestSource,
} from "@/lib/server/geminivids-request-log-store";
import { providerTrafficHeaders, trafficBodyModel } from "@/lib/server/traffic-context";

/** Sidecar 运行时路径白名单：视频任务 + 管理面。 */
const GEMINIVIDS_REQUEST_PATHS = new Set(["/v1/videos", "/health", "/stats", "/runtime/proxy", "/accounts", "/accounts/active", "/accounts/import-cookies", "/accounts/import-storage-state"]);

export const GEMINIVIDS_PROTOCOL = "geminivids" as const;
export const GEMINIVIDS_CHANNEL_ID = "geminivids";
export const GEMINIVIDS_CHANNEL_NAME = "GeminiVids";

export class GeminiVidsProviderError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "GeminiVidsProviderError";
    }
}

export function geminiVidsProviderConfigured() {
    return Boolean(readProviderConfig());
}

/* 长驻生成请求（最长 7 分钟）需要专用 dispatcher，避免 undici 默认 300s 超时掐断。 */
const sidecarDispatcher = new Agent({ headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS, bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS });

export async function geminiVidsSidecarRequest(path: string, init: RequestInit = {}, options: { unauthenticated?: boolean; logSource?: GeminiVidsRequestSource; skipLog?: boolean } = {}) {
    const config = readProviderConfig();
    if (!config) throw new GeminiVidsProviderError("GeminiVids 服务尚未配置", 503);
    const normalizedPath = normalizeSidecarPath(path);
    if (!normalizedPath) throw new GeminiVidsProviderError("GeminiVids 服务请求路径无效", 400);

    const headers = new Headers(init.headers);
    // Sidecar 凭据只归本服务器所有，绝不转发浏览器/请求方凭据。
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("cookie");
    if (!options.unauthenticated) headers.set("authorization", `Bearer ${config.apiKey}`);
    providerTrafficHeaders(headers, { channelId: GEMINIVIDS_CHANNEL_ID, channelName: GEMINIVIDS_CHANNEL_NAME, model: trafficBodyModel(init.body), protocol: GEMINIVIDS_PROTOCOL });

    const metadata = requestLogMetadata(normalizedPath, init, options.logSource);
    const startedAt = Date.now();
    const openLogId = metadata && !options.skipLog ? await safeOpenLog(metadata) : "";
    try {
        if (openLogId) await settleGeminiVidsRequestLog(openLogId, { phase: "upstream" }).catch(() => undefined);
        const response = await undiciFetch(sidecarUrl(config.baseUrl, normalizedPath), {
            method: init.method,
            headers,
            body: await toUndiciRequestBody(init.body),
            redirect: "error",
            signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS)]) : AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS),
            dispatcher: sidecarDispatcher,
        } as never);
        if (metadata && !options.skipLog) {
            const preview = await safePreview(response as unknown as Response);
            await safeSettle(openLogId, metadata, {
                statusCode: response.status,
                durationMs: Date.now() - startedAt,
                ...(preview ? { responsePreview: preview } : {}),
                ...(response.ok ? { phase: "success" } : { phase: "failed", error: preview || `上游返回 HTTP ${response.status}` }),
            });
        }
        return response as unknown as Response;
    } catch (error) {
        const message = providerErrorMessage(error);
        if (metadata && !options.skipLog) {
            await safeSettle(openLogId, metadata, { statusCode: 502, durationMs: Date.now() - startedAt, phase: "failed", error: message });
        }
        if (error instanceof GeminiVidsProviderError) throw error;
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new GeminiVidsProviderError("GeminiVids 服务请求超时", 504);
        const causeText = (error as { cause?: unknown })?.cause;
        const causeMessage = causeText instanceof Error ? causeText.message : causeText ? String(causeText) : "";
        throw new GeminiVidsProviderError(causeMessage ? `GeminiVids 服务暂时不可用（${causeMessage}）` : "GeminiVids 服务暂时不可用", 502);
    }
}

export async function geminiVidsRuntimeRequest(path: string, init: RequestInit = {}, options: { logSource?: GeminiVidsRequestSource } = {}) {
    const normalized = normalizeRuntimePath(path);
    if (!normalized) throw new GeminiVidsProviderError("GeminiVids 不支持该运行时接口", 404);
    return geminiVidsSidecarRequest(normalized, init, { logSource: options.logSource || "runtime" });
}

export function isGeminiVidsRuntimePath(path: string) {
    return Boolean(normalizeRuntimePath(path));
}

export async function geminiVidsHealth() {
    if (!geminiVidsProviderConfigured()) return false;
    try {
        const response = await geminiVidsSidecarRequest("/health", { signal: AbortSignal.timeout(10_000) }, { unauthenticated: true, skipLog: true });
        return response.ok;
    } catch (error) {
        console.warn("[geminivids] sidecar health check failed:", error instanceof Error ? error.message : error);
        return false;
    }
}

export async function syncGeminiVidsRuntimeProxy(proxyUrl: string) {
    const desired = proxyUrl.trim();
    const config = readProviderConfig();
    if (!config) throw new GeminiVidsProviderError("GeminiVids 服务尚未配置", 503);
    const response = await undiciFetch(sidecarUrl(config.baseUrl, "/runtime/proxy"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ proxy_url: desired }),
        cache: "no-store",
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { detail?: { message?: string } | string } | null;
        const detail = typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message;
        throw new GeminiVidsProviderError(detail || "GeminiVids 代理切换失败", response.status);
    }
}

function readProviderConfig() {
    const value = process.env.DREAMYO_GEMINIVIDS_URL?.trim() || "";
    const apiKey = process.env.DREAMYO_GEMINIVIDS_API_KEY?.trim() || "";
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
    const pathname = normalized.split("?")[0];
    // 运行时只放行：创建 / 查询 / 删除任务 / 媒体下载（/media 与 /content 等价）
    if (pathname === "/v1/videos") return normalized;
    const taskMatch = pathname.match(/^\/v1\/videos\/([^/]+)(?:\/media|\/content)?$/);
    if (taskMatch) return normalized;
    return "";
}

function normalizeSidecarPath(value: string) {
    const input = value.trim();
    if (!input || !input.startsWith("/") || input.startsWith("//") || /(?:^|\/)\.\.?\//.test(input)) return "";
    try {
        const url = new URL(input, "http://geminivids.local");
        if (url.origin !== "http://geminivids.local") return "";
        return `${url.pathname}${url.search}`;
    } catch {
        return "";
    }
}

function isHttpUrl(url: URL) {
    return url.protocol === "http:" || url.protocol === "https:";
}

type RequestLogMetadata = {
    source: GeminiVidsRequestSource;
    method: string;
    path: string;
    model: string;
    promptPreview?: string;
    requestPreview?: string;
    clientIp?: string;
    userAgent?: string;
};

function requestLogMetadata(path: string, init: RequestInit, source?: GeminiVidsRequestSource): RequestLogMetadata | null {
    const pathname = path.split("?")[0] || "";
    if (!pathname.startsWith("/v1/videos")) return null;
    const body = bodySummary(init.body);
    return {
        source: source || "admin-test",
        method: (init.method || "GET").toUpperCase(),
        path: pathname,
        model: body.model || "google-vids-omni",
        ...(body.preview ? { promptPreview: body.preview, requestPreview: body.preview } : {}),
        ...(clientIp(init.headers) ? { clientIp: clientIp(init.headers) } : {}),
        ...(userAgent(init.headers) ? { userAgent: userAgent(init.headers) } : {}),
    };
}

function bodySummary(body: RequestInit["body"]) {
    if (typeof body !== "string") {
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
            try {
                return bodySummary(new TextDecoder().decode(body));
            } catch {
                return { model: "", preview: undefined };
            }
        }
        return { model: "", preview: undefined };
    }
    try {
        const value = JSON.parse(body) as Record<string, unknown>;
        const prompt = typeof value.prompt === "string" ? value.prompt : "";
        return { model: typeof value.model === "string" ? value.model : "", preview: prompt ? `${prompt.slice(0, 400)}${prompt.length > 400 ? "…" : ""}` : undefined };
    } catch {
        return { model: "", preview: undefined };
    }
}

function clientIp(headers?: HeadersInit) {
    if (!headers) return undefined;
    const h = new Headers(headers);
    return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
}

function userAgent(headers?: HeadersInit) {
    if (!headers) return undefined;
    return new Headers(headers).get("user-agent") || undefined;
}

async function safeOpenLog(metadata: RequestLogMetadata) {
    try {
        return (await appendGeminiVidsRequestLog({
            source: metadata.source,
            capability: "video",
            method: metadata.method,
            path: metadata.path,
            model: metadata.model,
            ...(metadata.promptPreview ? { promptPreview: metadata.promptPreview, requestPreview: metadata.requestPreview } : {}),
            ...(metadata.clientIp ? { clientIp: metadata.clientIp } : {}),
            ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
            phase: "queued",
        })) || "";
    } catch (error) {
        console.error("Failed to open GeminiVids request log", error);
        return "";
    }
}

type SettlePatch = Partial<GeminiVidsRequestLog>;

async function safeSettle(openLogId: string, metadata: RequestLogMetadata, patch: SettlePatch) {
    try {
        if (openLogId) {
            await settleGeminiVidsRequestLog(openLogId, patch);
            return;
        }
        await appendGeminiVidsRequestLog({ ...metadata, capability: "video", ...patch } as Partial<GeminiVidsRequestLog> & Pick<GeminiVidsRequestLog, "source" | "method" | "path">);
    } catch (error) {
        console.error("Failed to settle GeminiVids request log", error);
    }
}

async function safePreview(response: Response) {
    try {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("video/")) return "〔视频流，已省略〕";
        const text = await response.clone().text();
        if (!text) return "";
        return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
    } catch {
        return "";
    }
}

function providerErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "GeminiVids 服务请求失败";
}
