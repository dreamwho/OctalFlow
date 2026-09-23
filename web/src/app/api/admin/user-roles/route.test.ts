import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getFreshAuthSettings: vi.fn(),
    setAuthSettings: vi.fn(),
    listPublicUsersPage: vi.fn(),
    getCurrentUser: vi.fn(),
    safeRecordAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({
    getFreshAuthSettings: mocks.getFreshAuthSettings,
    setAuthSettings: mocks.setAuthSettings,
    listPublicUsersPage: mocks.listPublicUsersPage,
    isAuthInputError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminPermission: () => true }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: () => ({ id: "admin" }), safeRecordAuditLog: mocks.safeRecordAuditLog }));

import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";
import { DEFAULT_USER_ROLE } from "@/lib/user-roles";
import { PUT } from "./route";

describe("admin user roles route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin", role: "admin", adminPermissions: ["users.manage"] });
        mocks.getFreshAuthSettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
        mocks.setAuthSettings.mockImplementation(async (patch) => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch }));
        mocks.listPublicUsersPage.mockResolvedValue({ users: [], total: 0, page: 1, pageSize: 1 });
    });

    it("persists a validated custom role and audits the change", async () => {
        const role = { ...structuredClone(DEFAULT_USER_ROLE), id: "honor", name: "荣誉会员", pointsMultiplier: 0, recordOnly: true };
        const response = await PUT(new Request("http://localhost/api/admin/user-roles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: [structuredClone(DEFAULT_USER_ROLE), role] }) }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({ userRoles: [expect.objectContaining({ id: "user" }), expect.objectContaining({ id: "honor", recordOnly: true })] });
        expect(mocks.safeRecordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.user-roles.update" }));
    });

    it("prevents deleting a role that is still assigned", async () => {
        const current = { ...structuredClone(DEFAULT_SETTINGS), userRoles: [structuredClone(DEFAULT_USER_ROLE), { ...structuredClone(DEFAULT_USER_ROLE), id: "honor", name: "荣誉会员" }] };
        mocks.getFreshAuthSettings.mockResolvedValue(current);
        mocks.listPublicUsersPage.mockResolvedValue({ users: [], total: 2, page: 1, pageSize: 1 });
        const response = await PUT(new Request("http://localhost/api/admin/user-roles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: [structuredClone(DEFAULT_USER_ROLE)] }) }));

        expect(response.status).toBe(409);
        expect(mocks.setAuthSettings).not.toHaveBeenCalled();
    });
});
