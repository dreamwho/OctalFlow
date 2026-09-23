import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { verifyExecutable } from "./verify-executable.mjs";

const release = "v1.19.31";
const asset = "mihomo-windows-amd64-v1.19.31.zip";
const assetSha256 = "38b2420799d9e7cde77ec1a19c7150dd17ca77f7fb82d9f62cb8763a307eee67";
const outputRoot = path.resolve(import.meta.dirname, "../resources/sidecars/win32-x64");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Mihomo 桌面暂存必须在 Windows x64 原生环境运行");

const temporary = await mkdtemp(path.join(tmpdir(), "dreamyo-mihomo-"));
try {
    const archive = path.join(temporary, asset);
    const response = await fetch(`https://github.com/MetaCubeX/mihomo/releases/download/${release}/${asset}`);
    if (!response.ok || !response.body) throw new Error(`Mihomo 下载失败：HTTP ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const archiveDigest = createHash("sha256").update(await readFile(archive)).digest("hex");
    if (archiveDigest !== assetSha256) throw new Error(`Mihomo 官方压缩包校验失败：${archiveDigest}`);

    const extracted = path.join(temporary, "extracted");
    await mkdir(extracted);
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${escapePowerShell(archive)}' -DestinationPath '${escapePowerShell(extracted)}' -Force`]);
    const binary = path.join(extracted, "mihomo-windows-amd64.exe");
    await verifyExecutable(binary, "win32", "x64");
    await run(binary, ["-v"]);

    await mkdir(outputRoot, { recursive: true });
    await copyFile(binary, path.join(outputRoot, "mihomo.exe"));
    await writeFile(path.join(outputRoot, "mihomo-release.json"), `${JSON.stringify({ version: release.slice(1), asset, archiveSha256: assetSha256, binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex") })}\n`, "utf8");
    console.log(`Mihomo ${release} (Windows x64) 已校验并暂存`);
} finally {
    await rm(temporary, { recursive: true, force: true });
}

function escapePowerShell(value) { return value.replaceAll("'", "''"); }

async function run(command, args) {
    const child = spawn(command, args, { stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) throw new Error(`${path.basename(command)} 执行失败 (${code})`);
}
