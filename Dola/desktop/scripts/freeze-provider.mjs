import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const providerRoot = path.resolve(desktopRoot, "../provider");
const buildRoot = path.join(desktopRoot, "build", "provider");
const python = path.join(providerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const outputName = process.platform === "win32" ? "dola-api.exe" : "dola-api";

await mkdir(buildRoot, { recursive: true });
await run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", "dola-api",
  "--distpath", path.join(buildRoot, "dist"), "--workpath", path.join(buildRoot, "work"), "--specpath", buildRoot,
  "--paths", path.join(providerRoot, "src"), "--collect-all", "camoufox", "--collect-all", "playwright",
  "--collect-all", "apify_fingerprint_datapoints", "--collect-all", "language_tags", "--hidden-import", "camoufox.async_api",
  path.join(desktopRoot, "scripts", "provider-entry.py")], { cwd: providerRoot });

const binary = path.join(buildRoot, "dist", outputName);
const port = await freePort();
const child = spawn(binary, [], { env: { ...process.env, DOLA_PROVIDER_PORT: String(port), DOLA_PROVIDER_KEY: "packaging-smoke-only-secret-with-32-characters", DOLA_ENABLE_BROWSER: "0" }, stdio: "ignore" });
try {
  while (child.exitCode === null) {
    try {
      const [health, protectedRoute] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`),
        fetch(`http://127.0.0.1:${port}/internal/runtime/v1/models`),
      ]);
      if (health.ok && protectedRoute.status === 401) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode !== null) throw new Error(`冻结 Provider 启动失败，退出码 ${child.exitCode}`);
} finally {
  child.kill();
}
await writeFile(path.join(buildRoot, "binary-location.txt"), `${binary}\n`);
console.log(`Provider 已冻结并通过鉴权健康检查：${binary}`);

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error(`Provider 冻结构建失败，退出码 ${code}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
