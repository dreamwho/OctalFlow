import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    appendLog: vi.fn(),
    ensureMagicProxy: vi.fn(),
    openedLogs: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/server/geminiai-request-log-store", () => ({
    appendGeminiAiRequestLog: mocks.appendLog,
    openGeminiAiRequestLog: vi.fn((input) => {
        const id = `log-open-${Date.now()}`;
        mocks.openedLogs.set(id, input);
        return Promise.resolve(id);
    }),
    markGeminiAiRequestLogRunning: vi.fn((id) => Promise.resolve({ id, phase: "running" })),
    settleGeminiAiRequestLog: vi.fn((id, patch) => {
        const opened = mocks.openedLogs.get(id) || {};
        const combined = { ...opened, ...patch };
        mocks.appendLog(combined);
        return Promise.resolve({ id, ...combined });
    }),
}));
vi.mock("@/lib/server/magic-proxy-service", () => ({
    ensureMagicProxyProvider: mocks.ensureMagicProxy,
    MagicProxyError: class MagicProxyError extends Error {
        constructor(
            message: string,
            readonly status = 502,
        ) {
            super(message);
        }
    },
}));

import { GeminiAiProviderError, geminiAiHealth, geminiAiProviderConfigured, geminiAiRuntimeRequest, geminiAiSidecarRequest } from "./geminiai-provider";

describe("GeminiAI sidecar provider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureMagicProxy.mockResolvedValue({ enabled: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        mocks.appendLog.mockReset();
    });

    it("requires server-only sidecar configuration", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "");

        expect(geminiAiProviderConfigured()).toBe(false);
        await expect(geminiAiSidecarRequest("/accounts")).rejects.toMatchObject({ status: 503 });
    });

    it("uses the configured private credential and removes caller credentials", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test/internal");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
        vi.stubGlobal("fetch", fetchMock);

        await geminiAiSidecarRequest("/accounts", { headers: { authorization: "Bearer browser-secret", "x-api-key": "browser-key", cookie: "session=browser" } });

        expect(fetchMock.mock.calls[0]?.[0]).toBe("http://geminiai.test/internal/accounts");
        const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
        expect(headers.get("authorization")).toBe("Bearer sidecar-test-key");
        expect(headers.get("x-api-key")).toBeNull();
        expect(headers.get("cookie")).toBeNull();
    });

    it("permits only the OpenAI-compatible runtime paths", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [] }));
        vi.stubGlobal("fetch", fetchMock);

        await geminiAiRuntimeRequest("/chat/completions", { method: "POST" });
        await expect(geminiAiRuntimeRequest("/accounts", { method: "GET" })).rejects.toBeInstanceOf(GeminiAiProviderError);

        expect(fetchMock.mock.calls).toHaveLength(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("http://geminiai.test/v1/chat/completions");
    });

    it("applies the GeminiAIStudio runtime group before sending traffic to the sidecar", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const events: string[] = [];
        mocks.ensureMagicProxy.mockImplementation(async () => {
            events.push("ensure");
            return { enabled: true };
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                events.push("sidecar");
                return Response.json({ choices: [] });
            }),
        );

        await geminiAiRuntimeRequest("/chat/completions", { method: "POST" });

        expect(mocks.ensureMagicProxy).toHaveBeenCalledWith("geminiai");
        expect(events).toEqual(["ensure", "sidecar"]);
    });

    it("checks health without sending the sidecar credential", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(geminiAiHealth()).resolves.toBe(true);

        expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
    });

    it("records a runtime request with the actual active account and a safe response preview", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "真实文本结果" } }] }))
            .mockResolvedValueOnce(Response.json({ id: "account-one", email: "owner@example.com" }));
        vi.stubGlobal("fetch", fetchMock);

        await geminiAiRuntimeRequest("/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "你好" }] }) });

        expect(mocks.appendLog).toHaveBeenCalledWith(
            expect.objectContaining({
                source: "runtime",
                capability: "text",
                model: "gemini-2.5-pro",
                accountId: "account-one",
                accountEmail: "owner@example.com",
                statusCode: 200,
                requestPreview: "你好",
                responsePreview: "真实文本结果",
            }),
        );
    });

    it("uses the account identity attached to the sidecar response", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const fetchMock = vi.fn().mockResolvedValueOnce(
            new Response(JSON.stringify({ choices: [{ message: { content: "结果" } }] }), {
                headers: { "content-type": "application/json", "x-aistudio-account-id": "account-two", "x-aistudio-account-email": "two@example.com" },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        await geminiAiRuntimeRequest("/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "你好" }] }) });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mocks.appendLog).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-two", accountEmail: "two@example.com" }));
    });

    it("never writes generated image bytes into the request log", async () => {
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_URL", "http://geminiai.test");
        vi.stubEnv("OCTALAICANVAS_GEMINIAI_API_KEY", "sidecar-test-key");
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ data: [{ b64_json: "secret-image-base64" }] }))
            .mockResolvedValueOnce(Response.json({ id: "account-one", email: "owner@example.com" }));
        vi.stubGlobal("fetch", fetchMock);

        await geminiAiRuntimeRequest("/images/generations", { method: "POST", body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "一只橘猫" }) });

        const log = mocks.appendLog.mock.calls[0]?.[0];
        const preview = String(log.responsePreview);
        expect(log).toMatchObject({ capability: "image" });
        expect(preview).toContain("base64 图片数据");
        expect(preview).toContain('"data"');
        expect(JSON.stringify(log)).not.toContain("secret-image-base64");
    });
});
