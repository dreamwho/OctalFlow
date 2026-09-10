import type { GeminiAiRequestCapability, GeminiAiRequestLog, GeminiAiRequestStats } from "@/lib/server/geminiai-request-log-store";
import type { QueryExecutor } from "./postgres";

export class GeminiAiRequestLogRepository {
    constructor(private readonly database: QueryExecutor) {}

    async ensureSchema() {
        await this.database.query(`
            CREATE TABLE IF NOT EXISTS geminiai_request_logs (
                id varchar(64) PRIMARY KEY,
                created_at timestamptz NOT NULL DEFAULT now(),
                source varchar(32) NOT NULL DEFAULT 'runtime',
                capability varchar(32) NOT NULL DEFAULT 'text',
                method varchar(16) NOT NULL DEFAULT 'POST',
                path varchar(255) NOT NULL,
                model varchar(128) NOT NULL,
                account_id varchar(64),
                account_email varchar(255),
                status_code integer NOT NULL,
                duration_ms integer NOT NULL DEFAULT 0,
                error text,
                request_preview text,
                response_preview text,
                phase varchar(32) DEFAULT 'success',
                lifecycle jsonb DEFAULT '[]'::jsonb,
                prompt_tokens integer DEFAULT 0,
                completion_tokens integer DEFAULT 0,
                total_tokens integer DEFAULT 0,
                image_requested_count integer DEFAULT 0,
                image_succeeded_count integer DEFAULT 0,
                image_failed_count integer DEFAULT 0,
                client_ip varchar(128),
                user_agent text,
                headers jsonb,
                proxy_egress jsonb
            );
            CREATE INDEX IF NOT EXISTS idx_geminiai_logs_created_at ON geminiai_request_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_geminiai_logs_model ON geminiai_request_logs(model);
            CREATE INDEX IF NOT EXISTS idx_geminiai_logs_account ON geminiai_request_logs(account_id);
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS phase varchar(32) DEFAULT 'success';
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS lifecycle jsonb DEFAULT '[]'::jsonb;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS prompt_tokens integer DEFAULT 0;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS completion_tokens integer DEFAULT 0;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS total_tokens integer DEFAULT 0;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS image_requested_count integer DEFAULT 0;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS image_succeeded_count integer DEFAULT 0;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS image_failed_count integer DEFAULT 0;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS client_ip varchar(128);
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS user_agent text;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS headers jsonb;
            ALTER TABLE geminiai_request_logs ADD COLUMN IF NOT EXISTS proxy_egress jsonb;
        `);
    }

    async append(log: GeminiAiRequestLog, maxLogs: number) {
        await this.database.query(
            `INSERT INTO geminiai_request_logs (
                id, created_at, source, capability, method, path, model, account_id, account_email,
                status_code, duration_ms, error, request_preview, response_preview, phase, lifecycle,
                prompt_tokens, completion_tokens, total_tokens, image_requested_count, image_succeeded_count, image_failed_count,
                client_ip, user_agent, headers, proxy_egress
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14, $15, $16,
                $17, $18, $19, $20, $21, $22,
                $23, $24, $25, $26
            )`,
            [
                log.id,
                new Date(log.createdAt),
                log.source,
                log.capability,
                log.method,
                log.path,
                log.model,
                log.accountId || null,
                log.accountEmail || null,
                log.statusCode,
                log.durationMs,
                log.error || null,
                log.requestPreview || null,
                log.responsePreview || null,
                log.phase || "success",
                JSON.stringify(log.lifecycle || []),
                log.promptTokens || 0,
                log.completionTokens || 0,
                log.totalTokens || 0,
                log.imageRequestedCount || 0,
                log.imageSucceededCount || 0,
                log.imageFailedCount || 0,
                log.clientIp || null,
                log.userAgent || null,
                log.headers ? JSON.stringify(log.headers) : null,
                log.proxyEgress ? JSON.stringify(log.proxyEgress) : null,
            ],
        );
        await this.database.query("DELETE FROM geminiai_request_logs WHERE id IN (SELECT id FROM geminiai_request_logs ORDER BY created_at DESC OFFSET $1)", [maxLogs]);
    }

    async update(log: GeminiAiRequestLog) {
        await this.database.query(
            `UPDATE geminiai_request_logs SET
                status_code = $2,
                duration_ms = $3,
                error = $4,
                response_preview = $5,
                account_id = $6,
                account_email = $7,
                phase = $8,
                lifecycle = $9,
                prompt_tokens = $10,
                completion_tokens = $11,
                total_tokens = $12,
                image_requested_count = $13,
                image_succeeded_count = $14,
                image_failed_count = $15,
                client_ip = coalesce($16, client_ip),
                user_agent = coalesce($17, user_agent),
                proxy_egress = coalesce($18, proxy_egress)
            WHERE id = $1`,
            [
                log.id,
                log.statusCode,
                log.durationMs,
                log.error || null,
                log.responsePreview || null,
                log.accountId || null,
                log.accountEmail || null,
                log.phase || "success",
                JSON.stringify(log.lifecycle || []),
                log.promptTokens || 0,
                log.completionTokens || 0,
                log.totalTokens || 0,
                log.imageRequestedCount || 0,
                log.imageSucceededCount || 0,
                log.imageFailedCount || 0,
                log.clientIp || null,
                log.userAgent || null,
                log.proxyEgress ? JSON.stringify(log.proxyEgress) : null,
            ],
        );
    }

    async findById(id: string) {
        const result = await this.database.query("SELECT * FROM geminiai_request_logs WHERE id = $1", [id]);
        return result.rows[0] ? mapLog(result.rows[0]) : null;
    }

    async list(input: { page: number; pageSize: number; keyword?: string; status?: "success" | "failed"; capability?: GeminiAiRequestCapability; model?: string; accountId?: string }) {
        const where: string[] = [];
        const values: unknown[] = [];
        if (input.status === "success") where.push("status_code < 400");
        if (input.status === "failed") where.push("status_code >= 400");
        if (input.capability) {
            values.push(input.capability);
            where.push(`capability = $${values.length}`);
        }
        if (input.model) {
            values.push(input.model);
            where.push(`model = $${values.length}`);
        }
        if (input.accountId) {
            values.push(input.accountId);
            where.push(`(account_id = $${values.length} OR account_email = $${values.length})`);
        }
        if (input.keyword) {
            values.push(`%${escapeLike(input.keyword.toLowerCase())}%`);
            const parameter = `$${values.length}`;
            where.push(`(lower(model) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(account_email,'')) LIKE ${parameter} ESCAPE '\\' OR lower(path) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(error,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(request_preview,'')) LIKE ${parameter} ESCAPE '\\')`);
        }
        const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
        const [count, stats] = await Promise.all([
            this.database.query(`SELECT count(*)::integer AS total FROM geminiai_request_logs${condition}`, [...values]),
            this.database.query("SELECT count(*)::integer AS total,count(*) FILTER (WHERE status_code < 400)::integer AS success,count(*) FILTER (WHERE status_code >= 400)::integer AS failed,coalesce(round(avg(duration_ms)),0)::integer AS average_duration_ms FROM geminiai_request_logs"),
        ]);
        values.push(input.pageSize, (input.page - 1) * input.pageSize);
        const result = await this.database.query(`SELECT * FROM geminiai_request_logs${condition} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
        return { items: result.rows.map(mapLog), total: number(count.rows[0]?.total), page: input.page, pageSize: input.pageSize, stats: mapStats(stats.rows[0]) };
    }

    async clear() {
        const result = await this.database.query("DELETE FROM geminiai_request_logs");
        return result.rowCount || 0;
    }
}

function mapLog(row: Record<string, unknown>): GeminiAiRequestLog {
    return {
        id: string(row.id),
        createdAt: date(row.created_at),
        source: row.source === "admin-test" ? "admin-test" : "runtime",
        capability: capability(row.capability),
        method: string(row.method) || "POST",
        path: string(row.path),
        model: string(row.model),
        ...(string(row.account_id) ? { accountId: string(row.account_id) } : {}),
        ...(string(row.account_email) ? { accountEmail: string(row.account_email) } : {}),
        statusCode: number(row.status_code),
        durationMs: number(row.duration_ms),
        ...(number(row.prompt_tokens) > 0 ? { promptTokens: number(row.prompt_tokens) } : {}),
        ...(number(row.completion_tokens) > 0 ? { completionTokens: number(row.completion_tokens) } : {}),
        ...(number(row.total_tokens) > 0 ? { totalTokens: number(row.total_tokens) } : {}),
        ...(number(row.image_requested_count) > 0 ? { imageRequestedCount: number(row.image_requested_count) } : {}),
        ...(number(row.image_succeeded_count) > 0 ? { imageSucceededCount: number(row.image_succeeded_count) } : {}),
        ...(number(row.image_failed_count) > 0 ? { imageFailedCount: number(row.image_failed_count) } : {}),
        ...(string(row.client_ip) ? { clientIp: string(row.client_ip) } : {}),
        ...(string(row.user_agent) ? { userAgent: string(row.user_agent) } : {}),
        ...(row.headers ? { headers: parseJson(row.headers) } : {}),
        ...(string(row.error) ? { error: string(row.error) } : {}),
        ...(string(row.request_preview) ? { requestPreview: string(row.request_preview) } : {}),
        ...(string(row.response_preview) ? { responsePreview: string(row.response_preview) } : {}),
        ...(row.proxy_egress ? { proxyEgress: parseJson(row.proxy_egress) } : {}),
        ...(string(row.phase) ? { phase: phase(row.phase) } : {}),
        ...(Array.isArray(row.lifecycle) || typeof row.lifecycle === "string" ? parseLifecycle(row.lifecycle) : {}),
    };
}

function parseJson<T>(value: unknown): T | undefined {
    if (!value) return undefined;
    if (typeof value === "object") return value as T;
    try {
        return JSON.parse(String(value)) as T;
    } catch {
        return undefined;
    }
}

function phase(value: unknown): GeminiAiRequestLog["phase"] {
    return value === "queued" || value === "running" || value === "failed" ? value : "success";
}

function parseLifecycle(value: unknown): Pick<GeminiAiRequestLog, "lifecycle"> {
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        if (Array.isArray(parsed)) return { lifecycle: parsed as GeminiAiRequestLog["lifecycle"] };
    } catch {
        // ignore malformed lifecycle payloads
    }
    return {};
}

function mapStats(row: Record<string, unknown> | undefined): GeminiAiRequestStats {
    return { total: number(row?.total), success: number(row?.success), failed: number(row?.failed), averageDurationMs: number(row?.average_duration_ms) };
}

function capability(value: unknown): GeminiAiRequestCapability {
    return value === "image" || value === "search" ? value : "text";
}
function string(value: unknown) {
    return value === null || value === undefined ? "" : String(value);
}
function number(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function date(value: unknown) {
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}
function escapeLike(value: string) {
    return value.replace(/[\\%_]/g, "\\$&");
}
