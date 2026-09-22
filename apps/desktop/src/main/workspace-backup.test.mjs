import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceBackup, restoreWorkspaceBackup } from "./workspace-backup.mjs";

function storage(device) {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`${device}:${value}`),
        decryptString: (value) => {
            const text = value.toString();
            if (!text.startsWith(`${device}:`)) throw new Error("Wrong device");
            return text.slice(device.length + 1);
        },
    };
}

test("encrypted workspace backup restores media, configuration and rewraps secrets on another device", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreamyo-backup-"));
    try {
        const original = path.join(root, "original");
        const target = path.join(root, "target");
        const destination = path.join(root, "backups");
        await mkdir(path.join(original, "data", "media"), { recursive: true });
        await mkdir(path.join(target, "data"), { recursive: true });
        await mkdir(destination);
        const secrets = { encryptionKey: randomBytes(32).toString("hex"), installToken: randomBytes(32).toString("hex"), adminPassword: randomBytes(32).toString("hex") };
        await writeFile(path.join(original, "runtime-secrets.bin"), storage("mac").encryptString(JSON.stringify(secrets)));
        await writeFile(path.join(original, "appearance.json"), '{"theme":"light"}');
        await writeFile(path.join(original, "data", "auth.json"), '{"settings":{"systemChannels":[{"id":"dola"}]}}');
        await writeFile(path.join(original, "data", "media", "video.mp4"), randomBytes(12345));
        await writeFile(path.join(original, "data", "media", `${"中文长文件名".repeat(10)}.png`), "long-name");
        const unsafeDestination = path.join(root, "linked-inside-workspace");
        await symlink(path.join(original, "data"), unsafeDestination);
        await assert.rejects(createWorkspaceBackup({ userData: original, destination: unsafeDestination, password: "password", safeStorage: storage("mac") }), /备份目录不能位于当前工作区内/);
        await writeFile(path.join(target, "data", "auth.json"), '{"old":true}');
        await writeFile(path.join(target, "runtime-secrets.bin"), storage("windows").encryptString(JSON.stringify({ ...secrets, encryptionKey: "f".repeat(64) })));
        const backup = await createWorkspaceBackup({ userData: original, destination, password: "correct horse battery staple", safeStorage: storage("mac") });
        const archive = await readFile(path.join(backup, "workspace.tar.gz.enc"));
        assert.equal(archive.includes(Buffer.from("video.mp4")), false);
        assert.equal(archive.includes(Buffer.from("systemChannels")), false);
        assert.equal(archive.includes(Buffer.from(secrets.encryptionKey)), false);
        await assert.rejects(restoreWorkspaceBackup({ userData: target, source: backup, password: "wrong", safeStorage: storage("windows") }), /密码错误/);
        assert.equal((await readFile(path.join(target, "data", "auth.json"))).toString(), '{"old":true}');
        const result = await restoreWorkspaceBackup({ userData: target, source: backup, password: "correct horse battery staple", safeStorage: storage("windows") });
        assert.equal(result.theme, "light");
        assert.deepEqual(await readFile(path.join(target, "data", "media", "video.mp4")), await readFile(path.join(original, "data", "media", "video.mp4")));
        assert.equal((await readFile(path.join(target, "data", "media", `${"中文长文件名".repeat(10)}.png`))).toString(), "long-name");
        assert.deepEqual(JSON.parse(storage("windows").decryptString(await readFile(path.join(target, "runtime-secrets.bin")))), secrets);
        assert.equal((await readdir(target)).some((name) => name.startsWith(".workspace-")), false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed startup after restore rolls back data and machine secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dreamyo-backup-"));
    try {
        const current = path.join(root, "current");
        const source = path.join(root, "source");
        const backups = path.join(root, "backups");
        for (const folder of [current, source]) {
            await mkdir(path.join(folder, "data"), { recursive: true });
            const secrets = { encryptionKey: randomBytes(32).toString("hex"), installToken: randomBytes(32).toString("hex"), adminPassword: randomBytes(32).toString("hex") };
            await writeFile(path.join(folder, "runtime-secrets.bin"), storage("device").encryptString(JSON.stringify(secrets)));
        }
        await mkdir(backups);
        await writeFile(path.join(current, "data", "project.json"), "current");
        await writeFile(path.join(source, "data", "project.json"), "incoming");
        await writeFile(path.join(current, "data", "auth.json"), "{}");
        await writeFile(path.join(source, "data", "auth.json"), "{}");
        const beforeSecrets = await readFile(path.join(current, "runtime-secrets.bin"));
        const backup = await createWorkspaceBackup({ userData: source, destination: backups, password: "password", safeStorage: storage("device") });
        await assert.rejects(restoreWorkspaceBackup({ userData: current, source: backup, password: "password", safeStorage: storage("device"), onCommit: async () => { throw new Error("startup failed"); } }), /startup failed/);
        assert.equal((await readFile(path.join(current, "data", "project.json"))).toString(), "current");
        assert.deepEqual(await readFile(path.join(current, "runtime-secrets.bin")), beforeSecrets);
    } finally { await rm(root, { recursive: true, force: true }); }
});
