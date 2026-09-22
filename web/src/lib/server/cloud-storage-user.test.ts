import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ current: vi.fn(), device: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.current }));
vi.mock("@/lib/server/desktop-device-auth", () => ({
    DesktopDeviceAuthError: class DesktopDeviceAuthError extends Error {},
    getDesktopDeviceSessionUserId: mocks.device,
}));

import { DesktopDeviceAuthError } from "@/lib/server/desktop-device-auth";
import { getCloudStorageUserId } from "./cloud-storage-user";

describe("cloud storage user identity", () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.current.mockResolvedValue({ id: "web-user" }); mocks.device.mockResolvedValue("desktop-user"); });

    it("keeps the current WEB cookie session behavior", async () => {
        expect(await getCloudStorageUserId(new Request("https://dreamyo.example/api/cloud-storage/backups"))).toBe("web-user");
        expect(mocks.device).not.toHaveBeenCalled();
    });

    it("uses the device token without falling back to a different browser cookie", async () => {
        const request = new Request("https://dreamyo.example/api/cloud-storage/backups", { headers: { Authorization: "Bearer device-token" } });
        expect(await getCloudStorageUserId(request)).toBe("desktop-user");
        expect(mocks.device).toHaveBeenCalledWith("device-token");
        expect(mocks.current).not.toHaveBeenCalled();
        mocks.device.mockRejectedValueOnce(new DesktopDeviceAuthError("device rejected", 401));
        expect(await getCloudStorageUserId(request)).toBeNull();
    });

    it("rejects an unsupported authorization header even with a valid WEB cookie", async () => {
        expect(await getCloudStorageUserId(new Request("https://dreamyo.example/api/cloud-storage/backups", { headers: { Authorization: "Basic abc" } }))).toBeNull();
        expect(mocks.current).not.toHaveBeenCalled();
    });
});
