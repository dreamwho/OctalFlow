import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    connect: vi.fn(),
    pool: vi.fn(),
}));

vi.mock("pg", () => ({
    Pool: mocks.pool,
}));

import { ensurePostgresSchema, initializePostgresSchema, postgresQuery, withPostgresTransaction } from "./postgres";

describe("PostgreSQL schema lifecycle", () => {
    beforeEach(() => {
        delete (globalThis as Record<string, unknown>).__octalaicanvasProPostgresPool;
        delete (globalThis as Record<string, unknown>).__octalaicanvasProPostgresSchemaReady;
        process.env.DATABASE_URL = "postgres://octalaicanvas:test@localhost:5432/octalaicanvas";
        delete process.env.OCTALAICANVAS_DATABASE_SSL;
        delete process.env.OCTALAICANVAS_DATABASE_SSL_CA;
        delete process.env.OCTALAICANVAS_DATABASE_SSL_REJECT_UNAUTHORIZED;
        mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: vi.fn() });
        mocks.pool.mockReset().mockImplementation(function PoolMock() {
            return { query: mocks.query, connect: mocks.connect };
        });
    });

    it("verifies PostgreSQL TLS certificates by default and accepts an explicit CA", async () => {
        process.env.OCTALAICANVAS_DATABASE_SSL = "1";
        process.env.OCTALAICANVAS_DATABASE_SSL_CA = "-----BEGIN CERTIFICATE-----\\ncertificate\\n-----END CERTIFICATE-----";
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

        await expect(ensurePostgresSchema()).rejects.toThrow("PostgreSQL schema has not been initialized");

        expect(mocks.pool).toHaveBeenCalledWith(
            expect.objectContaining({
                ssl: {
                    rejectUnauthorized: true,
                    ca: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
                },
            }),
        );
    });

    it("only disables PostgreSQL certificate verification through an explicit override", async () => {
        process.env.OCTALAICANVAS_DATABASE_SSL = "1";
        process.env.OCTALAICANVAS_DATABASE_SSL_REJECT_UNAUTHORIZED = "0";
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

        await expect(ensurePostgresSchema()).rejects.toThrow("PostgreSQL schema has not been initialized");

        expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: false } }));
    });

    it("serializes concurrent repository queries on one transaction client", async () => {
        let active = false;
        const statements: string[] = [];
        const release = vi.fn();
        const clientQuery = vi.fn(async (statement: string) => {
            statements.push(statement);
            if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") return { rows: [], rowCount: 0 };
            if (active) throw new Error("transaction client received concurrent queries");
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 0));
            active = false;
            return { rows: [], rowCount: 0 };
        });
        mocks.connect.mockResolvedValue({ query: clientQuery, release });

        await withPostgresTransaction(async (client) => {
            await Promise.all([client.query("SELECT 1"), client.query("SELECT 2"), client.query("SELECT 3")]);
        });

        expect(statements).toEqual(["BEGIN", "SELECT 1", "SELECT 2", "SELECT 3", "COMMIT"]);
        expect(release).toHaveBeenCalledOnce();
    });

    it("does not execute schema DDL when an ordinary caller reaches an empty database", async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

        await expect(ensurePostgresSchema()).rejects.toThrow("PostgreSQL schema has not been initialized");

        expect(mocks.query).toHaveBeenCalledTimes(1);
        expect(mocks.query.mock.calls[0]?.[0]).toContain("to_regclass");
        expect(mocks.query.mock.calls[0]?.[0]).not.toContain("CREATE TABLE");
    });

    it("prefixes SQL identifiers without rewriting ordinary string literals", async () => {
        await postgresQuery("SELECT 'users' AS target_type, $$users.read$$ AS permission FROM users WHERE action = 'users.read'");

        expect(mocks.query).toHaveBeenCalledWith("SELECT 'users' AS target_type, $$users.read$$ AS permission FROM octalaicanvas_users WHERE action = 'users.read'", undefined);
    });

    it("executes schema DDL only through explicit initialization", async () => {
        await initializePostgresSchema();

        expect(mocks.query).toHaveBeenCalledTimes(4);
        expect(mocks.query.mock.calls[0]?.[0]).toBe("BEGIN");
        expect(mocks.query.mock.calls[1]).toEqual(["SELECT pg_advisory_xact_lock(hashtext($1))", ["octalaicanvas:schema"]]);
        const ddl = String(mocks.query.mock.calls[2]?.[0]);
        expect(mocks.query.mock.calls[3]?.[0]).toBe("COMMIT");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_schema_migrations");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_generation_worker_heartbeats");
        expect(ddl).toContain("CREATE SEQUENCE IF NOT EXISTS octalaicanvas_user_account_id_seq");
        expect(ddl).toContain("account_id bigint NOT NULL DEFAULT nextval('octalaicanvas_user_account_id_seq')");
        expect(ddl).toMatch(/SELECT setval\(\s*'octalaicanvas_user_account_id_seq'/);
        expect(ddl).toContain("users.read");
        expect(ddl).toContain("users.manage");
        expect(ddl).not.toContain("octalaicanvas_users.read");
        expect(ddl).not.toContain("octalaicanvas_users.manage");
        expect(ddl).toContain("terms_version text");
        expect(ddl).toContain("policy_accepted_at timestamptz");
        expect(ddl).toContain("mfa_secret_ciphertext text");
        expect(ddl).toContain("CONSTRAINT users_mfa_enabled_secret CHECK");
        expect(ddl).toContain("CONSTRAINT users_registration_consent_complete CHECK");
        expect(ddl).toContain("ALTER TABLE octalaicanvas_users ADD CONSTRAINT users_admin_permissions_array");
        expect(ddl).toContain("conname = 'octalaicanvas_local_media_assets_storage_provider_check'");
        expect(ddl).toContain("ADD CONSTRAINT octalaicanvas_local_media_assets_storage_provider_check CHECK");
        expect(ddl).toContain("CREATE UNIQUE INDEX IF NOT EXISTS octalaicanvas_users_account_id_idx ON octalaicanvas_users (account_id)");
        expect(ddl).toContain("CREATE INDEX IF NOT EXISTS octalaicanvas_billing_orders_provider_payment_idx ON octalaicanvas_billing_orders (provider, provider_payment_id)");
        expect(ddl).toContain("webhook_secret_ciphertext text NOT NULL DEFAULT ''");
        expect(ddl).toContain("CREATE UNIQUE INDEX IF NOT EXISTS octalaicanvas_generation_tasks_channel_upstream_idx ON octalaicanvas_generation_tasks (channel_id, upstream_task_id)");
        expect(ddl).toContain("signature_timestamp timestamptz NOT NULL");
        expect(ddl).toContain("conflict_count integer NOT NULL DEFAULT 0");
        expect(ddl).toContain("user_id text NOT NULL REFERENCES octalaicanvas_users(id) ON DELETE CASCADE");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_account_deletion_requests");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_gemini_tools_accounts");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_gemini_tools_oauth_sessions");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_gemini_tools_api_keys");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_gemini_tools_gateway_settings");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_gemini_tools_request_logs");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_magic_proxy_settings");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_dreamina_cli_account_state");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_dreamina_cli_request_logs");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_runninghub_settings");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_runninghub_apps");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_runninghub_tasks");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_runninghub_request_logs");
        expect(ddl).toContain("CREATE UNIQUE INDEX IF NOT EXISTS octalaicanvas_gemini_tools_accounts_email_lower_idx");
        expect(ddl).toContain("'review_pending', 'reviewing', 'review_unavailable'");
        expect(ddl).toContain("task_type = 'agent' AND status = 'success' AND execution_phase IN ('review_pending', 'reviewing')");

        const tableNames = [...ddl.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z][a-z0-9_]*)/gi)].map((match) => match[1]).sort();
        expect(tableNames).toHaveLength(72);
        expect(tableNames.every((name) => name.startsWith("octalaicanvas_"))).toBe(true);
        expect(tableNames).not.toContain("octalaicanvas_check_ins");
        expect(ddl).toContain("DROP TABLE IF EXISTS octalaicanvas_check_ins");
        expect(ddl).not.toContain("20260731_generation_task_recovery");

        const indexNames = [...ddl.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)/gi)].map((match) => match[1]);
        expect(indexNames.length).toBeGreaterThan(0);
        expect(indexNames.every((name) => name.startsWith("octalaicanvas_"))).toBe(true);

        const uniqueConstraintNames = [...ddl.matchAll(/CONSTRAINT\s+([a-z][a-z0-9_]*)\s+UNIQUE\b/gi)].map((match) => match[1]);
        expect(uniqueConstraintNames.length).toBeGreaterThan(0);
        expect(uniqueConstraintNames.every((name) => name.startsWith("octalaicanvas_"))).toBe(true);
    });

    it("continues applying additive schema updates after the sentinel table exists", async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: "octalaicanvas_users" }] });

        await ensurePostgresSchema();

        expect(mocks.query).toHaveBeenCalledTimes(5);
        expect(mocks.query.mock.calls[0]?.[0]).toContain("to_regclass");
        expect(mocks.query.mock.calls[2]).toEqual(["SELECT pg_advisory_xact_lock(hashtext($1))", ["octalaicanvas:schema"]]);
        expect(mocks.query.mock.calls[3]?.[0]).toContain("CREATE TABLE IF NOT EXISTS octalaicanvas_schema_migrations");
    });
});
