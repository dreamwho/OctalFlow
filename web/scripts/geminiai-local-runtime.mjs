import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 18_080;

export function localGeminiAiRuntime({ repoRoot, webRoot, environment = process.env, tokenFactory = () => randomBytes(32).toString("hex") }) {
    const source = { ...environment };
    const configuredUrl = source.DREAMYO_GEMINIAI_URL?.trim() || "";
    const configuredKey = source.DREAMYO_GEMINIAI_API_KEY?.trim() || "";
    if (configuredUrl || configuredKey) {
        if (!configuredUrl || !configuredKey) throw new Error("DREAMYO_GEMINIAI_URL 与 DREAMYO_GEMINIAI_API_KEY 必须同时配置");
        return { environment: source };
    }

    const providerRoot = path.join(repoRoot, "services", "geminiai");
    const executable = source.DREAMYO_GEMINIAI_EXECUTABLE?.trim() || "";
    const python = executable || source.DREAMYO_GEMINIAI_PYTHON?.trim() || path.join(providerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!existsSync(python)) throw new Error(`本地 GeminiAI Provider 运行环境不存在：${python}`);
    const port = validPort(source.DREAMYO_GEMINIAI_PORT) || DEFAULT_PORT;
    const dataRoot = source.DREAMYO_DATA_DIR || path.join(webRoot, ".data");
    const apiKey = obtainStableKey(dataRoot, tokenFactory);
    const accountsDir = source.DREAMYO_GEMINIAI_ACCOUNTS_DIR?.trim() || path.join(dataRoot, "geminiai", "accounts");
    const providerEnvironment = {
        ...source,
        AISTUDIO_API_KEY: apiKey,
        AISTUDIO_ACCOUNTS_DIR: accountsDir,
        AISTUDIO_CONFIG_FILE: path.join(providerRoot, "config.yaml"),
        AISTUDIO_DUMP_RAW_RESPONSE: source.AISTUDIO_DUMP_RAW_RESPONSE?.trim() || "0",
        AISTUDIO_HOST: "127.0.0.1",
        AISTUDIO_PORT: String(port),
        ...(source.DREAMYO_GEMINIAI_STUDIO_URL?.trim() ? { AISTUDIO_STUDIO_URL: source.DREAMYO_GEMINIAI_STUDIO_URL.trim() } : {}),
    };
    return {
        environment: {
            ...source,
            DREAMYO_GEMINIAI_URL: `http://127.0.0.1:${port}`,
            DREAMYO_GEMINIAI_API_KEY: apiKey,
        },
        service: {
            name: "geminiai",
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
    const keyPath = path.join(dataRoot, "geminiai", "runtime-api-key");
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
