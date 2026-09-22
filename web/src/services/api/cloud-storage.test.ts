import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadCloudProjectBackup, getCloudStorageUsage, listCloudProjectBackups, uploadCloudProjectBackup, type CloudProjectBackup } from "./cloud-storage";

const bytes = new TextEncoder().encode("valid canvas archive");
const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
const backup: CloudProjectBackup = { referenceId: "backup-one", projectId: "canvas-one", title: "画布", createdAt: "2026-09-22T00:00:00.000Z", bytes: bytes.length, checksumSha256 };

describe("cloud project backup recovery", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("accepts a byte-exact response from the owned backup route", async () => {
        const fetchMock = vi.fn(async () => new Response(bytes, { headers: { "x-dreamyo-sha256": checksumSha256 } }));
        vi.stubGlobal("fetch", fetchMock);
        expect((await downloadCloudProjectBackup(backup)).size).toBe(bytes.length);
        expect(fetchMock).toHaveBeenCalledWith("/api/cloud-storage/backups/backup-one", { cache: "no-store" });
    });

    it("stops restoration if the downloaded bytes differ from the stored digest", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("corrupt", { headers: { "x-dreamyo-sha256": checksumSha256 } })));
        await expect(downloadCloudProjectBackup(backup)).rejects.toThrow("校验失败");
    });

    it("uses Electron Main for commercial backup transport and validates the returned file", async () => {
        const cloudStorage = vi.fn(async (action: string, input: Record<string, unknown>) => {
            if (action === "upload") return { referenceId: "ref-one", bytes: bytes.length };
            if (action === "list") return { items: [backup], total: 1, page: input.page, pageSize: input.pageSize };
            if (action === "usage") return { limitBytes: 1024, usedBytes: bytes.length, availableBytes: 1024 - bytes.length };
            if (action === "download") return { bytes, checksumSha256 };
            throw new Error("unexpected cloud operation");
        });
        const fetchMock = vi.fn();
        vi.stubGlobal("window", { dreamyoDesktop: { cloudStorage } });
        vi.stubGlobal("fetch", fetchMock);
        expect((await uploadCloudProjectBackup(new Blob([bytes]), { id: "canvas-one", title: "画布" })).referenceId).toBe("ref-one");
        expect(cloudStorage).toHaveBeenCalledWith("upload", expect.objectContaining({ projectId: "canvas-one", checksumSha256, bytes }));
        expect((await listCloudProjectBackups()).items).toHaveLength(1);
        expect((await getCloudStorageUsage()).availableBytes).toBe(1024 - bytes.length);
        expect((await downloadCloudProjectBackup(backup)).size).toBe(bytes.length);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
