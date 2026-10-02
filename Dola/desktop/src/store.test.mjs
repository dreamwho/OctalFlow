import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceStore, matchApiKey, newApiKey, parseCookie } from "./store.mjs";
import { accountProxyId } from "./proxy-runtime.mjs";

test("group proxy policies survive restart and apply to existing, new and imported accounts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-group-proxy-"));
  try {
    const store = new WorkspaceStore(root, (value) => value, (value) => value);
    await store.load();
    await store.addGroup("团队");
    await store.addGroup("另一组", "generic-node-b");
    const existing = await store.addAccount({ group: "团队" });
    const override = await store.addAccount({ group: "团队", proxyId: "direct" });
    assert.equal(accountProxyId(existing, store.state), "direct");
    await store.setGroupProxy("团队", "generic-node-a");
    const added = await store.addAccount({ group: "团队" });
    const [imported] = await store.addCredentialAccounts([{ email: "test@example.test", password: "fixture-password" }], { group: "团队", proxyId: "" });
    for (const account of [existing, added, imported]) assert.equal(accountProxyId(account, store.state), "generic-node-a");
    assert.equal(accountProxyId(override, store.state), "direct");
    await store.updateAccount(added.id, { group: "另一组" });
    assert.equal(accountProxyId(store.listAccounts().find((item) => item.id === added.id), store.state), "generic-node-b");
    await store.updateAccount(override.id, { proxyId: "" });
    const restored = new WorkspaceStore(root, (value) => value, (value) => value);
    await restored.load();
    assert.equal(restored.state.accountGroupProxies.团队, "generic-node-a");
    assert.equal(accountProxyId(restored.listAccounts().find((item) => item.id === override.id), restored.state), "generic-node-a");
    await assert.rejects(restored.setGroupProxy("不存在", "direct"), /不存在/);
    await restored.setGroupProxy("未分组", "direct");
    assert.equal(restored.state.accountGroupProxies.未分组, "direct");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cookie import, duplicate detection and restart persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-store-"));
  const encode = (value) => Buffer.from(value).toString("base64");
  const decode = (value) => Buffer.from(value, "base64").toString();
  try {
    const store = new WorkspaceStore(root, encode, decode);
    await store.load();
    const account = await store.addAccount({ name: "账号 A", cookie: "Cookie: foo=bar; sid=one" });
    assert.equal(store.listAccounts()[0].cookieCiphertext, undefined);
    assert.equal(store.cookie(account.id), "foo=bar; sid=one");
    await assert.rejects(store.addAccount({ name: "重复", cookie: "foo=bar; sid=one" }), /已导入/);
    await assert.rejects(store.addAccount({ name: "顺序不同", cookie: "sid=one; foo=bar" }), /已导入/);
    const restored = new WorkspaceStore(root, encode, decode);
    await restored.load();
    assert.equal(restored.cookie(account.id), "foo=bar; sid=one");
    await restored.updateAccount(account.id, { cookie: "foo=new" });
    assert.equal(restored.listAccounts()[0].credentialVersion, 2);
    await restored.updateAccount(account.id, { quota: [{ bucket: "video-credit", unit: "credit", remaining: 12 }] });
    assert.equal(restored.listAccounts()[0].quota[0].remaining, 12);
    const reopened = new WorkspaceStore(root, encode, decode);
    await reopened.load();
    assert.equal(reopened.listAccounts()[0].quota[0].remaining, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local API keys require exact match", () => {
  const { key, digest } = newApiKey();
  assert.ok(matchApiKey(key, digest));
  assert.ok(!matchApiKey(`${key}x`, digest));
  assert.throws(() => parseCookie("sid=abc\r\nHost: evil"));
});

test("new accounts retain their selected proxy and deletion persists without removing tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-account-delete-"));
  try {
    const store = new WorkspaceStore(root, (value) => value, (value) => value);
    await store.load();
    const account = await store.addAccount({ proxyId: "generic-node" });
    assert.equal(account.proxyId, "generic-node");
    store.state.tasks.push({ id: "task", accountId: account.id, status: "completed" });
    await store.save();
    const restored = new WorkspaceStore(root, (value) => value, (value) => value);
    await restored.load();
    assert.equal(restored.listAccounts()[0].proxyId, "generic-node");
    assert.equal(await restored.deleteAccount(account.id), true);
    await restored.load();
    assert.equal(restored.listAccounts().length, 0);
    assert.equal(restored.state.tasks[0].id, "task");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("account name defaults to DOLA sequence and groups must be created first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-groups-"));
  const encode = (value) => Buffer.from(value).toString("base64");
  const decode = (value) => Buffer.from(value, "base64").toString();
  try {
    const store = new WorkspaceStore(root, encode, decode);
    await store.load();
    assert.equal((await store.addAccount({})).name, "DOLA1");
    assert.equal((await store.addAccount({})).name, "DOLA2");
    await assert.rejects(store.addAccount({ group: "团队" }), /先建立/);
    await store.addGroup("团队");
    assert.equal((await store.addAccount({ group: "团队" })).group, "团队");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("credential import encrypts passwords, hides them from public accounts, and survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-credentials-"));
  const encode = (value) => Buffer.from(value).toString("base64");
  const decode = (value) => Buffer.from(value, "base64").toString();
  try {
    const store = new WorkspaceStore(root, encode, decode);
    await store.load();
    await store.addGroup("团队");
    const [account] = await store.addCredentialAccounts([{ email: "user@example.test", password: "sample-secret" }], { group: "团队", proxyId: "proxy-1" });
    assert.equal(account.email, "user@example.test");
    assert.equal(account.passwordCiphertext, undefined);
    assert.equal(account.proxyId, "proxy-1");
    assert.equal(store.password(account.id), "sample-secret");
    await assert.rejects(store.addCredentialAccounts([{ email: "USER@example.test", password: "another" }], { group: "团队", proxyId: "" }), /已存在/);
    const restored = new WorkspaceStore(root, encode, decode);
    await restored.load();
    assert.equal(restored.password(account.id), "sample-secret");
    assert.equal(restored.listAccounts()[0].passwordCiphertext, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accounts persist randomized fingerprints generated per account only when requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-fingerprints-"));
  const encode = (value) => Buffer.from(value).toString("base64");
  const decode = (value) => Buffer.from(value, "base64").toString();
  try {
    const store = new WorkspaceStore(root, encode, decode);
    await store.load();
    await store.addGroup("团队");
    const plain = await store.addAccount({});
    assert.equal(plain.fingerprint, undefined);
    const [first, second] = await store.addCredentialAccounts([
      { email: "one@example.test", password: "pass-one" },
      { email: "two@example.test", password: "pass-two" },
    ], { group: "团队", fingerprintParams: ["userAgent", "deviceMemory"] });
    for (const account of [first, second]) {
      assert.match(account.fingerprint.userAgent, /Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36$/);
      assert.ok([4, 8, 16].includes(account.fingerprint.deviceMemory));
      assert.equal(account.fingerprint.timezone, undefined);
      assert.equal(account.fingerprint.screen, undefined);
    }
    const restored = new WorkspaceStore(root, encode, decode);
    await restored.load();
    assert.deepEqual(restored.listAccounts().find((item) => item.id === first.id).fingerprint, first.fingerprint);
    assert.equal((await store.addAccount({ fingerprintParams: [] })).fingerprint, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
