import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/server/cloud-storage-user", () => ({ getCloudStorageUserId: mocks.user }));
vi.mock("@/lib/server/cloud-storage-upload", () => ({ uploadCloudStorageObject: mocks.upload }));

import { POST } from "./route";

const url = "http://localhost/api/cloud-storage/objects";

describe("cloud storage project backup upload", () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue("user-one"); mocks.upload.mockResolvedValue({ referenceId: "ref-one", deduplicated: false }); });

    it("passes the project identity to the storage transaction", async () => {
        const request = new Request(url, { method: "POST", body: "zip", headers: { "x-dreamyo-source": "backup", "x-dreamyo-project-id": "canvas-one",
            "x-dreamyo-project-title": encodeURIComponent("我的画布"), "x-dreamyo-content-bytes": "3", "x-dreamyo-sha256": "a".repeat(64) } });
        const response = await POST(request);
        expect(response.status).toBe(201);
        expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", source: "backup", backup: { projectId: "canvas-one", title: "我的画布" } }));
    });

    it("does not upload an unlabelled project backup", async () => {
        const response = await POST(new Request(url, { method: "POST", body: "zip", headers: { "x-dreamyo-source": "backup" } }));
        expect(response.status).toBe(400);
        expect(mocks.upload).not.toHaveBeenCalled();
    });

    it("requires login before accepting backup bytes", async () => {
        mocks.user.mockResolvedValue(null);
        const response = await POST(new Request(url, { method: "POST", body: "zip", headers: { "x-dreamyo-source": "backup" } }));
        expect(response.status).toBe(401);
        expect(mocks.upload).not.toHaveBeenCalled();
    });
});
