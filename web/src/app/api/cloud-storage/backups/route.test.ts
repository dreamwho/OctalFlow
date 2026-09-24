import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/server/cloud-storage-user", () => ({ getCloudStorageUserId: mocks.user }));
vi.mock("@/lib/server/cloud-storage-service", async (original) => ({ ...(await original()), listCloudProjectBackups: mocks.list }));

import { GET } from "./route";

describe("cloud project backup listing", () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue("user-one"); });

    it("only lists the current user's backups with bounded pagination", async () => {
        mocks.list.mockResolvedValue({ items: [{ referenceId: "backup-one", title: "画布" }], total: 1, page: 2, pageSize: 20 });
        const response = await GET(new Request("http://localhost/api/cloud-storage/backups?page=2"));
        expect(response.status).toBe(200);
        expect(mocks.list).toHaveBeenCalledWith("user-one", 2, 20);
        expect((await response.json()).data.items).toHaveLength(1);
    });

    it("does not query backups before authentication", async () => {
        mocks.user.mockResolvedValue(null);
        const response = await GET(new Request("http://localhost/api/cloud-storage/backups"));
        expect(response.status).toBe(401);
        expect(mocks.list).not.toHaveBeenCalled();
    });
});
