import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readOrCreateRuntimeSecrets, waitForRuntime } from "./runtime-controller.mjs";

const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => {
        const text = value.toString("utf8");
        if (!text.startsWith("protected:")) throw new Error("Cannot decrypt");
        return text.slice("protected:".length);
    },
};

async function withSecretsDirectory(run) {
    const directory = await mkdtemp(path.join(tmpdir(), "dreamyo-runtime-secrets-test-"));
    try { await run(path.join(directory, "runtime-secrets.bin")); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test("new Runtime credentials are encrypted at rest and the session token rotates", async () => withSecretsDirectory(async (file) => {
    const first = await readOrCreateRuntimeSecrets(file, safeStorage);
    const second = await readOrCreateRuntimeSecrets(file, safeStorage);
    assert.equal(first.encryptionKey, second.encryptionKey);
    assert.equal(first.installToken, second.installToken);
    assert.notEqual(first.sessionToken, second.sessionToken);
    const stored = await readFile(file, "utf8");
    assert.ok(stored.startsWith("protected:"));
    assert.ok(!stored.includes(first.sessionToken));
}));

test("existing plaintext Runtime credentials migrate without changing the encryption key", async () => withSecretsDirectory(async (file) => {
    const legacy = file.replace(/\.bin$/, ".json");
    const old = { encryptionKey: "e".repeat(64), installToken: "i".repeat(43), adminPassword: "a".repeat(43), sessionToken: "not-persisted" };
    await writeFile(legacy, JSON.stringify(old));
    const current = await readOrCreateRuntimeSecrets(file, safeStorage);
    assert.equal(current.encryptionKey, old.encryptionKey);
    assert.deepEqual(await readdir(path.dirname(file)), ["runtime-secrets.bin"]);
    assert.equal(JSON.parse(safeStorage.decryptString(await readFile(file))).sessionToken, undefined);
}));

test("unreadable credentials fail closed instead of replacing the encryption key", async () => withSecretsDirectory(async (file) => {
    await writeFile(file, "corrupt");
    await assert.rejects(readOrCreateRuntimeSecrets(file, safeStorage), /Cannot decrypt/);
    assert.equal(await readFile(file, "utf8"), "corrupt");
    await assert.rejects(readOrCreateRuntimeSecrets(file, { isEncryptionAvailable: () => false }), /系统安全存储不可用/);
}));

test("failed migration keeps the legacy key for a later retry", async () => withSecretsDirectory(async (file) => {
    const legacy = file.replace(/\.bin$/, ".json");
    await writeFile(legacy, JSON.stringify({ encryptionKey: "e".repeat(64), installToken: "i".repeat(43), adminPassword: "a".repeat(43) }));
    await assert.rejects(readOrCreateRuntimeSecrets(file, { ...safeStorage, encryptString: () => { throw new Error("Keychain unavailable"); } }), /Keychain unavailable/);
    assert.equal((await readdir(path.dirname(file))).includes("runtime-secrets.json"), true);
    assert.equal((await readOrCreateRuntimeSecrets(file, safeStorage)).encryptionKey, "e".repeat(64));
}));

test("desktop readiness waits for Provider health after Web is ready", async () => {
    let providerReady = false;
    let providerRequested;
    const firstProviderRequest = new Promise((resolve) => { providerRequested = resolve; });
    const web = createServer((_request, response) => { response.writeHead(200).end("ok"); });
    const provider = createServer((_request, response) => {
        response.writeHead(providerReady ? 200 : 503).end();
        providerRequested();
    });
    try {
        await Promise.all([web, provider].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
        const webOrigin = `http://127.0.0.1:${web.address().port}`;
        const providerUrl = `http://127.0.0.1:${provider.address().port}/health`;
        let resolved = false;
        const ready = waitForRuntime(webOrigin, { exitCode: null, signalCode: null }, [{ name: "Dola", url: providerUrl, status: 200 }]).then(() => { resolved = true; });
        await firstProviderRequest;
        assert.equal(resolved, false);
        providerReady = true;
        await ready;
        assert.equal(resolved, true);
    } finally {
        await Promise.all([web, provider].map((server) => new Promise((resolve) => server.close(resolve))));
    }
});
