import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composeProfiles, docsComposeProfiles, validateComposeContract, validateComposeContracts, validateDocsComposeContract, validateDocsComposeContracts, validateMihomoBootstrapContracts } from "./compose-contract.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

describe("Docker Compose contracts", () => {
    it("validates every supported deployment topology with structured YAML parsing", () => {
        expect(validateComposeContracts({ repoRoot })).toEqual(
            composeProfiles.map((profile) => ({
                file: profile.file,
                services: profile.expectedServices,
            })),
        );
        expect(validateDocsComposeContracts({ repoRoot })).toEqual(docsComposeProfiles.map(({ file }) => ({ file, services: ["docs"] })));
    });

    it("rejects a Worker that can bypass the application database boundary", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("      OCTALAICANVAS_WORKER_API_ORIGIN: http://app:3000", "      OCTALAICANVAS_WORKER_API_ORIGIN: http://app:3000\n      DATABASE_URL: postgres://leaked");

        expect(() => validateComposeContract(source, profile)).toThrow("generation-worker 不应直接持有数据库连接串");
    });

    it("rejects mutable latest release images", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replaceAll("ghcr.io/dreamwho/octalaicanvas:v0.0.6", "ghcr.io/dreamwho/octalaicanvas:latest");

        expect(() => validateComposeContract(source, profile)).toThrow("app 必须使用当前发布版本的明确镜像");
    });

    it("rejects a public magic-proxy listener", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace('    expose:\n      - "9090"', '    ports:\n      - "17890:17890"\n    expose:\n      - "9090"');

        expect(() => validateComposeContract(source, profile)).toThrow("magic-proxy 不得发布 Controller 或代理端口");
    });

    it("requires an authenticated magic-proxy healthcheck", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("Authorization: Bearer $$OCTALAICANVAS_MAGIC_PROXY_SECRET", "Authorization: Bearer missing");

        expect(() => validateComposeContract(source, profile)).toThrow("magic-proxy 健康检查必须使用 Controller Bearer 密钥");
    });

    it("keeps database and provider secrets out of magic-proxy", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace(
            "      OCTALAICANVAS_MAGIC_PROXY_SECRET: ${OCTALAICANVAS_MAGIC_PROXY_SECRET:?请在 .env 中配置至少 32 位魔法代理控制密钥}",
            "      OCTALAICANVAS_MAGIC_PROXY_SECRET: ${OCTALAICANVAS_MAGIC_PROXY_SECRET:?请在 .env 中配置至少 32 位魔法代理控制密钥}\n      DATABASE_URL: leaked",
        );

        expect(() => validateComposeContract(source, profile)).toThrow("magic-proxy 只能接收 Controller 密钥和监听地址环境变量");
    });

    it("keeps static providers and listeners in secret-free bootstraps", () => {
        expect(validateMihomoBootstrapContracts({ repoRoot })).toEqual([
            { file: "docker/mihomo/bootstrap.yaml", listenHost: "0.0.0.0", providerPath: "/root/.config/mihomo/runtime/subscription.yaml", listenerPorts: [17890, 17891] },
            { file: "docker/mihomo/bootstrap-host.yaml", listenHost: "127.0.0.1", providerPath: "/root/.config/mihomo/runtime/subscription.yaml", listenerPorts: [17890, 17891] },
        ]);
    });

    it("requires a private uid-1000 runtime provider setup", () => {
        const scriptPath = path.join(repoRoot, "docker/mihomo/entrypoint.sh");
        const script = readFileSync(scriptPath, "utf8");
        expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
        expect(script).toContain("umask 077");
        expect(script).toContain('mkdir -p "$runtime_dir"');
        expect(script).toContain('chmod 700 "$runtime_dir"');
        expect(script).toContain('chmod 600 "$provider_file"');
        expect(script).toContain('chown 1000:1000 "$runtime_dir" "$provider_file"');
        expect(script).toContain("proxies: []");
        expect(script).toContain('exec /mihomo -secret "$OCTALAICANVAS_MAGIC_PROXY_SECRET" -ext-ctl "$OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST:9090"');
        expect(script).not.toMatch(/(?:printf|echo)[^\n]*\$secret/);
        expect(script).not.toMatch(/chmod\s+(?:0?777|a\+rw)/);
    });

    it("keeps host-network provider routes on loopback", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.baota.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_URL: http://127.0.0.1:17890", "OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_URL: http://magic-proxy:17890");

        expect(() => validateComposeContract(source, profile)).toThrow("app 的 GeminiAIStudio 代理地址不正确");
    });

    it("rejects a Worker that imports the application secret environment", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace('    command: ["node", "/app/web/scripts/generation-worker.mjs"]', '    command: ["node", "/app/web/scripts/generation-worker.mjs"]\n    env_file:\n      - .env');

        expect(() => validateComposeContract(source, profile)).toThrow("generation-worker 不得读取包含安装令牌和业务密钥的 .env");
    });

    it("rejects exposing the external maintenance token to the Worker", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("      OCTALAICANVAS_WORKER_API_ORIGIN: http://app:3000", "      OCTALAICANVAS_WORKER_API_ORIGIN: http://app:3000\n      OCTALAICANVAS_MAINTENANCE_TOKEN: leaked");

        expect(() => validateComposeContract(source, profile)).toThrow("generation-worker 不得获得外部维护令牌");
    });

    it("rejects Baota-only host networking in the public default topology", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("    image: ${OCTALAICANVAS_IMAGE", "    network_mode: host\n    image: ${OCTALAICANVAS_IMAGE");

        expect(() => validateComposeContract(source, profile)).toThrow("宝塔专用 host 网络不得泄漏到其他拓扑");
    });

    it("reports an invalid docs service shape as a contract failure", () => {
        const profile = docsComposeProfiles[0];

        expect(() => validateDocsComposeContract("services: invalid", profile)).toThrow("文档 Compose 必须且只能声明 docs 服务");
    });
});
