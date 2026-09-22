import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../../services/video-depth");
const desktop = path.resolve(import.meta.dirname, "..");
const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const output = path.join(desktop, "build", "freeze-video-depth");
const name = process.platform === "win32" ? "video-depth.exe" : "video-depth";
const binary = path.join(output, "dist", name);
await run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", "video-depth",
    "--distpath", path.join(output, "dist"), "--workpath", path.join(output, "work"), "--specpath", output,
    "--collect-all", "torch", "--collect-all", "transformers", "--collect-all", "torchvision", "--collect-all", "safetensors",
    path.join(root, "infer_depth_frames.py")], root);

const fixture = await mkdtemp(path.join(tmpdir(), "dreamyo-depth-smoke-"));
try {
    const source = path.join(fixture, "source");
    const target = path.join(fixture, "output");
    await mkdir(source);
    await mkdir(target);
    await run(python, ["-c", "from PIL import Image; import sys; Image.new('RGB', (32, 32), (64, 128, 192)).save(sys.argv[1])", path.join(source, "frame-00000001.png")], root);
    const { PYTHONHOME: _home, PYTHONPATH: _path, ...environment } = process.env;
    await run(binary, ["--input-dir", source, "--output-dir", target, "--model-dir", path.join(root, "models", "depth-anything-v2-small-hf")], root, {
        ...environment, PATH: process.platform === "win32" ? environment.PATH : "/usr/bin:/bin", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", DREAMYO_VIDEO_DEPTH_THREADS: "1",
    });
    const result = await readFile(path.join(target, "frame-00000001.png"));
    if (result.length < 32) throw new Error("视频深度冻结程序未产生有效输出帧");
} finally { await rm(fixture, { recursive: true, force: true }); }

const sidecars = path.join(desktop, "resources", "sidecars", `${process.platform}-${process.arch}`);
await mkdir(sidecars, { recursive: true });
await copyFile(binary, path.join(sidecars, name));
await cp(path.join(root, "models", "depth-anything-v2-small-hf"), path.join(sidecars, "video-depth-model"), { recursive: true, force: true });
await copyFile(path.join(root, "NOTICE.md"), path.join(sidecars, "video-depth-model", "NOTICE.md"));
const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
await writeFile(path.join(output, "video-depth.sha256"), `${digest}  ${name}\n`);
console.log(`已冻结并实测 ${name}，SHA-256: ${digest}`);

async function run(command, args, cwd, env = process.env) {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) throw new Error(`视频深度冻结或推理验证失败：${command} (exit ${code})`);
}
