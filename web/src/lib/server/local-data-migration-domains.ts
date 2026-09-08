import type { QueryExecutor } from "@/lib/server/database";

type JsonRecord = Record<string, unknown>;

const FILE_NAMES = {
    canvasProjects: "canvas-projects.json",
    creativeRuntime: "creative-runtime.json",
    dramaProjects: "drama-projects.json",
    dramaProjectVersions: "drama-project-versions.json",
    libraryAssets: "library-assets.json",
    localMediaAssets: "local-media-assets.json",
    auditLogs: "audit-logs.json",
} as const;

export class MigrationDomainImportError extends Error {
    constructor(readonly file: string, readonly detail: string) {
        super(`${file}: ${detail}`);
    }
}

/**
 * Imports FILE-provider domain data into the matching PostgreSQL tables.
 * The caller owns schema setup, target safety checks, and the transaction.
 * This function reads only the provided in-memory snapshot and never writes it.
 */
export async function importMigrationDomains(client: QueryExecutor, files: Record<string, unknown>): Promise<Record<string, number>> {
    const counts: Record<string, number> = {
        canvasProjects: 0,
        creativeConversations: 0,
        creativeMessages: 0,
        creativeAssets: 0,
        creativeRunEvents: 0,
        dramaProjects: 0,
        dramaProjectVersions: 0,
        libraryAssets: 0,
        localMediaAssets: 0,
        auditLogs: 0,
    };

    if (hasFile(files, FILE_NAMES.canvasProjects)) counts.canvasProjects = await importCanvasProjects(client, objectFile(files, FILE_NAMES.canvasProjects), FILE_NAMES.canvasProjects);
    if (hasFile(files, FILE_NAMES.creativeRuntime)) {
        const imported = await importCreativeRuntime(client, objectFile(files, FILE_NAMES.creativeRuntime), FILE_NAMES.creativeRuntime);
        Object.assign(counts, imported);
    }
    if (hasFile(files, FILE_NAMES.dramaProjects)) counts.dramaProjects = await importDramaProjects(client, objectFile(files, FILE_NAMES.dramaProjects), FILE_NAMES.dramaProjects);
    if (hasFile(files, FILE_NAMES.dramaProjectVersions)) counts.dramaProjectVersions = await importDramaProjectVersions(client, objectFile(files, FILE_NAMES.dramaProjectVersions), FILE_NAMES.dramaProjectVersions);
    if (hasFile(files, FILE_NAMES.libraryAssets)) counts.libraryAssets = await importLibraryAssets(client, objectFile(files, FILE_NAMES.libraryAssets), FILE_NAMES.libraryAssets);
    if (hasFile(files, FILE_NAMES.localMediaAssets)) counts.localMediaAssets = await importLocalMediaAssets(client, objectFile(files, FILE_NAMES.localMediaAssets), FILE_NAMES.localMediaAssets);
    if (hasFile(files, FILE_NAMES.auditLogs)) counts.auditLogs = await importAuditLogs(client, objectFile(files, FILE_NAMES.auditLogs), FILE_NAMES.auditLogs);

    return counts;
}

async function importCanvasProjects(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const projects = records(file.projects, fileName, "projects");
    for (const item of projects) {
        const userId = text(item.userId, fileName, "projects[].userId");
        const project = object(item.project, fileName, "projects[].project");
        await client.query(
            `INSERT INTO canvas_projects (id, user_id, title, project_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
            [text(project.id, fileName, "projects[].project.id"), userId, text(project.title, fileName, "projects[].project.title"), json(project, fileName, "projects[].project"), timestamp(project.createdAt, fileName, "projects[].project.createdAt"), timestamp(project.updatedAt, fileName, "projects[].project.updatedAt")],
        );
    }
    return projects.length;
}

async function importCreativeRuntime(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const conversations = records(file.conversations, fileName, "conversations");
    const messages = records(file.messages, fileName, "messages");
    const assets = records(file.assets, fileName, "assets");
    const events = records(file.events, fileName, "events");

    for (const conversation of conversations) {
        await client.query(
            `INSERT INTO creative_conversations (
                id, user_id, surface, source, project_id, title, status, context_summary,
                context_summary_through_sequence, created_at, updated_at, last_message_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                text(conversation.id, fileName, "conversations[].id"),
                text(conversation.userId, fileName, "conversations[].userId"),
                text(conversation.surface, fileName, "conversations[].surface"),
                text(conversation.source, fileName, "conversations[].source"),
                optionalText(conversation.projectId),
                text(conversation.title, fileName, "conversations[].title"),
                text(conversation.status, fileName, "conversations[].status"),
                text(conversation.contextSummary, fileName, "conversations[].contextSummary"),
                integer(conversation.contextSummaryThroughSequence, fileName, "conversations[].contextSummaryThroughSequence"),
                timestamp(conversation.createdAt, fileName, "conversations[].createdAt"),
                timestamp(conversation.updatedAt, fileName, "conversations[].updatedAt"),
                timestamp(conversation.lastMessageAt, fileName, "conversations[].lastMessageAt"),
            ],
        );
    }

    for (const message of messages) {
        await client.query(
            `INSERT INTO creative_messages (id, conversation_id, sequence, role, status, content, run_id, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
            [
                text(message.id, fileName, "messages[].id"),
                text(message.conversationId, fileName, "messages[].conversationId"),
                integer(message.sequence, fileName, "messages[].sequence"),
                text(message.role, fileName, "messages[].role"),
                text(message.status, fileName, "messages[].status"),
                text(message.content, fileName, "messages[].content"),
                optionalText(message.runId),
                json(object(message.metadata, fileName, "messages[].metadata"), fileName, "messages[].metadata"),
                timestamp(message.createdAt, fileName, "messages[].createdAt"),
                timestamp(message.updatedAt, fileName, "messages[].updatedAt"),
            ],
        );
    }

    // parent_asset_id references the same table, so populate it only after every asset exists.
    for (const asset of assets) {
        await client.query(
            `INSERT INTO creative_assets (
                id, user_id, conversation_id, message_id, source_run_id, source_task_id, parent_asset_id,
                ordinal, type, status, title, text_content, storage_kind, storage_key, remote_url, server_url,
                mime_type, width, height, duration_ms, bytes, metadata, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23)`,
            [
                text(asset.id, fileName, "assets[].id"),
                text(asset.userId, fileName, "assets[].userId"),
                text(asset.conversationId, fileName, "assets[].conversationId"),
                optionalText(asset.messageId),
                optionalText(asset.sourceRunId),
                optionalText(asset.sourceTaskId),
                integer(asset.ordinal, fileName, "assets[].ordinal"),
                text(asset.type, fileName, "assets[].type"),
                text(asset.status, fileName, "assets[].status"),
                text(asset.title, fileName, "assets[].title"),
                optionalText(asset.textContent),
                optionalText(asset.storageKind),
                optionalText(asset.storageKey),
                optionalText(asset.remoteUrl),
                optionalText(asset.serverUrl),
                optionalText(asset.mimeType),
                optionalInteger(asset.width, fileName, "assets[].width"),
                optionalInteger(asset.height, fileName, "assets[].height"),
                optionalInteger(asset.durationMs, fileName, "assets[].durationMs"),
                optionalNumber(asset.bytes, fileName, "assets[].bytes"),
                json(object(asset.metadata, fileName, "assets[].metadata"), fileName, "assets[].metadata"),
                timestamp(asset.createdAt, fileName, "assets[].createdAt"),
                timestamp(asset.updatedAt, fileName, "assets[].updatedAt"),
            ],
        );
    }
    for (const asset of assets) {
        const parentAssetId = optionalText(asset.parentAssetId);
        if (parentAssetId) await client.query("UPDATE creative_assets SET parent_asset_id = $2 WHERE id = $1", [text(asset.id, fileName, "assets[].id"), parentAssetId]);
    }

    for (const event of events) {
        await client.query(
            "INSERT INTO creative_run_events (id, run_id, type, data, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)",
            [
                eventId(event.id, fileName),
                text(event.runId, fileName, "events[].runId"),
                text(event.type, fileName, "events[].type"),
                event.data === undefined ? null : json(event.data, fileName, "events[].data"),
                timestamp(event.createdAt, fileName, "events[].createdAt"),
            ],
        );
    }
    if (events.length) {
        await client.query("SELECT setval(pg_get_serial_sequence(current_schema() || '.octalaicanvas_creative_run_events', 'id'), (SELECT MAX(id) FROM creative_run_events), true)");
    }

    return { creativeConversations: conversations.length, creativeMessages: messages.length, creativeAssets: assets.length, creativeRunEvents: events.length };
}

async function importDramaProjects(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const projects = records(file.projects, fileName, "projects");
    for (const item of projects) {
        const project = object(item.project, fileName, "projects[].project");
        await client.query(
            `INSERT INTO drama_projects (id, user_id, title, status, project_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [
                text(project.id, fileName, "projects[].project.id"),
                text(item.userId, fileName, "projects[].userId"),
                text(project.title, fileName, "projects[].project.title"),
                text(project.status, fileName, "projects[].project.status"),
                json(project, fileName, "projects[].project"),
                timestamp(project.createdAt, fileName, "projects[].project.createdAt"),
                timestamp(project.updatedAt, fileName, "projects[].project.updatedAt"),
            ],
        );
    }
    return projects.length;
}

async function importDramaProjectVersions(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const items = records(file.items, fileName, "items");
    for (const item of items) {
        await client.query(
            `INSERT INTO drama_project_versions (id, project_id, user_id, version, reason, snapshot, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [
                text(item.id, fileName, "items[].id"),
                text(item.projectId, fileName, "items[].projectId"),
                text(item.userId, fileName, "items[].userId"),
                integer(item.version, fileName, "items[].version"),
                text(item.reason, fileName, "items[].reason"),
                json(object(item.snapshot, fileName, "items[].snapshot"), fileName, "items[].snapshot"),
                timestamp(item.createdAt, fileName, "items[].createdAt"),
            ],
        );
    }
    return items.length;
}

async function importLibraryAssets(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const assets = records(file.assets, fileName, "assets");
    for (const item of assets) {
        const asset = object(item.asset, fileName, "assets[].asset");
        await client.query(
            "INSERT INTO library_assets (id, user_id, kind, title, asset_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
            [
                text(asset.id, fileName, "assets[].asset.id"),
                text(item.userId, fileName, "assets[].userId"),
                text(asset.kind, fileName, "assets[].asset.kind"),
                text(asset.title, fileName, "assets[].asset.title"),
                json(asset, fileName, "assets[].asset"),
                timestamp(asset.createdAt, fileName, "assets[].asset.createdAt"),
                timestamp(asset.updatedAt, fileName, "assets[].asset.updatedAt"),
            ],
        );
    }
    return assets.length;
}

async function importLocalMediaAssets(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const assets = records(file.assets, fileName, "assets");
    for (const asset of assets) {
        await client.query(
            `INSERT INTO local_media_assets (
                storage_key, scope, storage_class, type, owner_user_id, original_name, source,
                conversation_id, run_id, task_id, project_id, mime_type, bytes, storage_provider,
                external_storage_id, external_object_key, external_synced_at, created_at, expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [
                text(asset.storageKey, fileName, "assets[].storageKey"),
                text(asset.scope, fileName, "assets[].scope"),
                text(asset.storageClass, fileName, "assets[].storageClass"),
                text(asset.type, fileName, "assets[].type"),
                text(asset.ownerUserId, fileName, "assets[].ownerUserId"),
                optionalText(asset.originalName),
                text(asset.source, fileName, "assets[].source"),
                optionalText(asset.conversationId),
                optionalText(asset.runId),
                optionalText(asset.taskId),
                optionalText(asset.projectId),
                text(asset.mimeType, fileName, "assets[].mimeType"),
                number(asset.bytes, fileName, "assets[].bytes"),
                optionalText(asset.storageProvider) || "local",
                optionalText(asset.externalStorageId),
                optionalText(asset.externalObjectKey),
                optionalTimestamp(asset.externalSyncedAt, fileName, "assets[].externalSyncedAt"),
                timestamp(asset.createdAt, fileName, "assets[].createdAt"),
                optionalTimestamp(asset.expiresAt, fileName, "assets[].expiresAt"),
            ],
        );
    }
    return assets.length;
}

async function importAuditLogs(client: QueryExecutor, file: JsonRecord, fileName: string) {
    const logs = records(file.logs, fileName, "logs");
    for (const log of logs) {
        const actor = optionalObject(log.actor, fileName, "logs[].actor") || {};
        const target = optionalObject(log.target, fileName, "logs[].target") || {};
        await client.query(
            `INSERT INTO audit_logs (
                id, action, status, actor_user_id, actor_username, actor_role, actor_ip, actor_user_agent,
                target_type, target_id, target_label, metadata, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
            [
                text(log.id, fileName, "logs[].id"),
                text(log.action, fileName, "logs[].action"),
                text(log.status, fileName, "logs[].status"),
                optionalText(actor.id),
                optionalText(actor.username),
                optionalText(actor.role),
                optionalText(actor.ip),
                optionalText(actor.userAgent),
                optionalText(target.type),
                optionalText(target.id),
                optionalText(target.label),
                log.metadata === undefined ? null : json(log.metadata, fileName, "logs[].metadata"),
                timestamp(log.createdAt, fileName, "logs[].createdAt"),
            ],
        );
    }
    return logs.length;
}

function hasFile(files: Record<string, unknown>, fileName: string) {
    return Object.prototype.hasOwnProperty.call(files, fileName);
}

function objectFile(files: Record<string, unknown>, fileName: string) {
    return object(files[fileName], fileName, "root");
}

function records(value: unknown, fileName: string, field: string): JsonRecord[] {
    if (!Array.isArray(value)) throw new MigrationDomainImportError(fileName, `${field} 必须是数组`);
    return value.map((item, index) => object(item, fileName, `${field}[${index}]`));
}

function object(value: unknown, fileName: string, field: string): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new MigrationDomainImportError(fileName, `${field} 必须是对象`);
    return value as JsonRecord;
}

function optionalObject(value: unknown, fileName: string, field: string): JsonRecord | undefined {
    if (value === undefined || value === null) return undefined;
    return object(value, fileName, field);
}

function text(value: unknown, fileName: string, field: string): string {
    if (typeof value !== "string") throw new MigrationDomainImportError(fileName, `${field} 必须是字符串`);
    return value;
}

function optionalText(value: unknown): string | null {
    return typeof value === "string" && value ? value : null;
}

function integer(value: unknown, fileName: string, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new MigrationDomainImportError(fileName, `${field} 必须是整数`);
    return value;
}

function optionalInteger(value: unknown, fileName: string, field: string): number | null {
    if (value === undefined || value === null) return null;
    return integer(value, fileName, field);
}

function number(value: unknown, fileName: string, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new MigrationDomainImportError(fileName, `${field} 必须是数字`);
    return value;
}

function optionalNumber(value: unknown, fileName: string, field: string): number | null {
    if (value === undefined || value === null) return null;
    return number(value, fileName, field);
}

function timestamp(value: unknown, fileName: string, field: string): Date {
    const milliseconds = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(milliseconds)) throw new MigrationDomainImportError(fileName, `${field} 必须是有效时间`);
    return new Date(milliseconds);
}

function optionalTimestamp(value: unknown, fileName: string, field: string): Date | null {
    if (value === undefined || value === null || value === "") return null;
    return timestamp(value, fileName, field);
}

function eventId(value: unknown, fileName: string): number {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new MigrationDomainImportError(fileName, "events[].id 必须是正整数");
    return parsed;
}

function json(value: unknown, fileName: string, field: string): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new MigrationDomainImportError(fileName, `${field} 不是可序列化 JSON`);
    return serialized;
}
