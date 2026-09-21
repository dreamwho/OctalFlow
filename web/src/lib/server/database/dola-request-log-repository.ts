import type {
    DolaRequestLog,
    DolaRequestLogCapability,
    DolaRequestLogPhase,
    DolaRequestLogSource,
    DolaRequestLogStatus,
} from "@/lib/server/dola/log-store";
import type { QueryExecutor } from "./postgres";

type ListInput = {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: DolaRequestLogStatus;
    phase?: DolaRequestLogPhase;
    source?: DolaRequestLogSource;
    model?: string;
    accountId?: string;
    proxyMode?: string;
};

export class DolaRequestLogRepository {
    constructor(private readonly db: QueryExecutor) {}

    async ensureSchema() {
        await this.db.query(`
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS capability varchar(32) NOT NULL DEFAULT 'video';
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS method varchar(16) NOT NULL DEFAULT 'POST';
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS account_name varchar(255);
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS task_id varchar(300);
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS verification_id varchar(300);
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS requested_duration integer;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS ratio varchar(32);
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS request_bytes integer;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS response_bytes integer;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS content_type varchar(160);
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS quota_remaining numeric;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS quota_limit numeric;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS client_ip varchar(128);
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS user_agent text;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS headers jsonb;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS screenshot_base64 text;
            ALTER TABLE dola_request_logs ADD COLUMN IF NOT EXISTS lifecycle jsonb NOT NULL DEFAULT '[]'::jsonb;
            CREATE INDEX IF NOT EXISTS dola_request_logs_model_idx ON dola_request_logs (model, created_at DESC);
            CREATE INDEX IF NOT EXISTS dola_request_logs_account_idx ON dola_request_logs (account_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS dola_request_logs_task_idx ON dola_request_logs (task_id, created_at DESC);
        `);
    }

    async findByTaskId(taskId: string, source: string) {
        // Prefer the original create row; legacy poll-created rows are only a fallback for pre-lifecycle data.
        const result = await this.db.query("SELECT id FROM dola_request_logs WHERE task_id=$1 AND source=$2 ORDER BY (CASE WHEN method='POST' THEN 0 ELSE 1 END), created_at DESC LIMIT 1", [taskId, source]);
        return String(result.rows[0]?.id || "");
    }

    async append(log: DolaRequestLog, maxLogs: number) {
        await this.db.query(
            `INSERT INTO dola_request_logs (
                id,created_at,source,capability,method,path,model,account_id,account_name,attempt_id,task_id,verification_id,
                status_code,duration_ms,phase,requested_duration,ratio,request_bytes,response_bytes,content_type,quota_remaining,quota_limit,
                client_ip,user_agent,headers,error,request_preview,response_preview,screenshot_base64,proxy_egress,lifecycle
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::numeric,$22::numeric,$23,$24,$25::jsonb,$26,$27,$28,$29,$30::jsonb,$31::jsonb)`,
            valuesForLog(log),
        );
        await this.db.query("DELETE FROM dola_request_logs WHERE id IN (SELECT id FROM dola_request_logs ORDER BY created_at DESC OFFSET $1)", [maxLogs]);
    }

    async update(log: DolaRequestLog) {
        await this.db.query(
            `UPDATE dola_request_logs SET
                status_code=$2,duration_ms=$3,phase=$4,error=$5,request_preview=$6,response_preview=$7,proxy_egress=$8::jsonb,lifecycle=$9::jsonb,
                model=$10,account_id=$11,account_name=$12,task_id=$13,verification_id=$14,requested_duration=$15,ratio=$16,request_bytes=$17,response_bytes=$18,content_type=$19,
                quota_remaining=$20::numeric,quota_limit=$21::numeric,screenshot_base64=$22
             WHERE id=$1`,
            [
                log.id,
                log.statusCode,
                log.durationMs,
                log.phase,
                log.error || null,
                log.requestPreview || null,
                log.responsePreview || null,
                JSON.stringify(log.proxyEgress || { mode: "direct" }),
                JSON.stringify(log.lifecycle || []),
                log.model,
                log.accountId || null,
                log.accountName || null,
                log.taskId || null,
                log.verificationId || null,
                log.requestedDuration ?? null,
                log.ratio || null,
                log.requestBytes ?? null,
                log.responseBytes ?? null,
                log.contentType || null,
                log.quotaRemaining ?? null,
                log.quotaLimit ?? null,
                log.screenshotBase64 || null,
            ],
        );
    }

    async findById(id: string) {
        const result = await this.db.query("SELECT * FROM dola_request_logs WHERE id=$1", [id]);
        return result.rows[0] ? mapLog(result.rows[0]) : null;
    }

    async list(input: ListInput) {
        const where: string[] = [];
        const values: unknown[] = [];
        if (input.status === "success") where.push("phase='success'");
        if (input.status === "failed") where.push("(phase='failed' OR (phase NOT IN ('needs_review','queued','running','routing','auth','upstream','response','submitted','generating') AND status_code>=400))");
        if (input.status === "needs_review") where.push("phase='needs_review'");
        if (input.status === "pending") where.push("phase IN ('queued','running','routing','auth','upstream','response','submitted','generating')");
        if (input.phase) {
            values.push(input.phase);
            where.push(`phase=$${values.length}`);
        }
        if (input.source) {
            values.push(input.source);
            where.push(`source=$${values.length}`);
        }
        if (input.model) {
            values.push(input.model);
            where.push(`model=$${values.length}`);
        }
        if (input.accountId) {
            values.push(input.accountId);
            where.push(`(account_id=$${values.length} OR account_name=$${values.length})`);
        }
        if (input.proxyMode) {
            values.push(input.proxyMode);
            where.push(`coalesce(proxy_egress->>'mode','direct')=$${values.length}`);
        }
        if (input.keyword) {
            values.push(`%${escapeLike(input.keyword.toLowerCase())}%`);
            const parameter = `$${values.length}`;
            where.push(`(lower(model) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(account_id,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(account_name,'')) LIKE ${parameter} ESCAPE '\\' OR lower(path) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(error,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(task_id,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(verification_id,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(request_preview,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(response_preview,'')) LIKE ${parameter} ESCAPE '\\')`);
        }
        const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
        const [count, stats] = await Promise.all([
            this.db.query(`SELECT count(*)::integer AS total FROM dola_request_logs${condition}`, [...values]),
            this.db.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE phase='success')::integer AS success,count(*) FILTER (WHERE phase='failed' OR (phase NOT IN ('needs_review','queued','running','routing','auth','upstream','response','submitted','generating') AND status_code>=400))::integer AS failed,count(*) FILTER (WHERE phase='needs_review')::integer AS needs_review,count(*) FILTER (WHERE phase IN ('queued','running','routing','auth','upstream','response','submitted','generating'))::integer AS pending,coalesce(round(avg(duration_ms)),0)::integer AS average_duration_ms FROM dola_request_logs`),
        ]);
        const pageValues = [...values, input.pageSize, (input.page - 1) * input.pageSize];
        const rows = await this.db.query(`SELECT * FROM dola_request_logs${condition} ORDER BY created_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`, pageValues);
        return { items: rows.rows.map(mapLog), total: number(count.rows[0]?.total), page: input.page, pageSize: input.pageSize, stats: mapStats(stats.rows[0]) };
    }

    async clear() {
        const result = await this.db.query("DELETE FROM dola_request_logs");
        return result.rowCount || 0;
    }
}

function valuesForLog(log: DolaRequestLog) {
    return [
        log.id,
        new Date(log.createdAt),
        log.source,
        log.capability,
        log.method,
        log.path,
        log.model,
        log.accountId || null,
        log.accountName || null,
        null,
        log.taskId || null,
        log.verificationId || null,
        log.statusCode,
        log.durationMs,
        log.phase,
        log.requestedDuration ?? null,
        log.ratio || null,
        log.requestBytes ?? null,
        log.responseBytes ?? null,
        log.contentType || null,
        log.quotaRemaining ?? null,
        log.quotaLimit ?? null,
        log.clientIp || null,
        log.userAgent || null,
        JSON.stringify(log.headers || {}),
        log.error || null,
        log.requestPreview || null,
        log.responsePreview || null,
        log.screenshotBase64 || null,
        JSON.stringify(log.proxyEgress || { mode: "direct" }),
        JSON.stringify(log.lifecycle || []),
    ];
}

function mapLog(row: Record<string, unknown>): DolaRequestLog {
    return {
        id: string(row.id),
        createdAt: date(row.created_at),
        source: row.source === "admin-test" ? "admin-test" : row.source === "external" ? "external" : "runtime",
        capability: row.capability === "image" ? ("image" satisfies DolaRequestLogCapability) : ("video" satisfies DolaRequestLogCapability),
        method: string(row.method) || "POST",
        path: string(row.path),
        model: string(row.model),
        ...(string(row.account_id) ? { accountId: string(row.account_id) } : {}),
        ...(string(row.account_name) ? { accountName: string(row.account_name) } : {}),
        statusCode: number(row.status_code),
        durationMs: number(row.duration_ms),
        phase: phase(row.phase),
        ...(string(row.task_id) ? { taskId: string(row.task_id) } : {}),
        ...(string(row.verification_id) ? { verificationId: string(row.verification_id) } : {}),
        ...(number(row.requested_duration) > 0 ? { requestedDuration: number(row.requested_duration) } : {}),
        ...(string(row.ratio) ? { ratio: string(row.ratio) } : {}),
        ...(number(row.request_bytes) > 0 ? { requestBytes: number(row.request_bytes) } : {}),
        ...(number(row.response_bytes) > 0 ? { responseBytes: number(row.response_bytes) } : {}),
        ...(string(row.content_type) ? { contentType: string(row.content_type) } : {}),
        ...(row.quota_remaining !== null && row.quota_remaining !== undefined ? { quotaRemaining: numberOrNull(row.quota_remaining) } : {}),
        ...(row.quota_limit !== null && row.quota_limit !== undefined ? { quotaLimit: numberOrNull(row.quota_limit) } : {}),
        ...(string(row.client_ip) ? { clientIp: string(row.client_ip) } : {}),
        ...(string(row.user_agent) ? { userAgent: string(row.user_agent) } : {}),
        ...(row.headers ? { headers: parseJson(row.headers) as Record<string, string> | undefined } : {}),
        ...(string(row.error) ? { error: string(row.error) } : {}),
        ...(string(row.request_preview) ? { requestPreview: string(row.request_preview) } : {}),
        ...(string(row.response_preview) ? { responsePreview: string(row.response_preview) } : {}),
        ...(string(row.screenshot_base64) ? { screenshotBase64: string(row.screenshot_base64) } : {}),
        ...(row.proxy_egress ? { proxyEgress: parseJson(row.proxy_egress) as DolaRequestLog["proxyEgress"] } : {}),
        ...(row.lifecycle ? { lifecycle: parseJson(row.lifecycle) as DolaRequestLog["lifecycle"] } : {}),
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
function phase(value: unknown): DolaRequestLogPhase {
    return value === "queued" || value === "routing" || value === "auth" || value === "upstream" || value === "response" || value === "running" || value === "submitted" || value === "generating" || value === "failed" || value === "needs_review" ? value : "success";
}
function mapStats(row: Record<string, unknown> | undefined) {
    return { total: number(row?.total), success: number(row?.success), failed: number(row?.failed), needsReview: number(row?.needs_review), pending: number(row?.pending), averageDurationMs: number(row?.average_duration_ms) };
}
function string(value: unknown) {
    return value === null || value === undefined ? "" : String(value);
}
function number(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function numberOrNull(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function date(value: unknown) {
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}
function escapeLike(value: string) {
    return value.replace(/[\\%_]/g, "\\$&");
}
