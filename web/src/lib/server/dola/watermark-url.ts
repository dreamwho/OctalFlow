import { createDecipheriv, createHash } from "node:crypto";

import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export const DOLA_WATERMARK_RESOLVER_REVISION = "dola-vod-qaab-v1";
const QAAB_SALT = Buffer.from("4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58", "hex");

export class DolaWatermarkError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = "DolaWatermarkError";
    }
}

export type DolaVodVariant = {
    token: string;
    width: number;
    height: number;
    duration: number;
    codecType: string;
    definition: string;
};

export type DolaWatermarkResolution = {
    fallbackApi: string;
    downloadUrl: string;
    variant: DolaVodVariant;
    resolverRevision: typeof DOLA_WATERMARK_RESOLVER_REVISION;
};

type DolaWatermarkFetchOptions = {
    proxyUrl?: string;
    fetchJson?: (url: string) => Promise<unknown>;
};

/** Extract the first trusted Dola fallback_api from a response or nested JSON string. */
export function extractDolaFallbackApi(value: unknown): string | null {
    const seen = new Set<unknown>();
    const visit = (node: unknown, depth: number): string | null => {
        if (depth > 10 || node == null) return null;
        if (typeof node === "string") {
            const direct = normalizeCandidate(node);
            if (direct) return direct;
            const trimmed = node.trim();
            if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 2_000_000) {
                try {
                    return visit(JSON.parse(trimmed), depth + 1);
                } catch {
                    return null;
                }
            }
            return null;
        }
        if (typeof node !== "object" || seen.has(node)) return null;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = visit(item, depth + 1);
                if (found) return found;
            }
            return null;
        }
        const record = node as Record<string, unknown>;
        if (typeof record.fallback_api === "string") {
            const found = normalizeCandidate(record.fallback_api);
            if (found) return found;
        }
        for (const item of Object.values(record)) {
            const found = visit(item, depth + 1);
            if (found) return found;
        }
        return null;
    };
    return visit(value, 0);
}

export function buildDolaUnwatermarkedUrl(fallbackApi: string): string {
    const url = parseAllowedUrl(fallbackApi, "fallback API");
    url.searchParams.set("channel", "no");
    url.searchParams.set("codec_type", "8");
    url.searchParams.set("logo_type", "unwatermarked");
    return url.toString();
}

export function resolveDolaWatermarkUrl(payload: unknown): DolaWatermarkResolution {
    const fallbackApi = extractDolaFallbackApi(payload);
    if (!fallbackApi) throw new DolaWatermarkError("Dola 原始结果缺少 fallback_api", "SOURCE_METADATA_UNAVAILABLE");
    return resolveDolaWatermarkResolution(payload, payload, fallbackApi);
}

/**
 * Resolve the actual no-watermark VOD response. Dola's original task response
 * only contains a signed fallback_api; the verified contract requires a fresh
 * GET with channel=no, codec_type=8 and logo_type=unwatermarked.
 */
export async function resolveDolaWatermarkUrlRemote(payload: unknown, options: DolaWatermarkFetchOptions = {}): Promise<DolaWatermarkResolution> {
    const fallbackApi = extractDolaFallbackApi(payload);
    if (!fallbackApi) throw new DolaWatermarkError("Dola 原始结果缺少 fallback_api", "SOURCE_METADATA_UNAVAILABLE");
    const requestUrl = buildDolaUnwatermarkedUrl(fallbackApi);
    let vodPayload: unknown;
    try {
        if (options.fetchJson) {
            vodPayload = await options.fetchJson(requestUrl);
        } else {
            const response = await fetchSafeOutbound(
                requestUrl,
                { method: "GET", headers: { accept: "application/json,text/plain,*/*" }, cache: "no-store", redirect: "follow" },
                { allowProxyFakeIpSpace: true, ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}) },
            );
            if (!response.ok) throw new DolaWatermarkError(`Dola 无水印 VOD 请求失败（HTTP ${response.status}）`, "VOD_FETCH_FAILED");
            try {
                vodPayload = await response.json();
            } catch {
                throw new DolaWatermarkError("Dola 无水印 VOD 返回了无效 JSON", "VOD_JSON_INVALID");
            }
        }
    } catch (error) {
        if (error instanceof DolaWatermarkError) throw error;
        throw new DolaWatermarkError("Dola 无水印 VOD 请求失败", "VOD_FETCH_FAILED");
    }
    return resolveDolaWatermarkResolution(payload, vodPayload, fallbackApi);
}

function resolveDolaWatermarkResolution(sourcePayload: unknown, vodPayload: unknown, fallbackApi: string): DolaWatermarkResolution {
    const data = getVideoData(vodPayload);
    const variant = pickVariant(data);
    if (!variant) throw new DolaWatermarkError("Dola 原始结果缺少可用视频变体", "VOD_VARIANT_UNAVAILABLE");
    const keySeed = findKeySeed(vodPayload) || findKeySeed(sourcePayload);
    const downloadUrl = decodeDolaVideoUrl(variant.token, keySeed);
    return { fallbackApi, downloadUrl, variant, resolverRevision: DOLA_WATERMARK_RESOLVER_REVISION };
}

export function decodeDolaVideoUrl(token: string, keySeed?: string): string {
    const value = token.trim();
    if (!value) throw new DolaWatermarkError("Dola 视频地址为空", "VOD_TOKEN_EMPTY");
    if (/^https:\/\//i.test(value)) return parseAllowedUrl(value, "视频地址").toString();
    const bytes = decodeBase64(value);
    if (!bytes) throw new DolaWatermarkError("Dola 视频地址编码无效", "UNSUPPORTED_URL_TOKEN");
    const direct = printableUrl(bytes);
    if (direct) return parseAllowedUrl(direct, "视频地址").toString();
    if (!value.startsWith("qAAB") || !keySeed) throw new DolaWatermarkError("Dola 视频地址缺少可验证的 key_seed", "UNSUPPORTED_URL_TOKEN");
    const seed = decodeBase64(keySeed);
    if (!seed || seed.length < 32) throw new DolaWatermarkError("Dola 视频地址 key_seed 无效", "UNSUPPORTED_URL_TOKEN");
    const digest1 = createHash("sha512").update(seed.subarray(0, 32)).digest();
    const digest2 = createHash("sha512").update(Buffer.concat([digest1, QAAB_SALT])).digest();
    const key = digest2.subarray(0, 16);
    const iv = digest2.subarray(16, 32);

    const attempts: Array<{ payload: Buffer; key: Buffer; iv: Buffer }> = [];
    if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0xa8, 0x00, 0x01, 0x00]))) {
        attempts.push({ payload: bytes.subarray(4), key, iv });
        attempts.push({ payload: bytes.subarray(4), key: iv, iv: key });
        if (bytes.length > 36) {
            attempts.push({ payload: bytes.subarray(36), key, iv: bytes.subarray(20, 36) });
            attempts.push({ payload: bytes.subarray(36), key, iv });
        }
    } else {
        attempts.push({ payload: bytes, key, iv });
    }

    for (const attempt of attempts) {
        if (!attempt.payload.length || attempt.payload.length % 16 !== 0) continue;
        try {
            const decipher = createDecipheriv("aes-128-cbc", attempt.key, attempt.iv);
            decipher.setAutoPadding(false);
            const plain = Buffer.concat([decipher.update(attempt.payload), decipher.final()]);
            const direct = printableUrl(plain);
            if (direct) return parseAllowedUrl(direct, "视频地址").toString();
            const stripped = stripPkcs7(plain);
            const url = printableUrl(stripped);
            if (url) return parseAllowedUrl(url, "视频地址").toString();
        } catch (error) {
            if (error instanceof DolaWatermarkError) throw error;
            // Continue trying fallback attempts
        }
    }

    throw new DolaWatermarkError("Dola 视频地址解码失败", "UNSUPPORTED_URL_TOKEN");
}

function stripPkcs7(bytes: Buffer): Buffer {
    if (!bytes || !bytes.length) return Buffer.alloc(0);
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
    for (let i = bytes.length - pad; i < bytes.length; i++) {
        if (bytes[i] !== pad) return bytes;
    }
    return bytes.subarray(0, bytes.length - pad);
}

function getVideoData(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== "object") return {};
    const record = payload as Record<string, unknown>;
    const dataWrapper = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : undefined;
    const nested = record.video_info && typeof record.video_info === "object"
        ? record.video_info as Record<string, unknown>
        : dataWrapper?.video_info && typeof dataWrapper.video_info === "object"
          ? dataWrapper.video_info as Record<string, unknown>
          : dataWrapper || record;
    const data = nested.data && typeof nested.data === "object" ? nested.data : nested;
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function pickVariant(data: Record<string, unknown>): DolaVodVariant | null {
    const videoList = data.video_list && typeof data.video_list === "object" ? Object.values(data.video_list as Record<string, unknown>) : [data];
    let best: DolaVodVariant | null = null;
    for (const item of videoList) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const token = typeof record.main_url === "string" ? record.main_url : typeof record.play_url === "string" ? record.play_url : "";
        if (!token.trim()) continue;
        const current: DolaVodVariant = {
            token: token.trim(),
            width: numberValue(record.vwidth ?? record.width ?? data.vwidth ?? data.width),
            height: numberValue(record.vheight ?? record.height ?? data.vheight ?? data.height),
            duration: numberValue(record.duration ?? data.duration),
            codecType: stringValue(record.codec_type ?? data.codec_type),
            definition: stringValue(record.definition ?? data.definition),
        };
        if (!best || current.width * current.height > best.width * best.height) best = current;
    }
    return best;
}

function findKeySeed(value: unknown, depth = 0): string {
    if (depth > 10 || value == null) return "";
    if (typeof value === "string") {
        const match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i) || value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
        return match ? safeDecodeURIComponent(match[1]) : "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    if (typeof record.key_seed === "string" && record.key_seed.trim()) return record.key_seed.trim();
    for (const item of Object.values(record)) {
        const found = findKeySeed(item, depth + 1);
        if (found) return found;
    }
    return "";
}

function normalizeCandidate(value: string): string | null {
    let candidate = value.trim();
    for (let index = 0; index < 3; index += 1) {
        candidate = candidate.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
        try {
            const parsed = JSON.parse(`"${candidate.replace(/"/g, '\\"')}"`);
            if (typeof parsed !== "string" || parsed === candidate) break;
            candidate = parsed;
        } catch {
            break;
        }
    }
    try {
        const url = parseAllowedUrl(candidate, "fallback API");
        return url.toString();
    } catch {
        return null;
    }
}

function parseAllowedUrl(value: string, label: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new DolaWatermarkError(`Dola ${label}格式无效`, "UNSAFE_URL");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !isAllowedDolaHost(url.hostname)) {
        throw new DolaWatermarkError(`Dola ${label}地址不在允许范围`, "UNSAFE_URL");
    }
    url.username = "";
    url.password = "";
    return url;
}

function isAllowedDolaHost(hostname: string) {
    const configured = (process.env.DREAMYO_DOLA_VOD_HOST_SUFFIXES || "dola.com,byteintlapi.com").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return configured.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function decodeBase64(value: string): Buffer | null {
    const candidates = [value, value.replace(/[$@#]/g, (char) => ({ $: "_", "@": "/", "#": "." })[char] || char), value.replace(/[$@#]/g, (char) => ({ $: "+", "@": "/", "#": "=" })[char] || char)];
    for (const candidate of candidates) {
        try {
            const normalized = candidate.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=").padEnd(Math.ceil(candidate.length / 4) * 4, "=");
            const result = Buffer.from(normalized, "base64");
            if (result.length) return result;
        } catch {
            // Try the next known representation.
        }
    }
    return null;
}

function printableUrl(value: Buffer | Uint8Array): string | null {
    if (!value.length) return null;
    const stripped = Buffer.isBuffer(value) ? stripPkcs7(value) : stripPkcs7(Buffer.from(value));
    const text = stripped.toString("utf8").replace(/[\u0000-\u001f\u007f]+$/g, "").trim();
    if (/^https?:\/\//i.test(text)) return text;
    const rawText = Buffer.from(value).toString("utf8").replace(/[\u0000-\u001f\u007f]+$/g, "").trim();
    return /^https?:\/\//i.test(rawText) ? rawText : null;
}
function numberValue(value: unknown) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function stringValue(value: unknown) { return typeof value === "string" ? value.slice(0, 100) : ""; }
function safeDecodeURIComponent(value: string) { try { return decodeURIComponent(value); } catch { return value; } }
