import { createHmac, timingSafeEqual } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { GENERATION_TRANSPORT_TIMEOUT_MS } from "@/lib/server/generation-http-lifecycle";
import { ensureMagicProxyProvider, MagicProxyError } from "@/lib/server/magic-proxy-service";
import { limitMediaResponseBody, MAX_MEDIA_PROXY_BYTES } from "@/lib/server/media-response-limit";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { toUndiciRequestBody } from "@/lib/server/undici-request-body";

export class ChatGptApiError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
    }
}

export type ChatGptProxySelection = {
    enabled: boolean;
    mode: "native" | "magic" | "chained";
    native_source: "manual" | "ipwo";
    chained_config?: {
        hop_magic_node_name: string;
        landing_generic_node_id: string;
    };
    magicConfigured: boolean;
    ipwoConfigured: boolean;
};

export type ChatGptProxySelectionPatch = Pick<ChatGptProxySelection, "enabled" | "mode" | "native_source" | "chained_config">;

const dispatcher = new Agent({ headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS, bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS });
export function getChatGptRuntimeConfig() {
    const value = process.env.OCTALAICANVAS_CHATGPT_API_URL?.trim();
    const apiKey = process.env.OCTALAICANVAS_CHATGPT_API_KEY?.trim() || "";
    if (!value || apiKey.length < 32) throw new ChatGptApiError("ChatGPT 运行时未就绪，请运行 services/chatgpt-api/setup.sh 安装环境后重启 pnpm start，或配置内部运行时地址与服务密钥", 503);
    const baseUrl = new URL(value);
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/") throw new ChatGptApiError("ChatGPT 内部运行时地址配置无效", 503);
    return { baseUrl, apiKey };
}

export async function chatGptRuntimeRequest(path: string, init: RequestInit = {}, clientKey?: string) {
    const { baseUrl, apiKey } = getChatGptRuntimeConfig();
    if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("\\") ||
        path
            .split("?")[0]
            .split("/")
            .some((part) => part === ".." || part === ".")
    )
        throw new ChatGptApiError("运行时请求路径无效", 400);
    const headers = new Headers(init.headers);
    headers.set("x-octal-runtime-key", apiKey);
    headers.set("authorization", `Bearer ${clientKey ?? apiKey}`);
    try {
        return (await undiciFetch(new URL(path, baseUrl), {
            method: init.method,
            headers,
            body: await toUndiciRequestBody(init.body),
            redirect: "error",
            cache: "no-store",
            signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS)]) : AbortSignal.timeout(GENERATION_TRANSPORT_TIMEOUT_MS),
            dispatcher,
        })) as unknown as Response;
    } catch {
        throw new ChatGptApiError("ChatGPT 内部运行时连接中断或超时；请检查运行时日志，已提交任务请勿自动重复提交", 502);
    }
}

export async function chatGptRuntimeJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await chatGptRuntimeRequest(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ChatGptApiError(chatGptErrorMessage(payload), response.status);
    if (payload === null) throw new ChatGptApiError("ChatGPT 运行时未返回有效数据");
    return payload as T;
}

export function chatGptErrorMessage(payload: unknown) {
    const value = payload as { error?: { message?: unknown } | string; detail?: { error?: unknown } | string } | null;
    const text = typeof value?.error === "string" ? value.error : value?.error?.message || (typeof value?.detail === "string" ? value.detail : value?.detail?.error);
    return typeof text === "string" ? redactChatGptText(text) : "ChatGPT 运行时操作失败";
}

export function redactChatGptText(value: string) {
    const key = process.env.OCTALAICANVAS_CHATGPT_API_KEY;
    return (key ? value.split(key).join("[redacted]") : value)
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\b(?:access_token|refresh_token|api_key|password|secret)["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "credential=[redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}

export function sanitizeChatGptAdminResult(value: unknown, allowCreatedKey = false): unknown {
    if (typeof value === "string") return redactChatGptText(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeChatGptAdminResult(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !/^(access_token|refresh_token|password|secret|authorization|raw_detail|proxy|raw_key)$/i.test(key) || (key === "raw_key" && allowCreatedKey))
            .map(([key, item]) => [key, key === "raw_key" && allowCreatedKey ? item : sanitizeChatGptAdminResult(item)]),
    );
}

function normalizeChatGptProxySelectionPatch(input: unknown): ChatGptProxySelectionPatch {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ChatGptApiError("代理选择参数无效", 400);
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["enabled", "mode", "native_source", "chained_config"].includes(key))) {
        throw new ChatGptApiError("代理选择参数无效", 400);
    }
    if (
        typeof value.enabled !== "boolean" ||
        (value.mode !== "native" && value.mode !== "magic" && value.mode !== "chained") ||
        (value.native_source !== "manual" && value.native_source !== "ipwo")
    ) {
        throw new ChatGptApiError("代理选择参数无效", 400);
    }
    let chained_config: ChatGptProxySelectionPatch["chained_config"] = undefined;
    if (value.mode === "chained") {
        const config = (value.chained_config as Record<string, unknown> | null | undefined) || {};
        const hop = typeof config.hop_magic_node_name === "string" ? config.hop_magic_node_name.trim() : "";
        const landing = typeof config.landing_generic_node_id === "string" ? config.landing_generic_node_id.trim() : "";
        chained_config = {
            hop_magic_node_name: hop,
            landing_generic_node_id: landing,
        };
    }
    return {
        enabled: value.enabled,
        mode: value.mode,
        native_source: value.native_source,
        ...(chained_config ? { chained_config } : {}),
    };
}

async function syncChatGptMagicProxyAddress() {
    const binding = await ensureMagicProxyProvider("chatgptApi").catch((error: unknown) => {
        if (error instanceof MagicProxyError) throw new ChatGptApiError(error.message, error.status);
        throw error;
    });
    if (!binding.enabled) throw new ChatGptApiError("请先在“魔法代理”页签选择并保存魔法节点，再开启使用魔法代理", 409);
    if (!binding.proxyUrl) throw new ChatGptApiError("ChatGPT 魔法代理缺少独立监听地址", 503);
    await chatGptRuntimeJson("/integration/proxy", { method: "PATCH", body: JSON.stringify({ proxyUrl: binding.proxyUrl }) });
}

export async function getChatGptProxySelection() {
    return chatGptRuntimeJson<ChatGptProxySelection>("/integration/proxy-selection");
}

export async function prepareChatGptMagicProxySelection() {
    await syncChatGptMagicProxyAddress();
}

export async function resolveGenericProxyNodeUrl(nodeId: string): Promise<string> {
    const resolved = await chatGptRuntimeJson<{ url: string }>(
        `/integration/proxy/resolve-node/${encodeURIComponent(nodeId)}`,
    );
    return resolved?.url || "";
}

export async function prepareChatGptChainedProxySelection(chainedConfig: { hop_magic_node_name: string; landing_generic_node_id: string }) {
    await syncChatGptMagicProxyAddress();
    const url = await resolveGenericProxyNodeUrl(chainedConfig.landing_generic_node_id);
    if (!url) throw new ChatGptApiError("指定的通用代理落地节点无效或未包含有效地址", 400);
    const { syncMihomoChainedProxy } = await import("@/lib/server/magic-proxy-service");
    await syncMihomoChainedProxy({
        hopNode: chainedConfig.hop_magic_node_name,
        landingProxyUrl: url,
    });
}

export async function syncChatGptMagicProxy() {
    const selection = await getChatGptProxySelection();
    if (!selection.enabled) return;
    if (selection.mode === "magic") {
        await syncChatGptMagicProxyAddress();
    } else if (selection.mode === "chained" && selection.chained_config) {
        await prepareChatGptChainedProxySelection(selection.chained_config).catch(() => undefined);
    }
}

export async function updateChatGptProxySelection(input: unknown) {
    const selection = normalizeChatGptProxySelectionPatch(input);
    if (selection.enabled && selection.mode === "magic") {
        await prepareChatGptMagicProxySelection();
        const { syncMihomoChainedProxy } = await import("@/lib/server/magic-proxy-service");
        await syncMihomoChainedProxy({});
    } else if (selection.enabled && selection.mode === "chained") {
        if (selection.chained_config?.hop_magic_node_name && selection.chained_config?.landing_generic_node_id) {
            await prepareChatGptChainedProxySelection(selection.chained_config);
        } else {
            throw new ChatGptApiError("请先在“链式代理”配置中选择跳板节点与落地出口，再开启使用链式代理", 400);
        }
    } else {
        const { syncMihomoChainedProxy } = await import("@/lib/server/magic-proxy-service");
        await syncMihomoChainedProxy({}).catch(() => undefined);
    }
    return chatGptRuntimeJson<ChatGptProxySelection>("/integration/proxy-selection", {
        method: "PATCH",
        body: JSON.stringify(selection),
    });
}

const mediaFields = new Set(["url", "image_url", "image", "images", "image[]", "images[]", "image_url[]", "mask", "mask[]", "file_url"]);
export async function resolveChatGptReferences(value: unknown, field = "", signal?: AbortSignal): Promise<unknown> {
    if (typeof value === "string" && mediaFields.has(field)) {
        if (/^https?:\/\//i.test(value)) {
            const response = await fetchSafeOutbound(value, { signal, redirect: "follow" }, { publicOnly: true });
            if (!response.ok) throw new ChatGptApiError("参考图片下载失败", 422);
            const mime = (response.headers.get("content-type") || "").split(";")[0];
            if (!mime.startsWith("image/")) {
                await response.body?.cancel();
                throw new ChatGptApiError("参考素材必须为图片", 422);
            }
            const bytes = await new Response(limitMediaResponseBody(response.body)).arrayBuffer();
            return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
        }
        if (/^(?:file:|ftp:|\/\/)/i.test(value)) throw new ChatGptApiError("参考图片地址不允许访问", 422);
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => resolveChatGptReferences(item, field, signal)));
    if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveChatGptReferences(item, key, signal)])));
    return value;
}

function mediaPath(value: string) {
    try {
        const path = new URL(value, "http://runtime.invalid").pathname;
        return /^\/(?:images|image-thumbnails)\/[A-Za-z0-9_./-]+$/.test(path) && !path.split("/").includes("..") ? path : null;
    } catch {
        return null;
    }
}
function mediaSignature(path: string, expires: string) {
    return createHmac("sha256", getChatGptRuntimeConfig().apiKey).update(`${path}\n${expires}`).digest("base64url");
}
export function rewriteChatGptMedia(value: unknown, origin: string): unknown {
    if (typeof value === "string") {
        const path = mediaPath(value);
        if (!path) return value;
        const expires = String(Date.now() + GENERATION_TRANSPORT_TIMEOUT_MS);
        const url = new URL(`/api/chatgpt-api/media${path}`, origin);
        url.searchParams.set("expires", expires);
        url.searchParams.set("signature", mediaSignature(path, expires));
        return url.toString();
    }
    if (Array.isArray(value)) return value.map((item) => rewriteChatGptMedia(item, origin));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteChatGptMedia(item, origin)]));
    return value;
}
export async function readChatGptSignedMedia(path: string, url: URL, signal: AbortSignal) {
    const expires = url.searchParams.get("expires") || "";
    const signature = url.searchParams.get("signature") || "";
    if (!mediaPath(path) || !/^\d+$/.test(expires) || Number(expires) < Date.now() || Number(expires) > Date.now() + GENERATION_TRANSPORT_TIMEOUT_MS) throw new ChatGptApiError("媒体链接无效或已过期", 403);
    const expected = mediaSignature(path, expires);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new ChatGptApiError("媒体签名无效", 403);
    // A verified result link is delivery, not a new public gateway call.
    // Managed generation must remain downloadable with the public gateway off.
    const response = await chatGptRuntimeRequest(path, { signal, headers: { "x-octal-internal-dispatch": "1" } });
    return new Response(limitMediaResponseBody(response.body, MAX_MEDIA_PROXY_BYTES), {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") || "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
}

export function rewriteChatGptStream(body: ReadableStream<Uint8Array>, origin: string) {
    let pending = "";
    const decoder = new TextDecoder();
    const line = (value: string) => {
        if (!value.startsWith("data:") || value.trim() === "data: [DONE]") return value;
        try {
            return `data: ${JSON.stringify(rewriteChatGptMedia(JSON.parse(value.slice(5)), origin))}`;
        } catch {
            return value;
        }
    };
    return body
        .pipeThrough(
            new TransformStream<Uint8Array, string>({
                transform(chunk, controller) {
                    controller.enqueue(decoder.decode(chunk, { stream: true }));
                },
                flush(controller) {
                    controller.enqueue(decoder.decode());
                },
            }),
        )
        .pipeThrough(
            new TransformStream<string, string>({
                transform(chunk, controller) {
                    pending += chunk;
                    const lines = pending.split("\n");
                    pending = lines.pop() || "";
                    for (const value of lines) controller.enqueue(`${line(value)}\n`);
                },
                flush(controller) {
                    if (pending) controller.enqueue(line(pending));
                },
            }),
        )
        .pipeThrough(new TextEncoderStream());
}
