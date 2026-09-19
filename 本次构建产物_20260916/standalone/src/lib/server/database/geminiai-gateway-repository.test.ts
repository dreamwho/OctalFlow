import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { GeminiAiGatewayRepository } from "./geminiai-gateway-repository";

function repositoryWith(query: ReturnType<typeof vi.fn>) {
    return new GeminiAiGatewayRepository({ query } as unknown as QueryExecutor);
}

describe("GeminiAiGatewayRepository", () => {
    it("creates the key and gateway tables and seeds the singleton gateway row", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        const repository = repositoryWith(query);

        await repository.ensureSchema();

        const ddl = query.mock.calls.map((call) => call[0]).join("\n");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS geminiai_api_keys");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS geminiai_gateway_settings");
        expect(ddl).toContain("INSERT INTO geminiai_gateway_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING");
    });

    it("authorizes keys by hash and records usage with RETURNING", async () => {
        const createdAt = new Date();
        const query = vi.fn().mockResolvedValue({
            rows: [{ id: "key-1", name: "外部网站", prefix: "oct_gai_test", key_hash: "hash-1", status: "active", expires_at: null, allowed_ips: [], request_count: 5, last_used_at: createdAt, created_at: createdAt }],
            rowCount: 1,
        });

        await expect(repositoryWith(query).findApiKeyByHash("hash-1")).resolves.toMatchObject({ id: "key-1", status: "active", allowedIps: [] });
        expect(query).toHaveBeenCalledWith("SELECT * FROM geminiai_api_keys WHERE key_hash = $1", ["hash-1"]);

        await expect(repositoryWith(query).recordApiKeyRequest("key-1")).resolves.toMatchObject({ requestCount: 5 });
        expect(query).toHaveBeenCalledWith("UPDATE geminiai_api_keys SET request_count=request_count+1,last_used_at=now() WHERE id=$1 RETURNING *", ["key-1"]);
    });

    it("patches the singleton gateway row and defaults a missing row to enabled", async () => {
        const query = vi.fn().mockResolvedValueOnce({
            rows: [{ id: "default", enabled: false, created_at: new Date(), updated_at: new Date() }],
            rowCount: 1,
        });

        await expect(repositoryWith(query).updateGateway({ enabled: false })).resolves.toEqual({ enabled: false });
        expect(query).toHaveBeenCalledWith("UPDATE geminiai_gateway_settings SET enabled=$1, updated_at=now() WHERE id='default' RETURNING *", [false]);

        await expect(repositoryWith(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })).updateGateway({ enabled: false })).resolves.toEqual({ enabled: false });
    });
});
