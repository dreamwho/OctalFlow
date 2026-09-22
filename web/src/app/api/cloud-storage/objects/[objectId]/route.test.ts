import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), remove: vi.fn(), sign: vi.fn(), deleteObject: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/cloud-storage-service", async (original) => ({ ...(await original()), getCloudStorageObject: mocks.get, deleteCloudStorageReference: mocks.remove }));
vi.mock("@/lib/server/object-storage-client", () => ({ signObjectRead: mocks.sign, deleteObject: mocks.deleteObject }));
vi.mock("@/lib/server/object-storage-config", () => ({ getObjectStorageRuntimeConfig: vi.fn(async () => ({ enabled: true })), assertObjectStorageConfigured: vi.fn() }));

import { DELETE, GET } from "./route";

const objectId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ objectId }) };

describe("cloud storage object reference route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "user-one" });
        mocks.get.mockResolvedValue({ referenceId: objectId, objectKey: "cloud/users/user-one/private-key", bytes: 42, checksumSha256: "a".repeat(64), source: "backup" });
        mocks.sign.mockResolvedValue("https://oss.example/signed");
        mocks.remove.mockImplementation(async (_userId, _referenceId, deleteRemote) => { await deleteRemote("cloud/users/user-one/private-key"); return { objectDeleted: true }; });
    });

    it("only returns the owned reference and a signed URL, not the OSS key", async () => {
        const response = await GET(new Request("http://localhost/api/cloud-storage/objects/" + objectId), context);
        const payload = await response.json();
        expect(response.status).toBe(200);
        expect(payload.data).toMatchObject({ referenceId: objectId, url: "https://oss.example/signed" });
        expect(payload.data).not.toHaveProperty("objectKey");
        expect(mocks.get).toHaveBeenCalledWith("user-one", objectId);
    });

    it("rejects unauthenticated deletion before touching the database or OSS", async () => {
        mocks.user.mockResolvedValue(null);
        const response = await DELETE(new Request("http://localhost/api/cloud-storage/objects/" + objectId, { method: "DELETE" }), context);
        expect(response.status).toBe(401);
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("deletes only the authenticated user's reference", async () => {
        const response = await DELETE(new Request("http://localhost/api/cloud-storage/objects/" + objectId, { method: "DELETE" }), context);
        expect(response.status).toBe(200);
        expect(mocks.remove).toHaveBeenCalledWith("user-one", objectId, expect.any(Function));
        expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), "cloud/users/user-one/private-key");
    });
});
