import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { decryptSecretValue, encryptSecretValue, isEncryptionKeyReady } from "@/lib/server/secret-crypto";

const FILE_NAME = "geminivids-gateway.json";

export type GeminiVidsApiKey = {
    id: string;
    name: string;
    prefix: string;
    key?: string;
    status: "active" | "disabled";
    expiresAt?: string;
    allowedIps: string[];
    requestCount: number;
    lastUsedAt?: string;
    createdAt: string;
};

export type GeminiVidsGatewaySettings = { enabled: boolean };

type StoredGeminiVidsApiKey = GeminiVidsApiKey & { hash: string; keyCiphertext?: string };
type Database = { apiKeys: StoredGeminiVidsApiKey[]; gateway: GeminiVidsGatewaySettings };

const EMPTY_DB: Database = { apiKeys: [], gateway: { enabled: true } };

async function readDatabase(): Promise<Database> {
    const data = await readJsonDataFile<Database>(FILE_NAME, EMPTY_DB);
    if (data && Array.isArray(data.apiKeys) && data.gateway) return data;
    return { ...EMPTY_DB };
}

async function writeDatabase(db: Database) {
    await writeJsonDataFile(FILE_NAME, db);
}

export async function getGeminiVidsGatewaySettings(): Promise<GeminiVidsGatewaySettings> {
    return (await readDatabase()).gateway;
}

export async function updateGeminiVidsGatewaySettings(patch: Partial<GeminiVidsGatewaySettings>) {
    let result!: GeminiVidsGatewaySettings;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        if (typeof patch.enabled === "boolean") db.gateway.enabled = patch.enabled;
        result = { ...db.gateway };
        await writeDatabase(db);
    });
    return result;
}

function publicApiKey(key: StoredGeminiVidsApiKey): GeminiVidsApiKey {
    const { hash: _hash, keyCiphertext, ...rest } = key;
    return { ...rest, ...(keyCiphertext ? { key: decryptSecretValue(keyCiphertext) } : {}) };
}

export async function listGeminiVidsApiKeys() {
    return (await readDatabase()).apiKeys.map(publicApiKey);
}

export async function createGeminiVidsApiKey(input: { name: string; expiresAt?: string; allowedIps?: string[] }) {
    const rawKey = `oct_gv_${randomBytes(30).toString("base64url")}`;
    const now = new Date().toISOString();
    const keyCiphertext = isEncryptionKeyReady() ? encryptSecretValue(rawKey) : undefined;
    const stored: StoredGeminiVidsApiKey = {
        id: `key-${randomUUID()}`,
        name: input.name.trim().slice(0, 120) || "GeminiVids API Key",
        prefix: rawKey.slice(0, 12),
        hash: hashApiKey(rawKey),
        ...(keyCiphertext ? { keyCiphertext } : {}),
        status: "active",
        ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
        allowedIps: normalizeAllowedIps(input.allowedIps),
        requestCount: 0,
        createdAt: now,
    };
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        db.apiKeys.push(stored);
        await writeDatabase(db);
    });
    return { key: publicApiKey(stored), rawKey };
}

export async function updateGeminiVidsApiKey(id: string, patch: Partial<Pick<GeminiVidsApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) {
    let result: GeminiVidsApiKey | null = null;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const key = db.apiKeys.find((item) => item.id === id);
        if (!key) return;
        if (typeof patch.name === "string" && patch.name.trim()) key.name = patch.name.trim().slice(0, 120);
        if (patch.status === "active" || patch.status === "disabled") key.status = patch.status;
        if (patch.expiresAt === "") delete key.expiresAt;
        else if (patch.expiresAt) key.expiresAt = new Date(patch.expiresAt).toISOString();
        if (Array.isArray(patch.allowedIps)) key.allowedIps = normalizeAllowedIps(patch.allowedIps);
        result = publicApiKey(key);
        await writeDatabase(db);
    });
    return result;
}

export async function deleteGeminiVidsApiKey(id: string) {
    let deleted = false;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const length = db.apiKeys.length;
        db.apiKeys = db.apiKeys.filter((key) => key.id !== id);
        deleted = db.apiKeys.length !== length;
        await writeDatabase(db);
    });
    return deleted;
}

export async function authorizeGeminiVidsApiKey(rawKey: string, clientIp: string): Promise<GeminiVidsApiKey | null> {
    const hash = hashApiKey(rawKey);
    let result: GeminiVidsApiKey | null = null;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const key = db.apiKeys.find((item) => secureEqual(item.hash, hash));
        if (!key || key.status !== "active" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) || !ipAllowed(clientIp, key.allowedIps)) return;
        key.requestCount += 1;
        key.lastUsedAt = new Date().toISOString();
        result = publicApiKey(key);
        await writeDatabase(db);
    });
    return result;
}

function hashApiKey(rawKey: string) {
    return createHash("sha256").update(rawKey).digest("hex");
}

function secureEqual(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function ipAllowed(clientIp: string, allowedIps: string[]) {
    if (!allowedIps.length) return true;
    return allowedIps.some((allowed) => allowed === clientIp || (isIP(allowed) && allowed.endsWith(".0") && clientIp.startsWith(allowed.slice(0, -1))));
}

function normalizeAllowedIps(value?: string[]) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => item.trim()).filter((item) => isIP(item) || item.endsWith(".0")))).slice(0, 20);
}
