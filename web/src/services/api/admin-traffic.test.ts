import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdminRequestTraffic, getAdminTrafficTasks } from "./admin-traffic";

describe("admin traffic request APIs", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("batches request and task identities in one POST without dropping task fallback IDs", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ displayUnit: "MB", items: [], tasks: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
        await getAdminRequestTraffic({ requestIds: ["req-1", "req-1", ""], taskIds: ["task-1"] });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ requestIds: ["req-1"], taskIds: ["task-1"] });
    });

    it("passes the global window and identity filters to the paged task endpoint", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ displayUnit: "GB", page: 2, pageSize: 20, total: 0, items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
        await getAdminTrafficTasks({ start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z", page: 2, pageSize: 20, requestId: "req-1", taskId: "task-1", attemptId: "attempt-1" });
        const url = String(fetchMock.mock.calls[0]?.[0]);
        expect(url).toContain("/api/admin/traffic/tasks?");
        expect(url).toContain("requestId=req-1");
        expect(url).toContain("taskId=task-1");
        expect(url).toContain("attemptId=attempt-1");
    });
});
