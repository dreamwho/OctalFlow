import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGeminiAiLogs, deleteGeminiAiAccount, getGeminiAiAdminState, getGeminiAiLogs, getGeminiAiTestStatus, startGeminiAiAccountLogin, testGeminiAiModel, updateGeminiAiModels, updateGeminiAiRotation } from "./geminiai";

describe("GeminiAI admin API client", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("reads the sanitized overview without caching", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { configured: true, healthy: true, accounts: [], models: [], channel: undefined }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getGeminiAiAdminState()).resolves.toMatchObject({ configured: true, healthy: true });
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/geminiai", expect.objectContaining({ cache: "no-store" }));
    });

    it("starts an isolated Provider login instead of reading browser cookies", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { sessionId: "session-one", status: "pending" }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await startGeminiAiAccountLogin({ name: "运营账号", headless: false, uiLocale: "zh-CN" });

        expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/geminiai/accounts/login/start");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "运营账号", headless: false, uiLocale: "zh-CN" }) });
    });

    it("sends one declared-capability test request and follows a returned same-origin video status URL", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ code: 0, data: { status: "running", model: "veo-3", taskId: "task-one", channelId: "official-veo", statusUrl: "/api/admin/geminiai/test?taskId=task-one&channelId=official-veo" }, msg: "OK" }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { status: "succeeded", model: "veo-3", videoUrl: "/api/generation-log-assets/video-one" }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        const task = await testGeminiAiModel({ capability: "video", model: "veo-3", prompt: "飞船穿过云海", options: { size: "16:9", channelId: "official-veo" } });
        await getGeminiAiTestStatus(task);

        expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/geminiai/test");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ capability: "video", model: "veo-3", prompt: "飞船穿过云海", options: { size: "16:9", channelId: "official-veo" } }) });
        expect(fetchMock.mock.calls[1][0]).toBe("/api/admin/geminiai/test?taskId=task-one&channelId=official-veo");
    });

    it("keeps the provider rotation contract explicit", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { enabled: true, mode: "least_rl", cooldownSeconds: 30 }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await updateGeminiAiRotation({ mode: "least_rl", cooldownSeconds: 30 });

        expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/geminiai/rotation");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ mode: "least_rl", cooldownSeconds: 30 }) });
    });

    it("sends the explicitly selected GeminiAI model IDs to the channel save endpoint", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { models: [] }, msg: "已保存" }));
        vi.stubGlobal("fetch", fetchMock);

        await updateGeminiAiModels(["gemini-text", "gemini-image"]);

        expect(fetchMock).toHaveBeenCalledWith("/api/admin/geminiai/models", expect.objectContaining({ method: "PUT", body: JSON.stringify({ models: ["gemini-text", "gemini-image"] }) }));
    });

    it("accepts a successful account deletion without a response data field", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 0, msg: "已删除" })));

        await expect(deleteGeminiAiAccount("account/one")).resolves.toBeUndefined();
    });

    it("loads filtered request logs and clears them through the dedicated endpoint", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(Response.json({ code: 0, data: { items: [], total: 0, page: 2, pageSize: 20, stats: { total: 1, success: 1, failed: 0, averageDurationMs: 300 } }, msg: "OK" }))
            .mockResolvedValueOnce(Response.json({ code: 0, data: { deletedCount: 1 }, msg: "已清空" }));
        vi.stubGlobal("fetch", fetchMock);

        await getGeminiAiLogs({ page: 2, keyword: "pro image", status: "success", capability: "image" });
        await clearGeminiAiLogs();

        expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/geminiai/logs?page=2&keyword=pro+image&status=success&capability=image");
        expect(fetchMock.mock.calls[1]).toEqual(["/api/admin/geminiai/logs", expect.objectContaining({ method: "DELETE" })]);
    });
});
