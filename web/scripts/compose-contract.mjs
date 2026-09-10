import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

const magicProxyImage = "${OCTALAICANVAS_MAGIC_PROXY_IMAGE:-metacubex/mihomo:v1.19.30}";
const magicProxySecret = "${OCTALAICANVAS_MAGIC_PROXY_SECRET:?请在 .env 中配置至少 32 位魔法代理控制密钥}";
const magicProxyListenHosts = new Set(["0.0.0.0", "127.0.0.1"]);
const magicProxyEntrypoint = ["/usr/local/bin/octalaicanvas-mihomo-entrypoint.sh"];
const magicProxyEntrypointMount = "./docker/mihomo/entrypoint.sh:/usr/local/bin/octalaicanvas-mihomo-entrypoint.sh:ro";
const magicProxyRuntimeVolume = "octalaicanvas-magic-proxy-runtime";
const magicProxyRuntimeMount = `${magicProxyRuntimeVolume}:/root/.config/mihomo/runtime`;
const appMagicProxyRuntimeMount = `${magicProxyRuntimeVolume}:/app/web/.magic-proxy-runtime`;
const magicProxyProviderFile = "/app/web/.magic-proxy-runtime/subscription.yaml";
const mihomoProviderPath = "/root/.config/mihomo/runtime/subscription.yaml";

export const composeProfiles = [
    { file: "docker-compose.yml", embeddedPostgres: true, image: "${OCTALAICANVAS_IMAGE:-ghcr.io/dreamwho/octalaicanvas:v0.0.6}", workerOrigin: "http://app:3000", expectedServices: ["magic-proxy", "geminiai", "postgres", "app", "generation-worker"] },
    { file: "docker-compose.offline.yml", embeddedPostgres: true, image: "${OCTALAICANVAS_IMAGE:-octalaicanvas-app:offline}", workerOrigin: "http://app:3000", expectedServices: ["magic-proxy", "geminiai", "chatgpt-api", "postgres", "app", "generation-worker"] },
    {
        file: "docker-compose.offline-external-db.yml",
        embeddedPostgres: false,
        hostNetwork: true,
        image: "${OCTALAICANVAS_IMAGE:-octalaicanvas-app:offline}",
        appPort: "${PORT:-8866}",
        internalOrigin: "http://127.0.0.1:${PORT:-8866}",
        trustedProxyHops: "${OCTALAICANVAS_TRUSTED_PROXY_HOPS:-0}",
        workerOrigin: "http://127.0.0.1:${PORT:-8866}",
        expectedServices: ["magic-proxy", "geminiai", "chatgpt-api", "app", "generation-worker"],
    },
    { file: "docker-compose.local.yml", embeddedPostgres: true, image: "octalaicanvas:local", workerOrigin: "http://app:3000", expectedServices: ["magic-proxy", "geminiai", "postgres", "app", "generation-worker"] },
    {
        file: "docker-compose.baota.yml",
        embeddedPostgres: false,
        hostNetwork: true,
        image: "${OCTALAICANVAS_IMAGE:-ghcr.io/dreamwho/octalaicanvas:v0.0.6}",
        workerOrigin: "http://127.0.0.1:3000",
        expectedServices: ["magic-proxy", "geminiai", "app", "generation-worker"],
    },
    { file: "docker-compose.external-db.yml", embeddedPostgres: false, image: "${OCTALAICANVAS_IMAGE:-ghcr.io/dreamwho/octalaicanvas:v0.0.6}", workerOrigin: "http://app:3000", expectedServices: ["magic-proxy", "geminiai", "app", "generation-worker"] },
    { file: "docker-compose.lowmem.yml", embeddedPostgres: false, image: "${OCTALAICANVAS_IMAGE:-ghcr.io/dreamwho/octalaicanvas:v0.0.6}", workerOrigin: "http://app:3000", expectedServices: ["magic-proxy", "geminiai", "app", "generation-worker"] },
];

export const docsComposeProfiles = [
    { file: "docs/docker-compose.yml", image: "ghcr.io/dreamwho/octalaicanvas-docs:v0.0.6" },
    { file: "docs/docker-compose.local.yml", build: { context: "..", dockerfile: "docs/Dockerfile" } },
];

const maintenanceToken = "${OCTALAICANVAS_MAINTENANCE_TOKEN:?请在 .env 中配置至少 32 位维护令牌}";
const workerToken = "${OCTALAICANVAS_WORKER_TOKEN:?请在 .env 中配置独立的至少 32 位 Worker 令牌}";
const installToken = "${OCTALAICANVAS_INSTALL_TOKEN:?请在 .env 中配置至少 32 位一次性安装令牌}";
const geminiAiToken = "${OCTALAICANVAS_GEMINIAI_API_KEY:?请在 .env 中配置独立的 GeminiAI 内部密钥}";

export function validateComposeContracts({ repoRoot }) {
    return composeProfiles.map((profile) => {
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8");
        return validateComposeContract(source, profile);
    });
}

export function validateMihomoBootstrapContracts({ repoRoot }) {
    return ["docker/mihomo/bootstrap.yaml", "docker/mihomo/bootstrap-host.yaml"].map((file) => {
        let bootstrap;
        try {
            bootstrap = parse(readFileSync(path.join(repoRoot, file), "utf8"));
        } catch (error) {
            throw new Error(`${file}: YAML 解析失败：${error.message}`);
        }

        const hostNetwork = file.endsWith("-host.yaml");
        const listenHost = hostNetwork ? "127.0.0.1" : "0.0.0.0";
        const provider = bootstrap?.["proxy-providers"]?.["OctalFlow-Subscription"];
        const groups = bootstrap?.["proxy-groups"];
        const listeners = bootstrap?.listeners;
        const ensure = (condition, message) => {
            if (!condition) throw new Error(`${file} Mihomo bootstrap 契约失败：${message}`);
        };

        ensure(!containsKey(bootstrap, "secret"), "bootstrap 不得保存 Controller secret");
        ensure(provider?.type === "file", "必须声明 OctalFlow-Subscription file provider");
        ensure(provider?.path === mihomoProviderPath, "file provider 必须指向共享 runtime/subscription.yaml");
        ensure(
            JSON.stringify(groups) ===
                JSON.stringify([
                    { name: "OctalFlow-GeminiAIStudio", type: "select", use: ["OctalFlow-Subscription"], proxies: ["DIRECT"] },
                    { name: "OctalFlow-GeminiTools", type: "select", use: ["OctalFlow-Subscription"], proxies: ["DIRECT"] },
                    { name: "OctalFlow-ChatGPTAPI", type: "select", use: ["OctalFlow-Subscription"], proxies: ["DIRECT"] },
                ]),
            "proxy groups 必须保持静态并使用共享 file provider",
        );
        ensure(
            JSON.stringify(listeners) ===
                JSON.stringify([
                    { name: "OctalFlow-GeminiAIStudio", type: "mixed", listen: listenHost, port: 17890, proxy: "OctalFlow-GeminiAIStudio" },
                    { name: "OctalFlow-GeminiTools", type: "mixed", listen: listenHost, port: 17891, proxy: "OctalFlow-GeminiTools" },
                    { name: "OctalFlow-ChatGPTAPI", type: "mixed", listen: listenHost, port: 17892, proxy: "OctalFlow-ChatGPTAPI" },
                ]),
            "listeners 必须保持三项静态 mixed listener",
        );
        return { file, listenHost, providerPath: provider.path, listenerPorts: listeners.map(({ port }) => port) };
    });
}

export function validateDocsComposeContracts({ repoRoot }) {
    return docsComposeProfiles.map((profile) => {
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8");
        return validateDocsComposeContract(source, profile);
    });
}

export function validateDocsComposeContract(source, profile) {
    let compose;
    try {
        compose = parse(source);
    } catch (error) {
        throw new Error(`${profile.file}: YAML 解析失败：${error.message}`);
    }
    const services = compose?.services && typeof compose.services === "object" && !Array.isArray(compose.services) ? compose.services : {};
    const docs = services.docs;
    const violations = [];
    if (!docs || Object.keys(services).length !== 1) violations.push("文档 Compose 必须且只能声明 docs 服务");
    if (!docs?.ports?.includes("3001:3000")) violations.push("docs 必须把宿主机 3001 映射到容器 3000");
    if (docs?.restart !== "unless-stopped") violations.push("docs 必须使用 unless-stopped 重启策略");
    if (profile.image && docs?.image !== profile.image) violations.push("发布文档 Compose 镜像不正确");
    if (profile.build && (docs?.build?.context !== profile.build.context || docs?.build?.dockerfile !== profile.build.dockerfile)) violations.push("本地文档 Compose 构建上下文不正确");
    if (violations.length > 0) throw new Error(`${profile.file} Compose 契约失败：\n- ${violations.join("\n- ")}`);
    return { file: profile.file, services: ["docs"] };
}

export function validateComposeContract(source, profile) {
    let compose;
    try {
        compose = parse(source);
    } catch (error) {
        throw new Error(`${profile.file}: YAML 解析失败：${error.message}`);
    }

    const violations = [];
    const ensure = (condition, message) => {
        if (!condition) violations.push(message);
    };
    const services = compose?.services || {};
    const magicProxy = services["magic-proxy"] || {};
    const geminiAi = services.geminiai || {};
    const app = services.app || {};
    const worker = services["generation-worker"] || {};
    const magicProxyEnvironment = magicProxy.environment || {};
    const geminiAiEnvironment = geminiAi.environment || {};
    const appEnvironment = app.environment || {};
    const workerEnvironment = worker.environment || {};
    const proxyHost = profile.hostNetwork ? "127.0.0.1" : "magic-proxy";
    const proxyUrls = {
        controller: `http://${proxyHost}:9090`,
        geminiai: `http://${proxyHost}:17890`,
        geminiTools: `http://${proxyHost}:17891`,
    };
    const proxyListenHost = profile.hostNetwork ? "127.0.0.1" : "0.0.0.0";
    ensure(magicProxyListenHosts.has(proxyListenHost), "Mihomo 监听地址必须是受限的桥接或回环地址");

    ensure(Object.keys(services).filter((name) => name === "magic-proxy").length === 1, "必须且只能声明一个 magic-proxy 服务");
    ensure(Boolean(services.geminiai), "缺少 geminiai 服务");
    ensure(Boolean(services.app), "缺少 app 服务");
    ensure(Boolean(services["generation-worker"]), "缺少 generation-worker 服务");
    ensure(JSON.stringify(Object.keys(services)) === JSON.stringify(profile.expectedServices), "Compose 服务声明顺序不正确");
    ensure(magicProxy.image === magicProxyImage, "magic-proxy 必须使用固定的 Mihomo v1.19.30 镜像表达式");
    ensure(JSON.stringify(magicProxy.entrypoint) === JSON.stringify(magicProxyEntrypoint), "magic-proxy 必须通过只读入口脚本启动 Mihomo");
    ensure(!magicProxy.ports, "magic-proxy 不得发布 Controller 或代理端口");
    ensure(JSON.stringify(Object.keys(magicProxyEnvironment).sort()) === JSON.stringify(["OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST", "OCTALAICANVAS_MAGIC_PROXY_SECRET"].sort()), "magic-proxy 只能接收 Controller 密钥和监听地址环境变量");
    ensure(magicProxyEnvironment.OCTALAICANVAS_MAGIC_PROXY_SECRET === magicProxySecret, "magic-proxy 未声明同一 Controller 密钥");
    ensure(magicProxyEnvironment.OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST === proxyListenHost, "magic-proxy 未声明当前拓扑监听地址");
    ensure(!magicProxy.env_file, "magic-proxy 不得读取包含数据库或 provider 密钥的 env 文件");
    ensure(magicProxy.volumes?.includes(`./docker/mihomo/${profile.hostNetwork ? "bootstrap-host.yaml" : "bootstrap.yaml"}:/root/.config/mihomo/config.yaml:ro`), "magic-proxy 必须只读挂载当前拓扑 bootstrap 配置");
    ensure(magicProxy.volumes?.includes(magicProxyEntrypointMount), "magic-proxy 必须只读挂载 Mihomo 入口脚本");
    ensure(magicProxy.volumes?.includes(magicProxyRuntimeMount), "magic-proxy 必须挂载共享 runtime 命名卷");
    ensure(
        magicProxy.healthcheck?.test?.some((value) => String(value).includes("/version")),
        "magic-proxy 健康检查必须调用 Controller /version",
    );
    ensure(
        magicProxy.healthcheck?.test?.some((value) => String(value).includes("Authorization: Bearer $$OCTALAICANVAS_MAGIC_PROXY_SECRET")),
        "magic-proxy 健康检查必须使用 Controller Bearer 密钥",
    );
    ensure(magicProxy.restart === "unless-stopped", "magic-proxy 必须使用 unless-stopped 重启策略");
    ensure(!magicProxy.cap_add && !magicProxy.privileged && !magicProxy.devices, "magic-proxy 不得申请 TUN 或额外 capability");
    ensure(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_CONTROLLER_URL === proxyUrls.controller, "app 的 Mihomo Controller 地址不正确");
    ensure(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_SECRET === magicProxySecret, "app 未声明 Mihomo Controller 密钥");
    ensure(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_URL === proxyUrls.geminiai, "app 的 GeminiAIStudio 代理地址不正确");
    ensure(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_GEMINI_TOOLS_URL === proxyUrls.geminiTools, "app 的 GeminiTools 代理地址不正确");
    ensure(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST === proxyListenHost, "app 的 Mihomo 监听地址不正确");
    ensure(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_PROVIDER_FILE === magicProxyProviderFile, "app 的 Mihomo provider 文件路径不正确");
    ensure(String(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_PORT) === "17890", "app 的 GeminiAIStudio 代理端口不正确");
    ensure(String(appEnvironment.OCTALAICANVAS_MAGIC_PROXY_GEMINI_TOOLS_PORT) === "17891", "app 的 GeminiTools 代理端口不正确");
    ensure(geminiAiEnvironment.AISTUDIO_PROXY === proxyUrls.geminiai, "geminiai 未使用 GeminiAIStudio 专用代理监听");
    ensure(geminiAi.depends_on?.["magic-proxy"]?.condition === "service_healthy", "geminiai 必须等待 magic-proxy 健康");
    ensure(app.depends_on?.["magic-proxy"]?.condition === "service_healthy", "app 必须等待 magic-proxy 健康");
    ensure(app.image === profile.image, "app 必须使用当前发布版本的明确镜像");
    ensure(sameImage(app.image, worker.image), "app 与 generation-worker 必须使用同一镜像");
    ensure(!String(app.image || "").endsWith(":latest"), "发布 Compose 禁止使用 latest 镜像");
    ensure(JSON.stringify(worker.command) === JSON.stringify(["node", "/app/web/scripts/generation-worker.mjs"]), "Worker 启动命令不正确");
    ensure(app.env_file?.includes(".env"), "app 必须读取 .env");
    ensure(!worker.env_file, "generation-worker 不得读取包含安装令牌和业务密钥的 .env");
    ensure(appEnvironment.OCTALAICANVAS_INSTALL_TOKEN === installToken, "app 未声明强制一次性安装令牌");
    ensure(!("OCTALAICANVAS_INSTALL_TOKEN" in workerEnvironment), "generation-worker 不得获得一次性安装令牌");
    ensure(appEnvironment.OCTALAICANVAS_MAINTENANCE_TOKEN === maintenanceToken, "app 未声明强制维护令牌");
    ensure(appEnvironment.OCTALAICANVAS_WORKER_TOKEN === workerToken, "app 未声明强制 Worker 令牌");
    ensure(appEnvironment.OCTALAICANVAS_GEMINIAI_API_KEY === geminiAiToken, "app 未声明强制 GeminiAI 内部密钥");
    ensure("GEMINI_TOOLS_OAUTH_CLIENT_ID" in appEnvironment, "app 未声明 GeminiTools OAuth Client ID");
    ensure("GEMINI_TOOLS_OAUTH_CLIENT_SECRET" in appEnvironment, "app 未声明 GeminiTools OAuth Client Secret");
    ensure("GEMINI_TOOLS_OAUTH_REDIRECT_URI" in appEnvironment, "app 未声明 GeminiTools OAuth 回调地址");
    ensure(geminiAiEnvironment.AISTUDIO_API_KEY === geminiAiToken, "geminiai 未使用与 app 相同的内部密钥");
    ensure(geminiAiEnvironment.AISTUDIO_ACCOUNTS_DIR === "/data/accounts", "geminiai 账号目录必须固定在私有数据卷");
    ensure(String(geminiAiEnvironment.AISTUDIO_DUMP_RAW_RESPONSE) === "0", "geminiai 不得默认落盘原始响应");
    ensure(!geminiAi.env_file, "geminiai 不得读取包含其他业务密钥的 .env");
    ensure(!geminiAi.ports, "geminiai 不得向公网映射端口");
    ensure(geminiAi.volumes?.includes("octalaicanvas-geminiai-accounts:/data/accounts"), "geminiai 缺少私有账号数据卷挂载");
    ensure(Object.hasOwn(compose?.volumes || {}, "octalaicanvas-geminiai-accounts"), "缺少 GeminiAI 账号数据卷");
    ensure(
        geminiAi.healthcheck?.test?.some((value) => String(value).includes("/health")),
        "geminiai 健康检查必须调用 /health",
    );
    ensure(geminiAi.restart === "unless-stopped", "geminiai 必须使用 unless-stopped 重启策略");
    ensure(app.depends_on?.geminiai?.condition === "service_healthy", "app 必须等待 geminiai 健康");
    ensure(workerEnvironment.OCTALAICANVAS_WORKER_TOKEN === workerToken, "generation-worker 未声明同一强制 Worker 令牌");
    ensure(!("OCTALAICANVAS_MAINTENANCE_TOKEN" in workerEnvironment), "generation-worker 不得获得外部维护令牌");
    ensure(!("OCTALAICANVAS_GEMINIAI_API_KEY" in workerEnvironment), "generation-worker 不得获得 GeminiAI 内部密钥");
    ensure(!("GEMINI_TOOLS_OAUTH_CLIENT_SECRET" in workerEnvironment), "generation-worker 不得获得 GeminiTools OAuth Client Secret");
    ensure(workerEnvironment.OCTALAICANVAS_WORKER_API_ORIGIN === profile.workerOrigin, `Worker API 地址必须为 ${profile.workerOrigin}`);
    if (profile.appPort) {
        ensure(appEnvironment.PORT === profile.appPort, `app 监听端口必须为 ${profile.appPort}`);
        ensure(appEnvironment.OCTALAICANVAS_INTERNAL_ORIGIN === profile.internalOrigin, `app 内部地址必须为 ${profile.internalOrigin}`);
        ensure(appEnvironment.OCTALAICANVAS_TRUSTED_PROXY_HOPS === profile.trustedProxyHops, `app 可信代理层数必须为 ${profile.trustedProxyHops}`);
        ensure(
            app.healthcheck?.test?.some((value) => String(value).includes(`${profile.internalOrigin}/api/health/live`)),
            `app 健康检查必须请求 ${profile.internalOrigin}/api/health/live`,
        );
        ensure(
            app.healthcheck?.test?.some((value) => String(value).includes(`${profile.internalOrigin}/api/health/ready`)),
            `app 健康检查必须请求 ${profile.internalOrigin}/api/health/ready`,
        );
    }
    ensure(appEnvironment.OCTALAICANVAS_DATABASE_PROVIDER === "postgres", "app 必须使用 PostgreSQL provider");
    ensure(typeof appEnvironment.DATABASE_URL === "string", "app 缺少 DATABASE_URL");
    ensure(!("DATABASE_URL" in workerEnvironment), "generation-worker 不应直接持有数据库连接串");
    ensure(!("OCTALAICANVAS_DATABASE_PROVIDER" in workerEnvironment), "generation-worker 不应直接访问数据库 provider");
    ensure(app.volumes?.includes("octalaicanvas-data:/app/web/.data"), "app 缺少持久数据卷挂载");
    ensure(app.volumes?.includes(appMagicProxyRuntimeMount), "app 必须挂载共享 runtime 命名卷");
    ensure(Object.hasOwn(compose?.volumes || {}, "octalaicanvas-data"), "缺少 octalaicanvas-data 顶层数据卷");
    ensure(Object.hasOwn(compose?.volumes || {}, magicProxyRuntimeVolume), "缺少 magic-proxy runtime 顶层命名卷");
    ensure(!geminiAi.volumes?.some((volume) => String(volume).startsWith(`${magicProxyRuntimeVolume}:`)), "geminiai 不得挂载 magic-proxy runtime 卷");
    ensure(!worker.volumes?.some((volume) => String(volume).startsWith(`${magicProxyRuntimeVolume}:`)), "generation-worker 不得挂载 magic-proxy runtime 卷");
    ensure(
        app.healthcheck?.test?.some((value) => String(value).includes("/api/health/live")),
        "app 健康检查必须调用 /api/health/live",
    );
    ensure(worker.depends_on?.app?.condition === "service_healthy", "generation-worker 必须等待 app 健康");

    if (profile.embeddedPostgres) {
        ensure(Boolean(services.postgres), "默认或本地拓扑必须包含 PostgreSQL 服务");
        ensure(String(appEnvironment.DATABASE_URL || "").includes("@postgres:5432/"), "内置 PostgreSQL 拓扑必须连接 postgres 服务");
        ensure(Object.hasOwn(compose?.volumes || {}, "octalaicanvas-postgres"), "内置 PostgreSQL 拓扑缺少数据库数据卷");
    } else {
        ensure(!services.postgres, "外部数据库拓扑不得内置 PostgreSQL 服务");
        ensure(String(appEnvironment.DATABASE_URL || "").startsWith("${DATABASE_URL:?"), "外部数据库拓扑必须显式要求 DATABASE_URL");
        ensure(!Object.hasOwn(compose?.volumes || {}, "octalaicanvas-postgres"), "外部数据库拓扑不得声明无用的 PostgreSQL 数据卷");
    }

    if (profile.hostNetwork) {
        ensure(magicProxy.network_mode === "host", "host 网络拓扑的 magic-proxy 必须使用 host 网络");
        ensure(!magicProxy.expose, "host 网络拓扑不得声明 magic-proxy 的公开 expose");
        ensure(geminiAi.network_mode === "host", "宝塔 geminiai 必须使用 host 网络");
        ensure(geminiAiEnvironment.AISTUDIO_HOST === "127.0.0.1", "宝塔 geminiai 必须只监听回环地址");
        ensure(appEnvironment.OCTALAICANVAS_GEMINIAI_URL === "http://127.0.0.1:8080", "宝塔 app 必须通过回环地址访问 geminiai");
        ensure(app.network_mode === "host", "宝塔 app 必须使用 host 网络");
        ensure(worker.network_mode === "host", "宝塔 generation-worker 必须使用 host 网络");
        ensure("OCTALAICANVAS_TRUSTED_PROXY_HOPS" in appEnvironment, "宝塔拓扑缺少反向代理层数配置");
    } else {
        ensure(!magicProxy.network_mode, "桥接拓扑不得使用 magic-proxy host 网络");
        ensure(JSON.stringify(magicProxy.expose) === JSON.stringify(["9090", "17890", "17891"]), "桥接拓扑必须只在 Compose 内网 expose 三个 Mihomo 端口");
        ensure(!geminiAi.network_mode, "宝塔专用 geminiai host 网络不得泄漏到其他拓扑");
        ensure(geminiAi.expose?.includes("8080"), "geminiai 必须只在 Compose 内网暴露 8080");
        ensure(appEnvironment.OCTALAICANVAS_GEMINIAI_URL === "http://geminiai:8080", "app 必须通过 Compose 内网访问 geminiai");
        ensure(!app.network_mode && !worker.network_mode, "宝塔专用 host 网络不得泄漏到其他拓扑");
        ensure(!("OCTALAICANVAS_TRUSTED_PROXY_HOPS" in appEnvironment), "宝塔专用反向代理默认值不得泄漏到其他拓扑");
    }

    if (violations.length > 0) throw new Error(`${profile.file} Compose 契约失败：\n- ${violations.join("\n- ")}`);
    return { file: profile.file, services: Object.keys(services) };
}

function sameImage(appImage, workerImage) {
    return typeof appImage === "string" && appImage === workerImage;
}

function containsKey(value, key) {
    if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([entryKey, entryValue]) => entryKey === key || containsKey(entryValue, key));
}
