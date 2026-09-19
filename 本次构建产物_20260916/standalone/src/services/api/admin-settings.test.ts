import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdminSettings, revealAdminChannelApiKey } from "./admin-settings";

describe("admin settings api", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("reads the latest admin settings without caching", async () => {
        const settings = { systemChannels: [{ id: "gemini-antigravity-tools" }] };
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ settings }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getAdminSettings()).resolves.toEqual(settings);
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings", { cache: "no-store" });
    });

    it("surfaces an admin settings refresh error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ error: "刷新失败" }), { status: 500 })),
        );

        await expect(getAdminSettings()).rejects.toThrow("刷新失败");
    });

    it("reads one saved channel key without caching", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ apiKey: "saved-secret" }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(revealAdminChannelApiKey("channel/a")).resolves.toBe("saved-secret");
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/channels/channel%2Fa/api-key", {
            method: "POST",
            cache: "no-store",
        });
    });

    it("surfaces the server error without returning an empty key", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ error: "该渠道尚未保存 API Key" }), { status: 404 })),
        );

        await expect(revealAdminChannelApiKey("missing")).rejects.toThrow("该渠道尚未保存 API Key");
    });
});
