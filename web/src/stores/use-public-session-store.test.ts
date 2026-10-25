import { afterEach, describe, expect, it, vi } from "vitest";

import { applyPublicSiteSettings, loadPublicSession, resetPublicSession, usePublicSessionStore } from "@/stores/use-public-session-store";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

afterEach(() => {
    resetPublicSession();
    useConfigStore.getState().setConfig(defaultConfig);
    useUserStore.getState().clearSession();
    vi.unstubAllGlobals();
});

describe("public session refresh", () => {
    it("updates the live model catalog when permissions change, even before the session cache expires", async () => {
        const settings = (ids: string[]) => ({
            systemChannels: [{ id: "channel", name: "渠道", baseUrl: "/api/ai/system/channel", apiKey: "system", apiFormat: "openai", enabled: true, models: ids }],
            logicalModels: ids.map((id) => ({ id, name: id, capability: "image", enabled: true, bindings: [{ id, channelId: "channel", upstreamModel: id, enabled: true, priority: 1 }] })),
        });
        vi.stubGlobal("fetch", vi.fn()
            .mockResolvedValueOnce(Response.json({ user: { id: "user", role: "limited" }, settings: settings(["image-one", "image-two"]) }))
            .mockResolvedValueOnce(Response.json({ user: { id: "user", role: "limited" }, settings: settings(["image-one"]) })));
        await loadPublicSession();
        expect(useConfigStore.getState().config.imageModels).toEqual(["image-one", "image-two"]);
        await loadPublicSession({ force: true });
        expect(useConfigStore.getState().config.imageModels).toEqual(["image-one"]);
        expect(useUserStore.getState().user?.role).toBe("limited");
    });

    it("does not let an older response restore revoked models or a previous account", async () => {
        let finishOld!: (response: Response) => void;
        vi.stubGlobal("fetch", vi.fn()
            .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
            .mockResolvedValueOnce(Response.json({ user: { id: "new-user", role: "limited" }, settings: { logicalModels: [], systemChannels: [] } })));
        const old = loadPublicSession();
        await loadPublicSession({ force: true });
        finishOld(Response.json({ user: { id: "old-admin", role: "admin" }, settings: { systemChannels: [{ id: "channel", apiKey: "system", models: ["image-one"] }] } }));
        await old;
        expect(useUserStore.getState().user?.id).toBe("new-user");
        expect(useConfigStore.getState().config.models).toEqual([]);
        expect(usePublicSessionStore.getState().payload?.user?.id).toBe("new-user");
    });

    it("applies the administrator save response immediately while preserving the current session", () => {
        usePublicSessionStore.setState({
            ready: true,
            payload: { user: { id: "user-1" } as never, settings: { site: { title: "旧标题", logoUrl: "/old.svg" }, logicalModels: [] } },
        });

        applyPublicSiteSettings({ title: "新标题", logoUrl: "/new.svg" });

        expect(usePublicSessionStore.getState().payload).toMatchObject({
            user: { id: "user-1" },
            settings: { site: { title: "新标题", logoUrl: "/new.svg" }, logicalModels: [] },
        });
    });

    it("can replace a cached model catalog after an administrator saves settings", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ user: null, settings: { logicalModels: [] } }))
            .mockResolvedValueOnce(Response.json({ user: null, settings: { logicalModels: [{ id: "video-one", name: "视频一", capability: "video", enabled: true, bindings: [] }] } }));
        vi.stubGlobal("fetch", fetchMock);

        expect((await loadPublicSession()).settings?.logicalModels).toEqual([]);
        expect((await loadPublicSession()).settings?.logicalModels).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const refreshed = await loadPublicSession({ force: true });

        expect(refreshed.settings?.logicalModels?.map((model) => model.id)).toEqual(["video-one"]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(usePublicSessionStore.getState().payload).toEqual(refreshed);
    });
});
