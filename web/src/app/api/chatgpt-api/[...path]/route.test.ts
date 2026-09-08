import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ request: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/server/chatgpt-api-service", async (original) => ({
    ...(await original<typeof import("@/lib/server/chatgpt-api-service")>()),
    getChatGptRuntimeConfig: () => ({ apiKey: "master-runtime-secret-not-for-public" }),
    chatGptRuntimeRequest: state.request,
    syncChatGptMagicProxy: state.sync,
}));
import { POST } from "./route";
const context = { params: Promise.resolve({ path: ["v1", "chat", "completions"] }) };
afterEach(() => vi.clearAllMocks());
describe("ChatGPT compatible gateway", () => {
    it("rejects missing, internal-master, and invalid external credentials", async () => {
        for (const key of ["", "master-runtime-secret-not-for-public"]) {
            const response = await POST(new Request("http://canvas.test/api/chatgpt-api/v1/chat/completions", { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {}, body: "{}" }), context);
            expect(response.status).toBe(401);
        }
        expect(state.request).not.toHaveBeenCalled();
        state.request.mockResolvedValue(Response.json({}, { status: 401 }));
        expect((await POST(new Request("http://canvas.test/api/chatgpt-api/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" }), context)).status).toBe(401);
        expect(state.sync).not.toHaveBeenCalled();
    });
    it("preserves the external identity for generation and returns native failure status", async () => {
        state.request
            .mockResolvedValueOnce(Response.json({ authenticated: true, role: "user" }))
            .mockResolvedValueOnce(Response.json({ enabled: true }))
            .mockResolvedValueOnce(Response.json({ error: { message: "account quota exhausted" } }, { status: 429 }));
        const response = await POST(
            new Request("http://canvas.test/api/chatgpt-api/v1/chat/completions", {
                method: "POST",
                headers: { authorization: "Bearer client-key", "content-type": "application/json" },
                body: '{"model":"fixture-text","messages":[{"role":"user","content":"hello"}]}',
            }),
            context,
        );
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: { message: "account quota exhausted" } });
        expect(state.request.mock.calls[2][2]).toBe("client-key");
        expect(state.sync).toHaveBeenCalledOnce();
    });
    it("does not submit while the gateway is disabled", async () => {
        state.request.mockResolvedValueOnce(Response.json({ authenticated: true, role: "user" })).mockResolvedValueOnce(Response.json({ enabled: false }));
        const response = await POST(new Request("http://canvas.test/api/chatgpt-api/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer client-key" }, body: "{}" }), context);
        expect(response.status).toBe(503);
        expect(state.request).toHaveBeenCalledTimes(2);
        expect(state.sync).not.toHaveBeenCalled();
    });
});
