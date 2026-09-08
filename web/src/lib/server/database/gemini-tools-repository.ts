import type { QueryExecutor } from "./postgres";
import type { GeminiToolsGatewaySettings, GeminiToolsOAuthSession, GeminiToolsQuota, GeminiToolsRequestLog, StoredGeminiToolsAccount, StoredGeminiToolsApiKey } from "@/lib/server/gemini-tools-store";

export class GeminiToolsRepository {
    constructor(private readonly db: QueryExecutor) {}

    async listAccounts(activeOnly = false) {
        const result = await this.db.query(`SELECT * FROM gemini_tools_accounts${activeOnly ? " WHERE status = 'active' AND proxy_enabled = true" : ""} ORDER BY priority DESC, last_used_at ASC NULLS FIRST, created_at ASC`);
        return result.rows.map(mapAccount);
    }

    async getAccount(id: string) {
        const result = await this.db.query("SELECT * FROM gemini_tools_accounts WHERE id = $1", [id]);
        return result.rows[0] ? mapAccount(result.rows[0]) : null;
    }

    async getAccountByEmail(email: string) {
        const result = await this.db.query("SELECT * FROM gemini_tools_accounts WHERE lower(email) = lower($1)", [email]);
        return result.rows[0] ? mapAccount(result.rows[0]) : null;
    }

    async upsertAccount(account: StoredGeminiToolsAccount) {
        const result = await this.db.query(
            `INSERT INTO gemini_tools_accounts (
                id,email,name,picture,status,proxy_enabled,priority,plan_type,quotas,request_count,total_tokens,error_count,note,last_used_at,
                access_token_ciphertext,refresh_token_ciphertext,expires_at,project_id,created_at,updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             ON CONFLICT (lower(email)) DO UPDATE SET
                name=EXCLUDED.name,picture=COALESCE(EXCLUDED.picture,gemini_tools_accounts.picture),status='active',plan_type=COALESCE(EXCLUDED.plan_type,gemini_tools_accounts.plan_type),
                quotas=EXCLUDED.quotas,access_token_ciphertext=EXCLUDED.access_token_ciphertext,
                refresh_token_ciphertext=CASE WHEN EXCLUDED.refresh_token_ciphertext <> '' THEN EXCLUDED.refresh_token_ciphertext ELSE gemini_tools_accounts.refresh_token_ciphertext END,
                expires_at=EXCLUDED.expires_at,project_id=COALESCE(EXCLUDED.project_id,gemini_tools_accounts.project_id),updated_at=EXCLUDED.updated_at
             RETURNING *`,
            [
                account.id,
                account.email,
                account.name,
                account.picture || null,
                account.status,
                account.proxyEnabled,
                account.priority,
                account.planType || null,
                JSON.stringify(account.quotas),
                account.requestCount,
                account.totalTokens,
                account.errorCount,
                account.note || null,
                account.lastUsedAt || null,
                account.accessTokenCiphertext,
                account.refreshTokenCiphertext,
                new Date(account.expiresAt),
                account.projectId || null,
                new Date(account.createdAt),
                new Date(account.updatedAt),
            ],
        );
        return mapAccount(result.rows[0]);
    }

    async patchAccount(id: string, patch: Partial<Pick<StoredGeminiToolsAccount, "name" | "note" | "status" | "proxyEnabled" | "priority">>) {
        const values: unknown[] = [id];
        const assignments: string[] = [];
        addPatch(assignments, values, "name", patch.name);
        addPatch(assignments, values, "note", patch.note);
        addPatch(assignments, values, "status", patch.status);
        addPatch(assignments, values, "proxy_enabled", patch.proxyEnabled);
        addPatch(assignments, values, "priority", patch.priority);
        if (!assignments.length) return this.getAccount(id);
        const result = await this.db.query(`UPDATE gemini_tools_accounts SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`, values);
        return result.rows[0] ? mapAccount(result.rows[0]) : null;
    }

    async deleteAccount(id: string) {
        const result = await this.db.query("DELETE FROM gemini_tools_accounts WHERE id = $1 RETURNING id", [id]);
        return (result.rowCount || 0) > 0;
    }

    async updateAccountCredentials(id: string, input: { accessTokenCiphertext: string; refreshTokenCiphertext?: string; expiresAt: number; projectId?: string; planType?: string; quotas?: GeminiToolsQuota[]; status?: StoredGeminiToolsAccount["status"] }) {
        const values: unknown[] = [id, input.accessTokenCiphertext, new Date(input.expiresAt)];
        const assignments = ["access_token_ciphertext = $2", "expires_at = $3"];
        addPatch(assignments, values, "refresh_token_ciphertext", input.refreshTokenCiphertext);
        addPatch(assignments, values, "project_id", input.projectId);
        addPatch(assignments, values, "plan_type", input.planType);
        if (input.quotas) addPatch(assignments, values, "quotas", JSON.stringify(input.quotas), "::jsonb");
        addPatch(assignments, values, "status", input.status);
        await this.db.query(`UPDATE gemini_tools_accounts SET ${assignments.join(", ")} WHERE id = $1`, values);
    }

    async recordAccountUsage(id: string, totalTokens: number, failed: boolean) {
        await this.db.query("UPDATE gemini_tools_accounts SET request_count = request_count + 1, total_tokens = total_tokens + $2, error_count = error_count + $3, last_used_at = now() WHERE id = $1", [id, totalTokens, failed ? 1 : 0]);
    }

    async createOAuthSession(session: GeminiToolsOAuthSession) {
        await this.db.query("DELETE FROM gemini_tools_oauth_sessions WHERE created_at < now() - interval '15 minutes'");
        await this.db.query("INSERT INTO gemini_tools_oauth_sessions (state,redirect_uri,opener_origin,created_at) VALUES ($1,$2,$3,$4)", [session.state, session.redirectUri, session.openerOrigin, new Date(session.createdAt)]);
    }

    async consumeOAuthSession(state: string) {
        const result = await this.db.query("DELETE FROM gemini_tools_oauth_sessions WHERE state = $1 AND created_at >= now() - interval '15 minutes' RETURNING *", [state]);
        return result.rows[0] ? mapOAuthSession(result.rows[0]) : null;
    }

    async getGateway() {
        const result = await this.db.query("SELECT * FROM gemini_tools_gateway_settings WHERE id = 'default'");
        return result.rows[0] ? mapGateway(result.rows[0]) : { enabled: true, strategy: "round_robin" as const, sessionStickiness: false };
    }

    async updateGateway(patch: Partial<GeminiToolsGatewaySettings>) {
        const current = await this.getGateway();
        const value = { ...current, ...patch };
        const result = await this.db.query("UPDATE gemini_tools_gateway_settings SET enabled=$1,strategy=$2,session_stickiness=$3 WHERE id='default' RETURNING *", [value.enabled, value.strategy, value.sessionStickiness]);
        return mapGateway(result.rows[0]);
    }

    async listApiKeys() {
        const result = await this.db.query("SELECT * FROM gemini_tools_api_keys ORDER BY created_at DESC");
        return result.rows.map(mapApiKey);
    }

    async insertApiKey(key: StoredGeminiToolsApiKey) {
        const result = await this.db.query("INSERT INTO gemini_tools_api_keys (id,name,prefix,key_hash,status,expires_at,allowed_ips,request_count,total_tokens,last_used_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING *", [
            key.id,
            key.name,
            key.prefix,
            key.hash,
            key.status,
            key.expiresAt || null,
            JSON.stringify(key.allowedIps),
            key.requestCount,
            key.totalTokens,
            key.lastUsedAt || null,
            new Date(key.createdAt),
        ]);
        return mapApiKey(result.rows[0]);
    }

    async patchApiKey(id: string, patch: Partial<Pick<StoredGeminiToolsApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) {
        const values: unknown[] = [id];
        const assignments: string[] = [];
        addPatch(assignments, values, "name", patch.name);
        addPatch(assignments, values, "status", patch.status);
        if (patch.expiresAt === "") assignments.push("expires_at = NULL");
        else addPatch(assignments, values, "expires_at", patch.expiresAt);
        if (patch.allowedIps) addPatch(assignments, values, "allowed_ips", JSON.stringify(patch.allowedIps), "::jsonb");
        if (!assignments.length) return (await this.listApiKeys()).find((key) => key.id === id) || null;
        const result = await this.db.query(`UPDATE gemini_tools_api_keys SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`, values);
        return result.rows[0] ? mapApiKey(result.rows[0]) : null;
    }

    async deleteApiKey(id: string) {
        const result = await this.db.query("DELETE FROM gemini_tools_api_keys WHERE id = $1 RETURNING id", [id]);
        return (result.rowCount || 0) > 0;
    }

    async findApiKeyByHash(hash: string) {
        const result = await this.db.query("SELECT * FROM gemini_tools_api_keys WHERE key_hash = $1", [hash]);
        return result.rows[0] ? mapApiKey(result.rows[0]) : null;
    }

    async recordApiKeyRequest(id: string) {
        const result = await this.db.query("UPDATE gemini_tools_api_keys SET request_count=request_count+1,last_used_at=now() WHERE id=$1 RETURNING *", [id]);
        return result.rows[0] ? mapApiKey(result.rows[0]) : null;
    }

    async recordApiKeyTokens(id: string, totalTokens: number) {
        await this.db.query("UPDATE gemini_tools_api_keys SET total_tokens=total_tokens+$2 WHERE id=$1", [id, totalTokens]);
    }

    async appendLog(log: GeminiToolsRequestLog, maxLogs: number) {
        await this.db.query(
            `INSERT INTO gemini_tools_request_logs (id,created_at,protocol,path,model,account_id,account_email,status_code,duration_ms,prompt_tokens,completion_tokens,total_tokens,error,key_prefix,request_preview,response_preview)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
                log.id,
                new Date(log.createdAt),
                log.protocol,
                log.path,
                log.model,
                log.accountId || null,
                log.accountEmail || null,
                log.statusCode,
                log.durationMs,
                log.promptTokens,
                log.completionTokens,
                log.totalTokens,
                log.error || null,
                log.keyPrefix || null,
                log.requestPreview || null,
                log.responsePreview || null,
            ],
        );
        await this.db.query("DELETE FROM gemini_tools_request_logs WHERE id IN (SELECT id FROM gemini_tools_request_logs ORDER BY created_at DESC OFFSET $1)", [maxLogs]);
    }

    async listLogs(input: { page: number; pageSize: number; keyword?: string; status?: "success" | "failed" }) {
        const where: string[] = [];
        const values: unknown[] = [];
        if (input.status === "success") where.push("status_code < 400");
        if (input.status === "failed") where.push("status_code >= 400");
        if (input.keyword) {
            values.push(`%${escapeLike(input.keyword.toLowerCase())}%`);
            const parameter = `$${values.length}`;
            where.push(
                `(lower(model) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(account_email,'')) LIKE ${parameter} ESCAPE '\\' OR lower(path) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(error,'')) LIKE ${parameter} ESCAPE '\\' OR lower(coalesce(key_prefix,'')) LIKE ${parameter} ESCAPE '\\')`,
            );
        }
        const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
        const count = await this.db.query(`SELECT count(*)::integer AS total FROM gemini_tools_request_logs${condition}`, [...values]);
        values.push(input.pageSize, (input.page - 1) * input.pageSize);
        const result = await this.db.query(`SELECT * FROM gemini_tools_request_logs${condition} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
        return { items: result.rows.map(mapLog), total: number(count.rows[0]?.total), page: input.page, pageSize: input.pageSize };
    }

    async clearLogs() {
        const result = await this.db.query("DELETE FROM gemini_tools_request_logs");
        return result.rowCount || 0;
    }
}

function addPatch(assignments: string[], values: unknown[], column: string, value: unknown, suffix = "") {
    if (value === undefined) return;
    values.push(value);
    assignments.push(`${column} = $${values.length}${suffix}`);
}

function mapAccount(row: Record<string, unknown>): StoredGeminiToolsAccount {
    return {
        id: string(row.id),
        email: string(row.email),
        name: string(row.name),
        ...(string(row.picture) ? { picture: string(row.picture) } : {}),
        status: status(row.status),
        proxyEnabled: row.proxy_enabled !== false,
        priority: number(row.priority),
        ...(string(row.plan_type) ? { planType: string(row.plan_type) } : {}),
        quotas: quotas(row.quotas),
        requestCount: number(row.request_count),
        totalTokens: number(row.total_tokens),
        errorCount: number(row.error_count),
        ...(string(row.note) ? { note: string(row.note) } : {}),
        ...(date(row.last_used_at) ? { lastUsedAt: date(row.last_used_at)! } : {}),
        accessTokenCiphertext: string(row.access_token_ciphertext),
        refreshTokenCiphertext: string(row.refresh_token_ciphertext),
        expiresAt: Date.parse(date(row.expires_at) || "") || 0,
        ...(string(row.project_id) ? { projectId: string(row.project_id) } : {}),
        createdAt: date(row.created_at) || new Date().toISOString(),
        updatedAt: date(row.updated_at) || new Date().toISOString(),
    };
}

function mapOAuthSession(row: Record<string, unknown>): GeminiToolsOAuthSession {
    return { state: string(row.state), redirectUri: string(row.redirect_uri), openerOrigin: string(row.opener_origin), createdAt: Date.parse(date(row.created_at) || "") || 0 };
}
function mapGateway(row: Record<string, unknown>): GeminiToolsGatewaySettings {
    return { enabled: row.enabled !== false, strategy: row.strategy === "priority" ? "priority" : "round_robin", sessionStickiness: row.session_stickiness === true };
}
function mapApiKey(row: Record<string, unknown>): StoredGeminiToolsApiKey {
    return {
        id: string(row.id),
        name: string(row.name),
        prefix: string(row.prefix),
        hash: string(row.key_hash),
        status: row.status === "disabled" ? "disabled" : "active",
        ...(date(row.expires_at) ? { expiresAt: date(row.expires_at)! } : {}),
        allowedIps: strings(row.allowed_ips),
        requestCount: number(row.request_count),
        totalTokens: number(row.total_tokens),
        ...(date(row.last_used_at) ? { lastUsedAt: date(row.last_used_at)! } : {}),
        createdAt: date(row.created_at) || new Date().toISOString(),
    };
}
function mapLog(row: Record<string, unknown>): GeminiToolsRequestLog {
    return {
        id: string(row.id),
        createdAt: date(row.created_at) || new Date().toISOString(),
        protocol: protocol(row.protocol),
        path: string(row.path),
        model: string(row.model),
        ...(string(row.account_id) ? { accountId: string(row.account_id) } : {}),
        ...(string(row.account_email) ? { accountEmail: string(row.account_email) } : {}),
        statusCode: number(row.status_code),
        durationMs: number(row.duration_ms),
        promptTokens: number(row.prompt_tokens),
        completionTokens: number(row.completion_tokens),
        totalTokens: number(row.total_tokens),
        ...(string(row.error) ? { error: string(row.error) } : {}),
        ...(string(row.key_prefix) ? { keyPrefix: string(row.key_prefix) } : {}),
        ...(string(row.request_preview) ? { requestPreview: string(row.request_preview) } : {}),
        ...(string(row.response_preview) ? { responsePreview: string(row.response_preview) } : {}),
    };
}
function quotas(value: unknown): GeminiToolsQuota[] {
    return Array.isArray(value) ? (value as GeminiToolsQuota[]) : typeof value === "string" ? (safeArray(value) as GeminiToolsQuota[]) : [];
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
function status(value: unknown): StoredGeminiToolsAccount["status"] {
    return value === "disabled" || value === "invalid" ? value : "active";
}
function protocol(value: unknown): GeminiToolsRequestLog["protocol"] {
    return value === "gemini" || value === "anthropic" || value === "admin-test" ? value : "openai";
}
function escapeLike(value: string) {
    return value.replace(/[\\%_]/g, "\\$&");
}
