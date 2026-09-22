import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ shared: false, found: true, events: [] as string[] }));
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: () => "postgres",
    ensurePostgresSchema: vi.fn(),
    postgresQuery: vi.fn(),
    withPostgresTransaction: async (callback: (db: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => callback({
        query: async (sql: string) => {
            state.events.push(sql);
            if (sql.includes("FROM cloud_storage_accounts")) return { rows: [{ base_bytes: "1000", bonus_bytes: "0" }] };
            if (sql.includes("SELECT object_key FROM cloud_storage_object_refs")) return { rows: state.found ? [{ object_key: "cloud/users/user-one/file" }] : [] };
            if (sql.includes("SELECT source FROM cloud_storage_object_refs")) return { rows: state.shared ? [{ source: "backup" }] : [] };
            if (sql.includes("FROM cloud_storage_objects WHERE user_id") && sql.includes("GROUP BY source")) return { rows: state.shared ? [{ source: "backup", bytes: "650" }] : [] };
            if (sql.includes("coalesce(sum(bytes),0)")) return { rows: [{ bytes: "0" }] };
            return { rows: [] };
        },
    }),
}));

import { deleteCloudStorageReference } from "./cloud-storage-service";

const referenceId = "11111111-1111-4111-8111-111111111111";

describe("cloud storage reference deletion", () => {
    beforeEach(() => { state.shared = false; state.found = true; state.events.length = 0; });

    it("keeps the shared OSS object and its quota until the final reference is removed", async () => {
        state.shared = true;
        const removeObject = vi.fn();
        const result = await deleteCloudStorageReference("user-one", referenceId, removeObject);
        expect(result).toMatchObject({ objectDeleted: false, usage: { usedBytes: 650, bySource: { backup: 650 } } });
        expect(removeObject).not.toHaveBeenCalled();
        expect(state.events.some((sql) => sql.includes("UPDATE cloud_storage_objects SET source"))).toBe(true);
        expect(state.events.some((sql) => sql.includes("DELETE FROM cloud_storage_objects"))).toBe(false);
    });

    it("deletes the OSS object before releasing the final reference and quota", async () => {
        const removeObject = vi.fn(async () => { state.events.push("OSS DELETE"); });
        const result = await deleteCloudStorageReference("user-one", referenceId, removeObject);
        expect(result).toMatchObject({ objectDeleted: true, usage: { usedBytes: 0, availableBytes: 1000 } });
        expect(removeObject).toHaveBeenCalledOnce();
        expect(state.events.indexOf("OSS DELETE")).toBeLessThan(state.events.findIndex((sql) => sql.includes("DELETE FROM cloud_storage_objects")));
    });

    it("keeps the database reference and quota when OSS deletion fails", async () => {
        await expect(deleteCloudStorageReference("user-one", referenceId, async () => { throw new Error("OSS unavailable"); })).rejects.toThrow("OSS unavailable");
        expect(state.events.some((sql) => sql.includes("DELETE FROM cloud_storage_object_refs"))).toBe(false);
        expect(state.events.some((sql) => sql.includes("DELETE FROM cloud_storage_objects"))).toBe(false);
    });

    it("does not delete another user's file", async () => {
        state.found = false;
        const removeObject = vi.fn();
        await expect(deleteCloudStorageReference("user-one", referenceId, removeObject)).rejects.toMatchObject({ status: 404 });
        expect(removeObject).not.toHaveBeenCalled();
    });
});
