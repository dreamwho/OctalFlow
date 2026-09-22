import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWorkspaceBackup } from "./workspace-backup.mjs";

const SETTINGS = "auto-workspace-backup.bin";

export async function readAutoWorkspaceBackup({ userData, safeStorage }) {
    let encrypted;
    try { encrypted = await readFile(path.join(userData, SETTINGS)); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (!safeStorage?.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    const value = JSON.parse(safeStorage.decryptString(encrypted));
    if (!value || typeof value.destination !== "string" || typeof value.password !== "string" || !Number.isInteger(value.intervalDays) || value.intervalDays < 1) throw new Error("自动备份配置无效");
    return value;
}

export async function saveAutoWorkspaceBackup({ userData, safeStorage, destination, password, intervalDays }) {
    if (!safeStorage?.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    if (!destination || typeof password !== "string" || !password.trim() || !Number.isInteger(intervalDays) || intervalDays < 1) throw new Error("自动备份参数无效");
    if (!(await stat(destination)).isDirectory()) throw new Error("自动备份目录不存在");
    const relative = path.relative(await realpath(userData), await realpath(destination));
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`))) throw new Error("自动备份目录不能位于当前工作区内");
    const value = { destination, password, intervalDays, lastAt: null };
    await writeEncryptedSettings(userData, safeStorage, value);
    return publicAutoBackupStatus(value);
}

export async function disableAutoWorkspaceBackup({ userData }) {
    await rm(path.join(userData, SETTINGS), { force: true });
}

export async function runAutoWorkspaceBackupIfDue({ userData, safeStorage, now = new Date(), createBackup = createWorkspaceBackup }) {
    const value = await readAutoWorkspaceBackup({ userData, safeStorage });
    if (!value) return { enabled: false, ran: false };
    const last = value.lastAt ? Date.parse(value.lastAt) : NaN;
    if (Number.isFinite(last) && now.getTime() - last < value.intervalDays * 24 * 60 * 60 * 1000) return { ...publicAutoBackupStatus(value), ran: false };
    const folder = await createBackup({ userData, destination: value.destination, password: value.password, safeStorage });
    value.lastAt = now.toISOString();
    await writeEncryptedSettings(userData, safeStorage, value);
    return { ...publicAutoBackupStatus(value), ran: true, folder };
}

export function publicAutoBackupStatus(value) {
    return value ? { enabled: true, destination: value.destination, intervalDays: value.intervalDays, lastAt: value.lastAt || null } : { enabled: false };
}

async function writeEncryptedSettings(userData, safeStorage, value) {
    const temporary = path.join(userData, `${SETTINGS}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
        await rename(temporary, path.join(userData, SETTINGS));
    } finally { await rm(temporary, { force: true }); }
}
