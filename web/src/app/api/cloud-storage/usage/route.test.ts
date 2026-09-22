import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/server/cloud-storage-user", () => ({ getCloudStorageUserId: mocks.user }));
vi.mock("@/lib/server/cloud-storage-service", async (original) => ({ ...(await original()), getCloudStorageUsage: mocks.usage }));

import { GET } from "./route";

describe("cloud storage usage", () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue("cloud-user"); mocks.usage.mockResolvedValue({ limitBytes: 1024, usedBytes: 32, availableBytes: 992 }); });

    it("reports the authenticated device or WEB user's server-side usage", async () => {
        const request = new Request("https://dreamyo.example/api/cloud-storage/usage", { headers: { Authorization: "Bearer device-token" } });
        const response = await GET(request);
        expect(response.status).toBe(200);
        expect(mocks.user).toHaveBeenCalledWith(request);
        expect(mocks.usage).toHaveBeenCalledWith("cloud-user");
    });

    it("does not query usage without an authenticated identity", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await GET(new Request("https://dreamyo.example/api/cloud-storage/usage"))).status).toBe(401);
        expect(mocks.usage).not.toHaveBeenCalled();
    });
});
