import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { GeminiToolsRepository } from "@/lib/server/database/gemini-tools-repository";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";

const FILE_NAME = "gemini-tools.json";
const MAX_LOGS = 10_000;

export type GeminiToolsQuota = {
    model: string;
    displayName: string;
    remainingPercent?: number;
    resetTime?: string;
    supportsImages?: boolean;
    supportsThinking?: boolean;
};

export type GeminiToolsAccount = {
    id: string;
    email: string;
    name: string;
    picture?: string;
    status: "active" | "disabled" | "invalid";
    proxyEnabled: boolean;
    priority: number;
    planType?: string;
    quotas: GeminiToolsQuota[];
    requestCount: number;
    totalTokens: number;
    errorCount: number;
    note?: string;
    lastUsedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type GeminiToolsApiKey = {
    id: string;
    name: string;
    prefix: string;
    status: "active" | "disabled";
    expiresAt?: string;
    allowedIps: string[];
    requestCount: number;
    totalTokens: number;
    lastUsedAt?: string;
    createdAt: string;
};

export type GeminiToolsRequestLog = {
    id: string;
    createdAt: string;
    protocol: "openai" | "gemini" | "anthropic" | "admin-test";
    path: string;
    model: string;
    accountId?: string;
    accountEmail?: string;
    statusCode: number;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    error?: string;
    keyPrefix?: string;
    requestPreview?: string;
    responsePreview?: string;
    proxyEgress?: { mode: "magic" | "generic"; node_name?: string; address?: string };
    phase?: "queued" | "running" | "success" | "failed";
    lifecycle?: Array<{ time: string; phase: "queued" | "running" | "success" | "failed"; message: string }>;
};

export type GeminiToolsGatewaySettings = {
    enabled: boolean;
    strategy: "round_robin" | "priority";
    sessionStickiness: boolean;
};

export type StoredGeminiToolsAccount = GeminiToolsAccount & {
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    expiresAt: number;
    projectId?: string;
};
export type GeminiToolsOAuthSession = { state: string; redirectUri: string; openerOrigin: string; createdAt: number };
export type StoredGeminiToolsApiKey = GeminiToolsApiKey & { hash: string };
type GeminiToolsDatabase = {
    accounts: StoredGeminiToolsAccount[];
    oauthSessions: GeminiToolsOAuthSession[];
    apiKeys: StoredGeminiToolsApiKey[];
    logs: GeminiToolsRequestLog[];
    gateway: GeminiToolsGatewaySettings;
};

export type GeminiToolsPrivateAccount = GeminiToolsAccount & { accessToken: string; refreshToken: string; expiresAt: number; projectId?: string };

const EMPTY_DB: GeminiToolsDatabase = { accounts: [], oauthSessions: [], apiKeys: [], logs: [], gateway: { enabled: true, strategy: "round_robin", sessionStickiness: false } };

export async function listGeminiToolsAccounts() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listAccounts().then((accounts) => accounts.map(publicAccount));
    return (await readDatabase()).accounts.map(publicAccount);
}

export async function getGeminiToolsPrivateAccount(id: string) {
    if (isPostgresDatabaseEnabled()) {
        const stored = await (await postgresRepository()).getAccount(id);
        return stored ? privateAccount(stored) : null;
    }
    const stored = (await readDatabase()).accounts.find((account) => account.id === id);
    return stored ? privateAccount(stored) : null;
}

export async function listGeminiToolsCandidateAccounts() {
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const [accounts, gateway] = await Promise.all([repository.listAccounts(true), repository.getGateway()]);
        accounts.sort(gateway.strategy === "priority" ? (left, right) => right.priority - left.priority || compareLastUsed(left, right) : compareLastUsed);
        return accounts.map(privateAccount);
    }
    const db = await readDatabase();
    const accounts = db.accounts.filter((account) => account.status === "active" && account.proxyEnabled);
    accounts.sort(db.gateway.strategy === "priority" ? (left, right) => right.priority - left.priority || compareLastUsed(left, right) : compareLastUsed);
    return accounts.map(privateAccount);
}

export async function createGeminiToolsOAuthSession(redirectUri: string, openerOrigin: string) {
    const state = randomBytes(32).toString("base64url");
    if (isPostgresDatabaseEnabled()) {
        await (await postgresRepository()).createOAuthSession({ state, redirectUri, openerOrigin, createdAt: Date.now() });
        return state;
    }
    await mutateDatabase((db) => {
        const cutoff = Date.now() - 15 * 60_000;
        db.oauthSessions = db.oauthSessions.filter((session) => session.createdAt >= cutoff);
        db.oauthSessions.push({ state, redirectUri, openerOrigin, createdAt: Date.now() });
    });
    return state;
}

export async function consumeGeminiToolsOAuthSession(state: string): Promise<GeminiToolsOAuthSession | null> {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).consumeOAuthSession(state);
    let value: GeminiToolsOAuthSession | null = null;
    await mutateDatabase((db) => {
        const index = db.oauthSessions.findIndex((session) => session.state === state && session.createdAt >= Date.now() - 15 * 60_000);
        if (index < 0) return;
        value = db.oauthSessions[index];
        db.oauthSessions.splice(index, 1);
    });
    return value;
}

export async function upsertGeminiToolsAccount(input: { email: string; name: string; picture?: string; accessToken: string; refreshToken: string; expiresAt: number; projectId?: string; planType?: string; quotas: GeminiToolsQuota[] }) {
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const existing = await repository.getAccountByEmail(input.email);
        return publicAccount(await repository.upsertAccount(buildStoredAccount(input, existing)));
    }
    let result!: GeminiToolsAccount;
    await mutateDatabase((db) => {
        const existing = db.accounts.find((account) => account.email.toLowerCase() === input.email.toLowerCase());
        const stored = buildStoredAccount(input, existing);
        if (existing) db.accounts[db.accounts.indexOf(existing)] = stored;
        else db.accounts.push(stored);
        result = publicAccount(stored);
    });
    return result;
}

export async function updateGeminiToolsAccount(id: string, patch: Partial<Pick<GeminiToolsAccount, "name" | "note" | "status" | "proxyEnabled" | "priority">>): Promise<GeminiToolsAccount | null> {
    const normalized = normalizeAccountPatch(patch);
    if (isPostgresDatabaseEnabled()) {
        const account = await (await postgresRepository()).patchAccount(id, normalized);
        return account ? publicAccount(account) : null;
    }
    let result: GeminiToolsAccount | null = null;
    await mutateDatabase((db) => {
        const account = db.accounts.find((item) => item.id === id);
        if (!account) return;
        Object.assign(account, normalized);
        account.updatedAt = new Date().toISOString();
        result = publicAccount(account);
    });
    return result;
}

export async function deleteGeminiToolsAccount(id: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).deleteAccount(id);
    let deleted = false;
    await mutateDatabase((db) => {
        const length = db.accounts.length;
        db.accounts = db.accounts.filter((account) => account.id !== id);
        deleted = db.accounts.length !== length;
    });
    return deleted;
}

export async function updateGeminiToolsAccountCredentials(id: string, input: { accessToken: string; refreshToken?: string; expiresAt: number; projectId?: string; planType?: string; quotas?: GeminiToolsQuota[]; status?: GeminiToolsAccount["status"] }) {
    if (isPostgresDatabaseEnabled()) {
        await (
            await postgresRepository()
        ).updateAccountCredentials(id, {
            accessTokenCiphertext: encryptSecretValue(input.accessToken),
            ...(input.refreshToken ? { refreshTokenCiphertext: encryptSecretValue(input.refreshToken) } : {}),
            expiresAt: input.expiresAt,
            projectId: input.projectId,
            planType: input.planType,
            quotas: input.quotas,
            status: input.status,
        });
        return;
    }
    await mutateDatabase((db) => {
        const account = db.accounts.find((item) => item.id === id);
        if (!account) return;
        account.accessTokenCiphertext = encryptSecretValue(input.accessToken);
        if (input.refreshToken) account.refreshTokenCiphertext = encryptSecretValue(input.refreshToken);
        account.expiresAt = input.expiresAt;
        if (input.projectId) account.projectId = input.projectId;
        if (input.planType) account.planType = input.planType;
        if (input.quotas) account.quotas = input.quotas;
        if (input.status) account.status = input.status;
        account.updatedAt = new Date().toISOString();
    });
}

export async function recordGeminiToolsAccountUsage(id: string, totalTokens: number, failed: boolean) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).recordAccountUsage(id, Math.max(0, Math.floor(totalTokens)), failed);
    await mutateDatabase((db) => {
        const account = db.accounts.find((item) => item.id === id);
        if (!account) return;
        account.requestCount += 1;
        account.totalTokens += Math.max(0, Math.floor(totalTokens));
        if (failed) account.errorCount += 1;
        account.lastUsedAt = new Date().toISOString();
        account.updatedAt = account.lastUsedAt;
    });
}

export async function getGeminiToolsGatewaySettings() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).getGateway();
    return (await readDatabase()).gateway;
}

export async function updateGeminiToolsGatewaySettings(patch: Partial<GeminiToolsGatewaySettings>) {
    const normalized = normalizeGatewayPatch(patch);
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).updateGateway(normalized);
    let result!: GeminiToolsGatewaySettings;
    await mutateDatabase((db) => {
        Object.assign(db.gateway, normalized);
        result = { ...db.gateway };
    });
    return result;
}

export async function listGeminiToolsApiKeys() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listApiKeys().then((keys) => keys.map(publicApiKey));
    return (await readDatabase()).apiKeys.map(publicApiKey);
}

export async function createGeminiToolsApiKey(input: { name: string; expiresAt?: string; allowedIps?: string[] }) {
    const rawKey = `oct_gat_${randomBytes(30).toString("base64url")}`;
    const now = new Date().toISOString();
    const stored: StoredGeminiToolsApiKey = {
        id: `key-${randomUUID()}`,
        name: input.name.trim().slice(0, 120) || "GeminiTools API Key",
        prefix: rawKey.slice(0, 14),
        hash: hashApiKey(rawKey),
        status: "active",
        ...(validDate(input.expiresAt) ? { expiresAt: new Date(input.expiresAt!).toISOString() } : {}),
        allowedIps: normalizeAllowedIps(input.allowedIps),
        requestCount: 0,
        totalTokens: 0,
        createdAt: now,
    };
    if (isPostgresDatabaseEnabled()) await (await postgresRepository()).insertApiKey(stored);
    else await mutateDatabase((db) => void db.apiKeys.push(stored));
    return { key: publicApiKey(stored), rawKey };
}

export async function updateGeminiToolsApiKey(id: string, patch: Partial<Pick<GeminiToolsApiKey, "name" | "status" | "expiresAt" | "allowedIps">>): Promise<GeminiToolsApiKey | null> {
    const normalized = normalizeApiKeyPatch(patch);
    if (isPostgresDatabaseEnabled()) {
        const key = await (await postgresRepository()).patchApiKey(id, normalized);
        return key ? publicApiKey(key) : null;
    }
    let result: GeminiToolsApiKey | null = null;
    await mutateDatabase((db) => {
        const key = db.apiKeys.find((item) => item.id === id);
        if (!key) return;
        if (normalized.expiresAt === "") delete key.expiresAt;
        Object.assign(key, { ...normalized, ...(normalized.expiresAt === "" ? { expiresAt: undefined } : {}) });
        result = publicApiKey(key);
    });
    return result;
}

export async function deleteGeminiToolsApiKey(id: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).deleteApiKey(id);
    let deleted = false;
    await mutateDatabase((db) => {
        const length = db.apiKeys.length;
        db.apiKeys = db.apiKeys.filter((key) => key.id !== id);
        deleted = db.apiKeys.length !== length;
    });
    return deleted;
}

export async function authorizeGeminiToolsApiKey(rawKey: string, clientIp: string): Promise<GeminiToolsApiKey | null> {
    const hash = hashApiKey(rawKey);
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const key = await repository.findApiKeyByHash(hash);
        if (!key || key.status !== "active" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) || !ipAllowed(clientIp, key.allowedIps)) return null;
        const used = await repository.recordApiKeyRequest(key.id);
        return used ? publicApiKey(used) : null;
    }
    let result: GeminiToolsApiKey | null = null;
    await mutateDatabase((db) => {
        const key = db.apiKeys.find((item) => secureEqual(item.hash, hash));
        if (!key || key.status !== "active" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) || !ipAllowed(clientIp, key.allowedIps)) return;
        key.requestCount += 1;
        key.lastUsedAt = new Date().toISOString();
        result = publicApiKey(key);
    });
    return result;
}

export async function recordGeminiToolsApiKeyTokens(id: string, totalTokens: number) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).recordApiKeyTokens(id, Math.max(0, Math.floor(totalTokens)));
    await mutateDatabase((db) => {
        const key = db.apiKeys.find((item) => item.id === id);
        if (key) key.totalTokens += Math.max(0, Math.floor(totalTokens));
    });
}

export async function appendGeminiToolsRequestLog(log: Omit<GeminiToolsRequestLog, "id" | "createdAt">) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).appendLog({ id: `log-${randomUUID()}`, createdAt: new Date().toISOString(), ...log }, MAX_LOGS);
    await mutateDatabase((db) => {
        db.logs.unshift({ id: `log-${randomUUID()}`, createdAt: new Date().toISOString(), ...log });
        if (db.logs.length > MAX_LOGS) db.logs.length = MAX_LOGS;
    });
}

export async function openGeminiToolsRequestLog(log: Omit<GeminiToolsRequestLog, "id" | "createdAt" | "statusCode" | "durationMs" | "phase" | "lifecycle">) {
    const id = `log-${randomUUID()}`;
    const entry = { id, createdAt: new Date().toISOString(), statusCode: 0, durationMs: 0, phase: "queued" as const, lifecycle: [{ time: new Date().toISOString(), phase: "queued" as const, message: "等待执行" }], ...log } satisfies GeminiToolsRequestLog;
    if (isPostgresDatabaseEnabled()) return void (await postgresRepository()).appendLog(entry, MAX_LOGS);
    await mutateDatabase((db) => {
        db.logs.unshift(entry);
        if (db.logs.length > MAX_LOGS) db.logs.length = MAX_LOGS;
    });
    return id;
}

export async function markGeminiToolsRequestLogRunning(id: string) {
    await patchGeminiToolsLog(id, (log) => {
        log.phase = "running";
        log.lifecycle = [...(log.lifecycle || []), { time: new Date().toISOString(), phase: "running", message: "执行中" }];
    });
}

export async function settleGeminiToolsRequestLog(id: string, settle: { statusCode: number; durationMs: number; error?: string; accountId?: string; accountEmail?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; responsePreview?: string; proxyEgress?: GeminiToolsRequestLog["proxyEgress"] }) {
    await patchGeminiToolsLog(id, (log) => {
        log.statusCode = settle.statusCode;
        log.durationMs = settle.durationMs;
        if (settle.error) log.error = settle.error;
        if (settle.accountId) log.accountId = settle.accountId;
        if (settle.accountEmail) log.accountEmail = settle.accountEmail;
        if (settle.promptTokens !== undefined) log.promptTokens = settle.promptTokens;
        if (settle.completionTokens !== undefined) log.completionTokens = settle.completionTokens;
        if (settle.totalTokens !== undefined) log.totalTokens = settle.totalTokens;
        if (settle.responsePreview) log.responsePreview = settle.responsePreview;
        if (settle.proxyEgress) log.proxyEgress = settle.proxyEgress;
        const failed = settle.statusCode >= 400 || Boolean(settle.error);
        log.phase = failed ? "failed" : "success";
        log.lifecycle = [...(log.lifecycle || []), { time: new Date().toISOString(), phase: log.phase, message: failed ? settle.error || "调用失败" : "调用完成" }];
    });
}

async function patchGeminiToolsLog(id: string, mutate: (log: GeminiToolsRequestLog) => void) {
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        for (let page = 1; page <= 20; page += 1) {
            const pageResult = await repository.listLogs({ page, pageSize: 100 });
            const target = pageResult.items.find((log) => log.id === id);
            if (target) {
                mutate(target);
                await repository.updateLog?.(target);
                return;
            }
            if (!pageResult.items.length || pageResult.items.length < 100) break;
        }
        return;
    }
    await mutateDatabase((db) => {
        const target = db.logs.find((log) => log.id === id);
        if (target) mutate(target);
    });
}

export async function listGeminiToolsRequestLogs(input: { page?: number; pageSize?: number; keyword?: string; status?: "success" | "failed" } = {}) {
    const page = Math.max(1, Math.floor(input.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 20)));
    const keyword = input.keyword?.trim().toLowerCase() || "";
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listLogs({ page, pageSize, keyword: keyword || undefined, status: input.status });
    const items = (await readDatabase()).logs.filter((log) => {
        if (input.status === "success" && log.statusCode >= 400) return false;
        if (input.status === "failed" && log.statusCode < 400) return false;
        return !keyword || [log.model, log.accountEmail, log.path, log.error, log.keyPrefix].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}

export async function listGeminiToolsProxyEgressLogs(input: { limit?: number; offset?: number } = {}) {
    const limit = Math.max(1, Math.min(Math.floor(input.limit || 50), 200));
    const offset = Math.max(0, Math.floor(input.offset || 0));
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const collected: GeminiToolsRequestLog[] = [];
        for (let page = 1; page <= 5 && collected.length < offset + limit; page += 1) {
            const pageResult = await repository.listLogs({ page, pageSize: 100 });
            if (!pageResult.items.length) break;
            collected.push(...pageResult.items.filter((log) => log.proxyEgress));
        }
        return { items: collected.slice(offset, offset + limit), total: collected.length, has_more: offset + limit < collected.length };
    }
    const matches = (await readDatabase()).logs.filter((log) => log.proxyEgress);
    return { items: matches.slice(offset, offset + limit), total: matches.length, has_more: offset + limit < matches.length };
}

export async function clearGeminiToolsRequestLogs() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).clearLogs();
    let count = 0;
    await mutateDatabase((db) => {
        count = db.logs.length;
        db.logs = [];
    });
    return count;
}

function publicAccount(account: StoredGeminiToolsAccount): GeminiToolsAccount {
    const { accessTokenCiphertext: _access, refreshTokenCiphertext: _refresh, expiresAt: _expires, projectId: _project, ...value } = account;
    return structuredClone(value);
}

function privateAccount(account: StoredGeminiToolsAccount): GeminiToolsPrivateAccount {
    return {
        ...publicAccount(account),
        accessToken: decryptSecretValue(account.accessTokenCiphertext),
        refreshToken: account.refreshTokenCiphertext ? decryptSecretValue(account.refreshTokenCiphertext) : "",
        expiresAt: account.expiresAt,
        ...(account.projectId ? { projectId: account.projectId } : {}),
    };
}

function publicApiKey(key: StoredGeminiToolsApiKey): GeminiToolsApiKey {
    const { hash: _hash, ...value } = key;
    return structuredClone(value);
}

async function postgresRepository() {
    await ensurePostgresSchema();
    return new GeminiToolsRepository({ query: postgresQuery });
}

function buildStoredAccount(
    input: {
        email: string;
        name: string;
        picture?: string;
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        projectId?: string;
        planType?: string;
        quotas: GeminiToolsQuota[];
    },
    existing?: StoredGeminiToolsAccount | null,
): StoredGeminiToolsAccount {
    const now = new Date().toISOString();
    const refreshTokenCiphertext = input.refreshToken ? encryptSecretValue(input.refreshToken) : existing?.refreshTokenCiphertext || "";
    return {
        id: existing?.id || `account-${randomUUID()}`,
        email: input.email.trim().toLowerCase(),
        name: input.name.trim().slice(0, 160) || input.email.trim().toLowerCase(),
        ...(input.picture?.trim() ? { picture: input.picture.trim() } : existing?.picture ? { picture: existing.picture } : {}),
        status: "active",
        proxyEnabled: existing?.proxyEnabled ?? true,
        priority: existing?.priority ?? 0,
        ...(input.planType?.trim() ? { planType: input.planType.trim() } : existing?.planType ? { planType: existing.planType } : {}),
        quotas: structuredClone(input.quotas),
        requestCount: existing?.requestCount ?? 0,
        totalTokens: existing?.totalTokens ?? 0,
        errorCount: existing?.errorCount ?? 0,
        ...(existing?.note ? { note: existing.note } : {}),
        ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
        accessTokenCiphertext: encryptSecretValue(input.accessToken),
        refreshTokenCiphertext,
        expiresAt: input.expiresAt,
        ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : existing?.projectId ? { projectId: existing.projectId } : {}),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
}

function normalizeAccountPatch(patch: Partial<Pick<GeminiToolsAccount, "name" | "note" | "status" | "proxyEnabled" | "priority">>) {
    const normalized: Partial<Pick<GeminiToolsAccount, "name" | "note" | "status" | "proxyEnabled" | "priority">> = {};
    if (typeof patch.name === "string") normalized.name = patch.name.trim().slice(0, 160);
    if (typeof patch.note === "string") normalized.note = patch.note.trim().slice(0, 500);
    if (patch.status === "active" || patch.status === "disabled" || patch.status === "invalid") normalized.status = patch.status;
    if (typeof patch.proxyEnabled === "boolean") normalized.proxyEnabled = patch.proxyEnabled;
    if (Number.isFinite(patch.priority)) normalized.priority = Math.max(-1_000, Math.min(1_000, Math.floor(patch.priority!)));
    return normalized;
}

function normalizeGatewayPatch(patch: Partial<GeminiToolsGatewaySettings>) {
    const normalized: Partial<GeminiToolsGatewaySettings> = {};
    if (typeof patch.enabled === "boolean") normalized.enabled = patch.enabled;
    if (patch.strategy === "round_robin" || patch.strategy === "priority") normalized.strategy = patch.strategy;
    if (typeof patch.sessionStickiness === "boolean") normalized.sessionStickiness = patch.sessionStickiness;
    return normalized;
}

function normalizeApiKeyPatch(patch: Partial<Pick<GeminiToolsApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) {
    const normalized: Partial<Pick<GeminiToolsApiKey, "name" | "status" | "expiresAt" | "allowedIps">> = {};
    if (typeof patch.name === "string") normalized.name = patch.name.trim().slice(0, 120) || "GeminiTools API Key";
    if (patch.status === "active" || patch.status === "disabled") normalized.status = patch.status;
    if (patch.expiresAt === "") normalized.expiresAt = "";
    else if (validDate(patch.expiresAt)) normalized.expiresAt = new Date(patch.expiresAt!).toISOString();
    if (Array.isArray(patch.allowedIps)) normalized.allowedIps = normalizeAllowedIps(patch.allowedIps);
    return normalized;
}

async function readDatabase(): Promise<GeminiToolsDatabase> {
    const stored = await readJsonDataFile<Partial<GeminiToolsDatabase>>(FILE_NAME, EMPTY_DB);
    return {
        accounts: Array.isArray(stored.accounts) ? structuredClone(stored.accounts) : [],
        oauthSessions: Array.isArray(stored.oauthSessions) ? structuredClone(stored.oauthSessions) : [],
        apiKeys: Array.isArray(stored.apiKeys) ? structuredClone(stored.apiKeys) : [],
        logs: Array.isArray(stored.logs) ? structuredClone(stored.logs) : [],
        gateway: { ...EMPTY_DB.gateway, ...(stored.gateway || {}) },
    };
}

async function mutateDatabase(mutator: (db: GeminiToolsDatabase) => void) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        mutator(db);
        await writeJsonDataFile(FILE_NAME, db);
    });
}

function compareLastUsed(left: StoredGeminiToolsAccount, right: StoredGeminiToolsAccount) {
    return Date.parse(left.lastUsedAt || left.createdAt) - Date.parse(right.lastUsedAt || right.createdAt);
}

function hashApiKey(value: string) {
    return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function validDate(value: unknown) {
    return typeof value === "string" && Boolean(value.trim()) && Number.isFinite(Date.parse(value));
}

function normalizeAllowedIps(value: unknown) {
    if (!Array.isArray(value)) return [];
    return Array.from(
        new Set(
            value
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter((item) => validIpRule(item)),
        ),
    ).slice(0, 100);
}

function validIpRule(value: string) {
    const [address, prefix] = value.split("/");
    const version = isIP(address);
    if (!version) return false;
    if (prefix === undefined) return true;
    const bits = Number(prefix);
    return version === 4 && Number.isInteger(bits) && bits >= 0 && bits <= 32;
}

function ipAllowed(clientIp: string, rules: string[]) {
    if (!rules.length) return true;
    const ip = clientIp.replace(/^::ffff:/, "");
    return rules.some((rule) => rule === ip || ipv4CidrContains(rule, ip));
}

function ipv4CidrContains(rule: string, ip: string) {
    const [network, prefixText] = rule.split("/");
    if (prefixText === undefined || isIP(network) !== 4 || isIP(ip) !== 4) return false;
    const prefix = Number(prefixText);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipv4Number(network) & mask) === (ipv4Number(ip) & mask);
}

function ipv4Number(value: string) {
    return value.split(".").reduce((result, item) => ((result << 8) | Number(item)) >>> 0, 0);
}
