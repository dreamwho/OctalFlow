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
import { cancelActiveGenerationLogSlots } from "./generation-log-cancellation";
import { createImageTask, getImageTask, transitionImageTask } from "./image-task-store";
import { createVideoTask, getVideoTask } from "./video-task-store";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import type { StoredGenerationLog } from "./generation-log-types";

const url = process.env.DREAMYO_PERFORMANCE_TEST_DATABASE_URL;
describe.skipIf(!url)("generation-log cancellation on real PostgreSQL", () => {
    const schema = `cancel_${randomUUID().replaceAll("-", "")}`;
    beforeAll(async () => {
        client = new Client({ connectionString: url });
        await client.connect();
        await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
        await client.query(POSTGRESQL_SCHEMA_SQL);
        await client.query("INSERT INTO users (id,username,display_name,password_hash) VALUES ('owner','fixture-owner','Fixture owner','fixture-unused-hash')");
    });
    afterAll(async () => {
        await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client?.end();
    });

    it("persists image/video cancellation and rejects a late image completion", async () => {
        const config = { baseUrl: "https://fixture.invalid", apiKey: "fixture-key", apiFormat: "openai" as const, model: "fixture-model" };
        const image = await createImageTask({ userId: "owner", username: "fixture-owner", displayName: "Fixture owner", kind: "generation", source: "image-workbench", prompt: "fixture", references: [], config, clientRequestId: "image-request" });
        const video = await createVideoTask({ userId: "owner", config: { ...config, apiSource: "system", apiKey: "system" }, upstream: { id: "upstream-fixture", provider: "openai", model: "fixture-model" }, clientRequestId: "video-request" });
        const logs = [
            { id: "image-log", kind: "image", requestSnapshot: { slots: [{ id: "image-slot", status: "pending", clientRequestId: "image-request" }] } },
            { id: "video-log", kind: "video", requestSnapshot: { slots: [{ id: "video-slot", status: "pending", clientRequestId: "video-request" }] } },
        ] as StoredGenerationLog[];
        expect(await cancelActiveGenerationLogSlots("other-user", logs)).toEqual([]);
        expect((await getImageTask(image.id))?.status).toBe("pending");
        expect(await cancelActiveGenerationLogSlots("owner", logs)).toEqual([{ type: "image", id: image.id }, { type: "video", id: video.id }]);
        expect((await getImageTask(image.id))?.status).toBe("cancelled");
        expect((await getVideoTask(video.id))?.status).toBe("cancelled");
        expect((await getStoredGenerationTaskRecord("image", image.id))?.executionPhase).toBe("cancel_requested");
        expect((await getStoredGenerationTaskRecord("video", video.id))?.upstreamTaskId).toBe("upstream-fixture");
        expect(await transitionImageTask(image, ["pending", "running"], { status: "success" })).toBeNull();
        expect(await cancelActiveGenerationLogSlots("owner", logs)).toEqual([]);
    });
});
