import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; values?: unknown[] }>, failBackup: false }));
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: () => "postgres", ensurePostgresSchema: vi.fn(),
    postgresQuery: vi.fn(async (sql: string, values?: unknown[]) => {
        state.queries.push({ sql, values });
        if (sql.includes("count(*)")) return { rows: [{ total: "1" }] };
        if (sql.includes("FROM cloud_storage_project_backups b")) return { rows: [{ reference_id: "backup-one", project_id: "canvas-one", title: "画布", created_at: new Date("2026-09-22T00:00:00Z"), bytes: "3", checksum_sha256: "a".repeat(64) }] };
        return { rows: [] };
    }),
    withPostgresTransaction: async (callback: (db: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => callback({
        query: async (sql, values) => {
            state.queries.push({ sql, values });
            if (sql.includes("FROM cloud_storage_accounts")) return { rows: [{ base_bytes: "1000", bonus_bytes: "0" }] };
            if (sql.includes("FROM cloud_storage_objects WHERE user_id") && !sql.includes("GROUP BY")) return { rows: [{ bytes: "3", checksum_sha256: "a".repeat(64) }] };
            if (sql.includes("INSERT INTO cloud_storage_project_backups") && state.failBackup) throw new Error("backup index failed");
            return { rows: [] };
        },
    }),
}));

import { attachCloudStorageReference, listCloudProjectBackups } from "./cloud-storage-service";

const input = { userId: "user-one", referenceId: "11111111-1111-4111-8111-111111111111", objectKey: "cloud/users/user-one/object",
    bytes: 3, checksumSha256: "a".repeat(64), source: "backup" as const, backup: { projectId: "canvas-one", title: "画布" } };

describe("cloud project backup index", () => {
    beforeEach(() => { state.queries.length = 0; state.failBackup = false; });

    it("writes the backup index after the owned object reference in the same transaction", async () => {
        await attachCloudStorageReference(input);
        const sql = state.queries.map((query) => query.sql);
        expect(sql.findIndex((value) => value.includes("INSERT INTO cloud_storage_object_refs"))).toBeGreaterThan(-1);
        expect(sql.findIndex((value) => value.includes("INSERT INTO cloud_storage_project_backups"))).toBeGreaterThan(sql.findIndex((value) => value.includes("INSERT INTO cloud_storage_object_refs")));
        expect(state.queries.find((query) => query.sql.includes("INSERT INTO cloud_storage_project_backups"))?.values).toEqual([input.referenceId, input.userId, "canvas-one", "画布"]);
    });

    it("aborts the attachment if the backup index cannot be written", async () => {
        state.failBackup = true;
        await expect(attachCloudStorageReference(input)).rejects.toThrow("backup index failed");
    });

    it("lists only the requested user's indexed backups", async () => {
        const page = await listCloudProjectBackups("user-one", 1, 20);
        expect(page).toMatchObject({ total: 1, items: [{ projectId: "canvas-one", title: "画布", bytes: 3 }] });
        expect(state.queries.filter((query) => query.sql.includes("cloud_storage_project_backups")).every((query) => query.values?.[0] === "user-one")).toBe(true);
        await expect(listCloudProjectBackups("user-one", 1, 101)).rejects.toMatchObject({ status: 400 });
    });
});
