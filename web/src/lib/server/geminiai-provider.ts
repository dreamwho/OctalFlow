import { appendGeminiAiRequestLog, type GeminiAiRequestCapability, type GeminiAiRequestSource } from "@/lib/server/geminiai-request-log-store";
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
    try {
        await ensureMagicProxyProvider("geminiai");
        const response = await fetch(sidecarUrl(config.baseUrl, normalizedPath), {
            ...init,
            headers,
            cache: "no-store",
            redirect: "error",
        });
        if (metadata) await recordRequestLog(config, metadata, response, startedAt);
        return response;
    } catch (error) {
        if (metadata) await safeAppendRequestLog({ ...metadata, statusCode: error instanceof GeminiAiProviderError ? error.status : 502, durationMs: Date.now() - startedAt, error: providerErrorMessage(error) });
        if (error instanceof GeminiAiProviderError) throw error;
        if (error instanceof MagicProxyError) throw new GeminiAiProviderError(error.message, error.status);
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new GeminiAiProviderError("GeminiAI 服务请求超时", 504);
        throw new GeminiAiProviderError("GeminiAI 服务暂时不可用", 502);
    }
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
};

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
    };
}

function requestBodySummary(body: RequestInit["body"]) {
    if (body instanceof FormData) {
        const model = textValue(body.get("model"));
        const prompt = textValue(body.get("prompt"));
        return { model, preview: prompt ? truncate(prompt) : undefined, googleSearch: false };
    }
    if (typeof body !== "string") return { model: "", preview: undefined, googleSearch: false };
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

async function recordRequestLog(config: NonNullable<ReturnType<typeof readProviderConfig>>, metadata: RequestLogMetadata, response: Response, startedAt: number) {
    const responseAccountId = textValue(response.headers.get("x-aistudio-account-id"));
    const responseAccountEmail = textValue(response.headers.get("x-aistudio-account-email"));
    const account = responseAccountId || responseAccountEmail ? { id: responseAccountId, email: responseAccountEmail } : await activeAccount(config);
    const responsePreview = await safeResponsePreview(response, metadata.capability);
    const error = response.ok ? undefined : responsePreview || `上游返回 HTTP ${response.status}`;
    await safeAppendRequestLog({
        ...metadata,
        ...(account?.id ? { accountId: account.id } : {}),
        ...(account?.email ? { accountEmail: account.email } : {}),
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
        ...(responsePreview ? { responsePreview } : {}),
    });
}

async function activeAccount(config: NonNullable<ReturnType<typeof readProviderConfig>>) {
    try {
        await ensureMagicProxyProvider("geminiai");
        const response = await fetch(sidecarUrl(config.baseUrl, "/accounts/active"), { headers: { authorization: `Bearer ${config.apiKey}` }, cache: "no-store", redirect: "error" });
        if (!response.ok) return null;
        const value = (await response.json()) as { id?: unknown; email?: unknown };
        return { id: textValue(value.id), email: textValue(value.email) };
    } catch {
        return null;
    }
}

async function safeResponsePreview(response: Response, capability: GeminiAiRequestCapability) {
    if (capability === "image" && response.ok) return "已返回图片结果（图片内容未写入日志）";
    if ((response.headers.get("content-type") || "").includes("text/event-stream")) return "流式响应内容未写入日志";
    try {
        const text = await response.clone().text();
        if (!text) return "";
        const value = JSON.parse(text) as Record<string, unknown>;
        const summary = collectText(value) || errorText(value) || text;
        return truncate(summary);
    } catch {
        return "响应内容无法解析";
    }
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
