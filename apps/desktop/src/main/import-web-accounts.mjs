import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PREFIX = "dreamyo-secret:v1:";

export async function importWebAccounts({ webRoot, dataRoot, targetKey }) {
    const sourceData = path.join(webRoot, ".data");
    if (!(await stat(sourceData).catch(() => null))?.isDirectory()) throw new Error("所选目录不是包含 .data 的 WEB 工作区");
    const env = await readFile(path.join(webRoot, ".env.local"), "utf8");
    const match = env.match(/^\s*DREAMYO_ENCRYPTION_KEY\s*=\s*(.+?)\s*$/m);
    if (!match) throw new Error("WEB 工作区缺少 .env.local 中的加密密钥");
    const sourceKey = decodeKey(match[1].replace(/^['"]|['"]$/g, ""));
    const desktopKey = decodeKey(targetKey);
    const result = {
        geminiai: await importGeminiAi(path.join(sourceData, "geminiai", "accounts"), path.join(dataRoot, "geminiai", "accounts")),
        dola: await importJsonAccounts(path.join(sourceData, "dola", "accounts.json"), path.join(dataRoot, "dola", "accounts.json"), sourceKey, desktopKey, "dola"),
        geminiTools: await importJsonAccounts(path.join(sourceData, "gemini-tools.json"), path.join(dataRoot, "gemini-tools.json"), sourceKey, desktopKey, "geminiTools"),
        gptapi: await importGptApi(path.join(sourceData, "chatgpt-api", "chatgpt2api.db"), path.join(dataRoot, "chatgpt-api", "chatgpt2api.db"), sourceKey, desktopKey),
    };
    return result;
}

function decodeKey(raw) {
    const key = /^[a-f\d]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("WEB 或桌面版加密密钥格式无效");
    return key;
}

function decrypt(value, key, allowPlaintext = false) {
    if (allowPlaintext && typeof value === "string" && !value.startsWith(PREFIX)) return value;
    if (typeof value !== "string" || !value.startsWith(PREFIX)) throw new Error("账号凭据不是预期的加密格式");
    const [iv, tag, body] = value.slice(PREFIX.length).split(".").map((part) => Buffer.from(part, "base64url"));
    if (iv?.length !== 12 || tag?.length !== 16 || !body?.length) throw new Error("账号凭据密文无效");
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8");
}

function encrypt(value, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
}

async function importGeminiAi(source, destination) {
    const incoming = await readJson(path.join(source, "registry.json"), { accounts: {} });
    const current = await readJson(path.join(destination, "registry.json"), { accounts: {}, active_account_id: null });
    if (!incoming.accounts || typeof incoming.accounts !== "object") throw new Error("GeminiAIStudio 账号注册表无效");
    let added = 0;
    for (const [id, meta] of Object.entries(incoming.accounts)) {
        if (!/^acc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || current.accounts[id]) continue;
        const sourceFile = path.join(source, id, "auth.json");
        if (!(await stat(sourceFile).catch(() => null))?.isFile()) continue;
        await mkdir(path.join(destination, id), { recursive: true, mode: 0o700 });
        await cp(sourceFile, path.join(destination, id, "auth.json"));
        await writeJsonAtomic(path.join(destination, id, "meta.json"), meta);
        current.accounts[id] = meta;
        added++;
    }
    if (!current.active_account_id && incoming.active_account_id in current.accounts) current.active_account_id = incoming.active_account_id;
    if (added) await writeJsonAtomic(path.join(destination, "registry.json"), current);
    return added;
}

async function importJsonAccounts(source, destination, sourceKey, targetKey, kind) {
    const incoming = await readJson(source, { accounts: [] });
    const current = await readJson(destination, kind === "dola" ? { accounts: [] } : { accounts: [], oauthSessions: [], apiKeys: [], logs: [], gateway: { enabled: true, strategy: "round_robin", sessionStickiness: false, rotationLimit: 2 } });
    if (!Array.isArray(incoming.accounts) || !Array.isArray(current.accounts)) throw new Error(`${kind} 账号文件无效`);
    const ids = new Set(current.accounts.map((item) => item.id));
    const emails = new Set(current.accounts.map((item) => item.email?.toLowerCase()).filter(Boolean));
    const fingerprints = new Set(current.accounts.map((item) => item.cookieFingerprint).filter(Boolean));
    let added = 0;
    for (const account of incoming.accounts) {
        if (ids.has(account.id) || (kind === "geminiTools" && emails.has(account.email?.toLowerCase()))) continue;
        if (kind === "dola") {
            const cookie = decrypt(account.cookieCiphertext, sourceKey, true);
            const normalized = cookie.split(";").map((part) => part.trim()).filter(Boolean).sort((a, b) => a.split("=")[0].localeCompare(b.split("=")[0])).join(";");
            const fingerprint = createHmac("sha256", targetKey.toString("hex")).update(normalized).digest("hex");
            if (fingerprints.has(fingerprint)) continue;
            current.accounts.push({ ...account, cookieCiphertext: encrypt(cookie, targetKey), cookieFingerprint: fingerprint, activeAttempts: 0 });
            fingerprints.add(fingerprint);
        } else {
            current.accounts.push({ ...account, accessTokenCiphertext: encrypt(decrypt(account.accessTokenCiphertext, sourceKey, true), targetKey), refreshTokenCiphertext: account.refreshTokenCiphertext ? encrypt(decrypt(account.refreshTokenCiphertext, sourceKey, true), targetKey) : "" });
            emails.add(account.email?.toLowerCase());
        }
        ids.add(account.id);
        added++;
    }
    if (added) await writeJsonAtomic(destination, current);
    return added;
}

async function importGptApi(source, destination, sourceKey, targetKey) {
    if (!(await stat(source).catch(() => null))?.isFile()) return 0;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const from = new DatabaseSync(source, { readOnly: true });
    const to = new DatabaseSync(destination);
    let added = 0;
    try {
        to.exec("CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, access_token VARCHAR(2048) NOT NULL, data TEXT NOT NULL)");
        const exists = to.prepare("SELECT 1 FROM accounts WHERE access_token = ?");
        const insert = to.prepare("INSERT INTO accounts (access_token, data) VALUES (?, ?)");
        to.exec("BEGIN IMMEDIATE");
        for (const row of from.prepare("SELECT data FROM accounts").all()) {
            const json = decrypt(row.data, sourceKey);
            const account = JSON.parse(json);
            if (!account.access_token) continue;
            const index = `dreamyo-account:v1:${createHmac("sha256", targetKey).update(account.access_token).digest("hex")}`;
            if (exists.get(index)) continue;
            insert.run(index, encrypt(json, targetKey));
            added++;
        }
        to.exec("COMMIT");
    } catch (error) {
        try { to.exec("ROLLBACK"); } catch {}
        throw error;
    } finally { from.close(); to.close(); }
    return added;
}
