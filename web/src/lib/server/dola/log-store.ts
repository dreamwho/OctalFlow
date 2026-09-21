import { randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { DolaRequestLogRepository } from "@/lib/server/database/dola-request-log-repository";

const FILE_NAME = "dola/request-logs.json";
const MAX_LOGS = 10_000;

export type DolaRequestLogSource = "runtime" | "admin-test" | "external";
export type DolaRequestLogCapability = "video" | "image";
/** Task-level phases: submitted（已提交排队）→ generating（生成中）→ success/failed/needs_review。 */
export type DolaRequestLogPhase = "queued" | "routing" | "auth" | "upstream" | "response" | "running" | "submitted" | "generating" | "success" | "failed" | "needs_review";
export type DolaRequestLogStatus = "success" | "failed" | "needs_review" | "pending";
/** Phases that mean the underlying Dola task is still in flight. */
export const DOLA_TASK_PENDING_PHASES = ["queued", "routing", "auth", "upstream", "response", "running", "submitted", "generating"] as const;
export type DolaRequestLifecycleEntry = {
    time: string;
    phase: DolaRequestLogPhase;
    message: string;
    detail?: string;
    durationMs?: number;
};
export type DolaRequestLog = {
    id: string;
    createdAt: string;
    source: DolaRequestLogSource;
    capability: DolaRequestLogCapability;
    method: string;
    path: string;
    model: string;
    accountId?: string;
    accountName?: string;
    statusCode: number;
    durationMs: number;
    phase: DolaRequestLogPhase;
    taskId?: string;
    verificationId?: string;
    requestedDuration?: number;
    ratio?: string;
    requestBytes?: number;
    responseBytes?: number;
    contentType?: string;
    quotaRemaining?: number | null;
    quotaLimit?: number | null;
    clientIp?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
    screenshotBase64?: string;
    proxyEgress?: { mode: "direct" | "magic" | "generic" | "chained"; nodeName?: string; address?: string };
    lifecycle?: DolaRequestLifecycleEntry[];
};

export type DolaRequestStats = {
    total: number;
    success: number;
    failed: number;
    needsReview: number;
    pending: number;
    averageDurationMs: number;
};
export type DolaRequestLogPage = { items: DolaRequestLog[]; total: number; page: number; pageSize: number; stats: DolaRequestStats };

type DolaRequestLogDatabase = { logs: DolaRequestLog[] };
const EMPTY_DB: DolaRequestLogDatabase = { logs: [] };
type DolaRequestLogInput = Omit<DolaRequestLog, "id" | "createdAt" | "capability" | "method" | "phase"> & Partial<Pick<DolaRequestLog, "capability" | "method" | "phase">>;

export async function appendDolaRequestLog(input: DolaRequestLogInput) {
    const log = normalizeLog({ id: `dola-log-${randomUUID()}`, createdAt: new Date().toISOString(), capability: "video", method: "POST", phase: "success", ...input });
    if (isPostgresDatabaseEnabled()) {
        await (await postgresRepository()).append(log, MAX_LOGS);
        return log;
    }
    await mutateDatabase((database) => {
        database.logs.unshift(log);
        if (database.logs.length > MAX_LOGS) database.logs.length = MAX_LOGS;
    });
    return log;
}

/** Insert a queued row before the provider call so rejected/aborted calls are still visible. */
export async function openDolaRequestLog(input: Omit<DolaRequestLog, "id" | "createdAt" | "statusCode" | "durationMs" | "phase" | "lifecycle"> & { lifecycle?: DolaRequestLifecycleEntry[] }) {
    const now = new Date().toISOString();
    const id = `dola-log-${randomUUID()}`;
    const log = normalizeLog({ id, createdAt: now, statusCode: 0, durationMs: 0, phase: "queued", lifecycle: [{ time: now, phase: "queued", message: "等待执行" }], ...input });
    if (isPostgresDatabaseEnabled()) {
        await (await postgresRepository()).append(log, MAX_LOGS);
        return id;
    }
    await mutateDatabase((database) => {
        database.logs.unshift(log);
        if (database.logs.length > MAX_LOGS) database.logs.length = MAX_LOGS;
    });
    return id;
}

export async function markDolaRequestLogRunning(id: string, entry: Omit<DolaRequestLifecycleEntry, "time" | "phase"> & { phase?: DolaRequestLogPhase } = { message: "执行中" }) {
    await patchDolaRequestLog(id, (log) => {
        const phase = entry.phase || "running";
        log.phase = phase;
        log.lifecycle = [...(log.lifecycle || []), { time: new Date().toISOString(), phase, message: entry.message, ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }) }];
    });
}

/** Map a Provider task status (queued/running/accepted/completed/failed/needs_review) onto the task lifecycle log phase. */
export function dolaTaskLogPhase(status: string, hasVerification = false): DolaRequestLogPhase {
    const value = (status || "").toLowerCase();
    if (hasVerification) return "needs_review";
    if (value === "completed" || value === "succeeded") return "success";
    if (value === "failed" || value === "submission_unknown") return "failed";
    if (value === "needs_review" || value === "verification_required" || value === "pending_verification") return "failed";
    if (value === "queued") return "submitted";
    return "generating";
}

/** Find the create log row that owns an upstream task so polls can update it instead of adding rows. */
export async function findDolaTaskLogIdByTaskId(taskId: string, source: DolaRequestLogSource): Promise<string> {
    const target = (taskId || "").trim();
    if (!target) return "";
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).findByTaskId(target, source);
    const candidates = (await readDatabase()).logs.filter((item) => item.taskId === target && item.source === source);
    // Prefer the original create row; legacy poll-created rows are only a fallback for pre-lifecycle data.
    return (candidates.find((item) => item.method === "POST") || candidates[0])?.id || "";
}

/**
 * Advance an existing task log through its lifecycle. Lifecycle entries are only
 * appended on phase transitions so repeated polls do not flood the timeline; the
 * final states also close durationMs to the total task time.
 */
export async function advanceDolaTaskLog(
    id: string,
    advance: {
        phase: DolaRequestLogPhase;
        message: string;
        detail?: string;
        statusCode?: number;
        responsePreview?: string;
        responseBytes?: number;
        contentType?: string;
        error?: string;
        verificationId?: string;
        screenshotBase64?: string;
        requestedDuration?: number;
        ratio?: string;
        quotaRemaining?: number | null;
        quotaLimit?: number | null;
    },
) {
    await patchDolaRequestLog(id, (log) => {
        const previous = log.phase;
        if (advance.statusCode !== undefined) log.statusCode = Math.max(0, Math.floor(advance.statusCode));
        if (advance.responsePreview) log.responsePreview = truncate(advance.responsePreview, 4_000);
        if (advance.responseBytes !== undefined) log.responseBytes = Math.max(0, Math.floor(advance.responseBytes));
        if (advance.contentType) log.contentType = truncate(advance.contentType, 160);
        if (advance.error) log.error = truncate(advance.error, 1_000);
        if (advance.verificationId) log.verificationId = truncate(advance.verificationId, 300);
        if (advance.screenshotBase64) log.screenshotBase64 = advance.screenshotBase64;
        if (advance.requestedDuration !== undefined) log.requestedDuration = advance.requestedDuration;
        if (advance.ratio) log.ratio = truncate(advance.ratio, 32);
        if (advance.quotaRemaining !== undefined) log.quotaRemaining = advance.quotaRemaining;
        if (advance.quotaLimit !== undefined) log.quotaLimit = advance.quotaLimit;
        log.phase = advance.phase;
        const final = advance.phase === "success" || advance.phase === "failed" || advance.phase === "needs_review";
        if (final && previous !== advance.phase) {
            const startedAt = Date.parse(log.createdAt);
            if (Number.isFinite(startedAt)) log.durationMs = Math.max(0, Date.now() - startedAt);
        }
        if (previous !== advance.phase) {
            log.lifecycle = [...(log.lifecycle || []), { time: new Date().toISOString(), phase: advance.phase, message: advance.message, ...(advance.detail ? { detail: advance.detail } : {}), ...(Number.isFinite(Date.parse(log.createdAt)) ? { durationMs: Math.max(0, Date.now() - Date.parse(log.createdAt)) } : {}) }];
        }
    });
}

export async function settleDolaRequestLog(
    id: string,
    settle: {
        statusCode: number;
        durationMs: number;
        phase?: DolaRequestLogPhase;
        error?: string;
        requestPreview?: string;
        responsePreview?: string;
        requestBytes?: number;
        responseBytes?: number;
        contentType?: string;
        model?: string;
        accountId?: string;
        accountName?: string;
        taskId?: string;
        verificationId?: string;
        screenshotBase64?: string;
        requestedDuration?: number;
        ratio?: string;
        quotaRemaining?: number | null;
        quotaLimit?: number | null;
        proxyEgress?: DolaRequestLog["proxyEgress"];
        lifecycle?: DolaRequestLifecycleEntry[];
    },
) {
    await patchDolaRequestLog(id, (log) => {
        log.statusCode = Math.max(0, Math.floor(settle.statusCode));
        log.durationMs = Math.max(0, Math.floor(settle.durationMs));
        if (settle.phase) log.phase = settle.phase;
        else log.phase = settle.error || log.statusCode >= 400 ? "failed" : "success";
        if (settle.error) log.error = truncate(settle.error, 1_000);
        if (settle.requestPreview) log.requestPreview = truncate(settle.requestPreview, 4_000);
        if (settle.responsePreview) log.responsePreview = truncate(settle.responsePreview, 4_000);
        if (settle.requestBytes !== undefined) log.requestBytes = Math.max(0, Math.floor(settle.requestBytes));
        if (settle.responseBytes !== undefined) log.responseBytes = Math.max(0, Math.floor(settle.responseBytes));
        if (settle.contentType) log.contentType = truncate(settle.contentType, 160);
        if (settle.model) log.model = truncate(settle.model, 200);
        if (settle.accountId) log.accountId = truncate(settle.accountId, 160);
        if (settle.accountName) log.accountName = truncate(settle.accountName, 160);
        if (settle.taskId) log.taskId = truncate(settle.taskId, 300);
        if (settle.verificationId) log.verificationId = truncate(settle.verificationId, 300);
        if (settle.screenshotBase64) log.screenshotBase64 = settle.screenshotBase64;
        if (settle.requestedDuration !== undefined) log.requestedDuration = settle.requestedDuration;
        if (settle.ratio) log.ratio = truncate(settle.ratio, 32);
        if (settle.quotaRemaining !== undefined) log.quotaRemaining = settle.quotaRemaining;
        if (settle.quotaLimit !== undefined) log.quotaLimit = settle.quotaLimit;
        if (settle.proxyEgress) log.proxyEgress = settle.proxyEgress;
        log.lifecycle = settle.lifecycle?.length ? settle.lifecycle : [...(log.lifecycle || []), { time: new Date().toISOString(), phase: log.phase, message: log.phase === "success" ? "请求处理完成" : log.error || phaseLabel(log.phase) }];
    });
}

/** 换号续生成：把原任务的请求日志转接到新任务 ID，之后新任务的轮询继续叠加在同一份日志里。 */
export async function retargetDolaRequestLogTask(oldTaskId: string, newTaskId: string, newAccountName?: string) {
    const source = (oldTaskId || "").trim();
    const target = (newTaskId || "").trim();
    if (!source || !target || source === target) return;
    const logId = await findDolaTaskLogIdByTaskId(source, "runtime");
    if (!logId) return;
    await patchDolaRequestLog(logId, (log) => {
        log.taskId = target.slice(0, 300);
        if (newAccountName) log.accountName = newAccountName.slice(0, 160);
    });
}

async function patchDolaRequestLog(id: string, mutate: (log: DolaRequestLog) => void) {
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const existing = await repository.findById(id);
        if (!existing) return;
        mutate(existing);
        await repository.update(existing);
        return;
    }
    await mutateDatabase((database) => {
        const target = database.logs.find((log) => log.id === id);
        if (target) mutate(target);
    });
}

export async function listDolaRequestLogs(
    input: {
        page?: number;
        pageSize?: number;
        keyword?: string;
        status?: DolaRequestLogStatus;
        phase?: DolaRequestLogPhase;
        source?: DolaRequestLogSource;
        model?: string;
        accountId?: string;
        proxyMode?: "direct" | "magic" | "generic" | "chained";
    } = {},
): Promise<DolaRequestLogPage> {
    const page = Math.max(1, Math.floor(input.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 20)));
    const keyword = input.keyword?.trim().toLowerCase() || "";
    const filters = { ...input, page, pageSize, keyword, model: input.model?.trim() || undefined, accountId: input.accountId?.trim() || undefined };
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).list(filters);
    const logs = (await readDatabase()).logs;
    const items = logs.filter((log) => matches(log, filters));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, stats: requestStats(logs) };
}

export async function clearDolaRequestLogs() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).clear();
    let count = 0;
    await mutateDatabase((database) => {
        count = database.logs.length;
        database.logs = [];
    });
    return count;
}

export function requestStats(logs: DolaRequestLog[]): DolaRequestStats {
    const total = logs.length;
    const success = logs.filter((log) => log.phase === "success").length;
    const failed = logs.filter((log) => log.phase === "failed" || (log.phase !== "needs_review" && log.statusCode >= 400)).length;
    const needsReview = logs.filter((log) => log.phase === "needs_review").length;
    const pending = logs.filter((log) => (DOLA_TASK_PENDING_PHASES as readonly string[]).includes(log.phase)).length;
    const duration = logs.reduce((sum, log) => sum + Math.max(0, log.durationMs), 0);
    return { total, success, failed, needsReview, pending, averageDurationMs: total ? Math.round(duration / total) : 0 };
}

function matches(log: DolaRequestLog, input: { keyword: string; status?: DolaRequestLogStatus; phase?: DolaRequestLogPhase; source?: DolaRequestLogSource; model?: string; accountId?: string; proxyMode?: string }) {
    if (input.status === "success" && log.phase !== "success") return false;
    if (input.status === "failed" && log.phase !== "failed" && log.statusCode < 400) return false;
    if (input.status === "needs_review" && log.phase !== "needs_review") return false;
    if (input.status === "pending" && !(DOLA_TASK_PENDING_PHASES as readonly string[]).includes(log.phase)) return false;
    if (input.phase && log.phase !== input.phase) return false;
    if (input.source && log.source !== input.source) return false;
    if (input.model && log.model !== input.model) return false;
    if (input.accountId && log.accountId !== input.accountId) return false;
    if (input.proxyMode && (log.proxyEgress?.mode || "direct") !== input.proxyMode) return false;
    if (!input.keyword) return true;
    return [log.model, log.accountId, log.accountName, log.path, log.error, log.taskId, log.verificationId, log.requestPreview, log.responsePreview, log.proxyEgress?.nodeName].filter(Boolean).join(" ").toLowerCase().includes(input.keyword);
}

function normalizeLog(input: DolaRequestLog): DolaRequestLog {
    return {
        ...input,
        source: input.source || "runtime",
        capability: input.capability || "video",
        method: (input.method || "POST").toUpperCase(),
        path: truncate(input.path || "/v1/videos", 500),
        model: truncate(input.model || "", 200),
        statusCode: Math.max(0, Math.floor(Number(input.statusCode) || 0)),
        durationMs: Math.max(0, Math.floor(Number(input.durationMs) || 0)),
        phase: input.phase || "success",
        ...(input.headers ? { headers: sanitizeHeaders(input.headers) } : {}),
        ...(input.requestPreview ? { requestPreview: sanitizePreview(input.requestPreview) } : {}),
        ...(input.responsePreview ? { responsePreview: sanitizePreview(input.responsePreview) } : {}),
        ...(input.screenshotBase64 ? { screenshotBase64: input.screenshotBase64 } : {}),
        ...(input.error ? { error: truncate(input.error, 1_000) } : {}),
    };
}

function sanitizeHeaders(headers: Record<string, string>) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (/authorization|cookie|api[-_]?key|token|secret|password/i.test(key)) continue;
        result[key.toLowerCase()] = truncate(String(value), 300);
    }
    return result;
}

function sanitizePreview(value: string) {
    try {
        const parsed = JSON.parse(value) as unknown;
        const rendered = JSON.stringify(redactValue(parsed), null, 2);
        return truncate(rendered, 4_000);
    } catch {
        return truncate(value.replace(/(?:cookie|authorization|x-api-key|token|secret|password)\s*[:=]\s*[^,;\s]+/gi, "$1:〔已脱敏〕"), 4_000);
    }
}

function redactValue(value: unknown, key = ""): unknown {
    // Media result URLs (videoUrl/imageUrls) are the deliverable and stay visible per admin requirement.
    if (key && /cookie|authorization|api[-_]?key|token|secret|password|base64|dataurl/i.test(key)) return "〔已脱敏〕";
    if (typeof value === "string") {
        if (/^data:(?:image|video)\//i.test(value) || value.length > 512 && /^[a-z0-9+/=_-]+$/i.test(value.replace(/\s/g, ""))) return "〔媒体或编码数据已脱敏〕";
        return value.length > 600 ? `${value.slice(0, 600)}…` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactValue(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 64).map(([entryKey, item]) => [entryKey, redactValue(item, entryKey)]));
    return value;
}

function phaseLabel(phase: DolaRequestLogPhase) {
    const labels: Record<DolaRequestLogPhase, string> = {
        queued: "等待执行",
        routing: "代理路由",
        auth: "账号鉴权",
        upstream: "上游请求",
        response: "读取响应",
        running: "执行中",
        submitted: "任务已提交",
        generating: "任务生成中",
        success: "请求处理完成",
        failed: "请求失败",
        needs_review: "等待人工确认",
    };
    return labels[phase] || "请求结束";
}

function truncate(value: string, max: number) {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

let schemaEnsured = false;
async function postgresRepository() {
    await ensurePostgresSchema();
    const repository = new DolaRequestLogRepository({ query: postgresQuery });
    if (!schemaEnsured) {
        schemaEnsured = true;
        await repository.ensureSchema().catch((error) => {
            schemaEnsured = false;
            console.error("[dola-log] Failed to ensure schema:", error);
        });
    }
    return repository;
}

async function readDatabase() {
    const stored = await readJsonDataFile<DolaRequestLogDatabase | DolaRequestLog[]>(FILE_NAME, EMPTY_DB);
    const logs = Array.isArray(stored) ? stored : Array.isArray(stored.logs) ? stored.logs : [];
    return { logs: logs.map((log) => normalizeLog(log)) };
}

async function mutateDatabase(mutator: (database: DolaRequestLogDatabase) => void) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const database = await readDatabase();
        mutator(database);
        await writeJsonDataFile(FILE_NAME, database.logs);
    });
}
