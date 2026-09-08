import { randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { RunningHubRepository } from "@/lib/server/database/runninghub-repository";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";

const FILE_NAME = "runninghub.json";
const MAX_TASKS = 2_000;
const MAX_LOGS = 10_000;

export type RunningHubField = {
    nodeId: string;
    fieldName: string;
    label: string;
    type: "text" | "textarea" | "image" | "video" | "audio" | "number" | "select" | "radio" | "switch";
    defaultValue: string;
    options: string[];
};

export type RunningHubApp = {
    id: string;
    remoteId: string;
    kind: "ai-app" | "workflow";
    name: string;
    description: string;
    thumbnailUrl: string;
    enabled: boolean;
    featureBindings: string[];
    fields: RunningHubField[];
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
};

export type RunningHubTask = {
    id: string;
    imageTaskId?: string;
    userId?: string;
    appId?: string;
    remoteTaskId?: string;
    status: "queued" | "running" | "success" | "failed" | "cancelled";
    error?: string;
    resultUrls: string[];
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
};

export type RunningHubRequestLog = {
    id: string;
    taskId?: string;
    appId?: string;
    phase: "account" | "sync" | "upload" | "submit" | "query" | "cancel";
    path: string;
    statusCode: number;
    durationMs: number;
    error?: string;
    createdAt: string;
};

export type StoredRunningHubSettings = {
    enabled: boolean;
    apiBaseUrl: string;
    apiKeyCiphertext: string;
    instanceType: "standard" | "plus";
    updatedAt: string;
};

export type RunningHubPublicSettings = Omit<StoredRunningHubSettings, "apiKeyCiphertext"> & { hasApiKey: boolean };
export type RunningHubPrivateSettings = Omit<StoredRunningHubSettings, "apiKeyCiphertext"> & { apiKey: string };

type RunningHubDatabase = {
    settings: StoredRunningHubSettings;
    apps: RunningHubApp[];
    tasks: RunningHubTask[];
    logs: RunningHubRequestLog[];
};

const EMPTY_DB: RunningHubDatabase = {
    settings: { enabled: false, apiBaseUrl: "https://www.runninghub.ai", apiKeyCiphertext: "", instanceType: "standard", updatedAt: new Date(0).toISOString() },
    apps: [],
    tasks: [],
    logs: [],
};

export async function getRunningHubPublicSettings(): Promise<RunningHubPublicSettings> {
    const settings = await getStoredSettings();
    const { apiKeyCiphertext, ...publicValue } = settings;
    return { ...publicValue, hasApiKey: Boolean(apiKeyCiphertext) };
}

export async function getRunningHubPrivateSettings(): Promise<RunningHubPrivateSettings> {
    const settings = await getStoredSettings();
    const { apiKeyCiphertext, ...value } = settings;
    return { ...value, apiKey: apiKeyCiphertext ? decryptSecretValue(apiKeyCiphertext) : "" };
}

export async function updateRunningHubSettings(patch: { enabled?: boolean; apiBaseUrl?: string; apiKey?: string; clearApiKey?: boolean; instanceType?: string }) {
    const current = await getStoredSettings();
    const next: StoredRunningHubSettings = {
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        apiBaseUrl: normalizeApiBaseUrl(typeof patch.apiBaseUrl === "string" ? patch.apiBaseUrl : current.apiBaseUrl),
        apiKeyCiphertext: patch.clearApiKey ? "" : typeof patch.apiKey === "string" && patch.apiKey.trim() ? encryptSecretValue(patch.apiKey.trim()) : current.apiKeyCiphertext,
        instanceType: patch.instanceType === "plus" ? "plus" : patch.instanceType === "standard" ? "standard" : current.instanceType,
        updatedAt: new Date().toISOString(),
    };
    if (isPostgresDatabaseEnabled()) await (await postgresRepository()).updateSettings(next);
    else await mutateDatabase((db) => void (db.settings = next));
    return getRunningHubPublicSettings();
}

export async function listRunningHubApps(input: { binding?: string; enabledOnly?: boolean } = {}) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listApps(input);
    const db = await readDatabase();
    return db.apps
        .filter((app) => (!input.enabledOnly || app.enabled) && (!input.binding || app.featureBindings.includes(input.binding)))
        .sort((left, right) => left.sortOrder - right.sortOrder || right.updatedAt.localeCompare(left.updatedAt));
}

export async function getRunningHubApp(id: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).getApp(id);
    return (await readDatabase()).apps.find((app) => app.id === id) || null;
}

export async function upsertRunningHubApp(input: Partial<RunningHubApp> & Pick<RunningHubApp, "remoteId" | "kind" | "name">) {
    const now = new Date().toISOString();
    const id = cleanId(input.id) || `rh-app-${randomUUID()}`;
    const existing = await getRunningHubApp(id);
    const app: RunningHubApp = {
        id,
        remoteId: input.remoteId.trim().slice(0, 200),
        kind: input.kind === "workflow" ? "workflow" : "ai-app",
        name: input.name.trim().slice(0, 120) || "RunningHub 应用",
        description: typeof input.description === "string" ? input.description.trim().slice(0, 500) : existing?.description || "",
        thumbnailUrl: normalizeThumbnailUrl(input.thumbnailUrl ?? existing?.thumbnailUrl ?? ""),
        enabled: typeof input.enabled === "boolean" ? input.enabled : existing?.enabled ?? true,
        featureBindings: normalizeBindings(input.featureBindings ?? existing?.featureBindings ?? []),
        fields: normalizeFields(input.fields ?? existing?.fields ?? []),
        sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.floor(Number(input.sortOrder)) : existing?.sortOrder ?? 0,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    if (!app.remoteId) throw new Error("请输入 RunningHub 应用或工作流 ID");
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).upsertApp(app);
    await mutateDatabase((db) => {
        const index = db.apps.findIndex((item) => item.id === id);
        if (index >= 0) db.apps[index] = app;
        else db.apps.push(app);
    });
    return app;
}

export async function deleteRunningHubApp(id: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).deleteApp(id);
    let deleted = false;
    await mutateDatabase((db) => {
        const before = db.apps.length;
        db.apps = db.apps.filter((item) => item.id !== id);
        deleted = db.apps.length !== before;
    });
    return deleted;
}

export async function saveRunningHubTask(task: RunningHubTask) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).upsertTask(task);
    await mutateDatabase((db) => {
        const index = db.tasks.findIndex((item) => item.id === task.id);
        if (index >= 0) db.tasks[index] = task;
        else db.tasks.unshift(task);
        if (db.tasks.length > MAX_TASKS) db.tasks.length = MAX_TASKS;
    });
    return task;
}

export async function getRunningHubTask(id: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).getTask(id);
    return (await readDatabase()).tasks.find((task) => task.id === id) || null;
}

export async function listRunningHubTasks(limit = 100) {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listTasks(bounded);
    return (await readDatabase()).tasks.slice(0, bounded);
}

export async function appendRunningHubRequestLog(input: Omit<RunningHubRequestLog, "id" | "createdAt">) {
    const log: RunningHubRequestLog = { id: `rh-log-${randomUUID()}`, createdAt: new Date().toISOString(), ...input };
    if (isPostgresDatabaseEnabled()) await (await postgresRepository()).appendLog(log, MAX_LOGS);
    else
        await mutateDatabase((db) => {
            db.logs.unshift(log);
            if (db.logs.length > MAX_LOGS) db.logs.length = MAX_LOGS;
        });
    return log;
}

export async function listRunningHubRequestLogs(limit = 100) {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listLogs(bounded);
    return (await readDatabase()).logs.slice(0, bounded);
}

export async function clearRunningHubRequestLogs() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).clearLogs();
    let count = 0;
    await mutateDatabase((db) => {
        count = db.logs.length;
        db.logs = [];
    });
    return count;
}

async function getStoredSettings() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).getSettings();
    return (await readDatabase()).settings;
}

async function postgresRepository() {
    await ensurePostgresSchema();
    return new RunningHubRepository({ query: postgresQuery });
}

async function readDatabase(): Promise<RunningHubDatabase> {
    const stored = await readJsonDataFile<Partial<RunningHubDatabase>>(FILE_NAME, EMPTY_DB);
    return {
        settings: { ...EMPTY_DB.settings, ...(stored.settings || {}) },
        apps: Array.isArray(stored.apps) ? structuredClone(stored.apps) : [],
        tasks: Array.isArray(stored.tasks) ? structuredClone(stored.tasks) : [],
        logs: Array.isArray(stored.logs) ? structuredClone(stored.logs) : [],
    };
}

async function mutateDatabase(mutator: (db: RunningHubDatabase) => void) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        mutator(db);
        await writeJsonDataFile(FILE_NAME, db);
    });
}

function normalizeApiBaseUrl(value: string) {
    const raw = value.trim() || "https://www.runninghub.ai";
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    if (url.protocol !== "https:") throw new Error("RunningHub 接口地址必须使用 HTTPS");
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

function cleanId(value: unknown) {
    return typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 200) : "";
}

function normalizeThumbnailUrl(value: string) {
    const raw = value.trim().slice(0, 2000);
    if (!raw) return "";
    if (raw.startsWith("/")) return raw;
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("缩略图地址必须是 HTTP(S) 或站内路径");
    return url.toString();
}

function normalizeBindings(value: unknown) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))).slice(0, 20);
}

function normalizeFields(value: unknown): RunningHubField[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 200).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const field = item as Partial<RunningHubField>;
        const nodeId = String(field.nodeId || "").trim().slice(0, 120);
        const fieldName = String(field.fieldName || "").trim().slice(0, 120);
        if (!nodeId || !fieldName) return [];
        const type = ["text", "textarea", "image", "video", "audio", "number", "select", "radio", "switch"].includes(String(field.type)) ? (field.type as RunningHubField["type"]) : "text";
        return [{ nodeId, fieldName, label: String(field.label || fieldName).trim().slice(0, 160), type, defaultValue: String(field.defaultValue ?? "").slice(0, 5000), options: Array.isArray(field.options) ? field.options.map(String).slice(0, 100) : [] }];
    });
}
