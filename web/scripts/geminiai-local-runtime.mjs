import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 18_080;

export function localGeminiAiRuntime({ repoRoot, webRoot, environment = process.env, tokenFactory = () => randomBytes(32).toString("hex") }) {
    const source = { ...environment };
    const configuredUrl = source.OCTALAICANVAS_GEMINIAI_URL?.trim() || "";
    const configuredKey = source.OCTALAICANVAS_GEMINIAI_API_KEY?.trim() || "";
    if (configuredUrl || configuredKey) {
        if (!configuredUrl || !configuredKey) throw new Error("OCTALAICANVAS_GEMINIAI_URL 与 OCTALAICANVAS_GEMINIAI_API_KEY 必须同时配置");
        return { environment: source };
    }

    const providerRoot = path.join(repoRoot, "services", "geminiai");
    const python = source.OCTALAICANVAS_GEMINIAI_PYTHON?.trim() || path.join(providerRoot, ".venv", "bin", "python");
    if (!existsSync(python)) throw new Error(`本地 GeminiAI Provider 运行环境不存在：${python}`);
    const port = validPort(source.OCTALAICANVAS_GEMINIAI_PORT) || DEFAULT_PORT;
    const apiKey = tokenFactory();
    const accountsDir = source.OCTALAICANVAS_GEMINIAI_ACCOUNTS_DIR?.trim() || path.join(webRoot, ".data", "geminiai", "accounts");
    const providerEnvironment = {
        ...source,
        AISTUDIO_API_KEY: apiKey,
        AISTUDIO_ACCOUNTS_DIR: accountsDir,
        AISTUDIO_CONFIG_FILE: path.join(providerRoot, "config.yaml"),
        AISTUDIO_DUMP_RAW_RESPONSE: "0",
        AISTUDIO_HOST: "127.0.0.1",
        AISTUDIO_PORT: String(port),
        ...(source.OCTALAICANVAS_GEMINIAI_STUDIO_URL?.trim() ? { AISTUDIO_STUDIO_URL: source.OCTALAICANVAS_GEMINIAI_STUDIO_URL.trim() } : {}),
    };
    return {
        environment: {
            ...source,
            OCTALAICANVAS_GEMINIAI_URL: `http://127.0.0.1:${port}`,
            OCTALAICANVAS_GEMINIAI_API_KEY: apiKey,
        },
        service: {
            name: "geminiai",
            command: python,
            args: [path.join(providerRoot, "main.py"), "server", "--port", String(port)],
            cwd: providerRoot,
            environment: providerEnvironment,
        },
    };
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}
