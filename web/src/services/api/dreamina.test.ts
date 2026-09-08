import { afterEach, describe, expect, it, vi } from "vitest";

import { clearDreaminaLogs, getDreaminaLogs, getDreaminaOverview, getDreaminaStats, refreshDreaminaStatus, saveDreaminaModels } from "./dreamina";

describe("Dreamina CLI admin API client", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("reads the no-cache runtime overview", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            Response.json({
                code: 0,
                data: {
                    runtime: { installed: true, authorized: true, checkedAt: "2026-08-31T00:00:00Z" },
                    models: { enabledModelIds: [], catalog: [] },
                    stats: { range: "all", endAt: "2026-08-31T00:00:00Z", timeZone: "Asia/Shanghai", total: 0, success: 0, failed: 0, needsReview: 0, officialCredits: 0, observedCredits: 0 },
                },
                msg: "OK",
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(getDreaminaOverview()).resolves.toMatchObject({ runtime: { installed: true, authorized: true } });
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/dreamina", expect.objectContaining({ cache: "no-store" }));
    });

    it("loads official credit statistics for a selected calendar range", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            Response.json({
                code: 0,
                data: { range: "month", startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-31T00:00:00Z", timeZone: "Asia/Shanghai", total: 4, success: 4, failed: 0, needsReview: 0, officialCredits: 26, observedCredits: 26 },
                msg: "OK",
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(getDreaminaStats("month")).resolves.toMatchObject({ range: "month", officialCredits: 26 });
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/dreamina/stats?range=month", expect.objectContaining({ cache: "no-store" }));
    });

    it("sends the selected model IDs using the documented body", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { enabledModelIds: ["seedream-5"] }, msg: "已保存" }));
        vi.stubGlobal("fetch", fetchMock);

        await saveDreaminaModels(["seedream-5"]);

        expect(fetchMock).toHaveBeenCalledWith("/api/admin/dreamina/models", expect.objectContaining({ method: "PUT", body: JSON.stringify({ modelIds: ["seedream-5"] }) }));
    });

    it("refreshes CLI status only through the explicit refresh endpoint", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, msg: "已刷新" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(refreshDreaminaStatus()).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/dreamina/refresh", expect.objectContaining({ method: "POST", cache: "no-store" }));
    });

    it("loads filtered paginated logs and permits an empty clear response", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ code: 0, data: { items: [], total: 0, page: 2, pageSize: 20 }, msg: "OK" }))
            .mockResolvedValueOnce(Response.json({ code: 0, msg: "已清空" }));
        vi.stubGlobal("fetch", fetchMock);

        await getDreaminaLogs({ page: 2, pageSize: 20, status: "needs_review", command: "image_upscale" });
        await expect(clearDreaminaLogs()).resolves.toBeUndefined();

        expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/dreamina/logs?page=2&pageSize=20&status=needs_review&command=image_upscale");
        expect(fetchMock.mock.calls[1]).toEqual(["/api/admin/dreamina/logs", expect.objectContaining({ method: "DELETE" })]);
    });
});
