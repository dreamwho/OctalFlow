import { describe, expect, it, vi } from "vitest";

import {
    dolaGoogleLoginMode,
    dolaRuntimeRequest,
    formatProviderFetchError,
    isDolaPublicRuntimePath,
    isDolaRuntimePath,
    isLocalLoopbackUrl,
    validateDolaVideoRequest,
} from "./provider";
import { dolaProviderProxyMode } from "./proxy";

describe("Dola provider paths", () => {
    it("keeps internal account inspection out of the public gateway", () => {
        expect(isDolaRuntimePath("/v1/accounts/inspect")).toBe(true);
        expect(isDolaRuntimePath("/v1/accounts/verify")).toBe(true);
        expect(isDolaRuntimePath("/v1/verifications/dola-verification-1/open")).toBe(true);
        expect(isDolaPublicRuntimePath("/v1/accounts/inspect")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/accounts/verify")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/verifications/dola-verification-1/open")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/chat/completions")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/videos/task-1/content")).toBe(true);
    });

    it("accepts the two model duration contracts independently", () => {
        expect(validateDolaVideoRequest({ model: "dola-seedance-2-5", duration: 30, ratio: "21:9" }).profile.id).toBe("dola-seedance-2-5");
        expect(() => validateDolaVideoRequest({ model: "dola-seedance-2-0-fast", duration: 30, ratio: "16:9" })).toThrow(/仅支持/);
    });

    it("maps a generic proxy binding to the provider managed mode", () => {
        expect(dolaProviderProxyMode({ mode: "direct" })).toBe("direct");
        expect(dolaProviderProxyMode({ mode: "generic", target: "node:tw" })).toBe("managed");
        expect(dolaProviderProxyMode({ mode: "magic", nodeName: "Tokyo-01" })).toBe("managed");
        expect(dolaProviderProxyMode({ mode: "chained", nodeName: "jump ➔ landing" })).toBe("managed");
    });

    it("identifies local loopback provider urls", () => {
        expect(isLocalLoopbackUrl("http://127.0.0.1:18082")).toBe(true);
        expect(isLocalLoopbackUrl("http://localhost:18082")).toBe(true);
        expect(isLocalLoopbackUrl("http://[::1]:18082")).toBe(true);
        expect(isLocalLoopbackUrl("https://dola.example.com")).toBe(false);
        expect(isLocalLoopbackUrl("invalid-url")).toBe(false);
    });

    it("opens a native browser only for a local desktop or local macOS/Windows page", () => {
        const localProvider = "http://127.0.0.1:18082";
        const runtime = { providerUrl: localProvider, preference: undefined };
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { ...runtime, platform: "darwin", packaged: false })).toBe("native");
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { ...runtime, platform: "win32", packaged: false })).toBe("native");
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { ...runtime, platform: "linux", packaged: true })).toBe("native");
        expect(dolaGoogleLoginMode("https://site.example.com/admin", { ...runtime, platform: "darwin", packaged: false })).toBe("remote");
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { ...runtime, platform: "linux", packaged: false })).toBe("remote");
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { platform: "darwin", packaged: true, providerUrl: "https://provider.example.com", preference: "native" })).toBe("remote");
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { ...runtime, platform: "darwin", packaged: false, preference: "remote" })).toBe("remote");
        expect(dolaGoogleLoginMode("https://site.example.com/admin", { ...runtime, platform: "darwin", packaged: false, preference: "native" })).toBe("remote");
        expect(dolaGoogleLoginMode("http://127.0.0.1:3000/admin", { ...runtime, platform: "linux", packaged: false, preference: "native" })).toBe("remote");
    });

    it("formats network connection errors into clear DolaProviderError instances", () => {
        const connRefusedError = new TypeError("fetch failed");
        Object.assign(connRefusedError, { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18082"), { code: "ECONNREFUSED" }) });

        const formatted = formatProviderFetchError(connRefusedError, "http://127.0.0.1:18082/internal/runtime/v1/videos", "http://127.0.0.1:18082");
        expect(formatted.status).toBe(502);
        expect(formatted.code).toBe("connection_refused");
        expect(formatted.message).toContain("ECONNREFUSED");
        expect(formatted.message).toContain("127.0.0.1:18082");

        const timeoutError = new TypeError("fetch failed");
        Object.assign(timeoutError, { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) });
        const timeoutFormatted = formatProviderFetchError(timeoutError, "http://127.0.0.1:18082/internal/runtime/v1/videos", "http://127.0.0.1:18082");
        expect(timeoutFormatted.status).toBe(504);
        expect(timeoutFormatted.code).toBe("connection_timeout");
    });

    it("maps unexpected fetch failure to DolaProviderError in dolaRuntimeRequest", async () => {
        vi.stubEnv("DREAMYO_DOLA_PROVIDER_URL", "http://127.0.0.1:18082");
        vi.stubEnv("DREAMYO_DOLA_PROVIDER_KEY", "test-key");
        vi.stubEnv("DREAMYO_DOLA_API_ENABLED", "0"); // Disable auto-spawn in mock test

        const connRefused = new TypeError("fetch failed");
        Object.assign(connRefused, { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18082"), { code: "ECONNREFUSED" }) });
        vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(connRefused);

        await expect(dolaRuntimeRequest("/v1/videos", { method: "POST" })).rejects.toThrow(/ECONNREFUSED/);
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });
});

describe("Dola provider runtime request fingerprint flag", () => {
    it("injects the admin randomFingerprint toggle into submit payloads", async () => {
        const { mkdtemp, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const directory = await mkdtemp(join(tmpdir(), "dreamyo-dola-provider-"));
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
        vi.stubEnv("DREAMYO_ENCRYPTION_KEY", "c".repeat(64));
        vi.stubEnv("DREAMYO_DOLA_PROVIDER_URL", "https://provider.example.com");
        vi.stubEnv("DREAMYO_DOLA_PROVIDER_KEY", "test-key");
        const { updateDolaGatewaySettings } = await import("./gateway-store");
        await updateDolaGatewaySettings({ randomFingerprint: true });
        const bodies: string[] = [];
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            bodies.push(String(init?.body));
            return new Response(JSON.stringify({ taskId: "dola-1", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } });
        });
        vi.stubGlobal("fetch", fetchMock);
        try {
            await dolaRuntimeRequest("/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "dola-seedance-2-5", prompt: "p", cookie: "sid=1" }) });
            const payload = JSON.parse(bodies[0] || "{}");
            expect(payload.randomFingerprint).toBe(true);
            await updateDolaGatewaySettings({ randomFingerprint: false });
            await dolaRuntimeRequest("/v1/images", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "dola-seedream-4-5", prompt: "p", cookie: "sid=1" }) });
            expect(JSON.parse(bodies[1] || "{}").randomFingerprint).toBe(false);
        } finally {
            vi.unstubAllEnvs();
            vi.unstubAllGlobals();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
