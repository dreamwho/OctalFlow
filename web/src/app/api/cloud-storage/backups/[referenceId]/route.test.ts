import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), remove: vi.fn(), stream: vi.fn(), deleteObject: vi.fn() }));
vi.mock("@/lib/server/cloud-storage-user", () => ({ getCloudStorageUserId: mocks.user }));
vi.mock("@/lib/server/cloud-storage-service", async (original) => ({ ...(await original()), getCloudProjectBackup: mocks.get, deleteCloudStorageReference: mocks.remove }));
vi.mock("@/lib/server/object-storage-config", () => ({ getObjectStorageRuntimeConfig: vi.fn(async () => ({ enabled: true })), assertObjectStorageConfigured: vi.fn() }));
vi.mock("@/lib/server/object-storage-client", () => ({ streamObjectBytes: mocks.stream, deleteObject: mocks.deleteObject }));

import { DELETE, GET } from "./route";

const referenceId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ referenceId }) };

describe("cloud project backup access", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue("user-one");
        mocks.get.mockResolvedValue({ objectKey: "cloud/users/user-one/file", checksumSha256: "a".repeat(64) });
        mocks.stream.mockResolvedValue(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } }));
        mocks.remove.mockResolvedValue({ objectDeleted: true });
    });

    it("streams only a backup owned by the authenticated user", async () => {
        const response = await GET(new Request(`http://localhost/api/cloud-storage/backups/${referenceId}`), context);
        expect(response.status).toBe(200);
        expect(mocks.get).toHaveBeenCalledWith("user-one", referenceId);
        expect(response.headers.get("x-dreamyo-sha256")).toBe("a".repeat(64));
        expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2]);
    });

    it("rejects unauthenticated deletion without touching OSS", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await DELETE(new Request(`http://localhost/api/cloud-storage/backups/${referenceId}`, { method: "DELETE" }), context)).status).toBe(401);
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("checks the backup's ownership before deleting its storage reference", async () => {
        const response = await DELETE(new Request(`http://localhost/api/cloud-storage/backups/${referenceId}`, { method: "DELETE" }), context);
        expect(response.status).toBe(200);
        expect(mocks.get).toHaveBeenCalledWith("user-one", referenceId);
        expect(mocks.remove).toHaveBeenCalledWith("user-one", referenceId, expect.any(Function));
    });
});
