import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), tasks: vi.fn(), requests: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("@/lib/server/traffic-meter-client", () => ({ queryTaskTraffic: mocks.tasks, queryRequestTraffic: mocks.requests }));
import { GET } from "./tasks/route";
import { POST } from "./requests/route";

describe("task and request traffic administration", () => {
    const range = "start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z";
    const post = (requestIds: unknown) => new Request("http://localhost/api/admin/traffic/requests", { method: "POST", body: JSON.stringify({ requestIds }), headers: { "content-type": "application/json" } });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["analytics.read"] });
        mocks.settings.mockResolvedValue({ trafficUnit: "GB", systemChannels: [{ id: "dola", name: "DOLA 当前渠道" }] });
        const items = [{ taskId: "task", requestId: "log", totalBytes: 540382, items: [{ channelId: "dola", role: "upload", connectionMode: "magic", totalBytes: 540382 }] }];
        mocks.tasks.mockResolvedValue({ page: 2, pageSize: 20, total: 21, items });
        mocks.requests.mockResolvedValue({ items });
    });
    it("keeps log lookup exact, batched and independent of timestamps", async () => {
        const response = await POST(post(["log", "log", "other-log"]));
        expect(mocks.requests).toHaveBeenCalledWith(["log", "other-log"], []);
        expect(await response.json()).toMatchObject({ code: 0, data: { displayUnit: "GB", items: [{ totalBytes: 540382, items: [{ channelName: "DOLA 当前渠道", role: "upload", connectionMode: "magic" }] }] } });
    });
    it("passes time, route and task pagination to the meter", async () => {
        const response = await GET(new Request(`http://localhost/api/admin/traffic/tasks?${range}&page=2&connectionMode=chained&port=17894`));
        expect(mocks.tasks).toHaveBeenCalledWith({ start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z", page: 2, pageSize: 20, connectionMode: "chained", port: 17894 });
        expect(await response.json()).toMatchObject({ code: 0, data: { displayUnit: "GB", total: 21 } });
    });
    it.each([null, { id: "user", role: "user" }])("rejects unauthorized reads", async (user) => {
        mocks.user.mockResolvedValue(user);
        expect((await POST(post(["log"]))).status).toBe(user ? 403 : 401);
        expect((await GET(new Request(`http://localhost/api/admin/traffic/tasks?${range}`))).status).toBe(user ? 403 : 401);
        expect(mocks.requests).not.toHaveBeenCalled();
        expect(mocks.tasks).not.toHaveBeenCalled();
    });
    it("rejects invalid IDs and pagination", async () => {
        expect((await POST(post([{}]))).status).toBe(400);
        expect((await POST(post([]))).status).toBe(400);
        expect((await GET(new Request(`http://localhost/api/admin/traffic/tasks?${range}&page=0`))).status).toBe(400);
        expect(mocks.tasks).not.toHaveBeenCalled();
    });
    it("distinguishes unavailable metering from zero traffic", async () => {
        mocks.requests.mockRejectedValue(new Error("计量服务不可用"));
        expect((await POST(post(["log"]))).status).toBe(503);
    });
});
