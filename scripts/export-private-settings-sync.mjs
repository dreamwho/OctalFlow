#!/usr/bin/env node

import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_FILES = new Set(["data/dola/accounts.json", "data/chatgpt-api/runtime.json", "data/geminiai/accounts.json", "private.env"]);

export async function verifySnapshot(directory) {
    const root = path.resolve(directory);
    const manifestPath = path.join(root, "manifest.json");
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("私有同步目录必须是普通目录");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("私有同步清单无效");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== 1 || !/^private-settings-sync-[0-9a-f-]{36}$/.test(manifest.id || "") || !Array.isArray(manifest.files)) throw new Error("私有同步清单格式无效");
    const seen = new Set();
    for (const entry of manifest.files) {
        if (!entry || Object.keys(entry).sort().join(",") !== "path,sha256,size" || !ALLOWED_FILES.has(entry.path) || seen.has(entry.path) || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("私有同步清单文件项无效");
        seen.add(entry.path);
        const filePath = path.join(root, ...entry.path.split("/"));
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("私有同步数据文件无效");
        const bytes = await readFile(filePath);
        if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("私有同步数据校验失败");
    }
    if (seen.size !== ALLOWED_FILES.size) throw new Error("私有同步清单缺少必要数据");
    const entries = await listFiles(root);
    if (entries.some((entry) => entry !== "manifest.json" && !seen.has(entry))) throw new Error("私有同步目录包含未声明文件");
    const privateEnv = await readFile(path.join(root, "private.env"), "utf8");
    const match = privateEnv.match(/^DREAMYO_ENCRYPTION_KEY=([A-Za-z0-9+/=]+)\n?$/);
    if (!match || !validKey(match[1])) throw new Error("私有同步源密钥格式无效");
    return manifest;
}

async function listFiles(root) {
    const files = [];
    async function visit(relative = "") {
        for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
            const next = path.posix.join(relative, entry.name);
            if (entry.isSymbolicLink()) throw new Error("私有同步目录不能包含符号链接");
            if (entry.isDirectory()) await visit(next);
            else if (entry.isFile()) files.push(next);
            else throw new Error("私有同步目录包含不支持的文件类型");
        }
    }
    await visit();
    return files;
}

async function main(args) {
    if (args[0] === "--verify") {
        const manifest = await verifySnapshot(args[1] || "");
        process.stdout.write(`私有设置快照校验通过：${manifest.files.length} 个文件\n`);
        return;
    }
    const options = parseArgs(args);
    if (!options.confirmPrivateData) throw new Error("请确认已授权将本机加密账号与代理配置写入私有部署包，并加入 --confirm-private-data");
    if (!options.output) throw new Error("用法：node --env-file=web/.env.local scripts/export-private-settings-sync.mjs --output <新目录> --confirm-private-data [--source <.data目录>]");
    const encryptionKey = process.env.DREAMYO_ENCRYPTION_KEY?.trim() || "";
    if (!validKey(encryptionKey)) throw new Error("缺少有效的 DREAMYO_ENCRYPTION_KEY");
    const source = path.resolve(options.source || path.join(ROOT, "web/.data"));
    const output = path.resolve(options.output);
    const sourceRealPath = await realpath(source);
    if (output === sourceRealPath || output.startsWith(`${sourceRealPath}${path.sep}`)) throw new Error("私有同步输出不能位于源数据目录内");
    try { await lstat(output); throw new Error("私有同步输出目录已存在"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(path.join(path.dirname(output), ".private-settings-sync-"));
    await chmod(stage, 0o700);
    try {
        const dolaSource = path.join(sourceRealPath, "dola/accounts.json");
        const dolaInfo = await lstat(dolaSource);
        if (!dolaInfo.isFile() || dolaInfo.isSymbolicLink()) throw new Error("缺少有效的本地 Dola 账号数据");
        const dola = JSON.parse(await readFile(dolaSource, "utf8"));
        if (!Array.isArray(dola.accounts) || dola.accounts.some((account) => !account?.id || !account?.cookieFingerprint || !["dreamyo-secret:v1:", "octalaicanvas-secret:v1:"].some((prefix) => account.cookieCiphertext?.startsWith(prefix)))) throw new Error("本地 Dola 账号数据缺失或包含未加密凭据，拒绝打包");
        const chatgptDb = path.join(sourceRealPath, "chatgpt-api/chatgpt2api.db");
        const chatgptInfo = await lstat(chatgptDb);
        if (!chatgptInfo.isFile() || chatgptInfo.isSymbolicLink()) throw new Error("缺少有效的本地 GPTAPI 数据库");
        const geminiSource = path.join(sourceRealPath, "geminiai/accounts");
        const geminiSourceInfo = await lstat(geminiSource);
        if (!geminiSourceInfo.isDirectory() || geminiSourceInfo.isSymbolicLink()) throw new Error("GeminiAIStudio 账号目录无效");
        const geminiRegistryPath = path.join(geminiSource, "registry.json");
        const geminiRegistryInfo = await lstat(geminiRegistryPath);
        if (!geminiRegistryInfo.isFile() || geminiRegistryInfo.isSymbolicLink()) throw new Error("缺少有效的本地 GeminiAIStudio 账号注册表");
        const geminiRegistry = JSON.parse(await readFile(geminiRegistryPath, "utf8"));
        if (!geminiRegistry.accounts || typeof geminiRegistry.accounts !== "object" || Array.isArray(geminiRegistry.accounts)) throw new Error("GeminiAIStudio 账号注册表格式无效");
        const geminiAccounts = {};
        for (const [id, meta] of Object.entries(geminiRegistry.accounts)) {
            if (!/^acc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || meta?.id !== id || typeof meta.name !== "string" || typeof meta.created_at !== "string" || (meta.email != null && typeof meta.email !== "string")) throw new Error("GeminiAIStudio 账号信息无效");
            const accountDirInfo = await lstat(path.join(geminiSource, id));
            if (!accountDirInfo.isDirectory() || accountDirInfo.isSymbolicLink()) throw new Error("GeminiAIStudio 账号目录无效");
            const authPath = path.join(geminiSource, id, "auth.json");
            const authInfo = await lstat(authPath);
            if (!authInfo.isFile() || authInfo.isSymbolicLink()) throw new Error("GeminiAIStudio 授权文件无效");
            const auth = JSON.parse(await readFile(authPath, "utf8"));
            if (!auth || !Array.isArray(auth.cookies)) throw new Error("GeminiAIStudio 授权数据格式无效");
            geminiAccounts[id] = { meta: { id, name: meta.name, email: meta.email ?? null, created_at: meta.created_at, last_used: meta.last_used ?? null }, auth };
        }

        const dolaDestination = path.join(stage, "data/dola/accounts.json");
        const runtimeDestination = path.join(stage, "data/chatgpt-api/runtime.json");
        const geminiDestination = path.join(stage, "data/geminiai/accounts.json");
        await mkdir(path.dirname(dolaDestination), { recursive: true, mode: 0o700 });
        await mkdir(path.dirname(runtimeDestination), { recursive: true, mode: 0o700 });
        await mkdir(path.dirname(geminiDestination), { recursive: true, mode: 0o700 });
        await writeFile(dolaDestination, JSON.stringify(dola), { mode: 0o600, flag: "wx" });
        await execFileAsync(process.env.PYTHON || "python3", [path.join(ROOT, "scripts/export-private-settings-sqlite.py"), "--database", chatgptDb, "--output", runtimeDestination]);
        await writeFile(geminiDestination, JSON.stringify({ version: 1, ciphertext: encryptGeminiAccounts({ accounts: geminiAccounts, active_account_id: geminiRegistry.active_account_id || null }, encryptionKey) }), { mode: 0o600, flag: "wx" });
        const privateEnv = path.join(stage, "private.env");
        await writeFile(privateEnv, `DREAMYO_ENCRYPTION_KEY=${encryptionKey}\n`, { mode: 0o600, flag: "wx" });
        const manifestFiles = [];
        for (const relative of [...ALLOWED_FILES].sort()) {
            const bytes = await readFile(path.join(stage, ...relative.split("/")));
            manifestFiles.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        }
        await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify({ version: 1, id: `private-settings-sync-${randomUUID()}`, files: manifestFiles }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        for (const entry of await listFiles(stage)) await chmod(path.join(stage, ...entry.split("/")), 0o600);
        for (const directory of [stage, path.join(stage, "data"), path.join(stage, "data/dola"), path.join(stage, "data/chatgpt-api"), path.join(stage, "data/geminiai")]) await chmod(directory, 0o700);
        await verifySnapshot(stage);
        await rename(stage, output);
        process.stdout.write(`私有账号与代理快照已创建：${output}\nDola 账号：${dola.accounts.length}；GeminiAIStudio 授权：${Object.keys(geminiAccounts).length}；GPTAPI 账号及通用代理配置已纳入加密数据快照。\n`);
    } catch (error) {
        await rm(stage, { force: true, recursive: true });
        throw error;
    }
}

function parseArgs(args) {
    const options = { confirmPrivateData: false, output: "", source: "" };
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === "--confirm-private-data") options.confirmPrivateData = true;
        else if (value === "--output" || value === "--source") {
            const next = args[index + 1];
            if (!next) throw new Error(`缺少 ${value} 参数`);
            options[value === "--output" ? "output" : "source"] = next;
            index += 1;
        } else throw new Error(`未知参数：${value}`);
    }
    return options;
}

function validKey(value) {
    if (/^[a-f0-9]{64}$/i.test(value)) return true;
    return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32;
}

function encryptGeminiAccounts(value, rawKey) {
    const key = /^[a-f0-9]{64}$/i.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `dreamyo-secret:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`私有设置快照未创建：${error?.message || "未知错误"}\n`);
        process.exitCode = 1;
    });
}
