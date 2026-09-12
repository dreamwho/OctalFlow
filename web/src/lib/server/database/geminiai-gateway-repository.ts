import type { GeminiAiGatewaySettings, StoredGeminiAiApiKey } from "@/lib/server/geminiai-gateway-store";
import type { QueryExecutor } from "./postgres";

export class GeminiAiGatewayRepository {
    constructor(private readonly db: QueryExecutor) {}

    async ensureSchema() {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS geminiai_api_keys (
                id text PRIMARY KEY,
                name text NOT NULL,
                prefix text NOT NULL,
                key_hash text NOT NULL UNIQUE,
                status text NOT NULL DEFAULT 'active',
                expires_at timestamptz,
                allowed_ips jsonb NOT NULL DEFAULT '[]'::jsonb,
                request_count bigint NOT NULL DEFAULT 0,
                last_used_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT geminiai_api_keys_status_check CHECK (status IN ('active', 'disabled'))
            );
            CREATE INDEX IF NOT EXISTS geminiai_api_keys_status_idx ON geminiai_api_keys (status, expires_at);
            CREATE TABLE IF NOT EXISTS geminiai_gateway_settings (
                id text PRIMARY KEY DEFAULT 'default',
                enabled boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT geminiai_gateway_singleton CHECK (id = 'default')
            );
            INSERT INTO geminiai_gateway_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
        `).catch(() => undefined);
    }

    async getGateway() {
        const result = await this.db.query("SELECT * FROM geminiai_gateway_settings WHERE id = 'default'");
        return result.rows[0] ? mapGateway(result.rows[0]) : { enabled: true };
    }

    async updateGateway(patch: Partial<GeminiAiGatewaySettings>) {
        if (patch.enabled === undefined) return this.getGateway();
        const result = await this.db.query("UPDATE geminiai_gateway_settings SET enabled=$1, updated_at=now() WHERE id='default' RETURNING *", [patch.enabled]);
        return result.rows[0] ? mapGateway(result.rows[0]) : { enabled: patch.enabled === true };
    }

    async listApiKeys() {
        const result = await this.db.query("SELECT * FROM geminiai_api_keys ORDER BY created_at DESC");
        return result.rows.map(mapApiKey);
    }

    async insertApiKey(key: StoredGeminiAiApiKey) {
        const result = await this.db.query("INSERT INTO geminiai_api_keys (id,name,prefix,key_hash,status,expires_at,allowed_ips,request_count,last_used_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *", [
            key.id,
            key.name,
            key.prefix,
            key.hash,
            key.status,
            key.expiresAt || null,
            JSON.stringify(key.allowedIps),
            key.requestCount,
            key.lastUsedAt || null,
            new Date(key.createdAt),
        ]);
        return mapApiKey(result.rows[0]);
    }

    async patchApiKey(id: string, patch: Partial<Pick<StoredGeminiAiApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) {
        const values: unknown[] = [id];
        const assignments: string[] = [];
        addPatch(assignments, values, "name", patch.name);
        addPatch(assignments, values, "status", patch.status);
        if (patch.expiresAt === "") assignments.push("expires_at = NULL");
        else addPatch(assignments, values, "expires_at", patch.expiresAt);
        if (patch.allowedIps) addPatch(assignments, values, "allowed_ips", JSON.stringify(patch.allowedIps), "::jsonb");
        if (!assignments.length) return (await this.listApiKeys()).find((key) => key.id === id) || null;
        const result = await this.db.query(`UPDATE geminiai_api_keys SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`, values);
        return result.rows[0] ? mapApiKey(result.rows[0]) : null;
    }

    async deleteApiKey(id: string) {
        const result = await this.db.query("DELETE FROM geminiai_api_keys WHERE id = $1 RETURNING id", [id]);
        return (result.rowCount || 0) > 0;
    }

    async findApiKeyByHash(hash: string) {
        const result = await this.db.query("SELECT * FROM geminiai_api_keys WHERE key_hash = $1", [hash]);
        return result.rows[0] ? mapApiKey(result.rows[0]) : null;
    }

    async recordApiKeyRequest(id: string) {
        const result = await this.db.query("UPDATE geminiai_api_keys SET request_count=request_count+1,last_used_at=now() WHERE id=$1 RETURNING *", [id]);
        return result.rows[0] ? mapApiKey(result.rows[0]) : null;
    }
}

function addPatch(assignments: string[], values: unknown[], column: string, value: unknown, suffix = "") {
    if (value === undefined) return;
    values.push(value);
    assignments.push(`${column} = $${values.length}${suffix}`);
}

function mapGateway(row: Record<string, unknown>): GeminiAiGatewaySettings {
    return { enabled: row.enabled !== false };
}

function mapApiKey(row: Record<string, unknown>): StoredGeminiAiApiKey {
    return {
        id: string(row.id),
        name: string(row.name),
        prefix: string(row.prefix),
        hash: string(row.key_hash),
        status: row.status === "disabled" ? "disabled" : "active",
        ...(date(row.expires_at) ? { expiresAt: date(row.expires_at)! } : {}),
        allowedIps: strings(row.allowed_ips),
        requestCount: number(row.request_count),
        ...(date(row.last_used_at) ? { lastUsedAt: date(row.last_used_at)! } : {}),
        createdAt: date(row.created_at) || new Date().toISOString(),
    };
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? safeArray(value).filter((item): item is string => typeof item === "string") : [];
}

function safeArray(value: string): unknown[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function string(value: unknown) {
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function number(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: unknown) {
    if (!value) return undefined;
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}
