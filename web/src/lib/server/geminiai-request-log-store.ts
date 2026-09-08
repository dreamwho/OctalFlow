import { randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { GeminiAiRequestLogRepository } from "@/lib/server/database/geminiai-request-log-repository";

const FILE_NAME = "geminiai-request-logs.json";
const MAX_LOGS = 10_000;

export type GeminiAiRequestCapability = "text" | "image" | "search";
export type GeminiAiRequestSource = "runtime" | "admin-test";
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
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
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
    const log = { id: `geminiai-log-${randomUUID()}`, createdAt: new Date().toISOString(), ...input } satisfies GeminiAiRequestLog;
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

export async function listGeminiAiRequestLogs(input: { page?: number; pageSize?: number; keyword?: string; status?: "success" | "failed"; capability?: GeminiAiRequestCapability } = {}) {
    const page = Math.max(1, Math.floor(input.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 20)));
    const keyword = input.keyword?.trim().toLowerCase() || "";
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).list({ page, pageSize, keyword: keyword || undefined, status: input.status, capability: input.capability });
    const logs = (await readDatabase()).logs;
    const items = logs.filter((log) => matches(log, { keyword, status: input.status, capability: input.capability }));
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

async function postgresRepository() {
    await ensurePostgresSchema();
    return new GeminiAiRequestLogRepository({ query: postgresQuery });
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

function matches(log: GeminiAiRequestLog, input: { keyword: string; status?: "success" | "failed"; capability?: GeminiAiRequestCapability }) {
    if (input.status === "success" && log.statusCode >= 400) return false;
    if (input.status === "failed" && log.statusCode < 400) return false;
    if (input.capability && log.capability !== input.capability) return false;
    return !input.keyword || [log.model, log.accountEmail, log.path, log.error, log.requestPreview].filter(Boolean).join(" ").toLowerCase().includes(input.keyword);
}
