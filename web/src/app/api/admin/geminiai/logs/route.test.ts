import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), auditAction: vi.fn(), auditFailure: vi.fn(), routeError: vi.fn(), list: vi.fn(), clear: vi.fn() }));

vi.mock("@/lib/server/geminiai-admin", () => ({ requireGeminiAiAdmin: mocks.requireAdmin, auditGeminiAiAdminAction: mocks.auditAction, auditGeminiAiAdminFailure: mocks.auditFailure, geminiAiRouteError: mocks.routeError }));
vi.mock("@/lib/server/geminiai-request-log-store", () => ({ listGeminiAiRequestLogs: mocks.list, clearGeminiAiRequestLogs: mocks.clear }));

import { DELETE, GET } from "./route";

describe("GeminiAIStudio request log route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.list.mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20, stats: { total: 3, success: 2, failed: 1, averageDurationMs: 500 } });
        mocks.clear.mockResolvedValue(3);
    });

    it("passes validated filters to the paginated store", async () => {
        const response = (await GET(new Request("http://localhost/api/admin/geminiai/logs?page=2&pageSize=20&status=failed&capability=image&keyword=pro")))!;
        expect(await response.json()).toMatchObject({ code: 0, data: { page: 2, stats: { total: 3 } } });
        expect(mocks.list).toHaveBeenCalledWith({ page: 2, pageSize: 20, status: "failed", capability: "image", keyword: "pro" });
    });

    it("clears logs with an audited count", async () => {
        const request = new Request("http://localhost/api/admin/geminiai/logs", { method: "DELETE" });
        const response = (await DELETE(request))!;
        expect(await response.json()).toEqual({ code: 0, data: { deletedCount: 3 }, msg: "GeminiAIStudio 请求日志已清空" });
        expect(mocks.auditAction).toHaveBeenCalledWith(request, user, "admin.geminiai.logs.clear", { type: "geminiai_request_log" }, { deletedCount: 3 });
    });
});
