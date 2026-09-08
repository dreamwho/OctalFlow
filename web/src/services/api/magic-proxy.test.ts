import { afterEach, describe, expect, it, vi } from "vitest";

import { getMagicProxy, importMagicProxySubscription, refreshMagicProxySubscription, updateMagicProxyBinding } from "./magic-proxy";

const state = {
    configured: true,
    runtimeAvailable: true,
    lastUpdatedAt: "2026-09-07T08:00:00.000Z",
    nodeCount: 1,
    nodes: [{ name: "节点 A", type: "http", alive: true, delay: 120 }],
    groups: [{ name: "默认组", type: "url-test", now: "节点 A", all: ["节点 A"] }],
    bindings: {
        geminiai: { enabled: false },
        geminiTools: { enabled: true, node: "节点 A" },
    },
};

describe("magic proxy api", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("unwraps the admin status envelope without caching", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: state, msg: "ok" }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getMagicProxy()).resolves.toEqual(state);
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/magic-proxy", expect.objectContaining({ cache: "no-store" }));
    });

    it("imports and refreshes subscription through the documented POST contract", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: state }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: state }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await importMagicProxySubscription("https://example.com/subscription");
        await refreshMagicProxySubscription();

        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/magic-proxy/subscription");
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ url: "https://example.com/subscription" });
        expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({});
    });

    it("persists a provider binding without exposing a second settings contract", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: state }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "节点 A" });

        expect(fetchMock).toHaveBeenCalledWith("/api/admin/magic-proxy", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ provider: "geminiai", enabled: true, node: "节点 A" }) }));
    });

    it("surfaces envelope errors", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ code: 400, msg: "请选择代理节点" }), { status: 400 })),
        );

        await expect(updateMagicProxyBinding({ provider: "geminiai", enabled: true })).rejects.toThrow("请选择代理节点");
    });
});
