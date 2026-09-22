import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const python = path.join(repositoryRoot, "services", "dola-api", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const buildRoot = path.join(desktopRoot, "build", "freeze-dola");
const outputName = `dola-api${process.platform === "win32" ? ".exe" : ""}`;
const binary = path.join(buildRoot, "dist", outputName);

await run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", "dola-api",
    "--distpath", path.join(buildRoot, "dist"), "--workpath", path.join(buildRoot, "work"), "--specpath", buildRoot,
    "--paths", path.join(repositoryRoot, "services", "dola-api", "src"),
    "--collect-all", "camoufox", "--collect-all", "playwright", "--collect-all", "apify_fingerprint_datapoints", "--collect-all", "language_tags", "--hidden-import", "camoufox.async_api",
    path.join(desktopRoot, "scripts", "freeze", "dola.py")], { cwd: repositoryRoot });

const port = await availablePort();
const { PYTHONHOME: _pythonHome, PYTHONPATH: _pythonPath, ...inherited } = process.env;
const child = spawn(binary, [], { env: { ...inherited, PATH: process.platform === "win32" ? inherited.PATH : "/usr/bin:/bin", DOLA_PROVIDER_PORT: String(port), DOLA_PROVIDER_KEY: "packaging-smoke-only-secret-with-32-characters", DOLA_ENABLE_BROWSER: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
try {
    const endpoint = `http://127.0.0.1:${port}`;
    const timeout = AbortSignal.timeout(30_000);
    await Promise.race([
        (async () => {
            while (child.exitCode === null) {
                try {
                    const [health, protectedRoute] = await Promise.all([fetch(`${endpoint}/health`), fetch(`${endpoint}/internal/runtime/v1/models`)]);
                    if (health.ok && protectedRoute.status === 401) return;
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`冻结 Dola 进程退出：${stderr}`);
        })(),
        new Promise((_resolve, reject) => timeout.addEventListener("abort", () => reject(new Error(`冻结 Dola 健康检查超时：${stderr}`)), { once: true })),
    ]);
} finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
}

const target = path.join(desktopRoot, "resources", "sidecars", `${process.platform}-${process.arch}`);
await mkdir(target, { recursive: true });
await copyFile(binary, path.join(target, outputName));
const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
await writeFile(path.join(buildRoot, "dola-api.sha256"), `${digest}  ${outputName}\n`);
console.log(`已冻结并验证 ${outputName}，SHA-256: ${digest}`);

async function run(command, args, options) {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) throw new Error(`冻结构建失败：${command} (exit ${code})`);
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
