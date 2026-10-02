import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";

const FILE_NAME = "geminivids-request-logs.json";
const MAX_LOGS = 10_000;

export type GeminiVidsRequestSource = "runtime" | "admin-test" | "external";

export type GeminiVidsRequestLog = {
    id: string;
    time: string;
    source: GeminiVidsRequestSource;
    capability: "video";
    method: string;
    path: string;
    model: string;
    accountId?: string;
    accountEmail?: string;
    promptPreview?: string;
    requestPreview?: string;
    responsePreview?: string;
    statusCode?: number;
    durationMs?: number;
    error?: string;
    phase?: "queued" | "upstream" | "success" | "failed";
    clientIp?: string;
    userAgent?: string;
};

type Database = { logs: GeminiVidsRequestLog[] };

function nowIso() {
    return new Date().toISOString();
}

function newId() {
    return `gvlog_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

async function readDatabase(): Promise<Database> {
    const data = await readJsonDataFile<Database>(FILE_NAME, { logs: [] });
    if (data && Array.isArray(data.logs)) return data;
    return { logs: [] };
}

async function writeDatabase(db: Database) {
    if (db.logs.length > MAX_LOGS) db.logs = db.logs.slice(-MAX_LOGS);
    await writeJsonDataFile(FILE_NAME, db);
}

export async function appendGeminiVidsRequestLog(input: Partial<GeminiVidsRequestLog> & Pick<GeminiVidsRequestLog, "source" | "method" | "path">) {
    const entry: GeminiVidsRequestLog = {
        id: newId(),
        time: nowIso(),
        capability: "video",
        model: "",
        ...input,
    };
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        db.logs.push(entry);
        await writeDatabase(db);
    });
    return entry.id;
}

export async function settleGeminiVidsRequestLog(id: string, patch: Partial<GeminiVidsRequestLog>) {
    if (!id) return;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const entry = db.logs.find((item) => item.id === id);
        if (!entry) return;
        Object.assign(entry, patch);
        await writeDatabase(db);
    });
}

export async function listGeminiVidsRequestLogs(filters: { keyword?: string; status?: string; source?: string; model?: string; accountId?: string; page?: number; pageSize?: number; limit?: number } = {}) {
    const db = await readDatabase();
    let logs = [...db.logs].reverse();
    const keyword = filters.keyword?.trim().toLowerCase();
    if (keyword) {
        logs = logs.filter((log) =>
            [log.path, log.model, log.promptPreview, log.requestPreview, log.responsePreview, log.error, log.accountEmail]
                .some((value) => typeof value === "string" && value.toLowerCase().includes(keyword)),
        );
    }
    if (filters.status === "success") logs = logs.filter((log) => log.statusCode && log.statusCode >= 200 && log.statusCode < 300);
    if (filters.status === "failed") logs = logs.filter((log) => !log.statusCode || log.statusCode >= 400 || log.error);
    if (filters.source) logs = logs.filter((log) => log.source === filters.source);
    if (filters.model) logs = logs.filter((log) => log.model === filters.model);
    if (filters.accountId) logs = logs.filter((log) => log.accountId === filters.accountId);
    if (filters.limit) {
        const limit = Math.max(1, Math.min(Number(filters.limit) || 200, 1000));
        return { logs: logs.slice(0, limit), total: logs.length };
    }
    const pageSize = Math.max(1, Math.min(Number(filters.pageSize) || 20, 100));
    const page = Math.max(1, Number(filters.page) || 1);
    const finished = logs.filter((log) => log.phase !== "queued" && log.phase !== "upstream" && (log.statusCode || log.error));
    const stats = {
        total: logs.length,
        success: logs.filter((log) => log.statusCode && log.statusCode >= 200 && log.statusCode < 300).length,
        failed: logs.filter((log) => !log.statusCode || log.statusCode >= 400 || log.error).length,
        averageDurationMs: finished.length ? Math.round(finished.reduce((sum, log) => sum + (log.durationMs || 0), 0) / finished.length) : 0,
    };
    return { logs: logs.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: logs.length, stats };
}

export async function clearGeminiVidsRequestLogs() {
    await writeJsonDataFile(FILE_NAME, { logs: [] });
}

export async function geminiVidsRequestStats() {
    const db = await readDatabase();
    const total = db.logs.length;
    const failed = db.logs.filter((log) => log.error || (log.statusCode && log.statusCode >= 400)).length;
    const avgDuration = total ? Math.round(db.logs.reduce((sum, log) => sum + (log.durationMs || 0), 0) / total) : 0;
    return { total, failed, avgDurationMs: avgDuration };
}
