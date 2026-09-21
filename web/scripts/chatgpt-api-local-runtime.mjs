import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

export function localChatGptApiRuntime({ repoRoot, webRoot, environment = process.env, exists = existsSync, tokenFactory = () => randomBytes(32).toString("hex") }) {
    const source = { ...environment };
    const url = source.DREAMYO_CHATGPT_API_URL?.trim();
    const configuredKey = source.DREAMYO_CHATGPT_API_KEY?.trim();
    if (configuredKey && configuredKey.length < 32) throw new Error("ChatGPT API 内部运行时需要至少 32 字符的服务密钥");
    if (url) {
        if (!configuredKey || configuredKey.length < 32) throw new Error("ChatGPT API 内部运行时需要至少 32 字符的服务密钥");
        return { environment: source };
    }
    const providerRoot = path.join(repoRoot, "services", "chatgpt-api");
    const python = source.DREAMYO_CHATGPT_API_PYTHON?.trim() || path.join(providerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (source.DREAMYO_CHATGPT_API_ENABLED === "0") return { environment: source };
    if (!exists(python)) {
        if (source.DREAMYO_CHATGPT_API_ENABLED === "1") throw new Error("ChatGPT API Python 运行环境未安装，请运行 services/chatgpt-api 中的安装脚本");
        return { environment: source };
    }
    const port = Number(source.DREAMYO_CHATGPT_API_PORT || "8046");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ChatGPT API 运行时端口无效");
    const apiKey = configuredKey || tokenFactory();
    const dataRoot = source.DREAMYO_DATA_DIR || path.join(webRoot, ".data");
    const providerEnvironment = {
        ...source,
        DATABASE_URL: "",
        DREAMYO_CHATGPT_API_KEY: apiKey,
        DREAMYO_CHATGPT_DATA_DIR: source.DREAMYO_CHATGPT_DATA_DIR || path.join(dataRoot, "chatgpt-api"),
    };
    return {
        environment: { ...source, DREAMYO_CHATGPT_API_URL: `http://127.0.0.1:${port}`, DREAMYO_CHATGPT_API_KEY: apiKey },
        service: { name: "chatgpt-api", port, command: python, args: [path.join(providerRoot, "main.py"), "--port", String(port)], cwd: providerRoot, environment: providerEnvironment },
    };
}
