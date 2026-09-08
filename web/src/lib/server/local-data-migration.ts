import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeDb } from "@/lib/auth/store-normalizers";
import type { AuthDatabase } from "@/lib/auth/store-types";
import { upsertPostgresPromptDbWithExecutor, type PromptDatabase } from "@/lib/prompts/store";
import { restorePostgresAuthSnapshot } from "@/lib/server/admin-backup-auth-restore";
import { withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { POSTGRESQL_SCHEMA_SQL } from "@/lib/server/database/schema";
import { upsertPostgresGenerationLogDbWithExecutor } from "@/lib/server/generation-log-repository";
import type { GenerationLogDatabase } from "@/lib/server/generation-log-types";
import { importMigrationDomains } from "@/lib/server/local-data-migration-domains";
import { importMigrationProviders } from "@/lib/server/local-data-migration-providers";
import { decryptSecretValue } from "@/lib/server/secret-crypto";

const FILES = new Set([
    "auth.json",
    "settings.json",
    "prompts.json",
    "generation-logs.json",
    "generation-tasks.json",
    "canvas-projects.json",
    "creative-runtime.json",
    "drama-projects.json",
    "drama-project-versions.json",
    "library-assets.json",
    "local-media-assets.json",
    "audit-logs.json",
    "gemini-tools.json",
    "geminiai-request-logs.json",
    "dreamina-cli.json",
]);
const RECEIPT_TABLE = "octalaicanvas_private_migration_receipts";

export async function readMigrationSource(input: string) {
    const files: Record<string, unknown> = {};
    const hash = createHash("sha256");
    for (const name of (await readdir(input)).filter((name) => name.endsWith(".json")).sort()) {
        if (!FILES.has(name)) throw new Error(`尚未支持的数据文件，拒绝遗漏：${name}`);
        const file = path.join(input, name);
        if (!(await lstat(file)).isFile()) throw new Error("迁移输入必须是普通文件");
        const bytes = await readFile(file);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        try {
            files[name] = JSON.parse(text);
        } catch {
            throw new Error(`迁移文件不是有效 JSON：${name}`);
        }
        hash.update(name).update("\0").update(bytes).update("\0");
    }
    if (!files["auth.json"]) throw new Error("迁移缺少 auth.json");
    const tasks = files["generation-tasks.json"];
    if (tasks !== undefined && !Array.isArray(tasks)) throw new Error("任务快照格式无效");
    // needs_review is deliberately excluded by the existing Worker recovery contract.
    if ((tasks as Record<string, unknown>[] | undefined)?.some((task) => ["pending", "running", "paused"].includes(String(task.status)) && task.executionPhase !== "needs_review"))
        throw new Error("源快照仍有可执行或暂停中的任务，请先在本地完成或取消后重新导出，防止重复计费");
    return { files, digest: hash.digest("hex") };
}

export async function migrateLocalData(input: { directory: string; sourceId: string; check?: boolean }) {
    if (!input.sourceId || !process.env.DATABASE_URL || !process.env.OCTALAICANVAS_ENCRYPTION_KEY) throw new Error("迁移缺少快照 ID、PostgreSQL 配置或原加密密钥");
    const source = await readMigrationSource(input.directory);
    const auth = normalizeDb(source.files["auth.json"] as Partial<AuthDatabase>);
    if (!auth.users.some((user) => user.role === "admin")) throw new Error("本地快照没有管理员，无法作为免安装迁移包");
    const userIds = new Set(auth.users.map((user) => user.id));
    const media = source.files["local-media-assets.json"] as { assets: Record<string, unknown>[] } | undefined;
    const quarantinedMedia = media?.assets.filter((asset) => !userIds.has(String(asset.ownerUserId))) || [];
    const importFiles = media ? { ...source.files, "local-media-assets.json": { ...media, assets: media.assets.filter((asset) => userIds.has(String(asset.ownerUserId))) } } : source.files;
    return withPostgresTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["octalaicanvas-private-data-migration"]);
        const exists = await client.query("SELECT to_regclass($1) AS relation", [`public.${RECEIPT_TABLE}`]);
        if (exists.rows[0]?.relation) {
            const receipt = await client.query(`SELECT source_id, source_digest, counts FROM ${RECEIPT_TABLE}`);
            if (receipt.rows.length === 1 && receipt.rows[0].source_id === input.sourceId && receipt.rows[0].source_digest === source.digest) return { status: "alreadyImported", counts: receipt.rows[0].counts };
            throw new Error("目标库已导入其他快照，拒绝覆盖");
        }
        await assertEmptyTarget(client);
        if (input.check) return { status: "ready", counts: { users: auth.users.length, files: Object.keys(source.files).length } };
        await client.query(POSTGRESQL_SCHEMA_SQL);
        await restorePostgresAuthSnapshot(client, auth);
        if (source.files["prompts.json"]) await upsertPostgresPromptDbWithExecutor(source.files["prompts.json"] as PromptDatabase, client);
        if (source.files["generation-logs.json"]) await upsertPostgresGenerationLogDbWithExecutor(source.files["generation-logs.json"] as GenerationLogDatabase, client);
        const domains = await importMigrationDomains(client, importFiles);
        const providers = await importMigrationProviders(client, source.files);
        const tasks = (source.files["generation-tasks.json"] || []) as Record<string, unknown>[];
        await insertTasks(client, tasks);
        const importedUsers = await client.query("SELECT id, password_hash FROM users");
        if (auth.users.some((user) => importedUsers.rows.find((row) => row.id === user.id)?.password_hash !== user.passwordHash)) throw new Error("管理员或用户密码校验失败，迁移已回滚");
        const importedChannels = await client.query("SELECT id, api_key_ciphertext FROM system_model_channels");
        if (auth.settings.systemChannels.some((channel) => decryptSecretValue(String(importedChannels.rows.find((row) => row.id === channel.id)?.api_key_ciphertext || "")) !== channel.apiKey)) throw new Error("渠道密钥解密校验失败，迁移已回滚");
        const importedSettings = await client.query("SELECT logical_models, default_models FROM app_settings WHERE id='default'");
        if (!isDeepStrictEqual(importedSettings.rows[0]?.logical_models, JSON.parse(JSON.stringify(auth.settings.logicalModels))) || !isDeepStrictEqual(importedSettings.rows[0]?.default_models, JSON.parse(JSON.stringify(auth.settings.defaultModels))))
            throw new Error("模型配置回读校验失败，迁移已回滚");
        const counts = { ...domains, ...providers, users: auth.users.length, channels: auth.settings.systemChannels.length, models: auth.settings.logicalModels.length, tasks: tasks.length, quarantinedMedia: quarantinedMedia.length };
        for (const [table, count] of [
            ["users", auth.users.length],
            ["system_model_channels", auth.settings.systemChannels.length],
            ["generation_tasks", tasks.length],
        ] as const) {
            const actual = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
            if (actual.rows[0]?.count !== count) throw new Error(`导入数量校验失败：${table}`);
        }
        await client.query(`CREATE TABLE ${RECEIPT_TABLE} (source_id text PRIMARY KEY, source_digest text NOT NULL, counts jsonb NOT NULL, quarantined_records jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now())`);
        await client.query(`INSERT INTO ${RECEIPT_TABLE} (source_id,source_digest,counts,quarantined_records) VALUES ($1,$2,$3::jsonb,$4::jsonb)`, [
            input.sourceId,
            source.digest,
            JSON.stringify(counts),
            JSON.stringify({ localMediaWithoutOwner: quarantinedMedia }),
        ]);
        return { status: "imported", counts };
    });
}

async function assertEmptyTarget(client: QueryExecutor) {
    const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND starts_with(tablename, 'octalaicanvas_')");
    for (const { tablename } of tables.rows) {
        if (tablename === "octalaicanvas_schema_migrations") continue;
        const quoted = `"${tablename.replaceAll('"', '""')}"`;
        const result = await client.query(`SELECT EXISTS (SELECT 1 FROM ${quoted}) AS occupied`);
        if (result.rows[0]?.occupied) throw new Error("目标 PostgreSQL 已有项目数据或初始化配置，拒绝自动覆盖，请使用空的专用数据库");
    }
}

async function insertTasks(client: QueryExecutor, tasks: Record<string, unknown>[]) {
    const fields = [
        "id",
        "userId",
        "type",
        "status",
        "payload",
        "createdAt",
        "updatedAt",
        "expiresAt",
        "conversationId",
        "runId",
        "surface",
        "projectId",
        "parentTaskId",
        "attemptNo",
        "clientRequestId",
        "executionPhase",
        "upstreamTaskId",
        "channelId",
        "provider",
        "queryPath",
        "submittedAt",
        "nextPollAt",
        "lastPollAt",
        "lastUpstreamStatus",
        "resultPayload",
        "workerId",
        "leaseUntil",
        "lastHeartbeatAt",
    ];
    const columns = fields.map((field) => (field === "type" ? "task_type" : field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)));
    const dates = new Set(["createdAt", "updatedAt", "expiresAt", "submittedAt", "nextPollAt", "lastPollAt", "leaseUntil", "lastHeartbeatAt"]);
    for (const task of tasks) {
        const values = fields.map((field) => {
            const value = task[field];
            if (value === undefined || value === null) return field === "executionPhase" ? "created" : null;
            if (dates.has(field)) return new Date(value as string | number);
            if (field === "payload" || field === "resultPayload") return JSON.stringify(value);
            return value;
        });
        await client.query(`INSERT INTO generation_tasks (${columns.join(",")}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")})`, values);
    }
}
