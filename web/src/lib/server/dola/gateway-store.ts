import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { decryptSecretValue, encryptSecretValue, isEncryptionKeyReady } from "@/lib/server/secret-crypto";

const FILE_NAME = "dola/gateway.json";
export type DolaGatewaySettings = { enabled: boolean; autoWatermark: boolean; rotationLimit: number; captureVerificationScreenshot: boolean; dispatchGroups: string[] };
export type DolaApiKey = { id: string; name: string; prefix: string; key?: string; status: "active" | "disabled"; expiresAt?: string; allowedIps: string[]; requestCount: number; lastUsedAt?: string; createdAt: string };
type StoredKey = DolaApiKey & { hash: string; keyCiphertext?: string };
type Database = { gateway: DolaGatewaySettings; apiKeys: StoredKey[] };
const EMPTY: Database = { gateway: { enabled: false, autoWatermark: true, rotationLimit: 2, captureVerificationScreenshot: true, dispatchGroups: [] }, apiKeys: [] };

export async function getDolaGatewaySettings() {
    const db = await readDatabase();
    return {
        enabled: db.gateway?.enabled ?? false,
        autoWatermark: db.gateway?.autoWatermark ?? true,
        rotationLimit: db.gateway?.rotationLimit ?? 2,
        captureVerificationScreenshot: db.gateway?.captureVerificationScreenshot ?? true,
        dispatchGroups: Array.isArray(db.gateway?.dispatchGroups) ? [...db.gateway.dispatchGroups] : [],
    };
}

export async function updateDolaGatewaySettings(patch: Partial<Omit<DolaGatewaySettings, "dispatchGroups">> & { dispatchGroups?: string[] | null }) {
    let value!: DolaGatewaySettings;
    await mutate((db) => {
        if (typeof patch.enabled === "boolean") db.gateway.enabled = patch.enabled;
        if (typeof patch.autoWatermark === "boolean") db.gateway.autoWatermark = patch.autoWatermark;
        if (typeof patch.rotationLimit === "number" && Number.isSafeInteger(patch.rotationLimit) && patch.rotationLimit >= 0) db.gateway.rotationLimit = patch.rotationLimit;
        if (typeof patch.captureVerificationScreenshot === "boolean") db.gateway.captureVerificationScreenshot = patch.captureVerificationScreenshot;
        if (patch.dispatchGroups === null || Array.isArray(patch.dispatchGroups)) db.gateway.dispatchGroups = normalizeGroups(patch.dispatchGroups);
        value = { ...db.gateway };
    });
    return value;
}

export async function listDolaApiKeys() {
    return (await readDatabase()).apiKeys.map(publicKey);
}

export async function createDolaApiKey(input: { name: string; expiresAt?: string; allowedIps?: string[] }) {
    const rawKey = `oct_dola_${randomBytes(30).toString("base64url")}`;
    const now = new Date().toISOString();
    const keyCiphertext = isEncryptionKeyReady() ? encryptSecretValue(rawKey) : undefined;
    const key: StoredKey = {
        id: `key-${randomUUID()}`,
        name: input.name.trim().slice(0, 120) || "Dola API Key",
        prefix: rawKey.slice(0, 16),
        status: "active",
        ...(validDate(input.expiresAt) ? { expiresAt: new Date(input.expiresAt!).toISOString() } : {}),
        allowedIps: normalizeIps(input.allowedIps),
        requestCount: 0,
        createdAt: now,
        hash: hash(rawKey),
        ...(keyCiphertext ? { keyCiphertext } : {}),
    };
    await mutate((db) => void db.apiKeys.push(key));
    return { key: publicKey(key), rawKey };
}

export async function updateDolaApiKey(id: string, patch: Partial<Pick<DolaApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) {
    let result: DolaApiKey | null = null;
    await mutate((db) => {
        const key = db.apiKeys.find((item) => item.id === id);
        if (!key) return;
        if (typeof patch.name === "string") key.name = patch.name.trim().slice(0, 120) || key.name;
        if (patch.status === "active" || patch.status === "disabled") key.status = patch.status;
        if (patch.expiresAt === "") delete key.expiresAt;
        else if (validDate(patch.expiresAt)) key.expiresAt = new Date(patch.expiresAt!).toISOString();
        if (Array.isArray(patch.allowedIps)) key.allowedIps = normalizeIps(patch.allowedIps);
        result = publicKey(key);
    });
    return result;
}

export async function deleteDolaApiKey(id: string) {
    let deleted = false;
    await mutate((db) => {
        const before = db.apiKeys.length;
        db.apiKeys = db.apiKeys.filter((item) => item.id !== id);
        deleted = before !== db.apiKeys.length;
    });
    return { deleted, id };
}

export async function authorizeDolaApiKey(rawKey: string, clientIp?: string) {
    const digest = hash(rawKey);
    let result: DolaApiKey | null = null;
    await mutate((db) => {
        const key = db.apiKeys.find((item) => secureEqual(item.hash, digest));
        if (!key || key.status !== "active" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) return;
        if (key.allowedIps.length && (!clientIp || !key.allowedIps.includes(clientIp))) return;
        key.requestCount += 1;
        key.lastUsedAt = new Date().toISOString();
        result = publicKey(key);
    });
    return result;
}

function publicKey(value: StoredKey): DolaApiKey {
    const { hash: _hash, keyCiphertext, ...rest } = value;
    let plainKey: string | undefined;
    if (keyCiphertext) {
        try {
            plainKey = decryptSecretValue(keyCiphertext);
        } catch {}
    }
    return {
        ...structuredClone(rest),
        ...(plainKey ? { key: plainKey } : {}),
    };
}
async function readDatabase(): Promise<Database> {
    const value = await readJsonDataFile<Partial<Database>>(FILE_NAME, EMPTY);
    const rotationLimit = value.gateway?.rotationLimit;
    return {
        gateway: {
            enabled: value.gateway?.enabled === true,
            autoWatermark: value.gateway?.autoWatermark === true,
            rotationLimit: Number.isSafeInteger(rotationLimit) && (rotationLimit ?? 0) >= 0 ? rotationLimit as number : 2,
            captureVerificationScreenshot: value.gateway?.captureVerificationScreenshot !== false,
            dispatchGroups: normalizeGroups(value.gateway?.dispatchGroups),
        },
        apiKeys: Array.isArray(value.apiKeys) ? structuredClone(value.apiKeys) : [],
    };
}
async function mutate(callback: (db: Database) => void) {
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        callback(db);
        await writeJsonDataFile(FILE_NAME, db);
    });
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function secureEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function validDate(value: unknown) { return typeof value === "string" && Boolean(value.trim()) && Number.isFinite(Date.parse(value)); }
function normalizeIps(value: unknown) { return Array.from(new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [])).slice(0, 100); }
/** 调度分组白名单：去空白去重，最多 50 个；null/非数组归一为空（表示全部分组参与调度）。 */
function normalizeGroups(value: unknown) { return Array.from(new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 60)).filter(Boolean) : [])).slice(0, 50); }
