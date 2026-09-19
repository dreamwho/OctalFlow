import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { GeminiAiGatewayRepository } from "@/lib/server/database/geminiai-gateway-repository";

const FILE_NAME = "geminiai-gateway.json";

export type GeminiAiApiKey = {
    id: string;
    name: string;
    prefix: string;
    status: "active" | "disabled";
    expiresAt?: string;
    allowedIps: string[];
    requestCount: number;
    lastUsedAt?: string;
    createdAt: string;
};

export type GeminiAiGatewaySettings = { enabled: boolean };

export type StoredGeminiAiApiKey = GeminiAiApiKey & { hash: string };
type GeminiAiGatewayDatabase = { apiKeys: StoredGeminiAiApiKey[]; gateway: GeminiAiGatewaySettings };

const EMPTY_DB: GeminiAiGatewayDatabase = { apiKeys: [], gateway: { enabled: true } };

export async function getGeminiAiGatewaySettings() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).getGateway();
    return (await readDatabase()).gateway;
}

export async function updateGeminiAiGatewaySettings(patch: Partial<GeminiAiGatewaySettings>) {
    const normalized: Partial<GeminiAiGatewaySettings> = {};
    if (typeof patch.enabled === "boolean") normalized.enabled = patch.enabled;
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).updateGateway(normalized);
    let result!: GeminiAiGatewaySettings;
    await mutateDatabase((db) => {
        Object.assign(db.gateway, normalized);
        result = { ...db.gateway };
    });
    return result;
}

export async function listGeminiAiApiKeys() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listApiKeys().then((keys) => keys.map(publicApiKey));
    return (await readDatabase()).apiKeys.map(publicApiKey);
}

export async function createGeminiAiApiKey(input: { name: string; expiresAt?: string; allowedIps?: string[] }) {
    const rawKey = `oct_gai_${randomBytes(30).toString("base64url")}`;
    const now = new Date().toISOString();
    const stored: StoredGeminiAiApiKey = {
        id: `key-${randomUUID()}`,
        name: input.name.trim().slice(0, 120) || "GeminiAIStudio API Key",
        prefix: rawKey.slice(0, 14),
        hash: hashApiKey(rawKey),
        status: "active",
        ...(validDate(input.expiresAt) ? { expiresAt: new Date(input.expiresAt!).toISOString() } : {}),
        allowedIps: normalizeAllowedIps(input.allowedIps),
        requestCount: 0,
        createdAt: now,
    };
    if (isPostgresDatabaseEnabled()) await (await postgresRepository()).insertApiKey(stored);
    else await mutateDatabase((db) => void db.apiKeys.push(stored));
    return { key: publicApiKey(stored), rawKey };
}

export async function updateGeminiAiApiKey(id: string, patch: Partial<Pick<GeminiAiApiKey, "name" | "status" | "expiresAt" | "allowedIps">>): Promise<GeminiAiApiKey | null> {
    const normalized = normalizeApiKeyPatch(patch);
    if (isPostgresDatabaseEnabled()) {
        const key = await (await postgresRepository()).patchApiKey(id, normalized);
        return key ? publicApiKey(key) : null;
    }
    let result: GeminiAiApiKey | null = null;
    await mutateDatabase((db) => {
        const key = db.apiKeys.find((item) => item.id === id);
        if (!key) return;
        if (normalized.expiresAt === "") delete key.expiresAt;
        Object.assign(key, { ...normalized, ...(normalized.expiresAt === "" ? { expiresAt: undefined } : {}) });
        result = publicApiKey(key);
    });
    return result;
}

export async function deleteGeminiAiApiKey(id: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).deleteApiKey(id);
    let deleted = false;
    await mutateDatabase((db) => {
        const length = db.apiKeys.length;
        db.apiKeys = db.apiKeys.filter((key) => key.id !== id);
        deleted = db.apiKeys.length !== length;
    });
    return deleted;
}

export async function authorizeGeminiAiApiKey(rawKey: string, clientIp: string): Promise<GeminiAiApiKey | null> {
    const hash = hashApiKey(rawKey);
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const key = await repository.findApiKeyByHash(hash);
        if (!key || key.status !== "active" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) || !ipAllowed(clientIp, key.allowedIps)) return null;
        const used = await repository.recordApiKeyRequest(key.id);
        return used ? publicApiKey(used) : null;
    }
    let result: GeminiAiApiKey | null = null;
    await mutateDatabase((db) => {
        const key = db.apiKeys.find((item) => secureEqual(item.hash, hash));
        if (!key || key.status !== "active" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) || !ipAllowed(clientIp, key.allowedIps)) return;
        key.requestCount += 1;
        key.lastUsedAt = new Date().toISOString();
        result = publicApiKey(key);
    });
    return result;
}

function publicApiKey(key: StoredGeminiAiApiKey): GeminiAiApiKey {
    const { hash: _hash, ...value } = key;
    return structuredClone(value);
}

let geminiAiSchemaEnsured = false;
async function postgresRepository() {
    await ensurePostgresSchema();
    const repo = new GeminiAiGatewayRepository({ query: postgresQuery });
    if (!geminiAiSchemaEnsured) {
        geminiAiSchemaEnsured = true;
        await repo.ensureSchema().catch((error) => {
            geminiAiSchemaEnsured = false;
            console.error("[geminiai-gateway] Failed to ensure schema:", error);
        });
    }
    return repo;
}

async function readDatabase(): Promise<GeminiAiGatewayDatabase> {
    const stored = await readJsonDataFile<Partial<GeminiAiGatewayDatabase>>(FILE_NAME, EMPTY_DB);
    return {
        apiKeys: Array.isArray(stored.apiKeys) ? structuredClone(stored.apiKeys) : [],
        gateway: { ...EMPTY_DB.gateway, ...(stored.gateway || {}) },
    };
}

async function mutateDatabase(mutator: (db: GeminiAiGatewayDatabase) => void) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        mutator(db);
        await writeJsonDataFile(FILE_NAME, db);
    });
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

function normalizeApiKeyPatch(patch: Partial<Pick<GeminiAiApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) {
    const normalized: Partial<Pick<GeminiAiApiKey, "name" | "status" | "expiresAt" | "allowedIps">> = {};
    if (typeof patch.name === "string") normalized.name = patch.name.trim().slice(0, 120) || "GeminiAIStudio API Key";
    if (patch.status === "active" || patch.status === "disabled") normalized.status = patch.status;
    if (patch.expiresAt === "") normalized.expiresAt = "";
    else if (validDate(patch.expiresAt)) normalized.expiresAt = new Date(patch.expiresAt!).toISOString();
    if (Array.isArray(patch.allowedIps)) normalized.allowedIps = normalizeAllowedIps(patch.allowedIps);
    return normalized;
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
