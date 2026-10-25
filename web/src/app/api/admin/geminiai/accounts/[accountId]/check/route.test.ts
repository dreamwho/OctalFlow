import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), auditAction: vi.fn(), auditFailure: vi.fn(), routeError: vi.fn((error: Error) => Response.json({ code: 500, data: null, msg: error.message }, { status: 500 })), checkAccount: vi.fn() }));

vi.mock("@/lib/server/geminiai-admin", () => ({ requireGeminiAiAdmin: mocks.requireAdmin, auditGeminiAiAdminAction: mocks.auditAction, auditGeminiAiAdminFailure: mocks.auditFailure, geminiAiRouteError: mocks.routeError }));
vi.mock("@/lib/server/geminiai-service", () => ({ checkGeminiAiAccount: mocks.checkAccount }));

import { POST } from "./route";

describe("GeminiAI account check route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.checkAccount.mockResolvedValue({ id: "account-a", name: "主账号", health: { status: "ready" } });
    });

    it("requires GeminiAI administrator access", async () => {
        mocks.requireAdmin.mockResolvedValueOnce({ error: Response.json({ code: 403, data: null, msg: "需要管理员权限" }, { status: 403 }) });
        const response = (await POST(new Request("http://localhost"), { params: Promise.resolve({ accountId: "account-a" }) }))!;
        expect(response.status).toBe(403);
        expect(mocks.checkAccount).not.toHaveBeenCalled();
    });

    it("checks and returns the account, auditing only its identity", async () => {
        const request = new Request("http://localhost/api/admin/geminiai/accounts/account-a/check", { method: "POST" });
        const response = (await POST(request, { params: Promise.resolve({ accountId: "account-a" }) }))!;
        expect(await response.json()).toEqual({ code: 0, data: { account: { id: "account-a", name: "主账号", health: { status: "ready" } } }, msg: "账号状态检测完成" });
        expect(mocks.checkAccount).toHaveBeenCalledWith("account-a");
        expect(mocks.auditAction).toHaveBeenCalledWith(request, user, "admin.geminiai.account.check", { type: "geminiai_account", id: "account-a", label: "主账号" });
    });
});
