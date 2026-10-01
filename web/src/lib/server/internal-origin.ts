import { currentTrafficContext } from "@/lib/server/traffic-context";
import { signedInternalTrafficHeaders } from "@/lib/server/system-ai-billing";
import { Agent, fetch as undiciFetch } from "undici";

import { GENERATION_TRANSPORT_TIMEOUT_MS } from "@/lib/server/generation-http-lifecycle";
import { toUndiciRequestBody } from "@/lib/server/undici-request-body";

const internalDispatcher = new Agent({
    headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS,
    bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS,
});

export function resolveInternalOrigin(publicOrigin: string) {
    const configured = normalizeOrigin(process.env.DREAMYO_INTERNAL_ORIGIN || "");
    if (configured) return configured;

    const publicUrl = parseOrigin(publicOrigin);
    if (publicUrl && isLoopbackHost(publicUrl.hostname)) return publicUrl.origin;
    if (process.env.VERCEL === "1") return publicUrl?.origin || publicOrigin;

    const port = process.env.PORT?.trim();
    if (port) return `http://127.0.0.1:${port}`;
    return publicUrl?.origin || "http://127.0.0.1:3000";
}

export function isInternalApiBaseUrl(baseUrl: string) {
    return baseUrl.trim().startsWith("/");
}

export async function fetchInternalApi(input: string | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.delete("x-dreamyo-internal-traffic");
    headers.delete("x-dreamyo-internal-traffic-signature");
    Object.entries(signedInternalTrafficHeaders(input, init?.method || "GET", currentTrafficContext())).forEach(([key, value]) => headers.set(key, value));
    const body = await toUndiciRequestBody(init?.body);
    return undiciFetch(input, { ...init, headers, body, dispatcher: internalDispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

function normalizeOrigin(value: string) {
    const parsed = parseOrigin(value.trim().replace(/\/+$/, ""));
    return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.origin : "";
}

function parseOrigin(value: string) {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function isLoopbackHost(hostname: string) {
    const host = hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
