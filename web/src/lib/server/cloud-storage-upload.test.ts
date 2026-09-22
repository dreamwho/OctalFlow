import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    reserve: vi.fn(), attach: vi.fn(), complete: vi.fn(), release: vi.fn(),
    put: vi.fn(), digest: vi.fn(), exists: vi.fn(), remove: vi.fn(),
}));

vi.mock("@/lib/server/cloud-storage-service", async (original) => ({
    ...(await original()), reserveCloudStorage: mocks.reserve,
    attachCloudStorageReference: mocks.attach, completeCloudStorageReservation: mocks.complete, releaseCloudStorageReservation: mocks.release,
}));
vi.mock("@/lib/server/object-storage-config", () => ({
    getObjectStorageRuntimeConfig: vi.fn(async () => ({ enabled: true })), assertObjectStorageConfigured: vi.fn(),
}));
vi.mock("@/lib/server/object-storage-client", () => ({
    putObjectFile: mocks.put, getObjectDigest: mocks.digest, objectExists: mocks.exists, deleteObject: mocks.remove,
}));

import { uploadCloudStorageObject } from "./cloud-storage-upload";

const bytes = new TextEncoder().encode("cloud storage payload");
const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
const input = { userId: "user-one", source: "backup" as const, bytes: bytes.length, checksumSha256, contentType: "application/zip" };
function body(value = bytes) { return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value); controller.close(); } }); }

describe("cloud storage upload", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.reserve.mockImplementation(async (value) => ({ status: "reserved", reservationId: value.reservationId, objectKey: value.objectKey }));
        mocks.digest.mockResolvedValue({ bytes: bytes.length, checksumSha256 });
        mocks.complete.mockImplementation(async (value) => ({ referenceId: value.reservationId }));
        mocks.attach.mockResolvedValue(undefined);
        mocks.release.mockResolvedValue(undefined);
        mocks.remove.mockResolvedValue(undefined);
    });

    it("writes a verified file to OSS before committing quota", async () => {
        const result = await uploadCloudStorageObject({ ...input, body: body() });
        expect(result).toMatchObject({ bytes: bytes.length, deduplicated: false, referenceId: expect.any(String) });
        expect(result.downloadPath).toBe(`/api/cloud-storage/objects/${result.referenceId}`);
        expect(mocks.put).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bytes: bytes.length, contentType: "application/zip" }));
        expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ verifiedBytes: bytes.length, verifiedChecksumSha256: checksumSha256 }));
        expect(mocks.release).not.toHaveBeenCalled();
    });

    it("rejects a changed body and releases the quota without writing to OSS", async () => {
        await expect(uploadCloudStorageObject({ ...input, body: body(new TextEncoder().encode("tampered payload")) })).rejects.toThrow("SHA-256");
        expect(mocks.put).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it("removes an uploaded object if remote verification disagrees", async () => {
        mocks.digest.mockResolvedValue({ bytes: bytes.length, checksumSha256: "0".repeat(64) });
        mocks.complete.mockRejectedValue(new Error("verification failed"));
        await expect(uploadCloudStorageObject({ ...input, body: body() })).rejects.toThrow("verification failed");
        expect(mocks.remove).toHaveBeenCalledOnce();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it("returns an existing object without uploading it again", async () => {
        mocks.reserve.mockResolvedValue({ status: "stored", objectKey: "cloud/users/user-one/existing", referenceId: "ref-one" });
        mocks.exists.mockResolvedValue(true);
        await expect(uploadCloudStorageObject({ ...input, body: body() })).resolves.toMatchObject({ deduplicated: true, referenceId: "ref-one" });
        expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", referenceId: "ref-one", source: "backup" }));
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it("does not create a reference if the indexed OSS object is missing", async () => {
        mocks.reserve.mockResolvedValue({ status: "stored", objectKey: "cloud/users/user-one/missing", referenceId: "ref-missing" });
        mocks.exists.mockResolvedValue(false);
        await expect(uploadCloudStorageObject({ ...input, body: body() })).rejects.toThrow("OSS 不一致");
        expect(mocks.attach).not.toHaveBeenCalled();
    });
});
