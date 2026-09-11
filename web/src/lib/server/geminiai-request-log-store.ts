import { randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { GeminiAiRequestLogRepository } from "@/lib/server/database/geminiai-request-log-repository";

const FILE_NAME = "geminiai-request-logs.json";
const MAX_LOGS = 10_000;

export type GeminiAiRequestCapability = "text" | "image" | "search";
export type GeminiAiRequestSource = "runtime" | "admin-test";
export type GeminiAiRequestLogPhase = "queued" | "running" | "success" | "failed";

export type GeminiAiRequestLog = {
    id: string;
    createdAt: string;
    source: GeminiAiRequestSource;
    capability: GeminiAiRequestCapability;
    method: string;
    path: string;
    model: string;
    accountId?: string;
    accountEmail?: string;
    statusCode: number;
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    imageRequestedCount?: number;
    imageSucceededCount?: number;
    imageFailedCount?: number;
    clientIp?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
    proxyEgress?: { mode: "magic" | "generic" | "chained"; node_name?: string; address?: string };
    phase?: GeminiAiRequestLogPhase;
    lifecycle?: Array<{ time: string; phase: GeminiAiRequestLogPhase; message: string }>;
};

export type GeminiAiRequestStats = {
    total: number;
    success: number;
    failed: number;
    averageDurationMs: number;
};

type GeminiAiRequestLogDatabase = { logs: GeminiAiRequestLog[] };
const EMPTY_DB: GeminiAiRequestLogDatabase = { logs: [] };

export async function appendGeminiAiRequestLog(input: Omit<GeminiAiRequestLog, "id" | "createdAt">) {
    const log = { id: `geminiai-log-${randomUUID()}`, createdAt: new Date().toISOString(), phase: "success", ...input } satisfies GeminiAiRequestLog;
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

/** Insert a placeholder row at submission time; returns the log id for later settlement. */
export async function openGeminiAiRequestLog(input: Omit<GeminiAiRequestLog, "id" | "createdAt" | "statusCode" | "durationMs" | "phase" | "lifecycle">) {
    const id = `geminiai-log-${randomUUID()}`;
    const log = {
        id,
        createdAt: new Date().toISOString(),
        statusCode: 0,
        durationMs: 0,
        phase: "queued",
        lifecycle: [{ time: new Date().toISOString(), phase: "queued", message: "等待执行" }],
        ...input,
    } satisfies GeminiAiRequestLog;
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

/** Advance an open log to running. */
export async function markGeminiAiRequestLogRunning(id: string) {
    await patchGeminiAiRequestLog(id, (log) => {
        log.phase = "running";
        log.lifecycle = [...(log.lifecycle || []), { time: new Date().toISOString(), phase: "running", message: "执行中" }];
    });
}

/** Settle an open log with the final status/response. */
export async function settleGeminiAiRequestLog(
    id: string,
    settle: {
        statusCode: number;
        durationMs: number;
        error?: string;
        responsePreview?: string;
        accountId?: string;
        accountEmail?: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        imageRequestedCount?: number;
        imageSucceededCount?: number;
        imageFailedCount?: number;
        clientIp?: string;
        userAgent?: string;
        proxyEgress?: GeminiAiRequestLog["proxyEgress"];
    },
) {
    await patchGeminiAiRequestLog(id, (log) => {
        log.statusCode = settle.statusCode;
        log.durationMs = settle.durationMs;
        if (settle.error) log.error = settle.error;
        if (settle.responsePreview) log.responsePreview = settle.responsePreview;
        if (settle.accountId) log.accountId = settle.accountId;
        if (settle.accountEmail) log.accountEmail = settle.accountEmail;
        if (settle.promptTokens !== undefined) log.promptTokens = settle.promptTokens;
        if (settle.completionTokens !== undefined) log.completionTokens = settle.completionTokens;
        if (settle.totalTokens !== undefined) log.totalTokens = settle.totalTokens;
        if (settle.imageRequestedCount !== undefined) log.imageRequestedCount = settle.imageRequestedCount;
        if (settle.imageSucceededCount !== undefined) log.imageSucceededCount = settle.imageSucceededCount;
        if (settle.imageFailedCount !== undefined) log.imageFailedCount = settle.imageFailedCount;
        if (settle.clientIp) log.clientIp = settle.clientIp;
        if (settle.userAgent) log.userAgent = settle.userAgent;
        if (settle.proxyEgress) log.proxyEgress = settle.proxyEgress;
        const failed = settle.statusCode >= 400 || Boolean(settle.error);
        log.phase = failed ? "failed" : "success";
        log.lifecycle = [...(log.lifecycle || []), { time: new Date().toISOString(), phase: log.phase, message: failed ? settle.error || `调用失败` : "调用完成" }];
    });
}

async function patchGeminiAiRequestLog(id: string, mutate: (log: GeminiAiRequestLog) => void) {
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

export async function listGeminiAiProxyEgressLogsPage(input: { limit?: number; offset?: number } = {}) {
    const limit = Math.max(1, Math.min(Math.floor(input.limit || 50), 200));
    const offset = Math.max(0, Math.floor(input.offset || 0));
    let logs: GeminiAiRequestLog[];
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        logs = [];
        for (let page = 1; page <= 5 && (page - 1) * 100 < MAX_LOGS; page += 1) {
            const pageResult = await repository.list({ page, pageSize: 100 });
            if (!pageResult.items.length) break;
            logs.push(...pageResult.items);
        }
    } else {
        logs = (await readDatabase()).logs;
    }
    const matches = logs.filter((log) => log.proxyEgress);
    return { items: matches.slice(offset, offset + limit), total: matches.length, has_more: offset + limit < matches.length };
}

export async function listGeminiAiRequestLogs(
    input: {
        page?: number;
        pageSize?: number;
        keyword?: string;
        status?: "success" | "failed";
        capability?: GeminiAiRequestCapability;
        model?: string;
        accountId?: string;
    } = {},
) {
    const page = Math.max(1, Math.floor(input.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 20)));
    const keyword = input.keyword?.trim().toLowerCase() || "";
    if (isPostgresDatabaseEnabled()) {
        return (await postgresRepository()).list({
            page,
            pageSize,
            keyword: keyword || undefined,
            status: input.status,
            capability: input.capability,
            model: input.model?.trim() || undefined,
            accountId: input.accountId?.trim() || undefined,
        });
    }
    const logs = (await readDatabase()).logs;
    const items = logs.filter((log) =>
        matches(log, {
            keyword,
            status: input.status,
            capability: input.capability,
            model: input.model?.trim() || undefined,
            accountId: input.accountId?.trim() || undefined,
        }),
    );
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, stats: requestStats(logs) };
}

export async function clearGeminiAiRequestLogs() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).clear();
    let count = 0;
    await mutateDatabase((database) => {
        count = database.logs.length;
        database.logs = [];
    });
    return count;
}

export function requestStats(logs: GeminiAiRequestLog[]): GeminiAiRequestStats {
    const total = logs.length;
    const success = logs.filter((log) => log.statusCode < 400).length;
    const duration = logs.reduce((sum, log) => sum + Math.max(0, log.durationMs), 0);
    return { total, success, failed: total - success, averageDurationMs: total ? Math.round(duration / total) : 0 };
}

let schemaEnsured = false;
async function postgresRepository() {
    await ensurePostgresSchema();
    const repo = new GeminiAiRequestLogRepository({ query: postgresQuery });
    if (!schemaEnsured) {
        schemaEnsured = true;
        await repo.ensureSchema().catch((error) => {
            schemaEnsured = false;
            console.error("[geminiai-log] Failed to ensure schema:", error);
        });
    }
    return repo;
}

async function readDatabase() {
    const stored = await readJsonDataFile<Partial<GeminiAiRequestLogDatabase>>(FILE_NAME, EMPTY_DB);
    return { logs: Array.isArray(stored.logs) ? structuredClone(stored.logs) : [] };
}

async function mutateDatabase(mutator: (database: GeminiAiRequestLogDatabase) => void) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const database = await readDatabase();
        mutator(database);
        await writeJsonDataFile(FILE_NAME, database);
    });
}

function matches(
    log: GeminiAiRequestLog,
    input: { keyword: string; status?: "success" | "failed"; capability?: GeminiAiRequestCapability; model?: string; accountId?: string },
) {
    if (input.status === "success" && log.statusCode >= 400) return false;
    if (input.status === "failed" && log.statusCode < 400) return false;
    if (input.capability && log.capability !== input.capability) return false;
    if (input.model && log.model !== input.model) return false;
    if (input.accountId && log.accountId !== input.accountId) return false;
    return !input.keyword || [log.model, log.accountEmail, log.path, log.error, log.requestPreview].filter(Boolean).join(" ").toLowerCase().includes(input.keyword);
}
