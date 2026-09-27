import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceStore, matchApiKey, newApiKey, parseCookie } from "./store.mjs";

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
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local API keys require exact match", () => {
  const { key, digest } = newApiKey();
  assert.ok(matchApiKey(key, digest));
  assert.ok(!matchApiKey(`${key}x`, digest));
  assert.throws(() => parseCookie("sid=abc\r\nHost: evil"));
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
