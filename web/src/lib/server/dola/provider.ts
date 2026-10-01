import { providerTrafficHeaders, trafficBodyModel } from "@/lib/server/traffic-context";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

import { getDolaGatewaySettings } from "./gateway-store";
import { dolaModelProfile } from "./types";
import { observeDolaTaskQuota } from "./account-service";
import { readDolaQuotaReply } from "./quota-observation";

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

export async function dolaHealth(timeoutMs = 2_000) {
    const base = dolaProviderUrl();
    if (!base) return false;
    try {
        const response = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
        return response.ok;
    } catch {
        return false;
    }
}

export function isLocalLoopbackUrl(value: string): boolean {
    if (!value) return false;
    try {
        const hostname = new URL(value).hostname;
        return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
    } catch {
        return false;
    }
}

export function dolaGoogleLoginMode(requestUrl: string, runtime = { platform: process.platform, packaged: process.env.DREAMYO_DESKTOP_PACKAGED === "1", providerUrl: dolaProviderUrl(), preference: process.env.DREAMYO_DOLA_GOOGLE_LOGIN_MODE }): "native" | "remote" {
    if (!isLocalLoopbackUrl(runtime.providerUrl)) return "remote";
    if (runtime.preference === "remote") return "remote";
    const localBrowserAvailable = runtime.packaged || (["darwin", "win32"].includes(runtime.platform) && isLocalLoopbackUrl(requestUrl));
    return localBrowserAvailable ? "native" : "remote";
}

async function findDolaApiRoot(): Promise<string | null> {
    const { existsSync } = await import("node:fs");
    const candidates = [
        path.resolve(process.cwd(), "services", "dola-api"),
        path.resolve(process.cwd(), "..", "services", "dola-api"),
        path.resolve(process.cwd(), "Octal-Canvas", "services", "dola-api"),
    ];
    for (const cand of candidates) {
        if (existsSync(/*turbopackIgnore: true*/ cand) && existsSync(/*turbopackIgnore: true*/ path.join(cand, "src", "dola_api", "app.py"))) {
            return cand;
        }
    }
    return null;
}

let autoStartedChild: ChildProcess | null = null;
let startingPromise: Promise<boolean> | null = null;

export async function ensureLocalDolaProviderReady(base: string): Promise<boolean> {
    if (!isLocalLoopbackUrl(base)) return false;
    if (process.env.DREAMYO_DOLA_API_ENABLED === "0") return false;

    if (await dolaHealth(1_500)) return true;

    if (startingPromise) {
        return startingPromise;
    }

    startingPromise = (async () => {
        try {
            if (await dolaHealth(1_000)) return true;

            const { existsSync } = await import("node:fs");
            const { spawn } = await import("node:child_process");

            const dolaApiRoot = await findDolaApiRoot();
            if (!dolaApiRoot) return false;

            const executable = process.env.DREAMYO_DOLA_PROVIDER_EXECUTABLE?.trim() || "";
            const python = executable || process.env.DREAMYO_DOLA_PROVIDER_PYTHON?.trim() || path.join(dolaApiRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
            if (!existsSync(/*turbopackIgnore: true*/ python)) return false;

            const parsedPort = Number(new URL(base).port) || 18_082;
            const apiKey = process.env.DREAMYO_DOLA_PROVIDER_KEY?.trim() || "";
            const dataRoot = process.env.DREAMYO_DATA_DIR || path.resolve(process.cwd(), "web", ".data");

            const child = spawn(
                /*turbopackIgnore: true*/ python,
                executable ? [] : ["-m", "uvicorn", "dola_api.app:app", "--host", "127.0.0.1", "--port", String(parsedPort)],
                {
                    cwd: dolaApiRoot,
                    env: {
                        ...process.env,
                        DOLA_PROVIDER_KEY: apiKey,
                        DOLA_ENABLE_BROWSER: process.env.DOLA_ENABLE_BROWSER?.trim() || "1",
                        DOLA_BROWSER_ENGINE: process.env.DOLA_BROWSER_ENGINE?.trim() || "camoufox",
                        DOLA_CAMOUFOX_BROWSER: process.env.DOLA_CAMOUFOX_BROWSER?.trim() || "",
                        DOLA_PROVIDER_PORT: String(parsedPort),
                        DOLA_TASK_STATE_PATH: process.env.DOLA_TASK_STATE_PATH?.trim() || path.join(dataRoot, "dola", "provider-tasks.json"),
                        DOLA_PROFILE_DIR: process.env.DOLA_PROFILE_DIR?.trim() || path.join(dataRoot, "dola", "profiles"),
                        PYTHONPATH: [path.join(dolaApiRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
                    },
                    stdio: "ignore",
                    detached: true,
                }
            );

            autoStartedChild = child;
            child.on("error", () => {
                if (autoStartedChild === child) autoStartedChild = null;
            });
            child.on("exit", () => {
                if (autoStartedChild === child) autoStartedChild = null;
            });
            child.unref();

            const deadline = Date.now() + 4_000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 80));
                if (await dolaHealth(800)) {
                    return true;
                }
            }
            return false;
        } catch {
            return false;
        } finally {
            startingPromise = null;
        }
    })();

    return startingPromise;
}

export function formatProviderFetchError(error: unknown, targetUrl: string, base: string): DolaProviderError {
    if (error instanceof DolaProviderError) return error;
    const cause = (error as { cause?: Error & { code?: string; errno?: number; address?: string; port?: number } })?.cause;
    const causeCode = cause?.code || "";
    const causeMessage = cause?.message || "";
    const baseMessage = error instanceof Error ? error.message : String(error);

    if (causeCode === "ECONNREFUSED" || causeMessage.includes("ECONNREFUSED") || baseMessage.includes("ECONNREFUSED")) {
        const isLocal = isLocalLoopbackUrl(base);
        const advice = isLocal
            ? `本地 Dola Provider 服务未运行或端口未开放 (${base})。请确认 services/dola-api 进程已启动。`
            : `Dola Provider 服务连接被拒绝 (${base})，请确认 Provider 主机与网络端口可用。`;
        return new DolaProviderError(`Dola Provider 服务连接失败 (connect ECONNREFUSED): ${advice}`, 502, "connection_refused");
    }

    if (causeCode === "ETIMEDOUT" || causeMessage.includes("ETIMEDOUT") || baseMessage.includes("ETIMEDOUT")) {
        return new DolaProviderError(`Dola Provider 服务连接超时 (${targetUrl})，请检查网络路由与代理连接。`, 504, "connection_timeout");
    }

    if (causeCode === "ENOTFOUND" || causeMessage.includes("ENOTFOUND")) {
        return new DolaProviderError(`Dola Provider 域名无法解析 (${base})，请检查 Provider URL 配置。`, 502, "dns_lookup_failed");
    }

    return new DolaProviderError(`Dola Provider 请求失败 (${targetUrl}): ${causeMessage || baseMessage || "fetch failed"}`, 502, "fetch_failed");
}

export function isDolaRuntimePath(path: string) {
    const normalized = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
    return (
        normalized === "/v1/traffic" ||
        normalized === "/v1/models" ||
        normalized === "/v1/videos" ||
        /^\/v1\/videos\/[^/]+$/.test(normalized) ||
        normalized === "/v1/images" ||
        /^\/v1\/images\/[^/]+$/.test(normalized) ||
        normalized === "/v1/accounts/inspect" ||
        normalized === "/v1/accounts/verify" ||
        normalized === "/v1/accounts/headed-test" ||
        normalized === "/v1/verifications/headed-tests" ||
        normalized === "/v1/accounts/google-login" ||
        normalized === "/v1/accounts/google-login/session" ||
        /^\/v1\/verifications\/[^/]+\/(?:open|input|keyboard|finalize|google-finalize|resume|close)$/.test(normalized)
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

    if (isLocalLoopbackUrl(base)) {
        await ensureLocalDolaProviderReady(base);
    }

    const headers = new Headers(init.headers);
    headers.set("x-dreamyo-internal-dispatch", "1");
    const key = process.env.DREAMYO_DOLA_PROVIDER_KEY?.trim();
    if (key) headers.set("x-api-key", key);
    providerTrafficHeaders(headers, { channelId: DOLA_CHANNEL_ID, channelName: "Dola API", model: trafficBodyModel(init.body), protocol: DOLA_PROTOCOL });
    const targetUrl = `${base}/internal/runtime${path.startsWith("/") ? path : `/${path}`}`;
    try {
        let body = init.body;
        if (init.method?.toUpperCase() === "POST" && (path === "/v1/videos" || path === "/v1/images") && typeof body === "string") {
            let payload: unknown;
            try { payload = JSON.parse(body); } catch { payload = null; }
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                const gateway = await getDolaGatewaySettings();
                body = JSON.stringify({ ...payload, captureFailureScreenshot: gateway.captureFailureScreenshot, pollIntervalMs: gateway.pollIntervalMs, randomFingerprint: gateway.randomFingerprint });
            }
        }
        const response = await fetch(targetUrl, { ...init, body, headers, cache: "no-store" });
        if (!/^\/v1\/(?:videos|images)(?:\/[^/?]+)?(?:\?.*)?$/.test(path) || !response.headers.get("content-type")?.includes("application/json")) return response;
        const value = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
        if (!value || !readDolaQuotaReply(value)) return response;
        const submitted = typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
        const accountId = String(value.accountId || submitted.accountId || "");
        const model = String(value.model || submitted.model || "");
        const quota = accountId ? await observeDolaTaskQuota(accountId, value, model) : null;
        const exhausted = readDolaQuotaReply(value)?.exhausted;
        const result = { ...value, ...(quota ? { quota: [{ ...quota, taskCost: readDolaQuotaReply(value)?.consumed, observations: undefined }] } : {}), ...(exhausted ? { status: "failed", error: "upstream_quota_exhausted" } : {}) };
        const resultHeaders = new Headers(response.headers);
        resultHeaders.delete("content-length");
        resultHeaders.delete("content-encoding");
        return new Response(JSON.stringify(result), { status: response.status, headers: resultHeaders });
    } catch (error) {
        throw formatProviderFetchError(error, targetUrl, base);
    }
}
