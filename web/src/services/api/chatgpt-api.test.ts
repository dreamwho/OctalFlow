import { afterEach, describe, expect, it, vi } from "vitest";
import { chatGptApiRequest, getChatGptProxyRuntime, updateChatGptProxyRuntime } from "./chatgpt-api";

afterEach(() => vi.unstubAllGlobals());
describe("GPTAPI admin client", () => {
    it("uses the authenticated same-origin management surface and disables caching", async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { enabled: true } }));
        vi.stubGlobal("fetch", fetcher);
        expect(await chatGptApiRequest("gateway", { method: "PATCH", body: '{"enabled":true}' })).toEqual({ enabled: true });
        expect(fetcher).toHaveBeenCalledWith("/api/admin/chatgpt-api/gateway", expect.objectContaining({ cache: "no-store", method: "PATCH" }));
    });
    it("preserves actionable server errors and rejects malformed successful responses", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 503, msg: "请安装 ChatGPT 运行环境" }, { status: 503 })));
        await expect(chatGptApiRequest("accounts")).rejects.toThrow("请安装 ChatGPT 运行环境");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 0 })));
        await expect(chatGptApiRequest("accounts")).rejects.toThrow("GPTAPI 操作失败");
    });

    it("uses the persisted proxy-selection contract with the complete selected source", async () => {
        const runtime = { enabled: true, mode: "native" as const, native_source: "ipwo" as const, magicConfigured: true, ipwoConfigured: true };
        const fetcher = vi.fn(() => Promise.resolve(Response.json({ code: 0, data: runtime })));
        vi.stubGlobal("fetch", fetcher);

        expect(await getChatGptProxyRuntime()).toEqual(runtime);
        expect(await updateChatGptProxyRuntime({ enabled: false, mode: "native", native_source: "ipwo" })).toEqual(runtime);
        expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/chatgpt-api/proxy-selection", expect.objectContaining({ cache: "no-store" }));
        expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/chatgpt-api/proxy-selection", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false, mode: "native", native_source: "ipwo" }) }));
    });
});
