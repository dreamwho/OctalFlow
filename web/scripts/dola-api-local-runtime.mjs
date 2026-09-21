import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 18_082;

export function localDolaApiRuntime({ repoRoot, webRoot, environment = process.env, exists = existsSync, tokenFactory = () => randomBytes(32).toString("hex") }) {
    const source = { ...environment };
    if (source.DREAMYO_DOLA_API_ENABLED === "0") return { environment: source };
    const configuredUrl = source.DREAMYO_DOLA_PROVIDER_URL?.trim() || "";
    const configuredKey = source.DREAMYO_DOLA_PROVIDER_KEY?.trim() || "";
    if (configuredUrl && !configuredKey) throw new Error("Dola Provider URL 与服务密钥必须同时配置");
    if (configuredUrl && !isLocalProviderUrl(configuredUrl)) {
        if (!configuredKey) throw new Error("Dola Provider URL 与服务密钥必须同时配置");
        return { environment: source };
    }

    const providerRoot = path.join(repoRoot, "services", "dola-api");
    const executable = source.DREAMYO_DOLA_PROVIDER_EXECUTABLE?.trim() || "";
    const python = executable || source.DREAMYO_DOLA_PROVIDER_PYTHON?.trim() || path.join(providerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!exists(python)) {
        if (source.DREAMYO_DOLA_API_ENABLED === "1" || configuredUrl) throw new Error(`本地 Dola Provider 运行环境不存在：${python}`);
        return { environment: source };
    }
    const configuredPort = source.DREAMYO_DOLA_PROVIDER_PORT?.trim() || "";
    if (configuredPort && !validPort(configuredPort)) throw new Error("Dola Provider 运行时端口无效");
    const port = localPort(configuredUrl) || validPort(configuredPort) || DEFAULT_PORT;
    if (!port) throw new Error("Dola Provider 运行时端口无效");
    const apiKey = configuredKey || tokenFactory();
    const dataRoot = source.DREAMYO_DATA_DIR || path.join(webRoot, ".data");
    const dotenv = source.DREAMYO_DESKTOP_EDITION ? {} : readDotenv(path.join(providerRoot, ".env"));
    const providerEnvironment = {
        ...source,
        ...dotenv,
        DOLA_PROVIDER_KEY: apiKey,
        DOLA_ENABLE_BROWSER: source.DOLA_ENABLE_BROWSER?.trim() || dotenv.DOLA_ENABLE_BROWSER || "1",
        DOLA_BROWSER_ENGINE: source.DOLA_BROWSER_ENGINE?.trim() || dotenv.DOLA_BROWSER_ENGINE || "camoufox",
        DOLA_CAMOUFOX_BROWSER: source.DOLA_CAMOUFOX_BROWSER?.trim() || dotenv.DOLA_CAMOUFOX_BROWSER || "",
        DOLA_PROVIDER_PORT: String(port),
        DOLA_TASK_STATE_PATH: source.DOLA_TASK_STATE_PATH?.trim() || dotenv.DOLA_TASK_STATE_PATH || path.join(dataRoot, "dola", "provider-tasks.json"),
        DOLA_PROFILE_DIR: source.DOLA_PROFILE_DIR?.trim() || dotenv.DOLA_PROFILE_DIR || path.join(dataRoot, "dola", "profiles"),
        PYTHONPATH: [path.join(providerRoot, "src"), source.PYTHONPATH].filter(Boolean).join(path.delimiter),
    };
    return {
        environment: { ...source, DREAMYO_DOLA_PROVIDER_URL: `http://127.0.0.1:${port}`, DREAMYO_DOLA_PROVIDER_KEY: apiKey },
        service: {
            name: "dola-api",
            port,
            command: python,
            args: executable ? [] : ["-m", "uvicorn", "dola_api.app:app", "--host", "127.0.0.1", "--port", String(port)],
            cwd: providerRoot,
            environment: providerEnvironment,
        },
    };
}

function isLocalProviderUrl(value) {
    try {
        return ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname);
    } catch {
        throw new Error("Dola Provider URL 无效");
    }
}

function localPort(value) {
    if (!value) return undefined;
    const url = new URL(value);
    return validPort(url.port || (url.protocol === "https:" ? "443" : "80"));
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}

function readDotenv(file) {
    if (!existsSync(file)) return {};
    return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).flatMap((raw) => {
        const match = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) return [];
        const value = match[2].trim();
        return [[match[1], /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value]];
    }));
}
