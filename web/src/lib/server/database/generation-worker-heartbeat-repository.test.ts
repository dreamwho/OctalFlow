import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    pool: vi.fn(),
}));

vi.mock("pg", () => ({
    Pool: mocks.pool,
}));

import { latestGenerationWorkerHeartbeat, upsertGenerationWorkerHeartbeat } from "./generation-worker-heartbeat-repository";

describe("generation Worker heartbeat PostgreSQL repository", () => {
    beforeEach(() => {
        delete (globalThis as Record<string, unknown>).__octalaicanvasProPostgresPool;
        delete (globalThis as Record<string, unknown>).__octalaicanvasProPostgresSchemaReady;
        process.env.DATABASE_URL = "postgres://octalaicanvas:test@localhost:5432/octalaicanvas";
        mocks.query.mockReset().mockImplementation(async (sql: string) => {
            if (sql.includes("to_regclass")) return { rows: [{ table_name: "octalaicanvas_users" }] };
            if (sql.includes("SELECT last_seen_at")) return { rows: [{ last_seen_at: "2026-07-29T12:00:00.000Z" }] };
            return { rows: [] };
        });
        mocks.pool.mockReset().mockImplementation(function PoolMock() {
            return {
                query: mocks.query,
                connect: vi.fn(async () => ({ query: mocks.query, release: vi.fn() })),
            };
        });
    });

    it("writes, prunes, and reads heartbeats through prefixed parameterized SQL", async () => {
        const at = new Date("2026-07-29T12:00:00.000Z");

        await upsertGenerationWorkerHeartbeat("worker-1", at);
        await expect(latestGenerationWorkerHeartbeat()).resolves.toBe(at.getTime());

        const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
        const insertCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO octalaicanvas_generation_worker_heartbeats"));
        const deleteCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM octalaicanvas_generation_worker_heartbeats"));
        const selectCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes("SELECT last_seen_at FROM octalaicanvas_generation_worker_heartbeats"));

        expect(statements.filter((sql) => sql.includes("SELECT to_regclass('public.octalaicanvas_users')"))).toHaveLength(1);
        expect(statements.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS octalaicanvas_schema_migrations"))).toHaveLength(1);
        expect(insertCall?.[1]).toEqual(["worker-1", at]);
        expect(deleteCall?.[1]).toEqual([new Date(at.getTime() - 10 * 60_000)]);
        expect(selectCall?.[1]).toBeUndefined();
    });
});
