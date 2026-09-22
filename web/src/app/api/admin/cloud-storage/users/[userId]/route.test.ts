import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), permission: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/admin-permissions", async (original) => ({ ...(await original()), hasAnyAdminPermission: mocks.permission }));
vi.mock("@/lib/server/cloud-storage-service", async (original) => ({ ...(await original()), getCloudStorageUsage: mocks.usage }));

import { GET } from "./route";

const context = { params: Promise.resolve({ userId: "user-one" }) };

describe("admin cloud storage user usage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin-one" });
        mocks.permission.mockReturnValue(true);
        mocks.usage.mockResolvedValue({ usedBytes: 12, reservedBytes: 3, availableBytes: 85, bySource: { asset: 12, project: 0, backup: 0, work: 0 } });
    });

    it("requires a current administrator with user or system duty", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await GET(new Request("http://localhost/api/admin/cloud-storage/users/user-one"), context)).status).toBe(401);
        mocks.user.mockResolvedValue({ id: "admin-one" });
        mocks.permission.mockReturnValue(false);
        expect((await GET(new Request("http://localhost/api/admin/cloud-storage/users/user-one"), context)).status).toBe(403);
        expect(mocks.usage).not.toHaveBeenCalled();
    });

    it("reads only the requested user's server-calculated usage", async () => {
        const response = await GET(new Request("http://localhost/api/admin/cloud-storage/users/user-one"), context);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect((await response.json()).data).toMatchObject({ usedBytes: 12, reservedBytes: 3, availableBytes: 85 });
        expect(mocks.usage).toHaveBeenCalledWith("user-one");
    });
});
