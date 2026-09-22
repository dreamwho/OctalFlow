import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

// Pinned upstream binary release; include its exact build notes and license.
const release = "b6.1.1";
const platform = process.platform;
const arch = process.arch;
if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch) || (platform === "win32" && arch !== "x64")) {
    throw new Error(`未验证的 FFmpeg 平台：${platform}-${arch}`);
}
const suffix = platform === "win32" ? ".exe" : "";
const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`;
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "resources", "sidecars", `${platform}-${arch}`);
const temporary = await mkdtemp(path.join(tmpdir(), "dreamyo-ffmpeg-"));
try {
    for (const name of ["ffmpeg", "ffprobe"]) {
        const staged = path.join(temporary, `${name}${suffix}`);
        await download(`${base}/${name}-${platform}-${arch}.gz`, staged, true);
        await chmod(staged, 0o755);
        await run(staged, ["-version"]);
    }
    await download(`${base}/${platform}-${arch}.README`, path.join(temporary, "FFmpeg-build.README"));
    await download(`${base}/${platform}-${arch}.LICENSE`, path.join(temporary, "FFmpeg-build.LICENSE"));
    const frame = path.join(temporary, "frame.png");
    await run(path.join(temporary, `ffmpeg${suffix}`), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:d=0.1", "-frames:v", "1", "-y", frame]);
    await run(path.join(temporary, `ffprobe${suffix}`), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", frame]);
    await mkdir(output, { recursive: true });
    const hashes = [];
    for (const name of ["ffmpeg", "ffprobe"]) {
        const filename = `${name}${suffix}`;
        const source = path.join(temporary, filename);
        await copyFile(source, path.join(output, filename));
        hashes.push(`${createHash("sha256").update(await readFile(source)).digest("hex")}  ${filename}`);
    }
    for (const filename of ["FFmpeg-build.README", "FFmpeg-build.LICENSE"]) await copyFile(path.join(temporary, filename), path.join(output, filename));
    await writeFile(path.join(output, "FFmpeg-build.sha256"), `${hashes.join("\n")}\n`);
    console.log(`FFmpeg/FFprobe ${release} 已验证并暂存于 ${output}`);
} finally { await rm(temporary, { recursive: true, force: true }); }

async function download(url, destination, compressed = false) {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`媒体工具下载失败：HTTP ${response.status} ${url}`);
    const stream = Readable.fromWeb(response.body);
    await pipeline(stream, ...(compressed ? [createGunzip()] : []), createWriteStream(destination));
}

async function run(command, args) {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk.toString().slice(0, 1_000); });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) throw new Error(`${path.basename(command)} 验证失败 (${code}): ${error}`);
}
