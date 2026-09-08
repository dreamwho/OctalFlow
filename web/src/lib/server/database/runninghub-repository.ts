import type { QueryExecutor } from "./postgres";
import type { RunningHubApp, RunningHubField, RunningHubRequestLog, RunningHubTask, StoredRunningHubSettings } from "../runninghub-store";

export class RunningHubRepository {
    constructor(private readonly db: QueryExecutor) {}

    async getSettings(): Promise<StoredRunningHubSettings> {
        const result = await this.db.query("SELECT * FROM runninghub_settings WHERE id='default'");
        return mapSettings(result.rows[0] || {});
    }

    async updateSettings(settings: StoredRunningHubSettings) {
        const result = await this.db.query(
            "UPDATE runninghub_settings SET enabled=$1,api_base_url=$2,api_key_ciphertext=$3,instance_type=$4 WHERE id='default' RETURNING *",
            [settings.enabled, settings.apiBaseUrl, settings.apiKeyCiphertext, settings.instanceType],
        );
        return mapSettings(result.rows[0]);
    }

    async listApps(input: { binding?: string; enabledOnly?: boolean } = {}) {
        const where: string[] = [];
        const values: unknown[] = [];
        if (input.enabledOnly) where.push("enabled=true");
        if (input.binding) {
            values.push(JSON.stringify([input.binding]));
            where.push(`feature_bindings @> $${values.length}::jsonb`);
        }
        const result = await this.db.query(`SELECT * FROM runninghub_apps${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order ASC, updated_at DESC`, values);
        return result.rows.map(mapApp);
    }

    async getApp(id: string) {
        const result = await this.db.query("SELECT * FROM runninghub_apps WHERE id=$1", [id]);
        return result.rows[0] ? mapApp(result.rows[0]) : null;
    }

    async upsertApp(app: RunningHubApp) {
        const result = await this.db.query(
            `INSERT INTO runninghub_apps (id,remote_id,kind,name,description,thumbnail_url,enabled,feature_bindings,fields,sort_order,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
             ON CONFLICT (id) DO UPDATE SET remote_id=EXCLUDED.remote_id,kind=EXCLUDED.kind,name=EXCLUDED.name,description=EXCLUDED.description,thumbnail_url=EXCLUDED.thumbnail_url,enabled=EXCLUDED.enabled,feature_bindings=EXCLUDED.feature_bindings,fields=EXCLUDED.fields,sort_order=EXCLUDED.sort_order,updated_at=EXCLUDED.updated_at RETURNING *`,
            [app.id, app.remoteId, app.kind, app.name, app.description, app.thumbnailUrl, app.enabled, JSON.stringify(app.featureBindings), JSON.stringify(app.fields), app.sortOrder, new Date(app.createdAt), new Date(app.updatedAt)],
        );
        return mapApp(result.rows[0]);
    }

    async deleteApp(id: string) {
        const result = await this.db.query("DELETE FROM runninghub_apps WHERE id=$1 RETURNING id", [id]);
        return (result.rowCount || 0) > 0;
    }

    async upsertTask(task: RunningHubTask) {
        const result = await this.db.query(
            `INSERT INTO runninghub_tasks (id,image_task_id,user_id,app_id,remote_task_id,status,error,result_urls,created_at,updated_at,completed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE SET image_task_id=EXCLUDED.image_task_id,user_id=EXCLUDED.user_id,app_id=EXCLUDED.app_id,remote_task_id=EXCLUDED.remote_task_id,status=EXCLUDED.status,error=EXCLUDED.error,result_urls=EXCLUDED.result_urls,updated_at=EXCLUDED.updated_at,completed_at=EXCLUDED.completed_at RETURNING *`,
            [task.id, task.imageTaskId || null, task.userId || null, task.appId || null, task.remoteTaskId || null, task.status, task.error || null, JSON.stringify(task.resultUrls), new Date(task.createdAt), new Date(task.updatedAt), task.completedAt ? new Date(task.completedAt) : null],
        );
        return mapTask(result.rows[0]);
    }

    async listTasks(limit: number) {
        const result = await this.db.query("SELECT * FROM runninghub_tasks ORDER BY created_at DESC LIMIT $1", [limit]);
        return result.rows.map(mapTask);
    }

    async getTask(id: string) {
        const result = await this.db.query("SELECT * FROM runninghub_tasks WHERE id=$1", [id]);
        return result.rows[0] ? mapTask(result.rows[0]) : null;
    }

    async appendLog(log: RunningHubRequestLog, maxLogs: number) {
        await this.db.query("INSERT INTO runninghub_request_logs (id,task_id,app_id,phase,path,status_code,duration_ms,error,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
            log.id,
            log.taskId || null,
            log.appId || null,
            log.phase,
            log.path,
            log.statusCode,
            log.durationMs,
            log.error || null,
            new Date(log.createdAt),
        ]);
        await this.db.query("DELETE FROM runninghub_request_logs WHERE id IN (SELECT id FROM runninghub_request_logs ORDER BY created_at DESC OFFSET $1)", [maxLogs]);
    }

    async listLogs(limit: number) {
        const result = await this.db.query("SELECT * FROM runninghub_request_logs ORDER BY created_at DESC LIMIT $1", [limit]);
        return result.rows.map(mapLog);
    }

    async clearLogs() {
        const result = await this.db.query("DELETE FROM runninghub_request_logs");
        return result.rowCount || 0;
    }
}

function mapSettings(row: Record<string, unknown>): StoredRunningHubSettings {
    return {
        enabled: row.enabled === true,
        apiBaseUrl: text(row.api_base_url) || "https://www.runninghub.ai",
        apiKeyCiphertext: text(row.api_key_ciphertext),
        instanceType: row.instance_type === "plus" ? "plus" : "standard",
        updatedAt: date(row.updated_at),
    };
}

function mapApp(row: Record<string, unknown>): RunningHubApp {
    return {
        id: text(row.id),
        remoteId: text(row.remote_id),
        kind: row.kind === "workflow" ? "workflow" : "ai-app",
        name: text(row.name),
        description: text(row.description),
        thumbnailUrl: text(row.thumbnail_url),
        enabled: row.enabled !== false,
        featureBindings: strings(row.feature_bindings),
        fields: fields(row.fields),
        sortOrder: number(row.sort_order),
        createdAt: date(row.created_at),
        updatedAt: date(row.updated_at),
    };
}

function mapTask(row: Record<string, unknown>): RunningHubTask {
    return {
        id: text(row.id),
        ...(text(row.image_task_id) ? { imageTaskId: text(row.image_task_id) } : {}),
        ...(text(row.user_id) ? { userId: text(row.user_id) } : {}),
        ...(text(row.app_id) ? { appId: text(row.app_id) } : {}),
        ...(text(row.remote_task_id) ? { remoteTaskId: text(row.remote_task_id) } : {}),
        status: taskStatus(row.status),
        ...(text(row.error) ? { error: text(row.error) } : {}),
        resultUrls: strings(row.result_urls),
        createdAt: date(row.created_at),
        updatedAt: date(row.updated_at),
        ...(row.completed_at ? { completedAt: date(row.completed_at) } : {}),
    };
}

function mapLog(row: Record<string, unknown>): RunningHubRequestLog {
    return {
        id: text(row.id),
        ...(text(row.task_id) ? { taskId: text(row.task_id) } : {}),
        ...(text(row.app_id) ? { appId: text(row.app_id) } : {}),
        phase: logPhase(row.phase),
        path: text(row.path),
        statusCode: number(row.status_code),
        durationMs: number(row.duration_ms),
        ...(text(row.error) ? { error: text(row.error) } : {}),
        createdAt: date(row.created_at),
    };
}

function text(value: unknown) {
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}
function number(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function date(value: unknown) {
    const parsed = value instanceof Date ? value : new Date(String(value || Date.now()));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}
function strings(value: unknown) {
    const parsed = typeof value === "string" ? safeArray(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
function fields(value: unknown): RunningHubField[] {
    const parsed = typeof value === "string" ? safeArray(value) : value;
    return Array.isArray(parsed) ? (parsed as RunningHubField[]) : [];
}
function safeArray(value: string): unknown[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}
function taskStatus(value: unknown): RunningHubTask["status"] {
    return value === "running" || value === "success" || value === "failed" || value === "cancelled" ? value : "queued";
}
function logPhase(value: unknown): RunningHubRequestLog["phase"] {
    return value === "account" || value === "sync" || value === "upload" || value === "query" || value === "cancel" ? value : "submit";
}
