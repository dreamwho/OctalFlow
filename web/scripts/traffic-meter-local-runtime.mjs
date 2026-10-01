import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 18_083;
const MIN_KEY_LENGTH = 32;

/**
 * Resolve the independent traffic-meter sidecar for standalone/local runs.
 *
 * An explicitly configured URL always denotes an already managed remote sidecar;
 * standalone must not start a second meter in that case.  Without a URL, the
 * bundled service is started with the same generated key passed to the web app.
 */
export function localTrafficMeterRuntime({
    repoRoot,
    webRoot,
    environment = process.env,
    exists = existsSync,
    tokenFactory = () => randomBytes(32).toString("hex"),
} = {}) {
    const source = { ...environment };
    const configuredUrl = source.DREAMYO_TRAFFIC_METER_URL?.trim() || "";
    const configuredKey = source.DREAMYO_TRAFFIC_METER_KEY?.trim() || "";

    if (configuredKey && configuredKey.length < MIN_KEY_LENGTH) {
        throw new Error("Traffic meter 内部运行时需要至少 32 字符的服务密钥");
    }
    if (configuredUrl) {
        if (!isHttpUrl(configuredUrl)) throw new Error("Traffic meter URL 必须使用 HTTP 或 HTTPS");
        if (configuredKey.length < MIN_KEY_LENGTH) {
            throw new Error("配置 DREAMYO_TRAFFIC_METER_URL 时必须同时提供至少 32 字符的 DREAMYO_TRAFFIC_METER_KEY");
        }
        return { environment: source };
    }

    const providerRoot = path.join(repoRoot, "services", "traffic-meter");
    const executable = source.DREAMYO_TRAFFIC_METER_EXECUTABLE?.trim() || "";
    const python = executable || source.DREAMYO_TRAFFIC_METER_PYTHON?.trim() || source.DREAMYO_DOLA_PROVIDER_PYTHON?.trim() || path.join(repoRoot, "services", "dola-api", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!exists(python)) {
        if (source.DREAMYO_TRAFFIC_METER_ENABLED === "1") {
            throw new Error(`Traffic meter Python 运行环境未安装，请运行 ${path.relative(repoRoot, providerRoot)} 中的安装脚本`);
        }
        return { environment: source };
    }

    const configuredPort = source.TRAFFIC_METER_PORT?.trim() || source.DREAMYO_TRAFFIC_METER_PORT?.trim() || "";
    if (configuredPort && !validPort(configuredPort)) throw new Error("Traffic meter 运行时端口无效");
    const port = validPort(configuredPort) || DEFAULT_PORT;
    const bindHost = "127.0.0.1";
    const publicHost = "127.0.0.1";
    const apiKey = configuredKey || tokenFactory();
    if (apiKey.length < MIN_KEY_LENGTH) throw new Error("Traffic meter 内部运行时需要至少 32 字符的服务密钥");
    const dataRoot = source.DREAMYO_DATA_DIR || path.join(webRoot, ".data");
    const statePath = source.TRAFFIC_METER_STATE_PATH?.trim() || path.join(dataRoot, "traffic-meter", "traffic.sqlite3");
    const sourcePath = path.join(providerRoot, "src");
    const pythonPath = [sourcePath, source.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const providerEnvironment = {
        ...source,
        TRAFFIC_METER_KEY: apiKey,
        TRAFFIC_METER_PORT: String(port),
        TRAFFIC_METER_BIND_HOST: bindHost,
        TRAFFIC_METER_PUBLIC_HOST: publicHost,
        TRAFFIC_METER_STATE_PATH: statePath,
        PYTHONPATH: pythonPath,
    };

    return {
        environment: {
            ...source,
            DREAMYO_TRAFFIC_METER_URL: `http://${publicHost}:${port}`,
            DREAMYO_TRAFFIC_METER_KEY: apiKey,
        },
        service: {
            name: "traffic-meter",
            port,
            command: python,
            args: ["-m", "uvicorn", "traffic_meter.main:app", "--host", bindHost, "--port", String(port)],
            cwd: providerRoot,
            environment: providerEnvironment,
        },
    };
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}
