import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { importWebAccounts } from "./import-web-accounts.mjs";

const sourceKey = "a".repeat(64);
const targetKey = "b".repeat(64);

function encrypt(value, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    const body = Buffer.concat([cipher.update(value), cipher.final()]);
    return `dreamyo-secret:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

function decrypt(value, key) {
    const [iv, tag, body] = value.slice("dreamyo-secret:v1:".length).split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString();
}

test("imports and re-encrypts all four WEB channel account pools without duplicates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dreamyo-import-accounts-"));
    const webRoot = path.join(root, "web");
    const source = path.join(webRoot, ".data");
    const destination = path.join(root, "desktop-data");
    try {
        await mkdir(path.join(source, "geminiai/accounts/acc_demo"), { recursive: true });
        await mkdir(path.join(source, "dola"), { recursive: true });
        await mkdir(path.join(source, "chatgpt-api"), { recursive: true });
        await writeFile(path.join(webRoot, ".env.local"), `DREAMYO_ENCRYPTION_KEY=${sourceKey}\n`);
        await writeFile(path.join(source, "geminiai/accounts/registry.json"), JSON.stringify({ accounts: { acc_demo: { id: "acc_demo", name: "Google", email: null, created_at: "now" } }, active_account_id: "acc_demo" }));
        await writeFile(path.join(source, "geminiai/accounts/acc_demo/auth.json"), JSON.stringify({ cookies: [{ name: "SID", value: "private", domain: ".google.com" }], origins: [] }));
        await writeFile(path.join(source, "dola/accounts.json"), JSON.stringify({ accounts: [{ id: "dola-demo", email: "dola@example.com", cookieCiphertext: encrypt("sid=private; token=value", sourceKey), cookieFingerprint: "old", activeAttempts: 3 }] }));
        await writeFile(path.join(source, "gemini-tools.json"), JSON.stringify({ accounts: [{ id: "tools-demo", email: "tools@example.com", accessTokenCiphertext: encrypt("access-private", sourceKey), refreshTokenCiphertext: encrypt("refresh-private", sourceKey) }] }));
        const db = new DatabaseSync(path.join(source, "chatgpt-api/chatgpt2api.db"));
        db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, access_token TEXT NOT NULL, data TEXT NOT NULL)");
        db.prepare("INSERT INTO accounts (access_token, data) VALUES (?, ?)").run("old-index", encrypt(JSON.stringify({ access_token: "gpt-private", email: "gpt@example.com" }), sourceKey));
        db.close();

        assert.deepEqual(await importWebAccounts({ webRoot, dataRoot: destination, targetKey }), { geminiai: 1, dola: 1, geminiTools: 1, gptapi: 1 });
        assert.deepEqual(await importWebAccounts({ webRoot, dataRoot: destination, targetKey }), { geminiai: 0, dola: 0, geminiTools: 0, gptapi: 0 });
        const dola = JSON.parse(await readFile(path.join(destination, "dola/accounts.json"))).accounts[0];
        const tools = JSON.parse(await readFile(path.join(destination, "gemini-tools.json"))).accounts[0];
        assert.equal(decrypt(dola.cookieCiphertext, targetKey), "sid=private; token=value");
        assert.equal(dola.activeAttempts, 0);
        assert.equal(decrypt(tools.accessTokenCiphertext, targetKey), "access-private");
        const importedDb = new DatabaseSync(path.join(destination, "chatgpt-api/chatgpt2api.db"), { readOnly: true });
        const imported = importedDb.prepare("SELECT * FROM accounts").get();
        importedDb.close();
        assert.equal(JSON.parse(decrypt(imported.data, targetKey)).access_token, "gpt-private");
        assert.ok(imported.access_token.startsWith("dreamyo-account:v1:"));
        assert.ok((await readFile(path.join(destination, "geminiai/accounts/acc_demo/auth.json"))).includes("private"));
    } finally { await rm(root, { recursive: true, force: true }); }
});
