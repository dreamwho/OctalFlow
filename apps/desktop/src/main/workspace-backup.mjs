import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as tar from "tar";

const scrypt = promisify(scryptCallback);
const ARCHIVE = "workspace.tar.gz.enc";
const MANIFEST = "manifest.json";
const SECRET_FILE = "runtime-secrets.bin";
const DATA = "data";
const APPEARANCE = "appearance.json";

export async function createWorkspaceBackup({ userData, destination, password, safeStorage }) {
    requirePassword(password);
    if (isWithin(await realpath(userData), await realpath(destination))) throw new Error("备份目录不能位于当前工作区内");
    if (!safeStorage?.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    if (!(await stat(path.join(userData, DATA))).isDirectory()) throw new Error("本地工作区数据目录不存在");
    if (!(await stat(path.join(userData, DATA, "auth.json"))).isFile()) throw new Error("本地工作区缺少账号与设置数据");
    const secrets = JSON.parse(safeStorage.decryptString(await readFile(path.join(userData, SECRET_FILE))));
    validateSecrets(secrets);
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 32);
    const archiveIv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, archiveIv);
    const folder = path.join(destination, `Dreamyo-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.dreamyo-workspace`);
    const temporary = `${folder}.tmp`;
    await mkdir(temporary, { recursive: false, mode: 0o700 });
    try {
        const entries = [DATA];
        if (await exists(path.join(userData, APPEARANCE))) entries.push(APPEARANCE);
        await pipeline(tar.c({ cwd: userData, gzip: true, portable: true, filter: rejectSourceSymlinks }, entries), cipher, createWriteStream(path.join(temporary, ARCHIVE), { mode: 0o600 }));
        const secretIv = randomBytes(12);
        const secretCipher = createCipheriv("aes-256-gcm", key, secretIv);
        const secretBody = Buffer.concat([secretCipher.update(JSON.stringify(secrets), "utf8"), secretCipher.final()]);
        const manifest = {
            format: "dreamyo-workspace", version: 1, createdAt: new Date().toISOString(),
            salt: salt.toString("base64"), archive: {
                iv: archiveIv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
                sha256: await sha256(path.join(temporary, ARCHIVE)),
            },
            secrets: { iv: secretIv.toString("base64"), tag: secretCipher.getAuthTag().toString("base64"), ciphertext: secretBody.toString("base64") },
        };
        await writeFile(path.join(temporary, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
        await rename(temporary, folder);
        return folder;
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
}

export async function restoreWorkspaceBackup({ userData, source, password, safeStorage, onCommit = async () => {} }) {
    requirePassword(password);
    if (isWithin(await realpath(userData), await realpath(source))) throw new Error("不能从当前工作区内恢复备份");
    if (!safeStorage?.isEncryptionAvailable()) throw new Error("系统安全存储不可用");
    const manifest = JSON.parse(await readFile(path.join(source, MANIFEST), "utf8"));
    if (manifest?.format !== "dreamyo-workspace" || manifest.version !== 1 || !/^[a-f0-9]{64}$/i.test(manifest.archive?.sha256 || "")) throw new Error("工作区备份格式无效");
    const salt = decoded(manifest.salt, 16);
    const key = await scrypt(password, salt, 32);
    const archive = path.join(source, ARCHIVE);
    if (await sha256(archive) !== manifest.archive.sha256) throw new Error("工作区备份校验失败：文件已损坏");
    let secrets;
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, decoded(manifest.secrets?.iv, 12));
        decipher.setAuthTag(decoded(manifest.secrets?.tag, 16));
        secrets = JSON.parse(Buffer.concat([decipher.update(decoded(manifest.secrets?.ciphertext)), decipher.final()]).toString("utf8"));
        validateSecrets(secrets);
    } catch { throw new Error("备份密码错误或凭据已损坏"); }

    const stage = path.join(userData, `.workspace-restore-${randomUUID()}`);
    const rollback = path.join(userData, `.workspace-rollback-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
        try {
            const decipher = createDecipheriv("aes-256-gcm", key, decoded(manifest.archive.iv, 12));
            decipher.setAuthTag(decoded(manifest.archive.tag, 16));
            await pipeline(createReadStream(archive), decipher, tar.x({ cwd: stage, gzip: true, strict: true, filter: validateArchiveEntry }));
        } catch { throw new Error("工作区备份解密或内容校验失败"); }
        if (!(await stat(path.join(stage, DATA))).isDirectory()) throw new Error("备份缺少工作区数据");
        if (!(await stat(path.join(stage, DATA, "auth.json"))).isFile()) throw new Error("备份缺少账号与设置数据");
        await assertRegularTree(path.join(stage, DATA));
        if (!(await exists(path.join(stage, APPEARANCE)))) await writeFile(path.join(stage, APPEARANCE), '{"theme":"dark"}', { mode: 0o600 });
        const appearance = JSON.parse(await readFile(path.join(stage, APPEARANCE), "utf8"));
        if (appearance.theme !== "dark" && appearance.theme !== "light") throw new Error("备份主题配置无效");
        await writeFile(path.join(stage, SECRET_FILE), safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
        await mkdir(rollback, { mode: 0o700 });
        const movedOld = [];
        const movedNew = [];
        try {
            for (const name of [DATA, SECRET_FILE, APPEARANCE]) {
                if (await exists(path.join(userData, name))) {
                    await rename(path.join(userData, name), path.join(rollback, name));
                    movedOld.push(name);
                }
                await rename(path.join(stage, name), path.join(userData, name));
                movedNew.push(name);
            }
            await onCommit();
        } catch (error) {
            for (const name of movedNew.reverse()) await rm(path.join(userData, name), { recursive: true, force: true });
            for (const name of movedOld.reverse()) await rename(path.join(rollback, name), path.join(userData, name));
            await rm(rollback, { recursive: true, force: true });
            throw error;
        }
        await rm(rollback, { recursive: true, force: true });
        return { theme: appearance.theme };
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

function rejectSourceSymlinks(_name, entry) {
    if (entry.isSymbolicLink?.()) throw new Error("工作区包含符号链接，无法安全备份");
    return true;
}

function validateArchiveEntry(name, entry) {
    const normalized = name.replace(/\/$/, "");
    if (!normalized || normalized.includes("\\") || normalized.startsWith("/") || normalized.split("/").includes("..") || !((normalized === DATA || normalized.startsWith(`${DATA}/`)) || normalized === APPEARANCE)) throw new Error("备份包含非法路径");
    if (entry.type !== "File" && entry.type !== "Directory") throw new Error("备份包含不支持的文件类型");
    return true;
}

async function assertRegularTree(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("备份包含符号链接");
        if (entry.isDirectory()) await assertRegularTree(path.join(directory, entry.name));
        else if (!entry.isFile()) throw new Error("备份包含不支持的文件类型");
    }
}

function validateSecrets(value) {
    if (!value || [value.encryptionKey, value.installToken, value.adminPassword].some((item) => typeof item !== "string" || item.length < 32)) throw new Error("工作区凭据无效");
}

function requirePassword(password) {
    if (typeof password !== "string" || !password.trim()) throw new Error("请设置备份密码");
}

function decoded(value, length) {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("备份格式无效");
    const buffer = Buffer.from(value, "base64");
    if (length && buffer.length !== length) throw new Error("备份格式无效");
    return buffer;
}

function isWithin(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function exists(file) { try { await access(file); return true; } catch { return false; } }

async function sha256(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}
