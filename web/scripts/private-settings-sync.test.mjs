import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exporter = path.join(repoRoot, "scripts/export-private-settings-sync.mjs");
const helper = path.join(repoRoot, "scripts/export-private-settings-sqlite.py");
const temporaryRoots = [];
const key = "a".repeat(64);

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("private deployment settings snapshot", () => {
    it("exports encrypted Dola, GeminiAIStudio and GPTAPI state with a private hash manifest", async () => {
        const fixture = await createFixture();
        const result = await execFileAsync(process.execPath, ["--env-file", path.join(fixture.source, "source.env"), exporter, "--output", fixture.output, "--source", fixture.source, "--confirm-private-data"], { cwd: repoRoot });
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Dola 账号：1");
        expect(result.stdout).toContain("GeminiAIStudio 授权：1");
        expect(result.stdout).not.toContain(key);
        expect(result.stdout).not.toContain("account-token-plaintext");
        expect(result.stdout).not.toContain("proxy-password-plaintext");
        expect(result.stdout).not.toContain("gemini-cookie-plaintext");
        const manifest = JSON.parse(await readFile(path.join(fixture.output, "manifest.json"), "utf8"));
        expect(manifest.files.map((entry) => entry.path)).toEqual([
            "data/chatgpt-api/runtime.json",
            "data/dola/accounts.json",
            "data/geminiai/accounts.json",
            "private.env",
        ]);
        const privateData = JSON.stringify({
            dola: JSON.parse(await readFile(path.join(fixture.output, "data/dola/accounts.json"), "utf8")),
            runtime: JSON.parse(await readFile(path.join(fixture.output, "data/chatgpt-api/runtime.json"), "utf8")),
            gemini: JSON.parse(await readFile(path.join(fixture.output, "data/geminiai/accounts.json"), "utf8")),
        });
        expect(privateData).not.toContain("cookie-plaintext");
        expect(privateData).not.toContain("account-token-plaintext");
        expect(privateData).not.toContain("proxy-password-plaintext");
        expect(privateData).not.toContain("gemini-cookie-plaintext");
        for (const relative of manifest.files.map((entry) => entry.path)) {
            const data = await readFile(path.join(fixture.output, relative));
            expect(data.length).toBe(manifest.files.find((entry) => entry.path === relative).size);
        }
        expect((await execFileAsync(process.execPath, [exporter, "--verify", fixture.output], { cwd: repoRoot })).stdout).toContain("校验通过");
        await expectPrivateMode(fixture.output);
    });

    it("rejects plaintext Dola cookies and leaves no output directory", async () => {
        const fixture = await createFixture();
        await writeFile(path.join(fixture.source, "dola/accounts.json"), JSON.stringify({ accounts: [{ id: "account-1", cookieCiphertext: "cookie-plaintext", cookieFingerprint: "fp" }] }));
        const result = await execFileAsync(process.execPath, ["--env-file", path.join(fixture.source, "source.env"), exporter, "--output", fixture.output, "--source", fixture.source, "--confirm-private-data"], { cwd: repoRoot }).catch((error) => error);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("拒绝打包");
        await expect(rm(fixture.output, { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("requires explicit authorization before packaging private account data", async () => {
        const fixture = await createFixture();
        const result = await execFileAsync(process.execPath, ["--env-file", path.join(fixture.source, "source.env"), exporter, "--output", fixture.output, "--source", fixture.source], { cwd: repoRoot }).catch((error) => error);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("--confirm-private-data");
        await expect(rm(fixture.output, { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });
    });
});

async function createFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-settings-sync-test-"));
    temporaryRoots.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "snapshot");
    await mkdir(path.join(source, "dola"), { recursive: true });
    await mkdir(path.join(source, "chatgpt-api"), { recursive: true });
    await mkdir(path.join(source, "geminiai/accounts/acc_fixture"), { recursive: true });
    await writeFile(path.join(source, "source.env"), `DREAMYO_ENCRYPTION_KEY=${key}\n`);
    await writeFile(path.join(source, "dola/accounts.json"), JSON.stringify({ accounts: [{ id: "account-1", cookieCiphertext: "dreamyo-secret:v1:fixture-ciphertext", cookieFingerprint: "fingerprint-1" }] }));
    await writeFile(path.join(source, "geminiai/accounts/registry.json"), JSON.stringify({ accounts: { acc_fixture: { id: "acc_fixture", name: "本地 Google", email: "local@example.com", created_at: "now" } }, active_account_id: "acc_fixture" }));
    await writeFile(path.join(source, "geminiai/accounts/acc_fixture/auth.json"), JSON.stringify({ cookies: [{ name: "SID", value: "gemini-cookie-plaintext", domain: ".google.com" }], origins: [] }));
    const database = path.join(source, "chatgpt-api/chatgpt2api.db");
    await execFileAsync("python3", ["-c", [
        "import sqlite3,sys",
        "c=sqlite3.connect(sys.argv[1])",
        "c.executescript('CREATE TABLE accounts (id INTEGER PRIMARY KEY, access_token TEXT, data TEXT); CREATE TABLE proxy_configuration (id INTEGER PRIMARY KEY, data JSON, updated_at TEXT);')",
        "c.execute('INSERT INTO accounts VALUES (1, ?, ?)', ('source-index-hash', 'dreamyo-secret:v1:account-ciphertext'))",
        "c.execute('INSERT INTO proxy_configuration VALUES (1, ?, ?)', ('{\\\"_dreamyo_encrypted_v1\\\":\\\"dreamyo-secret:v1:proxy-ciphertext\\\"}', '2026-09-22T00:00:00Z'))",
        "c.commit()",
    ].join(";"), database]);
    return { root, source, output, database };
}

async function expectPrivateMode(directory) {
    const rootStat = await import("node:fs/promises").then(({ stat }) => stat(directory));
    expect(rootStat.mode & 0o777).toBe(0o700);
    const fileStat = await import("node:fs/promises").then(({ stat }) => stat(path.join(directory, "private.env")));
    expect(fileStat.mode & 0o777).toBe(0o600);
}
