import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { GeminiAiRequestLogRepository } from "./geminiai-request-log-repository";
import type { QueryExecutor } from "./postgres";
import { POSTGRESQL_SCHEMA_SQL } from "./schema";

const databaseUrl = process.env.DREAMYO_GEMINIAI_TEST_DATABASE_URL;
const logSchema = POSTGRESQL_SCHEMA_SQL.slice(
    POSTGRESQL_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS geminiai_request_logs ("),
    POSTGRESQL_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS geminiai_api_keys ("),
);

describe.skipIf(!databaseUrl)("GeminiAI video logs in PostgreSQL", () => {
    it.each([false, true])("persists video logs when an existing constraint is present: %s", async (existingConstraint) => {
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        try {
            await client.query("BEGIN");
            const schema = `omni_${randomUUID().replaceAll("-", "")}`;
            await client.query(`CREATE SCHEMA ${schema}`);
            await client.query(`SET LOCAL search_path TO ${schema}`);
            await client.query(logSchema);
            const repository = new GeminiAiRequestLogRepository(client as unknown as QueryExecutor);
            await repository.ensureSchema();
            const log = {
                id: randomUUID(), createdAt: new Date().toISOString(), source: "runtime" as const,
                capability: "image" as const, method: "POST", path: "/v1/videos", model: "gemini-omni-1.1-flash",
                statusCode: 200, durationMs: 0, phase: "running" as const, requestPreview: "参考图视频测试",
            };
            await repository.append(log, 100);
            if (existingConstraint) {
                await client.query("ALTER TABLE geminiai_request_logs DROP CONSTRAINT geminiai_request_logs_capability_check");
                await client.query("ALTER TABLE geminiai_request_logs ADD CONSTRAINT geminiai_request_logs_capability_check CHECK (capability IN ('text', 'image', 'search'))");
                await client.query(logSchema);
            }
            const videoLog = { ...log, id: randomUUID(), capability: "video" as const, phase: "failed" as const, error: "reference image download failed" };
            await repository.append(videoLog, 100);
            const result = await repository.list({ page: 1, pageSize: 20, capability: "video", model: log.model, status: "failed" });
            expect(result.total).toBe(1);
            expect(result.items[0]).toMatchObject(videoLog);
            expect(result.stats).toMatchObject({ total: 2, success: 0, failed: 1 });
            expect((await repository.list({ page: 1, pageSize: 20, capability: "video", status: "success" })).total).toBe(0);
            expect((await repository.list({ page: 1, pageSize: 20, capability: "image" })).total).toBe(1);
            const accepted = { ...videoLog, id: randomUUID(), taskId: "vt_postgres", phase: "running" as const, error: undefined };
            await repository.append(accepted, 100);
            expect(await repository.findByTaskId("vt_postgres", "runtime")).toMatchObject({ id: accepted.id, phase: "running" });
            await repository.update({ ...accepted, phase: "success", responsePreview: "video_url=/v1/videos/vt_postgres/content" });
            await repository.update(accepted); // delayed pending cannot revert terminal success
            expect(await repository.findByTaskId("vt_postgres", "runtime")).toMatchObject({ phase: "success", responsePreview: "video_url=/v1/videos/vt_postgres/content" });
        } finally {
            await client.query("ROLLBACK");
            await client.end();
        }
    });
});
