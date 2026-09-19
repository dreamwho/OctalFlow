import type { DreaminaCliAccountState, DreaminaCliRequestLog, DreaminaCliRequestStats, DreaminaCliStatsWindow } from "@/lib/server/dreamina-cli-store";

import type { QueryExecutor } from "./postgres";

export class DreaminaCliRepository {
    constructor(private readonly db: QueryExecutor) {}

    async getAccountState() {
        const result = await this.db.query("SELECT * FROM dreamina_cli_account_state WHERE id = 'default'");
        return result.rows[0] ? mapAccountState(result.rows[0]) : null;
    }

    async saveAccountState(state: DreaminaCliAccountState) {
        const result = await this.db.query(
            `INSERT INTO dreamina_cli_account_state (
                id,status,user_id,user_name,vip_level,total_credit,cli_version,cli_commit,cli_build_time,executable_fingerprint,
                last_credit_checked_at,last_success_at,last_error_code,last_error_message,submit_lease_owner,submit_lease_task_id,submit_lease_until,created_at,updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            ON CONFLICT (id) DO UPDATE SET
                status=EXCLUDED.status,user_id=EXCLUDED.user_id,user_name=EXCLUDED.user_name,vip_level=EXCLUDED.vip_level,total_credit=EXCLUDED.total_credit,
                cli_version=EXCLUDED.cli_version,cli_commit=EXCLUDED.cli_commit,cli_build_time=EXCLUDED.cli_build_time,executable_fingerprint=EXCLUDED.executable_fingerprint,
                last_credit_checked_at=EXCLUDED.last_credit_checked_at,last_success_at=EXCLUDED.last_success_at,last_error_code=EXCLUDED.last_error_code,last_error_message=EXCLUDED.last_error_message,
                submit_lease_owner=EXCLUDED.submit_lease_owner,submit_lease_task_id=EXCLUDED.submit_lease_task_id,submit_lease_until=EXCLUDED.submit_lease_until,updated_at=EXCLUDED.updated_at
            RETURNING *`,
            accountValues(state),
        );
        return mapAccountState(result.rows[0]);
    }

    async acquireSubmitLease(input: { owner: string; taskId?: string; leaseUntil: Date }) {
        const result = await this.db.query(
            `INSERT INTO dreamina_cli_account_state (id,status,submit_lease_owner,submit_lease_task_id,submit_lease_until,created_at,updated_at)
             VALUES ('default','unverified',$1,$2,$3,now(),now())
             ON CONFLICT (id) DO UPDATE SET submit_lease_owner=EXCLUDED.submit_lease_owner,submit_lease_task_id=EXCLUDED.submit_lease_task_id,submit_lease_until=EXCLUDED.submit_lease_until
             WHERE dreamina_cli_account_state.submit_lease_until IS NULL OR dreamina_cli_account_state.submit_lease_until < now() OR dreamina_cli_account_state.submit_lease_owner = EXCLUDED.submit_lease_owner
             RETURNING *`,
            [input.owner, input.taskId || null, input.leaseUntil],
        );
        return result.rows[0] ? mapAccountState(result.rows[0]) : null;
    }

    async releaseSubmitLease(owner: string) {
        await this.db.query("UPDATE dreamina_cli_account_state SET submit_lease_owner=NULL,submit_lease_task_id=NULL,submit_lease_until=NULL WHERE id='default' AND submit_lease_owner=$1", [owner]);
    }

    async appendRequestLog(log: DreaminaCliRequestLog) {
        const result = await this.db.query(
            `INSERT INTO dreamina_cli_request_logs (
                id,created_at,updated_at,generation_task_id,attempt_no,command,phase,capability,model,upstream_model,status,duration_ms,submit_id,
                before_credit,after_credit,observed_credit_delta,credit_observation,error_code,error_message,succeeded_at,failed_at,request_summary,submission_summary,result_summary
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb)
            RETURNING *`,
            logValues(log),
        );
        return mapRequestLog(result.rows[0]);
    }

    async finalizeRequestLogBySubmissionId(input: {
        submissionId: string;
        status: "success" | "failed" | "needs_review";
        resultSummary: Record<string, unknown>;
        errorCode?: string;
        error?: string;
        observedCreditDelta?: number;
        creditObservation?: DreaminaCliRequestLog["creditObservation"];
        finishedAt: string;
    }) {
        const result = await this.db.query(
            `UPDATE dreamina_cli_request_logs
             SET status=$2,
                 duration_ms=greatest(0, (extract(epoch FROM ($3::timestamptz - created_at)) * 1000)::integer),
                 succeeded_at=CASE WHEN $2 = 'success' THEN $3::timestamptz ELSE succeeded_at END,
                 failed_at=CASE WHEN $2 IN ('failed','needs_review') THEN $3::timestamptz ELSE failed_at END,
                 observed_credit_delta=coalesce($4::bigint, observed_credit_delta),
                 credit_observation=coalesce($5, credit_observation),
                 error_code=$6,
                 error_message=$7,
                 result_summary=$8::jsonb,
                 updated_at=$3::timestamptz
             WHERE submit_id=$1 AND phase='submit'
             RETURNING *`,
            [input.submissionId, input.status, new Date(input.finishedAt), input.observedCreditDelta ?? null, input.creditObservation || null, input.errorCode || null, input.error || null, JSON.stringify(input.resultSummary)],
        );
        return result.rows[0] ? mapRequestLog(result.rows[0]) : undefined;
    }

    async listRequestLogs(input: { page: number; pageSize: number; status?: string; command?: string }) {
        const values: unknown[] = [];
        const where: string[] = ["phase <> 'query'"];
        if (input.status) {
            values.push(input.status);
            where.push(`status = $${values.length}`);
        }
        if (input.command) {
            values.push(input.command);
            where.push(`command = $${values.length}`);
        }
        const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
        const count = await this.db.query(`SELECT count(*)::integer AS total FROM dreamina_cli_request_logs${condition}`, values);
        values.push(input.pageSize, (input.page - 1) * input.pageSize);
        const rows = await this.db.query(`SELECT * FROM dreamina_cli_request_logs${condition} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
        return { items: rows.rows.map(mapRequestLog), total: numberValue(count.rows[0]?.total), page: input.page, pageSize: input.pageSize };
    }

    async requestStats(window: DreaminaCliStatsWindow): Promise<DreaminaCliRequestStats> {
        const result = await this.db.query(
            `WITH scoped_logs AS (
                SELECT *
                FROM dreamina_cli_request_logs
                WHERE phase <> 'query' AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz) AND created_at < $2::timestamptz
            ), official_costs AS (
                SELECT max(observed_credit_delta) AS official_cost, min(created_at) AS spent_at
                FROM dreamina_cli_request_logs
                WHERE phase <> 'query' AND credit_observation = 'official'
                GROUP BY coalesce(nullif(submit_id, ''), nullif(generation_task_id, ''), id)
            )
            SELECT
                count(*)::integer AS total,
                count(*) FILTER (WHERE status = 'success')::integer AS success,
                count(*) FILTER (WHERE status = 'failed')::integer AS failed,
                count(*) FILTER (WHERE status = 'needs_review')::integer AS needs_review,
                coalesce((
                    SELECT sum(official_cost)
                    FROM official_costs
                    WHERE ($1::timestamptz IS NULL OR spent_at >= $1::timestamptz) AND spent_at < $2::timestamptz
                ), 0)::bigint AS official_credits,
                (
                    coalesce(sum(observed_credit_delta) FILTER (WHERE credit_observation = 'observed'), 0) +
                    coalesce((
                        SELECT sum(official_cost)
                        FROM official_costs
                        WHERE ($1::timestamptz IS NULL OR spent_at >= $1::timestamptz) AND spent_at < $2::timestamptz
                    ), 0)
                )::bigint AS observed_credits
             FROM scoped_logs`,
            [window.startAt ? new Date(window.startAt) : null, new Date(window.endAt)],
        );
        const row = result.rows[0] || {};
        return {
            ...window,
            total: numberValue(row.total),
            success: numberValue(row.success),
            failed: numberValue(row.failed),
            needsReview: numberValue(row.needs_review),
            officialCredits: numberValue(row.official_credits),
            observedCredits: numberValue(row.observed_credits),
        };
    }

    async clearRequestLogs() {
        const result = await this.db.query("DELETE FROM dreamina_cli_request_logs");
        return result.rowCount || 0;
    }
}

function accountValues(state: DreaminaCliAccountState) {
    return [
        "default",
        state.status,
        state.userId || null,
        state.userName || null,
        state.vipLevel || null,
        state.totalCredit ?? null,
        state.cliVersion || null,
        state.cliCommit || null,
        state.cliBuildTime || null,
        state.executableFingerprint || null,
        state.lastCreditCheckedAt ? new Date(state.lastCreditCheckedAt) : null,
        state.lastSuccessAt ? new Date(state.lastSuccessAt) : null,
        state.lastErrorCode || null,
        state.lastErrorMessage || null,
        state.submitLeaseOwner || null,
        state.submitLeaseTaskId || null,
        state.submitLeaseUntil ? new Date(state.submitLeaseUntil) : null,
        new Date(state.createdAt),
        new Date(state.updatedAt),
    ];
}

function logValues(log: DreaminaCliRequestLog) {
    return [
        log.id,
        new Date(log.createdAt),
        new Date(log.updatedAt),
        log.taskId || null,
        log.attemptNo ?? null,
        log.command,
        log.phase,
        log.capability || null,
        log.model || null,
        log.upstreamModel || null,
        log.status,
        log.durationMs ?? null,
        log.submissionId || null,
        log.beforeCredit ?? null,
        log.afterCredit ?? null,
        log.observedCreditDelta ?? null,
        log.creditObservation,
        log.errorCode || null,
        log.error || null,
        log.succeededAt ? new Date(log.succeededAt) : null,
        log.failedAt ? new Date(log.failedAt) : null,
        JSON.stringify(log.requestSummary || {}),
        JSON.stringify(log.submissionSummary || {}),
        JSON.stringify(log.resultSummary || {}),
    ];
}

function mapAccountState(row: Record<string, unknown>): DreaminaCliAccountState {
    const now = new Date().toISOString();
    return {
        id: "default",
        status: accountStatus(row.status),
        ...(stringValue(row.user_id) ? { userId: stringValue(row.user_id) } : {}),
        ...(stringValue(row.user_name) ? { userName: stringValue(row.user_name) } : {}),
        ...(stringValue(row.vip_level) ? { vipLevel: stringValue(row.vip_level) } : {}),
        ...(numberOrUndefined(row.total_credit) !== undefined ? { totalCredit: numberOrUndefined(row.total_credit) } : {}),
        ...(stringValue(row.cli_version) ? { cliVersion: stringValue(row.cli_version) } : {}),
        ...(stringValue(row.cli_commit) ? { cliCommit: stringValue(row.cli_commit) } : {}),
        ...(stringValue(row.cli_build_time) ? { cliBuildTime: stringValue(row.cli_build_time) } : {}),
        ...(stringValue(row.executable_fingerprint) ? { executableFingerprint: stringValue(row.executable_fingerprint) } : {}),
        ...(dateValue(row.last_credit_checked_at) ? { lastCreditCheckedAt: dateValue(row.last_credit_checked_at)! } : {}),
        ...(dateValue(row.last_success_at) ? { lastSuccessAt: dateValue(row.last_success_at)! } : {}),
        ...(stringValue(row.last_error_code) ? { lastErrorCode: stringValue(row.last_error_code) } : {}),
        ...(stringValue(row.last_error_message) ? { lastErrorMessage: stringValue(row.last_error_message) } : {}),
        ...(stringValue(row.submit_lease_owner) ? { submitLeaseOwner: stringValue(row.submit_lease_owner) } : {}),
        ...(stringValue(row.submit_lease_task_id) ? { submitLeaseTaskId: stringValue(row.submit_lease_task_id) } : {}),
        ...(dateValue(row.submit_lease_until) ? { submitLeaseUntil: dateValue(row.submit_lease_until)! } : {}),
        createdAt: dateValue(row.created_at) || now,
        updatedAt: dateValue(row.updated_at) || now,
    };
}

function mapRequestLog(row: Record<string, unknown>): DreaminaCliRequestLog {
    const now = new Date().toISOString();
    return {
        id: stringValue(row.id),
        createdAt: dateValue(row.created_at) || now,
        updatedAt: dateValue(row.updated_at) || now,
        ...(stringValue(row.generation_task_id) ? { taskId: stringValue(row.generation_task_id) } : {}),
        ...(numberOrUndefined(row.attempt_no) !== undefined ? { attemptNo: numberOrUndefined(row.attempt_no) } : {}),
        command: command(row.command),
        phase: phase(row.phase),
        ...(capability(row.capability) ? { capability: capability(row.capability)! } : {}),
        ...(stringValue(row.model) ? { model: stringValue(row.model) } : {}),
        ...(stringValue(row.upstream_model) ? { upstreamModel: stringValue(row.upstream_model) } : {}),
        status: logStatus(row.status),
        ...(numberOrUndefined(row.duration_ms) !== undefined ? { durationMs: numberOrUndefined(row.duration_ms) } : {}),
        ...(stringValue(row.submit_id) ? { submissionId: stringValue(row.submit_id) } : {}),
        ...(dateValue(row.succeeded_at) ? { succeededAt: dateValue(row.succeeded_at)! } : {}),
        ...(dateValue(row.failed_at) ? { failedAt: dateValue(row.failed_at)! } : {}),
        ...(numberOrUndefined(row.before_credit) !== undefined ? { beforeCredit: numberOrUndefined(row.before_credit) } : {}),
        ...(numberOrUndefined(row.after_credit) !== undefined ? { afterCredit: numberOrUndefined(row.after_credit) } : {}),
        ...(numberOrUndefined(row.observed_credit_delta) !== undefined ? { observedCreditDelta: numberOrUndefined(row.observed_credit_delta) } : {}),
        creditObservation: creditObservation(row.credit_observation),
        ...(stringValue(row.error_code) ? { errorCode: stringValue(row.error_code) } : {}),
        ...(stringValue(row.error_message) ? { error: stringValue(row.error_message) } : {}),
        requestSummary: objectValue(row.request_summary),
        submissionSummary: objectValue(row.submission_summary),
        resultSummary: objectValue(row.result_summary),
    };
}

function accountStatus(value: unknown): DreaminaCliAccountState["status"] {
    return ["unconfigured", "unverified", "authorized", "not_logged_in", "permission_denied", "compliance_required", "error"].includes(String(value)) ? (value as DreaminaCliAccountState["status"]) : "unverified";
}

function command(value: unknown): DreaminaCliRequestLog["command"] {
    return ["user_credit", "version", "text2image", "image2image", "image_upscale", "text2video", "image2video", "frames2video", "multiframe2video", "multimodal2video", "query_result", "download"].includes(String(value))
        ? (value as DreaminaCliRequestLog["command"])
        : "version";
}

function phase(value: unknown): DreaminaCliRequestLog["phase"] {
    return ["preflight", "submit", "query", "download", "account_refresh"].includes(String(value)) ? (value as DreaminaCliRequestLog["phase"]) : "preflight";
}

function capability(value: unknown): DreaminaCliRequestLog["capability"] | undefined {
    return value === "image" || value === "video" ? value : undefined;
}

function logStatus(value: unknown): DreaminaCliRequestLog["status"] {
    return ["started", "success", "failed", "needs_review", "deferred"].includes(String(value)) ? (value as DreaminaCliRequestLog["status"]) : "failed";
}

function creditObservation(value: unknown): DreaminaCliRequestLog["creditObservation"] {
    return ["official", "unavailable", "observed", "ambiguous", "inconsistent"].includes(String(value)) ? (value as DreaminaCliRequestLog["creditObservation"]) : "unavailable";
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function numberOrUndefined(value: unknown) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

function numberValue(value: unknown) {
    return numberOrUndefined(value) || 0;
}

function dateValue(value: unknown) {
    const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function objectValue(value: unknown) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
            return {};
        }
    }
    return {};
}
