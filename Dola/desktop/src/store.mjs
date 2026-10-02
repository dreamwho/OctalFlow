import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprintOptions, randomFingerprint } from "./browser-fingerprint.mjs";

function accountFingerprint(fingerprintParams) {
  if (!Array.isArray(fingerprintParams)) return undefined;
  const fingerprint = randomFingerprint(fingerprintParams.filter((key) => fingerprintOptions.some((item) => item.key === key)));
  return Object.keys(fingerprint).length ? fingerprint : undefined;
}

export function parseCookie(input) {
  const value = String(input || "").trim().replace(/^Cookie\s*:\s*/i, "");
  if (!value || /[\r\n\u0000-\u001f\u007f]/.test(value)) throw new Error("Cookie 为空或含有非法字符");
  const pairs = value.split(";").map((item) => item.trim()).filter(Boolean);
  if (!pairs.length) throw new Error("Cookie 缺少键值");
  return pairs.map((item) => {
    const separator = item.indexOf("=");
    const key = item.slice(0, separator).trim();
    const content = item.slice(separator + 1).trim();
    if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !content) throw new Error("Cookie 键值格式无效");
    return `${key}=${content}`;
  }).join("; ");
}

export function publicAccount(account) {
  const { cookieCiphertext: _cookieCiphertext, passwordCiphertext: _passwordCiphertext, ...safe } = account;
  return safe;
}

export function newApiKey() {
  const key = `dola_${randomBytes(32).toString("base64url")}`;
  return { key, digest: createHash("sha256").update(key).digest("hex") };
}

export function matchApiKey(key, digest) {
  if (!key || !digest) return false;
  const actual = Buffer.from(createHash("sha256").update(key).digest("hex"), "hex");
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class WorkspaceStore {
  constructor(root, encrypt, decrypt) {
    this.root = root;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.state = { accounts: [], accountGroups: [], accountGroupProxies: {}, tasks: [], assets: [], proxies: { generic: [] }, settings: { theme: "dark", apiEnabled: false, apiPort: 19527, autoDownload: true, autoRemoveWatermark: true, downloadDir: "", imagexUploadProxyId: "" }, apiKeyDigest: "" };
  }

  async load() {
    await mkdir(this.root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(path.join(this.root, "workspace.json"), "utf8"));
      if (parsed && typeof parsed === "object") this.state = { ...this.state, ...parsed, proxies: { ...this.state.proxies, ...parsed.proxies }, settings: { ...this.state.settings, ...parsed.settings } };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.state;
  }

  async save() {
    await mkdir(this.root, { recursive: true });
    const target = path.join(this.root, "workspace.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  }

  listAccounts() { return this.state.accounts.map(publicAccount); }
  cookie(accountId) {
    const account = this.state.accounts.find((item) => item.id === accountId);
    return account?.cookieCiphertext ? this.decrypt(account.cookieCiphertext) : "";
  }
  password(accountId) {
    const account = this.state.accounts.find((item) => item.id === accountId);
    return account?.passwordCiphertext ? this.decrypt(account.passwordCiphertext) : "";
  }

  async addCredentialAccounts(items, { group, proxyId, fingerprintParams }) {
    if (!items.length) throw new Error("请先填写或上传账号密码");
    if (group !== "未分组" && !this.state.accountGroups.includes(group)) throw new Error("请先选择有效的账号分组");
    const existing = new Set(this.state.accounts.map((item) => String(item.email || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.name) ? item.name : "")).toLowerCase()).filter(Boolean));
    if (items.some((item) => existing.has(item.email.toLowerCase()))) throw new Error("导入内容包含已存在的邮箱");
    const now = new Date().toISOString();
    const accounts = items.map((item) => ({ id: randomUUID(), name: item.email, email: item.email, group, credentialVersion: 1, status: "待登录", proxyId, cookieCiphertext: "", cookieFingerprint: "", passwordCiphertext: this.encrypt(item.password), fingerprint: accountFingerprint(fingerprintParams), createdAt: now, updatedAt: now }));
    this.state.accounts.push(...accounts);
    try { await this.save(); } catch (error) { this.state.accounts.splice(-accounts.length); throw error; }
    return accounts.map(publicAccount);
  }

  async addAccount(input) {
    const cookie = input.cookie ? parseCookie(input.cookie) : "";
    if (cookie && this.state.accounts.some((item) => item.cookieFingerprint === this.fingerprint(cookie))) throw new Error("该 Cookie 已导入");
    const now = new Date().toISOString();
    const usedNames = new Set(this.state.accounts.map((item) => item.name));
    let sequence = 1;
    while (usedNames.has(`DOLA${sequence}`)) sequence += 1;
    const group = String(input.group || "未分组").trim().slice(0, 60);
    if (group !== "未分组" && !this.state.accountGroups.includes(group)) throw new Error("请先建立账号分组");
    const account = { id: randomUUID(), name: String(input.name || "").trim().slice(0, 120) || `DOLA${sequence}`, group, credentialVersion: 1, status: cookie ? "待验证" : "待登录", proxyId: String(input.proxyId || ""), cookieCiphertext: cookie ? this.encrypt(cookie) : "", cookieFingerprint: cookie ? this.fingerprint(cookie) : "", fingerprint: accountFingerprint(input.fingerprintParams), createdAt: now, updatedAt: now };
    this.state.accounts.push(account);
    await this.save();
    return publicAccount(account);
  }

  async updateAccount(id, patch) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) throw new Error("账号不存在");
    if (patch.name !== undefined) account.name = String(patch.name).trim().slice(0, 120) || account.name;
    if (patch.group !== undefined) {
      const group = String(patch.group).trim().slice(0, 60) || "未分组";
      if (group !== "未分组" && !this.state.accountGroups.includes(group)) throw new Error("请先建立账号分组");
      account.group = group;
    }
    if (patch.proxyId !== undefined) account.proxyId = String(patch.proxyId || "");
    if (patch.status !== undefined) account.status = String(patch.status);
    if (patch.quota !== undefined) {
      account.quota = Array.isArray(patch.quota) ? patch.quota.filter((item) => item && typeof item === "object").map((item) => ({ bucket: String(item.bucket || ""), unit: String(item.unit || "unknown"), remaining: Number.isFinite(item.remaining) ? item.remaining : null })) : [];
      account.quotaCheckedAt = new Date().toISOString();
    }
    if (patch.cookie !== undefined) {
      const cookie = parseCookie(patch.cookie);
      const fingerprint = this.fingerprint(cookie);
      if (this.state.accounts.some((item) => item.id !== id && item.cookieFingerprint === fingerprint)) throw new Error("该 Cookie 已属于其他账号");
      if (account.cookieFingerprint === fingerprint) return publicAccount(account);
      account.cookieCiphertext = this.encrypt(cookie);
      account.cookieFingerprint = fingerprint;
      account.credentialVersion += 1;
      account.status = patch.status === "ready" ? "ready" : "待验证";
      account.quota = [];
      account.quotaCheckedAt = "";
    }
    account.updatedAt = new Date().toISOString();
    await this.save();
    return publicAccount(account);
  }

  async deleteAccount(id) {
    const before = this.state.accounts.length;
    this.state.accounts = this.state.accounts.filter((item) => item.id !== id);
    if (before !== this.state.accounts.length) await this.save();
    return before !== this.state.accounts.length;
  }

  async addGroup(name, proxyId = "direct") {
    const value = String(name || "").trim().slice(0, 60);
    if (!value || value === "未分组") throw new Error("请输入有效的分组名称");
    if (this.state.accountGroups.includes(value)) throw new Error("分组已存在");
    this.state.accountGroups.push(value);
    this.state.accountGroupProxies = { ...this.state.accountGroupProxies, [value]: String(proxyId || "direct") };
    await this.save();
    return this.state.accountGroups;
  }

  async setGroupProxy(name, proxyId) {
    if (name !== "未分组" && !this.state.accountGroups.includes(name)) throw new Error("账号分组不存在");
    this.state.accountGroupProxies = { ...this.state.accountGroupProxies, [name]: String(proxyId || "direct") };
    await this.save();
    return this.state.accountGroupProxies;
  }

  fingerprint(cookie) {
    const normalized = parseCookie(cookie).split("; ").sort((left, right) => left.split("=", 1)[0].localeCompare(right.split("=", 1)[0])).join(";");
    return createHash("sha256").update(normalized).digest("hex");
  }
}
