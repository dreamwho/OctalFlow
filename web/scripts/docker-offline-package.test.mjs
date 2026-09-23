import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots = [];

afterEach(() => {
    while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { force: true, recursive: true });
});

describe("offline Docker package scripts", () => {
    it("builds the default external-db package with fake Docker, checks archives, and archives prior dated output", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);

        expect(readFileSync(path.join(packageDir, "manifest.env"), "utf8")).toContain("DREAMYO_DATABASE_MODE=external");
        expect(readFileSync(path.join(packageDir, "manifest.env"), "utf8")).toContain("DREAMYO_DOCKER_PLATFORM=linux/amd64");
        expect(readdirSync(path.join(packageDir, "images")).sort()).toEqual(["app.tar", "geminiai.tar", "magic-proxy.tar"]);
        expect(readFileSync(path.join(packageDir, "SHA256SUMS"), "utf8")).toContain("images/app.tar");
        expect(readFileSync(path.join(fixture.root, "scripts", "build-docker-offline-package.sh"), "utf8")).not.toContain("rm -rf");

        writeFileSync(path.join(packageDir, "previous-package-marker.txt"), "preserved", "utf8");
        const rerun = run("bash", ["scripts/build-docker-offline-package.sh"], fixture.root, fixture.environment);

        expect(rerun.status).toBe(0);
        const archiveDirectory = readdirSync(fixture.root).find((name) => name.startsWith("本次修改需上传文件_20990101_归档_"));
        expect(archiveDirectory).toBeTruthy();
        expect(readFileSync(path.join(fixture.root, archiveDirectory, "previous-package-marker.txt"), "utf8")).toBe("preserved");
    });

    it("rejects a checksum-tampered archive before fake Docker loads it", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);

        appendFileSync(path.join(packageDir, "images", "app.tar"), "tampered");
        writeFileSync(fixture.dockerLog, "", "utf8");
        const result = run("bash", ["一键部署.sh"], packageDir, fixture.environment);

        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("load --input");
    });

    it("rejects an archive whose Linux architecture disagrees with its checked manifest before fake Docker loads it", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);

        replaceArchiveArchitecture(path.join(packageDir, "images", "app.tar"), "arm64");
        refreshChecksum(packageDir, "images/app.tar");
        writeFileSync(fixture.dockerLog, "", "utf8");
        const result = run("bash", ["一键部署.sh"], packageDir, fixture.environment);

        expect(result.status).not.toBe(0);
        expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("load --input");
    });

    it("keeps a punctuated external DATABASE_URL private and byte-stable across simulated deployments", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);
        const databaseUrl = "postgresql://offline_user:p%40ss$with!punctuation@127.0.0.1:5432/app?application_name=offline&sslmode=disable";
        const firstEnvironment = { ...fixture.environment, DREAMYO_DATABASE_URL: databaseUrl };

        writeFileSync(fixture.dockerLog, "", "utf8");
        const first = run("bash", ["一键部署.sh"], packageDir, firstEnvironment);
        expect(first.status).toBe(0);
        expect(`${first.stdout}${first.stderr}`).not.toContain(databaseUrl);

        const firstEnv = readFileSync(path.join(packageDir, ".env"), "utf8");
        expect(firstEnv).toContain(`DATABASE_URL='${databaseUrl}'`);
        expect(firstEnv).toContain("PORT='8866'");
        expect(readFileSync(fixture.dockerLog, "utf8")).toContain("up -d --pull never");
        expect(readFileSync(fixture.dockerLog, "utf8")).not.toMatch(/^pull /m);

        const second = run("bash", ["一键部署.sh"], packageDir, fixture.environment);
        expect(second.status).toBe(0);
        expect(readFileSync(path.join(packageDir, ".env"), "utf8")).toBe(firstEnv);
    });

    it("persists an explicit external port override instead of retaining a legacy .env PORT", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);
        const databaseUrl = "postgresql://offline_user:password@127.0.0.1:5432/app";
        writeFileSync(path.join(packageDir, ".env"), "PORT=3000\n", "utf8");

        const first = run("bash", ["一键部署.sh"], packageDir, { ...fixture.environment, DREAMYO_DATABASE_URL: databaseUrl, DREAMYO_PORT: "8866" });
        expect(first.status, first.stderr || first.stdout).toBe(0);
        expect(`${first.stdout}${first.stderr}`).toContain("http://服务器IP:8866/install");

        const firstEnv = readFileSync(path.join(packageDir, ".env"), "utf8");
        expect(firstEnv).toContain("PORT='8866'");
        expect(firstEnv).toContain("DREAMYO_INTERNAL_ORIGIN='http://127.0.0.1:8866'");
        expect(firstEnv).toContain("DREAMYO_TRUSTED_PROXY_HOPS='0'");

        const second = run("bash", ["一键部署.sh"], packageDir, fixture.environment);
        expect(second.status, second.stderr || second.stdout).toBe(0);
        expect(readFileSync(path.join(packageDir, ".env"), "utf8")).toBe(firstEnv);
    });

    it("keeps the external host-network listener, probes, and callbacks on the resolved port", () => {
        const embedded = readFileSync(path.join(repoRoot, "docker-compose.offline.yml"), "utf8");
        const external = readFileSync(path.join(repoRoot, "docker-compose.offline-external-db.yml"), "utf8");
        const externalCompose = parse(external);

        for (const source of [embedded, external]) {
            expect(source).toContain("/api/health/live");
            expect(source).toContain("/api/health/ready");
            expect(source).toContain("database?.healthy");
        }
        expect(externalCompose.services.postgres).toBeUndefined();
        expect(externalCompose.volumes["dreamyo-postgres"]).toBeUndefined();
        expect(externalCompose.services.app.network_mode).toBe("host");
        expect(externalCompose.services.app.environment.DREAMYO_CHATGPT_DATA_DIR).toBe("/app/web/.data/chatgpt-api");
        expect(externalCompose.services.app.environment.HOSTNAME).toBe("${DREAMYO_BIND_ADDRESS:-0.0.0.0}");
        expect(externalCompose.services.app.command).toBeUndefined();
        expect(externalCompose.services.app.environment.PORT).toBe("${PORT:-8866}");
        expect(externalCompose.services.app.environment.DREAMYO_INTERNAL_ORIGIN).toBe("http://127.0.0.1:${PORT:-8866}");
        expect(externalCompose.services["generation-worker"].environment.DREAMYO_WORKER_API_ORIGIN).toBe("http://127.0.0.1:${PORT:-8866}");
        expect(externalCompose.services.app.environment.DREAMYO_TRUSTED_PROXY_HOPS).toBe("${DREAMYO_TRUSTED_PROXY_HOPS:-0}");
        const healthcheck = externalCompose.services.app.healthcheck.test.join("\n");
        expect(healthcheck).toContain("http://127.0.0.1:${PORT:-8866}/api/health/live");
        expect(healthcheck).toContain("http://127.0.0.1:${PORT:-8866}/api/health/ready");
    });

    it("keeps a stable Compose volume namespace and Beijing timezone in every deployment variant", () => {
        const composeFiles = readdirSync(repoRoot).filter((name) => /^docker-compose(?:\..+)?\.yml$/.test(name));
        expect(composeFiles).toHaveLength(7);
        for (const file of composeFiles) {
            const config = parse(readFileSync(path.join(repoRoot, file), "utf8"));
            expect(config.name, file).toBe("${COMPOSE_PROJECT_NAME:-dreamyo}");
            expect(config.services["magic-proxy"].environment.TZ, file).toBe("${TZ:-Asia/Shanghai}");
        }
    });

    it("reattaches the old populated magic-proxy volume namespace and persists it before startup", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);
        const result = run("bash", ["一键部署.sh"], packageDir, {
            ...fixture.environment,
            FAKE_DOCKER_MAGIC_PROXY_PROJECT: "release_20260916",
            FAKE_DOCKER_VOLUME_HAS_NODES: "1",
            DREAMYO_DATABASE_URL: "postgresql://offline_user:password@127.0.0.1:5432/app",
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(readFileSync(path.join(packageDir, ".env"), "utf8")).toContain("COMPOSE_PROJECT_NAME='release_20260916'");
        const dockerLog = readFileSync(fixture.dockerLog, "utf8");
        expect(dockerLog).toContain("volume ls --quiet --filter label=com.docker.compose.volume=dreamyo-magic-proxy-runtime");
        expect(dockerLog).toContain("run --rm --pull never --network none -v release_20260916_dreamyo-magic-proxy-runtime:/proxy-runtime:ro");
        expect(dockerLog).toContain("up -d --pull never");
    });

    it("stages private settings in an app-readable temporary volume and removes it after sync failure", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);
        addPrivateSettingsSyncSnapshot(packageDir);
        const result = run("bash", ["一键部署.sh"], packageDir, {
            ...fixture.environment,
            FAKE_DOCKER_PRIVATE_SYNC_FAIL: "1",
            DREAMYO_DATABASE_URL: "postgresql://offline_user:password@127.0.0.1:5432/app",
        });

        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`, result.stderr).toContain("账号与代理设置同步失败");
        const dockerLog = readFileSync(fixture.dockerLog, "utf8");
        expect(dockerLog).toContain("--entrypoint node dreamyo-app:offline -e process.stdout.write");
        expect(dockerLog).toContain("--user 0 -v ");
        expect(dockerLog).toContain("/private-settings-source:ro");
        expect(dockerLog).toContain("/private-settings-target");
        expect(dockerLog).toContain("run --rm --no-deps --user 1000:1000");
        expect(dockerLog).toContain(":/private-settings-sync:ro");
        expect(dockerLog).toMatch(/volume create dreamyo-private-settings-sync-[^\n]+/);
        expect(dockerLog).toMatch(/volume rm dreamyo-private-settings-sync-[^\n]+/);
    });

    it("stops GeminiAIStudio and mounts its account volume for the private authorization sync", () => {
        const script = readFileSync(path.join(repoRoot, "scripts/deploy-docker-offline.sh"), "utf8");
        expect(script).toContain('stop app generation-worker chatgpt-api geminiai');
        expect(script).toContain('volumes["dreamyo-geminiai-accounts"].name');
        expect(script).toContain('-v "$gemini_accounts_volume:/geminiai-accounts"');
        expect(script).toContain('DREAMYO_GEMINIAI_ACCOUNTS_DIR=/geminiai-accounts');
        expect(script).toContain('--gemini-snapshot /private-settings-sync');
    });

    it("parses the app UID:GID passed as one Docker node-eval argument", () => {
        const deployScript = readFileSync(path.join(repoRoot, "scripts/deploy-docker-offline.sh"), "utf8");
        const parserStart = deployScript.indexOf('const [uidGid = "", ...unexpectedArgs] = process.argv.slice(1);');
        const parserEnd = deployScript.indexOf("\nconst uid = Number(uidText)", parserStart);

        expect(parserStart).toBeGreaterThanOrEqual(0);
        expect(parserEnd).toBeGreaterThan(parserStart);

        const parser = deployScript.slice(parserStart, parserEnd);
        const result = run(process.execPath, ["-e", `${parser}\nprocess.stdout.write(uidText+":"+gidText);`, "1000:1000"], repoRoot);

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stdout).toBe("1000:1000");
        expect(run(process.execPath, ["-e", parser, "1000:1000:extra"], repoRoot).status).not.toBe(0);
    });

    it("prints Compose diagnostics when external host-network startup fails", () => {
        const fixture = createFixture();
        const packageDir = buildPackage(fixture);
        const result = run("bash", ["一键部署.sh"], packageDir, {
            ...fixture.environment,
            FAKE_DOCKER_COMPOSE_UP_FAIL: "1",
            DREAMYO_DATABASE_URL: "postgresql://offline_user:password@127.0.0.1:5432/app",
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("Compose 启动失败");
        const dockerLog = readFileSync(fixture.dockerLog, "utf8");
        expect(dockerLog).toContain("up -d --pull never");
        expect(dockerLog).toContain(" ps");
        expect(dockerLog).toContain("logs --tail=120 magic-proxy app generation-worker geminiai");
    });
});

function createFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "dreamyo-offline-package-"));
    const fakeBin = path.join(root, "fake-bin");
    const dockerLog = path.join(root, "fake-docker.log");
    temporaryRoots.push(root);

    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "docker", "mihomo"), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    for (const file of ["build-docker-offline-package.sh", "deploy-docker-offline.sh"]) cpSync(path.join(repoRoot, "scripts", file), path.join(root, "scripts", file));
    for (const file of ["docker-compose.offline.yml", "docker-compose.offline-external-db.yml", ".env.example", "VERSION"]) cpSync(path.join(repoRoot, file), path.join(root, file));
    for (const file of ["bootstrap.yaml", "bootstrap-host.yaml", "entrypoint.sh"]) cpSync(path.join(repoRoot, "docker", "mihomo", file), path.join(root, "docker", "mihomo", file));
    writeFakeDocker(fakeBin);
    writeFakeUname(fakeBin);

    return {
        root,
        dockerLog,
        environment: {
            ...process.env,
            FAKE_DOCKER_LOG: dockerLog,
            DREAMYO_PACKAGE_DATE: "20990101",
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        },
    };
}

function buildPackage(fixture) {
    const result = run("bash", ["scripts/build-docker-offline-package.sh"], fixture.root, fixture.environment);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return path.join(fixture.root, "本次修改需上传文件_20990101");
}

function run(command, args, cwd, environment) {
    return spawnSync(command, args, { cwd, encoding: "utf8", env: environment });
}

function writeFakeDocker(fakeBin) {
    const script = `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
    case "$1" in
        info|pull|load) exit 0 ;;
    volume)
        case "$2" in
            ls)
                if [[ -n "\${FAKE_DOCKER_MAGIC_PROXY_PROJECT:-}" ]]; then printf '%s_dreamyo-magic-proxy-runtime\\n' "$FAKE_DOCKER_MAGIC_PROXY_PROJECT"; fi
                exit 0
                ;;
            inspect) printf '%s\\n' "\${FAKE_DOCKER_MAGIC_PROXY_PROJECT:-}"; exit 0 ;;
            create) printf '%s\\n' "$3"; exit 0 ;;
            rm) exit 0 ;;
        esac
        ;;
    run)
        if [[ "$*" == *"--user 0"* && "$*" == *"/private-settings-source:ro"* ]]; then exit 0; fi
        if [[ "$*" == *"process.stdout.write"* ]]; then printf '1000:1000'; exit 0; fi
        if [[ "$*" == *"dreamyo-geminiai-accounts"* ]]; then printf 'dreamyo_dreamyo-geminiai-accounts\\n'; exit 0; fi
        [[ "\${FAKE_DOCKER_VOLUME_HAS_NODES:-0}" == "1" ]] && exit 0
        exit 1
        ;;
    rm) exit 0 ;;
    buildx)
        [[ "$2" == version || "$2" == build ]] && exit 0
        ;;
    image) exit 0 ;;
    compose)
        if [[ "\${FAKE_DOCKER_PRIVATE_SYNC_FAIL:-0}" == "1" && " $* " == *"sync_private_settings.py"* ]]; then
            printf 'simulated private sync failure\\n' >&2
            exit 42
        fi
        if [[ "\${FAKE_DOCKER_COMPOSE_UP_FAIL:-0}" == "1" && " $* " == *" up -d --pull never "* ]]; then
            printf 'simulated compose up failure\\n' >&2
            exit 42
        fi
        exit 0
        ;;
    inspect)
        if [[ "$*" == *"Config.Labels"* ]]; then printf '%s\\n' "\${FAKE_DOCKER_CONTAINER_PROJECT:-}"; exit 0; fi
        case "\${@: -1}" in
            dreamyo-generation-worker) printf 'running\\n' ;;
            *) printf 'healthy\\n' ;;
        esac
        exit 0
        ;;
    save)
        output=""
        shift
        while [[ "$#" -gt 0 ]]; do
            case "$1" in
                --output) output="$2"; shift 2 ;;
                *) shift ;;
            esac
        done
        [[ -n "$output" ]] || exit 1
        fixture_dir="$(mktemp -d)"
        printf '[{"Config":"config.json","RepoTags":["fake:offline"],"Layers":[]}]' > "$fixture_dir/manifest.json"
        printf '{"architecture":"%s","os":"linux"}' "\${FAKE_DOCKER_ARCH:-amd64}" > "$fixture_dir/config.json"
        tar -C "$fixture_dir" -cf "$output" manifest.json config.json
        rm -rf "$fixture_dir"
        exit 0
        ;;
esac
exit 1
`;
    writeExecutable(path.join(fakeBin, "docker"), script);
}

function writeFakeUname(fakeBin) {
    writeExecutable(
        path.join(fakeBin, "uname"),
        `#!/usr/bin/env bash
case "\${1:-}" in
    -s) printf 'Linux\\n' ;;
    -m) printf 'x86_64\\n' ;;
    *) exit 1 ;;
esac
`,
    );
}

function writeExecutable(file, source) {
    writeFileSync(file, source, { encoding: "utf8", mode: 0o755 });
}

function replaceArchiveArchitecture(archive, architecture) {
    const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "dreamyo-offline-archive-"));
    temporaryRoots.push(fixtureDirectory);
    writeFileSync(path.join(fixtureDirectory, "manifest.json"), '[{"Config":"config.json","RepoTags":["fake:offline"],"Layers":[]}]', "utf8");
    writeFileSync(path.join(fixtureDirectory, "config.json"), JSON.stringify({ architecture, os: "linux" }), "utf8");
    execFileSync("tar", ["-C", fixtureDirectory, "-cf", archive, "manifest.json", "config.json"]);
}

function refreshChecksum(packageDirectory, relativePath) {
    const checksumPath = path.join(packageDirectory, "SHA256SUMS");
    const checksum = createHash("sha256")
        .update(readFileSync(path.join(packageDirectory, relativePath)))
        .digest("hex");
    const lines = readFileSync(checksumPath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => (line.endsWith(`  ${relativePath}`) ? `${checksum}  ${relativePath}` : line));
    writeFileSync(checksumPath, `${lines.join("\n")}\n`, "utf8");
}

function addPrivateSettingsSyncSnapshot(packageDirectory) {
    const snapshotDirectory = path.join(packageDirectory, "private-settings-sync");
    const files = {
        "data/dola/accounts.json": JSON.stringify({ accounts: [] }),
        "data/chatgpt-api/runtime.json": JSON.stringify({ version: 1, accounts: [], proxyConfiguration: { data: {}, updatedAt: "2026-09-23T00:00:00Z" } }),
        "data/geminiai/accounts.json": JSON.stringify({ version: 1, ciphertext: "dreamyo-secret:v1:fixture" }),
        "private.env": `DREAMYO_ENCRYPTION_KEY=${"a".repeat(64)}\n`,
    };
    for (const [relativePath, contents] of Object.entries(files)) {
        const file = path.join(snapshotDirectory, relativePath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents, "utf8");
    }
    const entries = Object.entries(files).map(([relativePath]) => {
        const contents = readFileSync(path.join(snapshotDirectory, relativePath));
        return { path: relativePath, size: contents.length, sha256: createHash("sha256").update(contents).digest("hex") };
    });
    writeFileSync(path.join(snapshotDirectory, "manifest.json"), JSON.stringify({ version: 1, id: "private-settings-sync-test", files: entries }), "utf8");
    const manifestPath = path.join(packageDirectory, "manifest.env");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("DREAMYO_PRIVATE_SETTINGS_SYNC=0", "DREAMYO_PRIVATE_SETTINGS_SYNC=1"), "utf8");
    refreshChecksum(packageDirectory, "manifest.env");

    const checksumPath = path.join(packageDirectory, "SHA256SUMS");
    const lines = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
    for (const relativePath of [...Object.keys(files), "manifest.json"]) {
        const packageRelativePath = `private-settings-sync/${relativePath}`;
        const checksum = createHash("sha256").update(readFileSync(path.join(packageDirectory, packageRelativePath))).digest("hex");
        lines.push(`${checksum}  ${packageRelativePath}`);
    }
    writeFileSync(checksumPath, `${lines.join("\n")}\n`, "utf8");
}
