import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 18_081;

export function localGeminiVidsRuntime({ repoRoot, webRoot, environment = process.env, tokenFactory = () => randomBytes(32).toString("hex") }) {
    const source = { ...environment };
    const configuredUrl = source.DREAMYO_GEMINIVIDS_URL?.trim() || "";
    const configuredKey = source.DREAMYO_GEMINIVIDS_API_KEY?.trim() || "";
    if (configuredUrl || configuredKey) {
        if (!configuredUrl || !configuredKey) throw new Error("DREAMYO_GEMINIVIDS_URL 与 DREAMYO_GEMINIVIDS_API_KEY 必须同时配置");
        return { environment: source };
    }

    const providerRoot = path.join(repoRoot, "services", "geminivids");
    const executable = source.DREAMYO_GEMINIVIDS_EXECUTABLE?.trim() || "";
    const python = executable || source.DREAMYO_GEMINIVIDS_PYTHON?.trim() || path.join(providerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!existsSync(python)) throw new Error(`本地 GeminiVids Provider 运行环境不存在：${python}`);
    const port = validPort(source.DREAMYO_GEMINIVIDS_PORT) || DEFAULT_PORT;
    const dataRoot = source.DREAMYO_DATA_DIR || path.join(webRoot, ".data");
    const apiKey = obtainStableKey(dataRoot, tokenFactory);
    // sidecar 媒体经系统代理 _media 下载：本地回环地址需要放开出站白名单（不覆盖既有配置）
    const privateHosts = (source.DREAMYO_PRIVATE_UPSTREAM_HOSTS || "").split(",").map((item) => item.trim()).filter(Boolean);
    const allowPrivate = {
        ...(source.DREAMYO_ALLOW_PRIVATE_UPSTREAMS ? {} : { DREAMYO_ALLOW_PRIVATE_UPSTREAMS: "1" }),
        ...(!privateHosts.includes("127.0.0.1") ? { DREAMYO_PRIVATE_UPSTREAM_HOSTS: [...privateHosts, "127.0.0.1"].join(",") } : {}),
    };
    const providerEnvironment = {
        ...source,
        ...allowPrivate,
        GVIDS_API_KEY: apiKey,
        GVIDS_HOST: "127.0.0.1",
        GVIDS_PORT: String(port),
        GVIDS_DATA_DIR: path.join(dataRoot, "geminivids"),
        PYTHONPATH: [path.join(providerRoot, "src"), source.PYTHONPATH].filter(Boolean).join(path.delimiter),
    };
    return {
        environment: {
            ...source,
            DREAMYO_GEMINIVIDS_URL: `http://127.0.0.1:${port}`,
            DREAMYO_GEMINIVIDS_API_KEY: apiKey,
        },
        service: {
            name: "geminivids",
            port,
            command: python,
            args: executable ? ["server", "--port", String(port)] : [path.join(providerRoot, "main.py"), "server", "--port", String(port)],
            cwd: providerRoot,
            environment: providerEnvironment,
        },
    };
}

/** 内部密钥按数据目录持久化：web 与 sidecar 分别重启时不会因随机密钥不同而互相 401。 */
function obtainStableKey(dataRoot, tokenFactory) {
    const keyPath = path.join(dataRoot, "geminivids", "runtime-api-key");
    try {
        const existing = readFileSync(keyPath, "utf8").trim();
        if (existing.length >= 32) return existing;
    } catch {}
    const key = tokenFactory();
    try {
        mkdirSync(path.dirname(keyPath), { recursive: true });
        writeFileSync(keyPath, key, { encoding: "utf8", mode: 0o600 });
    } catch {}
    return key;
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}
