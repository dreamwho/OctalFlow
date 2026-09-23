import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyExecutable } from "./verify-executable.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const baseUrl = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta";

export function resolveDreaminaTarget(platform, arch) {
    const downloads = {
        "darwin-arm64": "dreamina_cli_darwin_arm64",
        "darwin-x64": "dreamina_cli_darwin_amd64",
        "win32-x64": "dreamina_cli_windows_amd64.exe",
    };
    const key = `${platform}-${arch}`;
    const filename = downloads[key];
    if (!filename) throw new Error(`即梦 CLI 不支持桌面目标平台：${key}`);
    return { filename, executable: platform === "win32" ? "dreamina.exe" : "dreamina" };
}

export async function stageDreamina({ platform = process.platform, arch = process.arch, outputRoot = path.join(desktopRoot, "resources", "sidecars", `${platform}-${arch}`), fetchImpl = fetch } = {}) {
    const target = resolveDreaminaTarget(platform, arch);
    const temporary = await mkdtemp(path.join(tmpdir(), "dreamyo-dreamina-"));
    const binary = path.join(temporary, target.executable);
    try {
        const response = await fetchImpl(`${baseUrl}/${target.filename}`);
        if (!response.ok || !response.body) throw new Error(`即梦 CLI 下载失败：HTTP ${response.status}`);
        await writeFile(binary, Buffer.from(await response.arrayBuffer()));
        if (platform === "darwin") await chmod(binary, 0o755);
        await verifyExecutable(binary, platform, arch);

        const versionResponse = await fetchImpl("https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/version.json");
        if (!versionResponse.ok) throw new Error(`即梦 CLI 版本信息读取失败：HTTP ${versionResponse.status}`);
        const release = await versionResponse.json();
        if (!/^\d+\.\d+\.\d+$/.test(release.version ?? "")) throw new Error("即梦 CLI 版本信息无效");

        await mkdir(outputRoot, { recursive: true });
        const destination = path.join(outputRoot, target.executable);
        await copyFile(binary, destination);
        const sha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
        await writeFile(path.join(outputRoot, "dreamina-release.json"), `${JSON.stringify({ version: release.version, releaseDate: release.release_date, filename: target.filename, sha256 })}\n`, "utf8");
        console.log(`即梦 CLI ${release.version} (${platform}-${arch}) 已验证并暂存，SHA-256: ${sha256}`);
        return { destination, release: { ...release, filename: target.filename, sha256 } };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await stageDreamina();
}
