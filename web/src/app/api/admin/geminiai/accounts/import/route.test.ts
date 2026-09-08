import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    auditAction: vi.fn(),
    auditFailure: vi.fn(),
    routeError: vi.fn((error: Error) => new Response(JSON.stringify({ code: 500, data: null, msg: error.message }), { status: 500, headers: { "content-type": "application/json" } })),
    importCookies: vi.fn(),
}));

vi.mock("@/lib/server/geminiai-admin", () => ({
    requireGeminiAiAdmin: mocks.requireAdmin,
    auditGeminiAiAdminAction: mocks.auditAction,
    auditGeminiAiAdminFailure: mocks.auditFailure,
    geminiAiRouteError: mocks.routeError,
}));
vi.mock("@/lib/server/geminiai-service", () => ({ importGeminiAiCookies: mocks.importCookies }));

import { POST } from "./route";

describe("GeminiAI cookie import route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.importCookies.mockResolvedValue({ id: "google-a", name: "主账号", email: "google@example.com" });
    });

    it("requires the upstream.manage administrator grant", async () => {
        mocks.requireAdmin.mockResolvedValueOnce({ error: new Response(JSON.stringify({ code: 403, data: null, msg: "需要管理员权限" }), { status: 403, headers: { "content-type": "application/json" } }) });

        const response = (await POST(new Request("http://localhost/api/admin/geminiai/accounts/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cookies: "SID=private-cookie" }) })))!;

        expect(response.status).toBe(403);
        expect(mocks.importCookies).not.toHaveBeenCalled();
    });

    it("passes the Cookie only to the service and never returns or audits it", async () => {
        const cookie = "SID=private-cookie";
        const response = (await POST(
            new Request("http://localhost/api/admin/geminiai/accounts/import", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ cookies: cookie, name: "主账号", account_id: "google-a" }),
            }),
        ))!;
        const payload = await response.json();

        expect(payload).toEqual({ code: 0, data: { account: { id: "google-a", name: "主账号", email: "google@example.com" } }, msg: "Google 账号已导入" });
        expect(mocks.importCookies).toHaveBeenCalledWith({ cookies: cookie, name: "主账号", account_id: "google-a", accountId: "google-a" });
        expect(mocks.auditAction).toHaveBeenCalledWith(expect.any(Request), user, "admin.geminiai.account.cookies_import", { type: "geminiai_account", id: "google-a", label: "主账号" });
        expect(JSON.stringify(mocks.auditAction.mock.calls)).not.toContain(cookie);
    });
});
