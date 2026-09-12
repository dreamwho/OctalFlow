import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    gatewaySettings: vi.fn(),
    runtimeRequest: vi.fn(),
    clientIp: "203.0.113.5",
}));
vi.mock("@/lib/server/geminiai-gateway-store", () => ({
    authorizeGeminiAiApiKey: mocks.authorize,
    getGeminiAiGatewaySettings: mocks.gatewaySettings,
}));
vi.mock("@/lib/server/geminiai-provider", () => ({
    geminiAiRuntimeRequest: mocks.runtimeRequest,
}));
vi.mock("@/lib/server/security", () => ({
    getClientIp: () => mocks.clientIp,
}));

import { GET, POST } from "./route";

type Context = { params: Promise<{ path: string[] }> };
const context = (path: string[]): Context => ({ params: Promise.resolve({ path }) });

describe("GeminiAIStudio external gateway route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue({ id: "key-1", prefix: "oct_gai_test" });
        mocks.gatewaySettings.mockResolvedValue({ enabled: true });
        mocks.runtimeRequest.mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    });

    it("rejects unsupported paths and mismatched methods", async () => {
        await expect(GET(new Request("http://site.test/api/geminiai/v1/chat/completions"), context(["v1", "chat", "completions"]))).resolves.toMatchObject({ status: 404 });
        await expect(POST(new Request("http://site.test/api/geminiai/v1/models", { method: "POST" }), context(["v1", "models"]))).resolves.toMatchObject({ status: 404 });
        await expect(GET(new Request("http://site.test/api/geminiai/v1/accounts"), context(["v1", "accounts"]))).resolves.toMatchObject({ status: 404 });
        expect(mocks.authorize).not.toHaveBeenCalled();
    });

    it("requires a valid gateway API key", async () => {
        await expect(GET(new Request("http://site.test/api/geminiai/v1/models"), context(["v1", "models"]))).resolves.toMatchObject({ status: 401 });
        mocks.authorize.mockResolvedValue(null);
        const response = await GET(new Request("http://site.test/api/geminiai/v1/models", { headers: { authorization: "Bearer oct_gai_wrong" } }), context(["v1", "models"]));
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("无效") } });
    });

    it("stops forwarding when the gateway is disabled", async () => {
        mocks.gatewaySettings.mockResolvedValue({ enabled: false });
        const response = await GET(new Request("http://site.test/api/geminiai/v1/models", { headers: { authorization: "Bearer oct_gai_ok" } }), context(["v1", "models"]));
        expect(response.status).toBe(503);
        expect(mocks.runtimeRequest).not.toHaveBeenCalled();
    });

    it("forwards external requests to the provider with the external log source and caller metadata", async () => {
        const response = await POST(
            new Request("http://site.test/api/geminiai/v1/chat/completions", {
                method: "POST",
                headers: { authorization: "Bearer oct_gai_ok", "content-type": "application/json", "user-agent": "external-client/1.0" },
                body: JSON.stringify({ model: "gemini-2.5-pro", messages: [] }),
            }),
            context(["v1", "chat", "completions"]),
        );

        expect(response.status).toBe(200);
        expect(mocks.runtimeRequest).toHaveBeenCalledWith(
            "/v1/chat/completions",
            expect.objectContaining({
                method: "POST",
                headers: expect.any(Headers),
            }),
            { logSource: "external" },
        );
        const headers = new Headers(mocks.runtimeRequest.mock.calls[0]?.[1]?.headers);
        expect(headers.get("x-forwarded-for")).toBe("203.0.113.5");
        expect(headers.get("user-agent")).toBe("external-client/1.0");
        expect(headers.get("authorization")).toBeNull();
        expect(await response.json()).toEqual({ choices: [] });
    });

    it("accepts paths without the version prefix", async () => {
        await POST(
            new Request("http://site.test/api/geminiai/images/generations", {
                method: "POST",
                headers: { authorization: "Bearer oct_gai_ok", "content-type": "application/json" },
                body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "cat" }),
            }),
            context(["images", "generations"]),
        );
        expect(mocks.runtimeRequest.mock.calls[0]?.[0]).toBe("/v1/images/generations");
    });
});
