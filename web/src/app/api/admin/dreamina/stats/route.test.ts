import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getDreaminaCliStats: vi.fn(),
    auditDreaminaCliAction: vi.fn(async () => undefined),
    requireDreaminaCliAdmin: vi.fn(),
}));

vi.mock("@/lib/server/dreamina-cli-admin", () => ({
    auditDreaminaCliAction: mocks.auditDreaminaCliAction,
    dreaminaCliRouteError: vi.fn(() => Response.json({ code: 500, msg: "读取失败" }, { status: 500 })),
    requireDreaminaCliAdmin: mocks.requireDreaminaCliAdmin,
}));
vi.mock("@/lib/server/dreamina-cli-service", () => ({ getDreaminaCliStats: mocks.getDreaminaCliStats }));

import { GET } from "./route";

describe("Dreamina CLI admin statistics route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireDreaminaCliAdmin.mockResolvedValue({ user: { id: "admin" } });
        mocks.getDreaminaCliStats.mockResolvedValue({
            range: "week",
            startAt: "2026-08-24T16:00:00.000Z",
            endAt: "2026-08-31T04:00:00.000Z",
            timeZone: "Asia/Shanghai",
            total: 2,
            success: 2,
            failed: 0,
            needsReview: 0,
            officialCredits: 18,
            observedCredits: 18,
        });
    });

    it("returns a server-aggregated calendar range", async () => {
        const request = new Request("http://localhost/api/admin/dreamina/stats?range=week");
        const response = await GET(request);

        expect(response).toBeDefined();
        if (!response) throw new Error("missing response");
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { range: "week", officialCredits: 18 } });
        expect(mocks.getDreaminaCliStats).toHaveBeenCalledWith("week");
        expect(mocks.auditDreaminaCliAction).toHaveBeenCalledWith(request, { id: "admin" }, "admin.dreamina.stats.view", { type: "dreamina_cli_request_log" }, { range: "week" });
    });

    it("rejects an unknown range before querying logs", async () => {
        const response = await GET(new Request("http://localhost/api/admin/dreamina/stats?range=quarter"));

        expect(response).toBeDefined();
        if (!response) throw new Error("missing response");
        expect(response.status).toBe(400);
        expect(mocks.getDreaminaCliStats).not.toHaveBeenCalled();
    });
});
