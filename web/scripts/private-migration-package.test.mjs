import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { verifyPrivateSnapshot } from "./restore-private-files.mjs";

const execute = promisify(execFile);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const exportScript = path.join(repoRoot, "scripts", "export-private-migration.mjs");
const chromiumRuntimeMarkers = ["RunningChromeVersion", "SingletonLock", "SingletonCookie", "SingletonSocket"];
const temporaryRoots = [];

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("private FILE to PostgreSQL migration snapshot", () => {
    it("creates the fixed, hash-verified private package without reading or changing a real data directory", async () => {
        const fixture = await createFixture();
        const before = await sourceDigest(fixture.source);
        const result = await runExport(fixture);

        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain(fixture.encryptionKey);
        expect(result.stdout).not.toContain(fixture.oauthSecret);
        expect(result.stdout).toContain("即梦登录态未导出");
        expect(await sourceDigest(fixture.source)).toEqual(before);

        const manifest = JSON.parse(await readFile(path.join(fixture.output, "manifest.json"), "utf8"));
        expect(manifest).toMatchObject({
            version: 1,
            id: expect.stringMatching(/^private-migration-[0-9a-f-]{36}$/),
        });
        expect(Object.keys(manifest).sort()).toEqual(["files", "id", "version"]);
        for (const entry of manifest.files) {
            expect(Object.keys(entry).sort()).toEqual(["path", "sha256", "size"]);
        }
        expect(manifest.files.map((entry) => entry.path)).toEqual([
            "data/auth.json",
            "data/generation-assets/permanent/render.bin",
            "data/ignored.json",
            "data/reference-assets/permanent/reference.bin",
            "data/unknown-importer-record.json",
            "geminiai-accounts/account.json",
            "private.env",
        ]);
        expect(JSON.stringify(manifest)).not.toContain(fixture.encryptionKey);
        expect(JSON.stringify(manifest)).not.toContain(fixture.oauthSecret);
        expect(manifest.files).not.toContainEqual(expect.objectContaining({ path: "manifest.json" }));
        await expect(verifyPrivateSnapshot(fixture.output)).resolves.toEqual(manifest);

        for (const entry of manifest.files) await expectManifestHash(fixture.output, entry);
        await expect(readFile(path.join(fixture.output, "data", "unknown-importer-record.json"), "utf8")).resolves.toBe("{ deliberately left for the import agent");
        await expect(lstat(path.join(fixture.output, "data", "restore-backups"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(path.join(fixture.output, "data", "reference-assets", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readdir(path.join(fixture.output, "data", "dreamina"))).resolves.toEqual([]);
        for (const marker of chromiumRuntimeMarkers) {
            await expect(lstat(path.join(fixture.output, "geminiai-accounts", "Chrome", marker))).rejects.toMatchObject({ code: "ENOENT" });
        }

        const privateEnv = await readFile(path.join(fixture.output, "private.env"), "utf8");
        expect(privateEnv).toContain(`OCTALAICANVAS_ENCRYPTION_KEY='${fixture.encryptionKey}'`);
        expect(privateEnv).toContain(`GEMINI_TOOLS_OAUTH_CLIENT_SECRET='${fixture.oauthSecret}'`);
        expect(privateEnv).toContain(`GEMINI_TOOLS_OAUTH_CLIENT_ID='${fixture.oauthClientId}'`);
        expect(privateEnv).toContain(`GEMINI_TOOLS_OAUTH_REDIRECT_URI='${fixture.oauthRedirectUri}'`);
        for (const forbidden of ["PORT", "DATABASE_URL", "OCTALAICANVAS_DATABASE_PROVIDER", "OCTALAICANVAS_GEMINIAI_URL", "OCTALAICANVAS_DATA_DIR", "HTTP_PROXY", "NEXT_PUBLIC_SITE_URL"]) {
            expect(privateEnv).not.toContain(forbidden);
        }
        expect(privateEnv).not.toContain(fixture.publicSiteUrl);
        await expectDeployEnvRoundTrip(path.join(fixture.output, "private.env"), [
            ["OCTALAICANVAS_ENCRYPTION_KEY", fixture.encryptionKey],
            ["GEMINI_TOOLS_OAUTH_CLIENT_ID", fixture.oauthClientId],
            ["GEMINI_TOOLS_OAUTH_CLIENT_SECRET", fixture.oauthSecret],
            ["GEMINI_TOOLS_OAUTH_REDIRECT_URI", fixture.oauthRedirectUri],
        ]);

        await expectMode(fixture.output, 0o700);
        for (const directory of ["data", "data/reference-assets", "data/reference-assets/permanent", "data/generation-assets", "data/generation-assets/permanent", "data/dreamina", "geminiai-accounts"]) {
            await expectMode(path.join(fixture.output, directory), 0o700);
        }
        await expectMode(path.join(fixture.output, "private.env"), 0o600);
        await expectMode(path.join(fixture.output, "manifest.json"), 0o600);
        for (const entry of manifest.files.filter((entry) => entry.path !== "private.env")) await expectMode(path.join(fixture.output, entry.path), 0o600);
    });

    it("requires explicit offline confirmation and never creates its requested target without it", async () => {
        const fixture = await createFixture();
        const result = await runExport(fixture, { confirmOffline: false });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("--confirm-offline");
        await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses an already existing output directory, including an empty one", async () => {
        const fixture = await createFixture();
        await mkdir(fixture.output, { recursive: true });
        await writeFile(path.join(fixture.output, "keep.txt"), "keep", "utf8");

        const result = await runExport(fixture);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("输出目录已存在");
        await expect(readFile(path.join(fixture.output, "keep.txt"), "utf8")).resolves.toBe("keep");
    });

    it("rejects unknown root directories instead of silently omitting them", async () => {
        const fixture = await createFixture();
        await mkdir(path.join(fixture.source, "unmodeled-state"));

        const result = await runExport(fixture);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("未知目录");
        await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("requires auth.json because the paired restore contract requires it", async () => {
        const fixture = await createFixture();
        await rm(path.join(fixture.source, "auth.json"));

        const result = await runExport(fixture);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("缺少 auth.json");
        await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a source symlink before it can escape the snapshot root", async () => {
        const fixture = await createFixture();
        const outside = path.join(fixture.root, "outside.bin");
        await writeFile(outside, "must-not-copy", "utf8");
        await symlink(outside, path.join(fixture.source, "reference-assets", "escaped.bin"));

        const result = await runExport(fixture);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("符号链接");
        await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not guess a portable Dreamina credential and refuses unknown CLI state", async () => {
        const fixture = await createFixture();
        await writeFile(path.join(fixture.source, "dreamina", "task-history.json"), "not-auth-state", "utf8");

        const result = await runExport(fixture);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("即梦登录状态目录包含未知条目");
        await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("creates an empty Dreamina directory when the project data source has no Dreamina directory", async () => {
        const fixture = await createFixture();
        await rm(path.join(fixture.source, "dreamina"), { force: true, recursive: true });

        const result = await runExport(fixture);

        expect(result.code).toBe(0);
        await expect(readdir(path.join(fixture.output, "data", "dreamina"))).resolves.toEqual([]);
    });

    it("uses deploy-compatible single quotes for OAuth values containing dollar signs, apostrophes, and backslashes", async () => {
        const fixture = await createFixture();
        const specialSecret = "fixture-oauth-'apostrophe\\literal-$value";
        const base64Key = Buffer.alloc(32, 0x42).toString("base64");
        const result = await runExport(fixture, { environment: { GEMINI_TOOLS_OAUTH_CLIENT_SECRET: specialSecret, OCTALAICANVAS_ENCRYPTION_KEY: base64Key } });

        expect(result.code).toBe(0);
        const privateEnv = path.join(fixture.output, "private.env");
        await expectDeployEnvRoundTrip(privateEnv, [
            ["OCTALAICANVAS_ENCRYPTION_KEY", base64Key],
            ["GEMINI_TOOLS_OAUTH_CLIENT_SECRET", specialSecret],
        ]);
        expect(await readFile(privateEnv, "utf8")).toContain("\\'");
    });

    it("rejects invalid encryption keys and multiline OAuth values before creating a snapshot", async () => {
        const invalidKey = await createFixture();
        const invalidKeyResult = await runExport(invalidKey, { environment: { OCTALAICANVAS_ENCRYPTION_KEY: "not-a-valid-encryption-key" } });
        expect(invalidKeyResult.code).toBe(1);
        expect(invalidKeyResult.stderr).toContain("64 位十六进制或 32 字节 Base64");
        await expect(lstat(invalidKey.output)).rejects.toMatchObject({ code: "ENOENT" });

        const multilineOAuth = await createFixture();
        const multilineResult = await runExport(multilineOAuth, { environment: { GEMINI_TOOLS_OAUTH_CLIENT_SECRET: "line-one\nline-two" } });
        expect(multilineResult.code).toBe(1);
        expect(multilineResult.stderr).toContain("不能包含换行");
        await expect(lstat(multilineOAuth.output)).rejects.toMatchObject({ code: "ENOENT" });
    });
});

async function createFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "octal-private-migration-"));
    temporaryRoots.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "snapshot");
    const encryptionKey = "ab".repeat(32);
    const oauthClientId = "fixture-oauth-client";
    const oauthSecret = "fixture-oauth-secret-$literal";
    const oauthRedirectUri = "https://oauth.example.invalid/callback";
    const publicSiteUrl = "https://site.example.invalid";

    await mkdir(path.join(source, "reference-assets", "permanent"), { recursive: true });
    await mkdir(path.join(source, "reference-assets", "cache"), { recursive: true });
    await mkdir(path.join(source, "generation-assets", "permanent"), { recursive: true });
    await mkdir(path.join(source, "restore-backups"), { recursive: true });
    await mkdir(path.join(source, "cache"), { recursive: true });
    await mkdir(path.join(source, "geminiai", "accounts"), { recursive: true });
    await mkdir(path.join(source, "geminiai", "accounts", "Chrome"), { recursive: true });
    await mkdir(path.join(source, "dreamina", "dreamina"), { recursive: true });
    await mkdir(path.join(source, "dreamina", "logs"), { recursive: true });
    await mkdir(path.join(source, "dreamina", "locks"), { recursive: true });
    await writeFile(path.join(source, "auth.json"), '{"users":[]}', "utf8");
    await writeFile(path.join(source, "unknown-importer-record.json"), "{ deliberately left for the import agent", "utf8");
    await writeFile(path.join(source, "ignored.json"), "ignored", "utf8");
    await writeFile(path.join(source, ".DS_Store"), "ignored", "utf8");
    await writeFile(path.join(source, "reference-assets", "permanent", "reference.bin"), "reference-data", "utf8");
    await writeFile(path.join(source, "reference-assets", "cache", "cache.bin"), "ignored", "utf8");
    await writeFile(path.join(source, "generation-assets", "permanent", "render.bin"), "generation-data", "utf8");
    await writeFile(path.join(source, "restore-backups", "old.json"), "ignored", "utf8");
    await writeFile(path.join(source, "cache", "old.json"), "ignored", "utf8");
    await writeFile(path.join(source, "geminiai", "accounts", "account.json"), '{"cookie":"fixture"}', "utf8");
    const chromiumMarkerTarget = path.join(root, "chromium-runtime-marker-target");
    await writeFile(chromiumMarkerTarget, "not-account-data", "utf8");
    for (const marker of chromiumRuntimeMarkers) {
        await symlink(chromiumMarkerTarget, path.join(source, "geminiai", "accounts", "Chrome", marker));
    }
    await writeFile(path.join(source, "dreamina", "version.json"), '{"version":"fixture"}', "utf8");
    await writeFile(path.join(source, "dreamina", "tasks.db"), "runtime", "utf8");
    await writeFile(path.join(source, "dreamina", "tasks.db-wal"), "runtime", "utf8");
    await writeFile(path.join(source, "dreamina", "tasks.db-shm"), "runtime", "utf8");
    await writeFile(path.join(source, "dreamina", "dreamina", "SKILL.md"), "runtime", "utf8");
    await writeFile(path.join(source, "dreamina", "logs", "runtime.log"), "runtime", "utf8");
    await writeFile(path.join(source, "dreamina", "locks", "runtime.lock"), "runtime", "utf8");

    const environmentFile = path.join(root, "fixture.env");
    await writeFile(
        environmentFile,
        [
            `OCTALAICANVAS_ENCRYPTION_KEY='${encryptionKey}'`,
            `GEMINI_TOOLS_OAUTH_CLIENT_ID='${oauthClientId}'`,
            `GEMINI_TOOLS_OAUTH_CLIENT_SECRET='${oauthSecret}'`,
            `GEMINI_TOOLS_OAUTH_REDIRECT_URI='${oauthRedirectUri}'`,
            "PORT='3999'",
            "DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:5432/fixture'",
            "OCTALAICANVAS_DATABASE_PROVIDER='file'",
            "OCTALAICANVAS_GEMINIAI_URL='http://127.0.0.1:18080'",
            "OCTALAICANVAS_DATA_DIR='/private/fixture'",
            "HTTP_PROXY='http://127.0.0.1:7890'",
            `NEXT_PUBLIC_SITE_URL='${publicSiteUrl}'`,
            "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
    );
    return { root, source, output, environmentFile, encryptionKey, oauthClientId, oauthSecret, oauthRedirectUri, publicSiteUrl };
}

async function runExport(fixture, { confirmOffline = true, environment = {} } = {}) {
    const args = ["--env-file", fixture.environmentFile, exportScript, "--output", fixture.output, "--source", fixture.source];
    if (confirmOffline) args.push("--confirm-offline");
    try {
        const result = await execute(process.execPath, args, { cwd: repoRoot, env: { PATH: process.env.PATH || "", ...environment }, maxBuffer: 1024 * 1024 });
        return { code: 0, ...result };
    } catch (error) {
        return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" };
    }
}

async function sourceDigest(directory) {
    const files = [];
    await collect(directory, "");
    return files.sort((left, right) => left.path.localeCompare(right.path));

    async function collect(current, relative) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const next = path.join(current, entry.name);
            const nextRelative = path.join(relative, entry.name);
            if (entry.isDirectory()) await collect(next, nextRelative);
            else if (entry.isFile())
                files.push({
                    path: nextRelative,
                    sha256: createHash("sha256")
                        .update(await readFile(next))
                        .digest("hex"),
                });
        }
    }
}

async function expectManifestHash(root, entry) {
    const content = await readFile(path.join(root, entry.path));
    expect(entry.size).toBe(content.length);
    expect(entry.sha256).toBe(createHash("sha256").update(content).digest("hex"));
}

async function expectMode(target, mode) {
    expect((await lstat(target)).mode & 0o777).toBe(mode);
}

async function expectDeployEnvRoundTrip(privateEnv, pairs) {
    const deploySource = await readFile(path.join(repoRoot, "scripts", "deploy-docker-offline.sh"), "utf8");
    const decoder = extractDeployFunction(deploySource, "decode_env_value");
    const reader = extractDeployFunction(deploySource, "read_env_value");
    for (const [key, expected] of pairs) {
        const result = await execute("bash", ["-c", `${decoder}\n${reader}\nread_env_value "$1" "$2"`, "bash", key, privateEnv], { env: { PATH: process.env.PATH || "" } });
        expect(result.stdout).toBe(expected);
    }
}

function extractDeployFunction(source, name) {
    const start = source.indexOf(`${name}() {`);
    if (start === -1) throw new Error(`未找到部署脚本函数：${name}`);
    const remainder = source.slice(start);
    const nextFunction = remainder.search(/\n\n[A-Za-z_][A-Za-z0-9_]*\(\) \{/u);
    if (nextFunction === -1) throw new Error(`部署脚本函数边界无效：${name}`);
    return remainder.slice(0, nextFunction).trimEnd();
}
