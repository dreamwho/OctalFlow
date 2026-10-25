import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POSTGRESQL_SCHEMA_SQL } from "./database/schema";

let client: Client;
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: () => "postgres",
    ensurePostgresSchema: async () => undefined,
    postgresQuery: (sql: string, values: unknown[]) => client.query(sql, values),
    withPostgresTransaction: async (run: (db: Client) => Promise<unknown>) => run(client),
}));
import { claimDueGenerationTasks, releaseGenerationTaskLease, wakeGeminiAiVideoTask } from "./generation-task-scheduler";

const url = process.env.DREAMYO_PERFORMANCE_TEST_DATABASE_URL;
describe.skipIf(!url)("generation notifications on real PostgreSQL", () => {
    const schema = `performance_${randomUUID().replaceAll("-", "")}`;
    let listener: Client;
    beforeAll(async () => {
        client = new Client({ connectionString: url });
        listener = new Client({ connectionString: url });
        await client.connect();
        await listener.connect();
        await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
        await client.query(POSTGRESQL_SCHEMA_SQL);
        await client.query("INSERT INTO users (id,username,display_name,password_hash) VALUES ('owner','fixture-owner','Fixture owner','fixture-unused-hash')");
    });
    afterAll(async () => {
        await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await listener?.end();
        await client?.end();
    });
    it("keeps an active lease and preserves a completion wakeup through release", async () => {
        await client.query(
            "INSERT INTO generation_tasks (id,user_id,task_type,status,provider,channel_id,upstream_task_id,execution_phase,next_poll_at,expires_at) VALUES ('task','owner','video','running','generation','geminiai','vt_fixture','polling','2000-01-01',now()+interval '1 day')",
        );
        await claimDueGenerationTasks({ workerId: "existing-worker", taskIds: ["task"] });
        expect(await wakeGeminiAiVideoTask("vt_fixture")).toEqual([expect.objectContaining({ id: "task", workerId: "existing-worker", lastUpstreamStatus: "provider_notified" })]);
        expect(await claimDueGenerationTasks({ workerId: "other-worker", taskIds: ["task"] })).toEqual([]);
        const released = await releaseGenerationTaskLease("video", "task", "existing-worker", { executionPhase: "polling", nextPollAt: Date.now() + 25_000, lastUpstreamStatus: "processing" });
        const databaseClock = await client.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now");
        const now = Number(databaseClock.rows[0].now);
        expect(released?.nextPollAt).toBeLessThanOrEqual(now);
        await claimDueGenerationTasks({ workerId: "other-worker", taskIds: ["task"], now });
        await releaseGenerationTaskLease("video", "task", "other-worker", { executionPhase: "completed", nextPollAt: undefined });
        expect(await wakeGeminiAiVideoTask("vt_fixture")).toEqual([]);
    });
    it("publishes an owner-only signal after commit and publishes nothing after rollback", async () => {
        await listener.query("LISTEN dreamyo_generation_logs");
        const received: string[] = [];
        listener.on("notification", (event) => received.push(event.payload || ""));
        await client.query("BEGIN");
        await client.query("INSERT INTO generation_logs (id,user_id,username,display_name,kind,source,status,title,prompt) VALUES ('log-one','owner','fixture-owner','Fixture owner','image','image-workbench','pending','private text','private text')");
        await listener.query("SELECT 1");
        expect(received).toEqual([]);
        const event = new Promise<string>((resolve) => listener.once("notification", (item) => resolve(item.payload || "")));
        await client.query("COMMIT");
        expect(await event).toBe("owner");
        await client.query("BEGIN; UPDATE generation_logs SET title='rolled back' WHERE id='log-one'; ROLLBACK");
        await listener.query("SELECT 1");
        expect(received).toEqual(["owner"]);
    });
});
