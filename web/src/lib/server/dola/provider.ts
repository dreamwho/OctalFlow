import { dolaModelProfile } from "./types";

export const DOLA_PROTOCOL = "dola" as const;
export const DOLA_CHANNEL_ID = "dola";
export const DOLA_CHANNEL_NAME = "Dola API";

export class DolaProviderError extends Error {
    constructor(message: string, readonly status = 502, readonly code = "dola_provider_error") {
        super(message);
        this.name = "DolaProviderError";
    }
}

export function dolaProviderUrl() {
    return process.env.DREAMYO_DOLA_PROVIDER_URL?.trim().replace(/\/+$/, "") || "";
}

export function dolaProviderConfigured() {
    return Boolean(dolaProviderUrl() && process.env.DREAMYO_DOLA_PROVIDER_KEY?.trim());
}

export async function dolaHealth() {
    const base = dolaProviderUrl();
    if (!base) return false;
    try {
        const response = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
        return response.ok;
    } catch {
        return false;
    }
}

export function isDolaRuntimePath(path: string) {
    const normalized = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
    return (
        normalized === "/v1/models" ||
        normalized === "/v1/videos" ||
        /^\/v1\/videos\/[^/]+$/.test(normalized) ||
        normalized === "/v1/images" ||
        /^\/v1\/images\/[^/]+$/.test(normalized) ||
        normalized === "/v1/accounts/inspect" ||
        /^\/v1\/verifications\/[^/]+\/(?:open|input|resume|close)$/.test(normalized)
    );
}

/** Public gateway paths are deliberately narrower than the internal Provider contract. */
export function isDolaPublicRuntimePath(path: string) {
    const normalized = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
    return normalized === "/v1/models" || normalized === "/v1/videos" || /^\/v1\/videos\/[^/]+(?:\/content)?$/.test(normalized) || normalized === "/v1/images" || /^\/v1\/images\/[^/]+$/.test(normalized);
}

export function validateDolaVideoRequest(input: { model: string; duration?: unknown; ratio?: unknown }) {
    const profile = dolaModelProfile(input.model);
    if (!profile) throw new DolaProviderError(`Dola 不支持模型 ${input.model}`, 422, "unsupported_model");
    if (profile.capability === "image") {
        const ratio = typeof input.ratio === "string" ? input.ratio.trim() : "";
        if (ratio && !profile.aspectRatios.includes(ratio)) throw new DolaProviderError(`${profile.label} 不支持比例 ${ratio}`, 422, "unsupported_ratio");
        return { profile, duration: 0, ratio: ratio || "1:1" };
    }
    const duration = Number(input.duration);
    if (!Number.isSafeInteger(duration) || !profile.durations.includes(duration)) throw new DolaProviderError(`${profile.label} 仅支持 ${profile.durations.join("、")} 秒`, 422, "unsupported_duration");
    const ratio = typeof input.ratio === "string" ? input.ratio.trim() : "";
    if (ratio && !profile.aspectRatios.includes(ratio)) throw new DolaProviderError(`${profile.label} 不支持比例 ${ratio}`, 422, "unsupported_ratio");
    return { profile, duration, ratio: ratio || "16:9" };
}

export async function dolaRuntimeRequest(path: string, init: RequestInit = {}) {
    const base = dolaProviderUrl();
    if (!base || !process.env.DREAMYO_DOLA_PROVIDER_KEY?.trim()) throw new DolaProviderError("Dola Camoufox Provider 尚未配置 URL 或服务密钥", 503, "provider_unconfigured");
    if (!isDolaRuntimePath(path)) throw new DolaProviderError("Dola 不支持该运行时接口", 404, "unsupported_path");
    const headers = new Headers(init.headers);
    headers.set("x-dreamyo-internal-dispatch", "1");
    const key = process.env.DREAMYO_DOLA_PROVIDER_KEY?.trim();
    if (key) headers.set("x-api-key", key);
    const response = await fetch(`${base}/internal/runtime${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers, cache: "no-store" });
    return response;
}
