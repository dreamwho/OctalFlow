import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg } from "@/lib/server/ffmpeg";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { CanvasVideoOperationError, authorizeCanvasVideoSource, materializeCanvasVideoSource, normalizeCanvasVideoStorageKey, probeCanvasVideoSource, type AuthorizedCanvasVideoSource, type CanvasVideoProbe } from "@/lib/server/canvas-video-source-service";

export type CanvasExtractedVideoFrame = {
    storageKey: string;
    serverUrl: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    atMs: number;
};

type ExtractCanvasVideoFramesInput = {
    ownerUserId: string;
    storageKey: string;
    mode: "both" | "current" | "seconds";
    timeMs?: number;
};

export type CanvasVideoFrameResult = { firstFrame?: CanvasExtractedVideoFrame; lastFrame?: CanvasExtractedVideoFrame; frame?: CanvasExtractedVideoFrame; frames?: CanvasExtractedVideoFrame[] };

const automaticFrameRequests = new Map<string, Promise<CanvasVideoFrameResult>>();

export function extractCanvasVideoFrames(input: ExtractCanvasVideoFramesInput): Promise<CanvasVideoFrameResult> {
    if (input.mode === "current") return extractCanvasVideoFramesOnce(input);
    const key = `${input.ownerUserId}:${normalizeCanvasVideoStorageKey(input.storageKey)}:${input.mode}`;
    const active = automaticFrameRequests.get(key);
    if (active) return active;
    const request = extractCanvasVideoFramesOnce(input).finally(() => {
        if (automaticFrameRequests.get(key) === request) automaticFrameRequests.delete(key);
    });
    automaticFrameRequests.set(key, request);
    return request;
}

async function extractCanvasVideoFramesOnce(input: ExtractCanvasVideoFramesInput): Promise<CanvasVideoFrameResult> {
    const source = await authorizeCanvasVideoSource(input);

    const workdir = await mkdtemp(join(tmpdir(), "octalaicanvas-video-frame-"));
    try {
        const sourcePath = await materializeCanvasVideoSource(source, workdir);
        const probe = await probeCanvasVideoSource(sourcePath);
        if (input.mode === "current") {
            const atMs = frameTimestamp(input.timeMs, probe.durationMs);
            const suffix = probe.durationMs - atMs <= 100 ? "last" : "current";
            return { frame: await extractFrame(sourcePath, workdir, atMs, input, source, probe, suffix) };
        }
        if (input.mode === "seconds") {
            return { frames: await extractFramesEverySecond(sourcePath, workdir, input, source, probe) };
        }
        const firstFrame = await extractFrame(sourcePath, workdir, 0, input, source, probe, "first");
        const lastFrame = await extractFrame(sourcePath, workdir, frameTimestamp(probe.durationMs, probe.durationMs), input, source, probe, "last");
        return { firstFrame, lastFrame };
    } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function extractFrame(
    sourcePath: string,
    workdir: string,
    atMs: number,
    input: ExtractCanvasVideoFramesInput,
    source: AuthorizedCanvasVideoSource,
    probe: CanvasVideoProbe,
    suffix = "current",
): Promise<CanvasExtractedVideoFrame> {
    const outputPath = join(workdir, `frame-${suffix}-${atMs}.jpg`);
    const args =
        suffix === "last"
            ? ["-y", "-sseof", "-1", "-i", sourcePath, "-map", "0:v:0", "-fps_mode", "passthrough", "-update", "1", "-q:v", "2", outputPath]
            : ["-y", "-i", sourcePath, "-ss", (atMs / 1000).toFixed(3), "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", outputPath];
    await runFfmpeg(args, { cwd: workdir });
    return persistFrame(outputPath, atMs, input, source, probe, suffix);
}

async function extractFramesEverySecond(sourcePath: string, workdir: string, input: ExtractCanvasVideoFramesInput, source: AuthorizedCanvasVideoSource, probe: CanvasVideoProbe) {
    const timestamps = integerSecondTimestamps(probe.durationMs);
    const outputPattern = join(workdir, "frame-second-%08d.jpg");
    await runFfmpeg(["-y", "-i", sourcePath, "-map", "0:v:0", "-vf", "fps=1:start_time=0:round=up", "-fps_mode", "passthrough", "-q:v", "2", outputPattern], { cwd: workdir });
    const outputNames = (await readdir(workdir)).filter((name) => /^frame-second-\d{8}\.jpg$/i.test(name)).sort();
    if (outputNames.length !== timestamps.length) throw new CanvasVideoOperationError("FFmpeg 未按每个整数秒完整导出视频帧", 502);
    const frames: CanvasExtractedVideoFrame[] = [];
    for (const [index, atMs] of timestamps.entries()) frames.push(await persistFrame(join(workdir, outputNames[index]!), atMs, input, source, probe, `second-${atMs / 1_000}`));
    return frames;
}

async function persistFrame(
    outputPath: string,
    atMs: number,
    input: ExtractCanvasVideoFramesInput,
    source: AuthorizedCanvasVideoSource,
    probe: CanvasVideoProbe,
    suffix: string,
): Promise<CanvasExtractedVideoFrame> {
    const asset = await writeReferenceMediaFile(outputPath, "image", "image/jpeg", true, {
        ownerUserId: input.ownerUserId,
        source: "canvas-video-frame",
        originalName: `${source.registration.originalName?.replace(/\.[^.]+$/, "") || "video"}-${suffix}.jpg`,
        conversationId: source.registration.conversationId,
        runId: source.registration.runId,
        taskId: source.registration.taskId,
        projectId: source.registration.projectId,
    });
    return {
        storageKey: asset.token,
        serverUrl: `/api/reference-assets/${asset.token.split("/").map(encodeURIComponent).join("/")}`,
        mimeType: asset.mimeType || "image/jpeg",
        bytes: asset.bytes,
        ...(probe.width ? { width: probe.width } : {}),
        ...(probe.height ? { height: probe.height } : {}),
        atMs,
    };
}

function frameTimestamp(requested: number | undefined, durationMs: number) {
    const value = Number(requested);
    if (!Number.isFinite(value) || value < 0) throw new CanvasVideoOperationError("视频截图时间无效");
    if (value > durationMs) throw new CanvasVideoOperationError("视频截图时间超出视频时长");
    // Keep the seek inside the decodable interval so the last-frame request
    // does not cross the container boundary while still selecting the final frame.
    return Math.min(Math.floor(value), Math.max(0, durationMs - 1));
}

function integerSecondTimestamps(durationMs: number) {
    const timestamps: number[] = [];
    for (let atMs = 0; atMs < durationMs; atMs += 1_000) timestamps.push(atMs);
    if (!timestamps.length) throw new CanvasVideoOperationError("视频没有可抽取的有效帧", 502);
    return timestamps;
}
