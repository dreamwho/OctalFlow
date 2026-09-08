import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

function relativePath(value) {
    if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..") || path.isAbsolute(value)) throw new Error("迁移包路径无效");
    return value;
}

async function regularPath(root, relative, allowMissing = false) {
    let current = root;
    for (const part of ["", ...relativePath(relative).split("/")]) {
        current = path.join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) throw new Error("迁移目录不能包含符号链接");
        } catch (error) {
            if (allowMissing && error.code === "ENOENT") return current;
            throw error;
        }
    }
    return current;
}

async function digest(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}

export async function verifyPrivateSnapshot(directory) {
    const root = path.resolve(directory);
    await regularPath(root, "manifest.json");
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    if (manifest.version !== 1 || typeof manifest.id !== "string" || !manifest.id || !Array.isArray(manifest.files)) throw new Error("不支持的私有迁移包格式");
    const listed = new Set();
    for (const entry of manifest.files) {
        const name = relativePath(entry.path);
        if (listed.has(name) || name === "manifest.json" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("迁移文件清单无效");
        listed.add(name);
        const file = await regularPath(root, name);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size !== entry.size || (await digest(file)) !== entry.sha256) throw new Error(`迁移文件校验失败：${name}`);
    }
    if (!listed.has("private.env") || !listed.has("data/auth.json")) throw new Error("迁移包缺少原加密密钥或账号数据");
    async function walk(relative = "") {
        for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) throw new Error("迁移目录不能包含符号链接");
            if (entry.isDirectory()) await walk(name);
            else if (!entry.isFile() || (name !== "manifest.json" && !listed.has(name))) throw new Error("迁移包存在未登记文件");
        }
    }
    await walk();
    return manifest;
}

// Only media and provider state enter runtime volumes. Source JSON stays in the private backup.
export async function restorePrivateFiles({ directory, manifest, dataDirectory, accountsDirectory, ownership = true }) {
    const copies = [];
    for (const entry of manifest.files) {
        let targetRoot, relative, uid;
        if (/^data\/(reference-assets|generation-assets|dreamina)\//.test(entry.path)) {
            targetRoot = dataDirectory;
            relative = entry.path.slice("data/".length);
            uid = 1000;
        } else if (entry.path.startsWith("geminiai-accounts/")) {
            targetRoot = accountsDirectory;
            relative = entry.path.slice("geminiai-accounts/".length);
            uid = 10001;
        } else continue;
        relativePath(relative);
        await regularPath(targetRoot, relative, true);
        const target = path.join(targetRoot, relative);
        try {
            const stat = await lstat(target);
            if (!stat.isFile() || stat.size !== entry.size || (await digest(target)) !== entry.sha256) throw new Error("目标已有不同的媒体或账号文件，停止迁移，未覆盖");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        copies.push({ source: path.join(directory, entry.path), target, targetRoot, uid });
    }
    // Validate every collision before copying any file.
    for (const { source, target, targetRoot, uid } of copies) {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        try {
            await copyFile(source, target, constants.COPYFILE_EXCL);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        await chmod(target, 0o600);
        if (ownership) {
            await chown(target, uid, uid);
            let parent = path.dirname(target);
            while (parent === targetRoot || parent.startsWith(`${targetRoot}${path.sep}`)) {
                await chown(parent, uid, uid);
                if (parent === targetRoot) break;
                parent = path.dirname(parent);
            }
        }
    }
    return { copiedFiles: copies.length };
}
