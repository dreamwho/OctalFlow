import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), auditAction: vi.fn(), auditFailure: vi.fn(), routeError: vi.fn(), list: vi.fn(), clear: vi.fn() }));

vi.mock("@/lib/server/dola/admin", () => ({ requireDolaAdmin: mocks.requireAdmin, auditDolaAdminAction: mocks.auditAction, auditDolaAdminFailure: mocks.auditFailure, dolaRouteError: mocks.routeError }));
vi.mock("@/lib/server/dola/log-store", () => ({ listDolaRequestLogs: mocks.list, clearDolaRequestLogs: mocks.clear }));

import { DELETE, GET } from "./route";

describe("Dola request log route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.list.mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20, stats: { total: 5, success: 2, failed: 1, needsReview: 2, pending: 0, averageDurationMs: 800 } });
        mocks.clear.mockResolvedValue(5);
    });

    it("passes status, phase, source, proxy and keyword filters", async () => {
        const response = (await GET(new Request("http://localhost/api/admin/dola/logs?page=2&pageSize=20&status=needs_review&phase=upstream&source=admin-test&proxyMode=generic&keyword=seedance")))!;
        expect(await response.json()).toMatchObject({ code: 0, data: { page: 2, stats: { needsReview: 2 } } });
        expect(mocks.list).toHaveBeenCalledWith({ page: 2, pageSize: 20, keyword: "seedance", status: "needs_review", phase: "upstream", source: "admin-test", proxyMode: "generic", model: undefined, accountId: undefined });
        expect(mocks.auditAction).toHaveBeenCalledWith(expect.any(Request), user, "admin.dola.logs.view", { type: "dola_request_log" });
    });

    it("clears logs with an audited count", async () => {
        const request = new Request("http://localhost/api/admin/dola/logs", { method: "DELETE" });
        const response = (await DELETE(request))!;
        expect(await response.json()).toEqual({ code: 0, data: { deletedCount: 5 }, msg: "Dola 请求日志已清空" });
        expect(mocks.auditAction).toHaveBeenCalledWith(request, user, "admin.dola.logs.clear", { type: "dola_request_log" }, { deletedCount: 5 });
    });
});
