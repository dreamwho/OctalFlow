import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const target = process.argv[2];
const settings = {
    geminiai: { service: "geminiai", entry: "main.py", extra: ["--collect-all", "camoufox", "--collect-all", "playwright", "--collect-all", "cloakbrowser", "--collect-all", "apify_fingerprint_datapoints", "--collect-all", "language_tags", "--hidden-import", "camoufox.sync_api"] },
    "geminiai-browser": { service: "geminiai", entry: "src/aistudio_api/infrastructure/browser/camoufox_launcher.py", extra: ["--collect-all", "camoufox", "--collect-all", "playwright", "--collect-all", "apify_fingerprint_datapoints", "--collect-all", "language_tags"] },
    "chatgpt-api": { service: "chatgpt-api", entry: "main.py", extra: ["--collect-all", "curl_cffi", "--collect-all", "tiktoken"] },
}[target];
if (!settings) throw new Error("请指定 geminiai、geminiai-browser 或 chatgpt-api");

const serviceRoot = path.join(repositoryRoot, "services", settings.service);
const python = path.join(serviceRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const buildRoot = path.join(desktopRoot, "build", `freeze-${target}`);
const name = `${target}${process.platform === "win32" ? ".exe" : ""}`;
const binary = path.join(buildRoot, "dist", name);
const paths = settings.service === "geminiai" ? path.join(serviceRoot, "src") : serviceRoot;
await run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", target,
    "--distpath", path.join(buildRoot, "dist"), "--workpath", path.join(buildRoot, "work"), "--specpath", buildRoot,
    "--paths", paths, ...settings.extra, path.join(serviceRoot, settings.entry)], serviceRoot);

if (target === "geminiai-browser") {
    await run(binary, ["--help"], serviceRoot);
} else {
    const dataRoot = await mkdtemp(path.join(tmpdir(), `dreamyo-${target}-smoke-`));
    const port = await availablePort();
    const key = "packaging-smoke-only-secret-with-32-characters";
    const { PYTHONHOME: _pythonHome, PYTHONPATH: _pythonPath, ...inherited } = process.env;
    const env = {
        ...inherited, PATH: process.platform === "win32" ? inherited.PATH : "/usr/bin:/bin",
        ...(target === "geminiai" ? {
            AISTUDIO_API_KEY: key, AISTUDIO_PORT: String(port), AISTUDIO_ACCOUNTS_DIR: path.join(dataRoot, "accounts"), AISTUDIO_CONFIG_FILE: path.join(serviceRoot, "config.yaml"),
        } : {
            DREAMYO_CHATGPT_API_KEY: key, DREAMYO_CHATGPT_DATA_DIR: dataRoot, DREAMYO_ENCRYPTION_KEY: randomBytes(32).toString("hex"), DATABASE_URL: "",
        }),
    };
    const args = target === "geminiai" ? ["server", "--port", String(port)] : ["--port", String(port)];
    const child = spawn(binary, args, { cwd: serviceRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    try {
        const endpoint = target === "geminiai" ? "/health" : "/integration/health";
        const signal = AbortSignal.timeout(45_000);
        await Promise.race([
            (async () => {
                while (child.exitCode === null) {
                    try {
                        const url = `http://127.0.0.1:${port}${endpoint}`;
                        const headers = target === "geminiai" ? { "x-api-key": key } : { "x-dreamyo-runtime-key": key };
                        const authorized = await fetch(url, { headers });
                        const denied = await fetch(url);
                        if (authorized.ok && (target === "geminiai" || denied.status === 401)) return;
                    } catch {}
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                throw new Error(`${target} 进程退出：${stderr}`);
            })(),
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(`${target} 健康检查超时：${stderr}`)), { once: true })),
        ]);
    } finally {
        child.kill("SIGTERM");
        if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
        await rm(dataRoot, { recursive: true, force: true });
    }
}
if (target === "geminiai") {
    const tracker = spawn(binary, ["-c", "from multiprocessing.resource_tracker import main;main(3)"], {
        cwd: serviceRoot, stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    let stderr = "";
    tracker.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    tracker.stdio[3].end();
    const exitCode = await new Promise((resolve, reject) => { tracker.once("error", reject); tracker.once("close", resolve); });
    if (exitCode !== 0) throw new Error(`冻结 Gemini 资源追踪子进程失败：${stderr}`);
}

const sidecars = path.join(desktopRoot, "resources", "sidecars", `${process.platform}-${process.arch}`);
await mkdir(sidecars, { recursive: true });
await copyFile(binary, path.join(sidecars, name));
const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
await writeFile(path.join(buildRoot, `${target}.sha256`), `${digest}  ${name}\n`);
console.log(`已冻结并验证 ${name}，SHA-256: ${digest}`);

async function run(command, args, cwd) {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) throw new Error(`冻结构建或检查失败：${command} (exit ${code})`);
}

async function availablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}
