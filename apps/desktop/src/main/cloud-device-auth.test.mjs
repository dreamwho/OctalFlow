import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CloudDeviceHttpError, CloudDeviceNetworkError, createCloudDeviceAuth, isTemporaryCloudFailure, validateCloudOrigin } from "./cloud-device-auth.mjs";

test("cloud origin requires HTTPS outside local development", () => {
    assert.equal(validateCloudOrigin("https://dreamyo.example", true), "https://dreamyo.example");
    assert.throws(() => validateCloudOrigin("http://dreamyo.example", false), /HTTPS/);
    assert.throws(() => validateCloudOrigin("http://127.0.0.1:3333", true), /HTTPS/);
    assert.equal(validateCloudOrigin("http://127.0.0.1:3333", false), "http://127.0.0.1:3333");
});

test("device authorization stores only encrypted refresh credentials and rotates them on restart", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "dreamyo-device-auth-"));
    const calls = [];
    let exchanges = 0;
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
        decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
    };
    const fetchImpl = async (url, options) => {
        const action = new URL(url).pathname.split("/").at(-1);
        calls.push({ action, body: options.body && JSON.parse(options.body), authorization: options.headers.Authorization });
        if (action === "start") return Response.json({ data: { deviceCode: "d".repeat(43), userCode: "ABCDEF0123456789", verificationUrl: "https://dreamyo.example/desktop/authorize?code=ABCDEF0123456789", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (action === "exchange") return ++exchanges === 1 ? Response.json({ data: { status: "pending" } }, { status: 202 }) : Response.json({ data: { status: "authorized", accessToken: "a".repeat(43), refreshToken: "r".repeat(43), accessExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (action === "refresh") return Response.json({ data: { accessToken: "b".repeat(43), refreshToken: "s".repeat(43), accessExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (action === "me") return Response.json({ data: { user: { id: "cloud-user-000001", username: "cloud", status: "active" } } });
        if (action === "revoke") return Response.json({ data: { revoked: true } });
        throw new Error(`unexpected action ${action}`);
    };
    try {
        const first = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl, packaged: true });
        const started = await first.start("Dreamyo Mac");
        assert.equal(started.userCode, "ABCDEF0123456789");
        assert.equal("deviceCode" in started, false);
        assert.deepEqual(await first.finish(), { status: "pending" });
        assert.equal((await first.finish()).user.id, "cloud-user-000001");
        assert.equal(first.getAccessToken(), "a".repeat(43));
        assert.equal((await readFile(path.join(userData, "cloud-device-credentials.bin"), "utf8")).includes("r".repeat(43)), false);

        const restarted = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl, packaged: true });
        assert.equal((await restarted.current()).id, "cloud-user-000001");
        assert.equal(calls.find((call) => call.action === "refresh")?.body.refreshToken, "r".repeat(43));
        assert.equal(restarted.getAccessToken(), "b".repeat(43));
        const offline = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl: async () => { throw new TypeError("fetch failed"); }, packaged: true });
        assert.equal((await offline.cachedIdentity()).id, "cloud-user-000001");
        await assert.rejects(offline.current(), (error) => isTemporaryCloudFailure(error));
        await restarted.logout();
        assert.equal(calls.find((call) => call.action === "revoke")?.body.refreshToken, "s".repeat(43));
        assert.equal(await restarted.current(), null);
    } finally { await rm(userData, { recursive: true, force: true }); }
});

test("an expired or rejected device credential is not treated as offline access", () => {
    assert.equal(isTemporaryCloudFailure(new CloudDeviceHttpError("revoked", 401)), false);
    assert.equal(isTemporaryCloudFailure(new CloudDeviceHttpError("temporarily unavailable", 503)), true);
    assert.equal(isTemporaryCloudFailure(new CloudDeviceNetworkError(new TypeError("fetch failed"))), true);
    assert.equal(isTemporaryCloudFailure(new TypeError("local programming error")), false);
});

test("an upstream HTML 503 remains a temporary cloud failure", async () => {
    const auth = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData: os.tmpdir(), safeStorage: { isEncryptionAvailable: () => true }, fetchImpl: async () => new Response("unavailable", { status: 503, headers: { "content-type": "text/html" } }), packaged: true });
    await assert.rejects(auth.start("Dreamyo Mac"), (error) => isTemporaryCloudFailure(error) && error.status === 503);
});

test("commercial desktop backup requests use only owned cloud storage endpoints and keep the bearer token in Main", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "dreamyo-cloud-backup-"));
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
        decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
    };
    const calls = [];
    const fetchImpl = async (url, options) => {
        const pathname = new URL(url).pathname;
        calls.push({ pathname, method: options.method, authorization: options.headers.Authorization, body: options.body });
        if (pathname.endsWith("/start")) return Response.json({ data: { deviceCode: "d".repeat(43), userCode: "ABCDEF0123456789" } });
        if (pathname.endsWith("/exchange")) return Response.json({ data: { status: "authorized", accessToken: "a".repeat(43), refreshToken: "r".repeat(43), accessExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (pathname.endsWith("/me")) return Response.json({ data: { user: { id: "cloud-user-000001", status: "active" } } });
        if (pathname === "/api/cloud-storage/objects") return Response.json({ data: { referenceId: "ref-one", bytes: 3 } }, { status: 201 });
        if (pathname === "/api/cloud-storage/usage") return Response.json({ data: { limitBytes: 1024, usedBytes: 3, availableBytes: 1021 } });
        if (pathname === "/api/cloud-storage/backups" && options.method === "GET") return Response.json({ data: { items: [], total: 0, page: 1, pageSize: 20 } });
        if (pathname.endsWith("/11111111-1111-4111-8111-111111111111") && options.method === "GET") return new Response(new Uint8Array([1, 2, 3]), { headers: { "x-dreamyo-sha256": "a".repeat(64) } });
        if (pathname.endsWith("/11111111-1111-4111-8111-111111111111") && options.method === "DELETE") return Response.json({ data: { objectDeleted: true } });
        throw new Error(`unexpected path ${pathname}`);
    };
    try {
        const auth = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl, packaged: true });
        await auth.start("Dreamyo Mac");
        await auth.finish();
        const bytes = new Uint8Array([1, 2, 3]);
        assert.deepEqual(await auth.cloudStorage("upload", { projectId: "canvas-one", title: "我的画布", checksumSha256: "a".repeat(64), bytes }), { referenceId: "ref-one", bytes: 3 });
        assert.equal(calls.at(-1).pathname, "/api/cloud-storage/objects");
        assert.equal(calls.at(-1).authorization, `Bearer ${"a".repeat(43)}`);
        assert.deepEqual(calls.at(-1).body, bytes);
        assert.equal((await auth.cloudStorage("list", { page: 1 })).total, 0);
        assert.equal((await auth.cloudStorage("usage")).availableBytes, 1021);
        assert.deepEqual(await auth.cloudStorage("download", { referenceId: "11111111-1111-4111-8111-111111111111" }), { bytes, checksumSha256: "a".repeat(64) });
        assert.deepEqual(await auth.cloudStorage("delete", { referenceId: "11111111-1111-4111-8111-111111111111" }), { objectDeleted: true });
        const beforeInvalid = calls.length;
        await assert.rejects(auth.cloudStorage("download", { referenceId: "../../admin" }), /编号无效/);
        await assert.rejects(auth.cloudStorage("billing", {}), /不支持/);
        assert.equal(calls.length, beforeInvalid);
    } finally { await rm(userData, { recursive: true, force: true }); }
});

test("offline sign-out clears local credentials and revokes the device after reconnect", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "dreamyo-device-signout-"));
    const token = "r".repeat(43);
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
        decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
    };
    let online = true;
    const revoked = [];
    const fetchImpl = async (url, options) => {
        if (!online) throw new TypeError("fetch failed");
        const action = new URL(url).pathname.split("/").at(-1);
        if (action === "exchange") return Response.json({ data: { status: "authorized", accessToken: "a".repeat(43), refreshToken: token, accessExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (action === "start") return Response.json({ data: { deviceCode: "d".repeat(43), userCode: "ABCDEF0123456789", verificationUrl: "https://dreamyo.example", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (action === "me") return Response.json({ data: { user: { id: "cloud-user-000001", status: "active" } } });
        if (action === "revoke") { revoked.push(JSON.parse(options.body).refreshToken); return Response.json({ data: { revoked: true } }); }
        throw new Error(`unexpected action ${action}`);
    };
    try {
        const auth = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl, packaged: true });
        await auth.start("Dreamyo Mac");
        await auth.finish();
        online = false;
        await auth.logout();
        assert.equal(await auth.cachedIdentity(), null);
        await assert.rejects(readFile(path.join(userData, "cloud-device-credentials.bin")), { code: "ENOENT" });
        assert.equal((await readFile(path.join(userData, "cloud-device-revocations.bin"), "utf8")).includes(token), false);
        online = true;
        const restarted = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl, packaged: true });
        assert.equal(await restarted.current(), null);
        assert.deepEqual(revoked, [token]);
        await assert.rejects(readFile(path.join(userData, "cloud-device-revocations.bin")), { code: "ENOENT" });
    } finally { await rm(userData, { recursive: true, force: true }); }
});

test("a delayed identity response cannot restore credentials after sign-out", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "dreamyo-device-race-"));
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
        decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
    };
    let holdIdentity = false;
    let enteredIdentity;
    let releaseIdentity;
    const identityEntered = new Promise((resolve) => { enteredIdentity = resolve; });
    const identityRelease = new Promise((resolve) => { releaseIdentity = resolve; });
    const fetchImpl = async (url) => {
        const action = new URL(url).pathname.split("/").at(-1);
        if (action === "start") return Response.json({ data: { deviceCode: "d".repeat(43) } });
        if (action === "exchange") return Response.json({ data: { status: "authorized", accessToken: "a".repeat(43), refreshToken: "r".repeat(43), accessExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
        if (action === "me") {
            if (holdIdentity) { enteredIdentity(); await identityRelease; }
            return Response.json({ data: { user: { id: "cloud-user-000001", status: "active" } } });
        }
        if (action === "revoke") return Response.json({ data: { revoked: true } });
        throw new Error(`unexpected action ${action}`);
    };
    try {
        const auth = createCloudDeviceAuth({ cloudOrigin: "https://dreamyo.example", userData, safeStorage, fetchImpl, packaged: true });
        await auth.start("Dreamyo Mac");
        await auth.finish();
        holdIdentity = true;
        const pending = auth.current();
        await identityEntered;
        await auth.logout();
        releaseIdentity();
        await assert.rejects(pending, /已退出登录/);
        await assert.rejects(readFile(path.join(userData, "cloud-device-credentials.bin")), { code: "ENOENT" });
        assert.equal(await auth.current(), null);
    } finally { await rm(userData, { recursive: true, force: true }); }
});
