import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), query: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("@/lib/server/traffic-meter-client", () => ({ queryGlobalTraffic: mocks.query }));
import { GET } from "./route";

describe("admin global traffic", () => {
    const url = "http://localhost/api/admin/traffic?start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z";
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["analytics.read"] });
        mocks.settings.mockResolvedValue({ systemChannels: [{ id: "c", name: "当前渠道名称" }], trafficUnit: "GB" });
        mocks.query.mockResolvedValue({
            start: "2026-10-01T00:00:00Z",
            end: "2026-10-02T00:00:00Z",
            uploadBytes: 11,
            downloadBytes: 19,
            totalBytes: 30,
            items: [{ channelId: "c", channelName: "原名称", totalBytes: 30 }],
            options: { channels: [{ id: "c", name: "原名称" }], models: ["图片模型"], connectionModes: ["magic"] },
        });
    });
    it.each([null, { id: "user", role: "user" }])("rejects unauthorized traffic access", async (user) => {
        mocks.user.mockResolvedValue(user);
        expect((await GET(new Request(url))).status).toBe(user ? 403 : 401);
        expect(mocks.query).not.toHaveBeenCalled();
    });
    it("forwards exact dimensions and displays configured channel names", async () => {
        const response = await GET(new Request(`${url}&channelId=c&model=${encodeURIComponent("图片模型")}&connectionMode=magic&port=17894`));
        expect(response.status).toBe(200);
        expect(mocks.query).toHaveBeenCalledWith({ start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z", channelId: "c", model: "图片模型", connectionMode: "magic", port: 17894 });
        expect(mocks.settings).toHaveBeenCalledOnce();
        expect(await response.json()).toMatchObject({ code: 0, data: { totalBytes: 30, displayUnit: "GB", items: [{ channelName: "当前渠道名称" }] } });
    });
    it("rejects invalid ranges before contacting the meter", async () => {
        expect((await GET(new Request(url.replace("2026-10-02", "2026-09-30")))).status).toBe(400);
        expect(mocks.query).not.toHaveBeenCalled();
    });
    it("reports unavailable metering instead of a false zero", async () => {
        mocks.query.mockRejectedValue(new Error("计量服务不可用"));
        const response = await GET(new Request(url));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: 503, data: null, msg: "计量服务不可用" });
    });
});
