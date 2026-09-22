import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { disableAutoWorkspaceBackup, readAutoWorkspaceBackup, runAutoWorkspaceBackupIfDue, saveAutoWorkspaceBackup } from "./auto-workspace-backup.mjs";

const deviceKey = randomBytes(32);
const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", deviceKey, iv); return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptString: (value) => { const iv = value.subarray(0, 12); const decipher = createDecipheriv("aes-256-gcm", deviceKey, iv); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8"); },
};

test("automatic workspace backup runs on next start only when the configured period is due", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreamyo-auto-backup-"));
    try {
        const userData = path.join(root, "user-data");
        const destination = path.join(root, "backups");
        await mkdir(userData);
        await mkdir(destination);
        await saveAutoWorkspaceBackup({ userData, safeStorage, destination, password: "test-password", intervalDays: 3 });
        const encrypted = await readFile(path.join(userData, "auto-workspace-backup.bin"));
        assert.equal(encrypted.includes(Buffer.from("test-password")), false);
        const calls = [];
        const createBackup = async (options) => { calls.push(options); return "/backup/first.dreamyo-workspace"; };
        const first = await runAutoWorkspaceBackupIfDue({ userData, safeStorage, now: new Date("2026-09-22T00:00:00Z"), createBackup });
        assert.equal(first.ran, true);
        assert.equal(first.lastAt, "2026-09-22T00:00:00.000Z");
        const early = await runAutoWorkspaceBackupIfDue({ userData, safeStorage, now: new Date("2026-09-24T00:00:00Z"), createBackup });
        assert.equal(early.ran, false);
        const due = await runAutoWorkspaceBackupIfDue({ userData, safeStorage, now: new Date("2026-09-25T00:00:00Z"), createBackup });
        assert.equal(due.ran, true);
        assert.equal(calls.length, 2);
        assert.equal((await readAutoWorkspaceBackup({ userData, safeStorage })).lastAt, "2026-09-25T00:00:00.000Z");
        await disableAutoWorkspaceBackup({ userData });
        assert.equal(await readAutoWorkspaceBackup({ userData, safeStorage }), null);
    } finally { await rm(root, { recursive: true, force: true }); }
});
