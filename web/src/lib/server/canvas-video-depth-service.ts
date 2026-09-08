import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { runFfmpeg } from "@/lib/server/ffmpeg";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { CanvasVideoOperationError, authorizeCanvasVideoSource, materializeCanvasVideoSource, probeCanvasVideoSource } from "@/lib/server/canvas-video-source-service";

const DEFAULT_DEPTH_SCRIPT = "services/video-depth/infer_depth_frames.py";
const DEFAULT_DEPTH_MODEL = "services/video-depth/models/depth-anything-v2-small-hf";

export type CanvasDepthVideoAsset = {
    storageKey: string;
    serverUrl: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type CanvasVideoDepthRuntime = {
    interpreter: string;
    scriptPath: string;
    modelDir: string;
};

export type DepthProgress = { stage: string; percent?: number };
export type CanvasVideoDepthRunner = (input: CanvasVideoDepthRuntime & { inputDir: string; outputDir: string; onProgress?: (progress: DepthProgress) => Promise<void> }) => Promise<void>;

export function resolveCanvasVideoDepthRuntime(): CanvasVideoDepthRuntime {
    return {
        interpreter: process.env.OCTALAICANVAS_VIDEO_DEPTH_PYTHON?.trim() || defaultDepthInterpreter(),
        scriptPath: configuredRuntimePath("OCTALAICANVAS_VIDEO_DEPTH_SCRIPT", DEFAULT_DEPTH_SCRIPT),
        modelDir: configuredRuntimePath("OCTALAICANVAS_VIDEO_DEPTH_MODEL", DEFAULT_DEPTH_MODEL),
    };
}

export async function extractCanvasVideoDepth(
    input: { ownerUserId: string; storageKey: string; onProgress?: (progress: DepthProgress) => Promise<void>; taskId?: string },
    dependencies: { runner?: CanvasVideoDepthRunner } = {},
): Promise<{ video: CanvasDepthVideoAsset }> {
    const source = await authorizeCanvasVideoSource(input);
    const workdir = await mkdtemp(join(tmpdir(), "octalaicanvas-video-depth-"));
    try {
        await input.onProgress?.({ stage: "读取源视频" });
        const sourcePath = await materializeCanvasVideoSource(source, workdir);
        const sourceProbe = await probeCanvasVideoSource(sourcePath);
        if (!sourceProbe.frameRate) throw new CanvasVideoOperationError("无法从源视频读取帧率，无法生成准确的深度视频", 502);

        const decodedFrames = join(workdir, "decoded-frames");
        const depthFrames = join(workdir, "depth-frames");
        await Promise.all([mkdir(decodedFrames, { recursive: true }), mkdir(depthFrames, { recursive: true })]);
        await input.onProgress?.({ stage: "解码视频" });
        await runFfmpeg(["-y", "-i", sourcePath, "-map", "0:v:0", "-fps_mode", "passthrough", join(decodedFrames, "frame-%08d.png")], { cwd: workdir });
        const decodedNames = await depthFrameNames(decodedFrames);
        if (!decodedNames.length) throw new CanvasVideoOperationError("FFmpeg 未从源视频解码出可用于深度推理的帧", 502);

        const runtime = resolveCanvasVideoDepthRuntime();
        await input.onProgress?.({ stage: "加载深度模型", percent: 0 });
        await (dependencies.runner || runCanvasVideoDepthInference)({ ...runtime, inputDir: decodedFrames, outputDir: depthFrames, onProgress: input.onProgress });
        await assertCompleteDepthFrames(decodedNames, depthFrames);

        const outputPath = join(workdir, "depth-video.mp4");
        await input.onProgress?.({ stage: "合成视频" });
        await runFfmpeg(
            [
                "-y",
                "-framerate",
                sourceProbe.frameRate,
                "-start_number",
                "1",
                "-i",
                join(depthFrames, "frame-%08d.png"),
                "-i",
                sourcePath,
                "-map",
                "0:v:0",
                "-map",
                "1:a?",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-r",
                sourceProbe.frameRate,
                "-c:a",
                "aac",
                outputPath,
            ],
            { cwd: workdir },
        );
        const outputProbe = await probeCanvasVideoSource(outputPath);
        if (!outputProbe.width || !outputProbe.height) throw new CanvasVideoOperationError("深度视频未生成有效的画面尺寸", 502);
        if ((sourceProbe.width && outputProbe.width !== sourceProbe.width) || (sourceProbe.height && outputProbe.height !== sourceProbe.height)) throw new CanvasVideoOperationError("深度视频尺寸与源视频不一致", 502);

        await input.onProgress?.({ stage: "保存视频" });
        const asset = await writeReferenceMediaFile(outputPath, "video", "video/mp4", true, {
            ownerUserId: input.ownerUserId,
            source: "canvas-video-depth",
            originalName: `${source.registration.originalName?.replace(/\.[^.]+$/, "") || "video"}-depth.mp4`,
            conversationId: source.registration.conversationId,
            runId: source.registration.runId,
            taskId: input.taskId || source.registration.taskId,
            projectId: source.registration.projectId,
        });
        return {
            video: {
                storageKey: asset.token,
                serverUrl: `/api/reference-assets/${asset.token.split("/").map(encodeURIComponent).join("/")}`,
                mimeType: asset.mimeType || "video/mp4",
                bytes: asset.bytes,
                width: outputProbe.width,
                height: outputProbe.height,
                durationMs: outputProbe.durationMs,
            },
        };
    } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

export async function runCanvasVideoDepthInference(input: Parameters<CanvasVideoDepthRunner>[0]) {
    await assertDepthRuntime(input);
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(input.interpreter, [input.scriptPath, "--input-dir", input.inputDir, "--output-dir", input.outputDir, "--model-dir", input.modelDir], {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const progress = (async () => {
            for await (const line of createInterface({ input: child.stdout! })) {
                let frame: { completed?: number; total?: number };
                try {
                    frame = JSON.parse(line);
                } catch {
                    continue;
                }
                if (typeof frame.completed === "number" && typeof frame.total === "number" && frame.total > 0 && frame.completed >= 0 && frame.completed <= frame.total) {
                    await input.onProgress?.({ stage: `深度推理 ${frame.completed}/${frame.total} 帧`, percent: Math.floor((frame.completed / frame.total) * 100) });
                }
            }
        })();
        void progress.catch((error) => {
            child.kill();
            reject(error);
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", (error) => {
            const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
            reject(new CanvasVideoOperationError(unavailable ? "视频深度推理运行时不可用：未找到 OCTALAICANVAS_VIDEO_DEPTH_PYTHON 指向的解释器" : `视频深度推理进程无法启动：${error.message}`, unavailable ? 503 : 502));
        });
        child.once("close", (code) => {
            if (code === 0) {
                void progress.then(resolvePromise, reject);
                return;
            }
            const unavailable = /(?:No module named|ModuleNotFoundError|cannot import name)/i.test(stderr);
            reject(new CanvasVideoOperationError(`视频深度推理失败：${stderr.trim() || `进程退出状态 ${code ?? "unknown"}`}`, unavailable ? 503 : 502));
        });
    });
}

async function assertDepthRuntime(runtime: CanvasVideoDepthRuntime) {
    try {
        const [interpreter, script, model] = await Promise.all([stat(/*turbopackIgnore: true*/ runtime.interpreter), stat(/*turbopackIgnore: true*/ runtime.scriptPath), stat(/*turbopackIgnore: true*/ runtime.modelDir)]);
        if (!interpreter.isFile() || !script.isFile() || !model.isDirectory()) throw new Error("invalid depth runtime path");
    } catch {
        throw new CanvasVideoOperationError("视频深度推理运行时尚未准备，请先运行 services/video-depth/setup_runtime.sh；也可通过 OCTALAICANVAS_VIDEO_DEPTH_* 指定外部运行时", 503);
    }
}

async function depthFrameNames(directory: string) {
    return (await readdir(directory)).filter((name) => /^frame-\d{8}\.png$/i.test(name)).sort();
}

async function assertCompleteDepthFrames(decodedNames: string[], depthDirectory: string) {
    const depthNames = new Set(await depthFrameNames(depthDirectory));
    if (decodedNames.some((name) => !depthNames.has(name))) throw new CanvasVideoOperationError("深度推理没有为全部源视频帧生成深度图", 502);
}

function configuredRuntimePath(environmentName: "OCTALAICANVAS_VIDEO_DEPTH_SCRIPT" | "OCTALAICANVAS_VIDEO_DEPTH_MODEL", fallback: string) {
    const configured = process.env[environmentName]?.trim() || fallback;
    if (isAbsolute(configured)) return configured;
    const root = projectRoot();
    const resolved = resolve(/*turbopackIgnore: true*/ root, configured);
    const pathFromRoot = relative(root, resolved);
    if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) throw new CanvasVideoOperationError(`${environmentName} 必须是绝对路径，或显式设置为项目目录内的相对路径`, 503);
    return resolved;
}

function projectRoot() {
    const cwd = resolve(/*turbopackIgnore: true*/ process.cwd());
    return basename(cwd) === "web" ? dirname(cwd) : cwd;
}

function defaultDepthInterpreter() {
    return join(projectRoot(), "services", "video-depth", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
