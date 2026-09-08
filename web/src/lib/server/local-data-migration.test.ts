import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), restore: vi.fn() }));
vi.mock("@/lib/server/database", () => ({ withPostgresTransaction: (callback: (client: { query: typeof mocks.query }) => unknown) => callback({ query: mocks.query }) }));
vi.mock("@/lib/server/admin-backup-auth-restore", () => ({ restorePostgresAuthSnapshot: mocks.restore }));
vi.mock("@/lib/prompts/store", () => ({ upsertPostgresPromptDbWithExecutor: vi.fn() }));
vi.mock("@/lib/server/generation-log-repository", () => ({ upsertPostgresGenerationLogDbWithExecutor: vi.fn() }));
vi.mock("@/lib/server/local-data-migration-domains", () => ({ importMigrationDomains: vi.fn(async () => ({})) }));
vi.mock("@/lib/server/local-data-migration-providers", () => ({ importMigrationProviders: vi.fn(async () => ({})) }));
import { migrateLocalData, readMigrationSource } from "./local-data-migration";

const roots: string[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@127.0.0.1/fixture");
    vi.stubEnv("OCTALAICANVAS_ENCRYPTION_KEY", "a".repeat(64));
    mocks.query.mockResolvedValue({ rows: [] });
});
afterEach(async () => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function source(tasks: unknown[] = []) {
    const directory = await mkdtemp(path.join(tmpdir(), "octal-migration-core-"));
    roots.push(directory);
    await writeFile(path.join(directory, "auth.json"), JSON.stringify({ users: [{ id: "admin", role: "admin", username: "fixture", passwordHash: "preserved-fixture-hash" }] }));
    await writeFile(path.join(directory, "generation-tasks.json"), JSON.stringify(tasks));
    return directory;
}
it("retains needs_review tasks but refuses automatically executable tasks", async () => {
    const directory = await source([{ status: "running", executionPhase: "needs_review" }]);
    expect((await readMigrationSource(directory)).files["generation-tasks.json"]).toHaveLength(1);
    await writeFile(path.join(directory, "generation-tasks.json"), JSON.stringify([{ status: "running", executionPhase: "polling" }]));
    await expect(readMigrationSource(directory)).rejects.toThrow("防止重复计费");
});
it("refuses unknown data files rather than silently skipping them", async () => {
    const directory = await source();
    await writeFile(path.join(directory, "new-business-data.json"), "{}");
    await expect(readMigrationSource(directory)).rejects.toThrow("拒绝遗漏");
});
it("preflight on empty target never writes schema or business data", async () => {
    const directory = await source();
    expect((await migrateLocalData({ directory, sourceId: "fixture", check: true })).status).toBe("ready");
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.every(([sql]) => !/CREATE|INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
});
it("refuses a populated database before any import", async () => {
    const directory = await source();
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_tables") ? [{ tablename: "octalaicanvas_users" }] : sql.includes("SELECT EXISTS") ? [{ occupied: true }] : [] }));
    await expect(migrateLocalData({ directory, sourceId: "fixture" })).rejects.toThrow("拒绝自动覆盖");
    expect(mocks.restore).not.toHaveBeenCalled();
});
it("matching transactional receipt is a read-only repeat, changed snapshot is refused", async () => {
    const directory = await source();
    const { digest } = await readMigrationSource(directory);
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("to_regclass") ? [{ relation: "receipt" }] : sql.includes("SELECT source_id") ? [{ source_id: "fixture", source_digest: digest, counts: { users: 1 } }] : [] }));
    expect((await migrateLocalData({ directory, sourceId: "fixture" })).status).toBe("alreadyImported");
    await writeFile(path.join(directory, "settings.json"), "{}");
    await expect(migrateLocalData({ directory, sourceId: "fixture" })).rejects.toThrow("拒绝覆盖");
    expect(mocks.restore).not.toHaveBeenCalled();
});
