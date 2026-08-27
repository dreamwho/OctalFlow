import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dramaOutputDimensions, normalizeDramaImageSize } from "@/lib/drama-image-size";
import type { AgentRun, AgentRunTask } from "@/lib/server/agent-run-store";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { ffmpegAvailable, runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { taskReferences } from "@/lib/server/agent-run-execution-helpers";

export async function composeVideoRemakeTask(task: AgentRunTask, run: AgentRun, origin: string, cookie: string) {
    if (!(await ffmpegAvailable())) throw new Error("当前服务器未安装 FFmpeg，无法自动合成复刻成片");
    const videoReferences = taskReferences(task).filter((reference) => reference.type === "video");
    if (!videoReferences.length) throw new Error("复刻成片缺少已完成的视频片段");

    const workdir = await mkdtemp(join(tmpdir(), "octaflow-remake-"));
    try {
        const size = dramaOutputDimensions(normalizeDramaImageSize(task.ratio) || "9:16");
        const clips: string[] = [];
        for (let index = 0; index < videoReferences.length; index += 1) {
            const sourcePath = join(workdir, `source-${index}.mp4`);
            await downloadMedia(videoReferences[index].url, sourcePath, origin, cookie, 300 * 1024 * 1024);
            const clipPath = join(workdir, `clip-${index}.mp4`);
            const hasAudio = await hasAudioStream(sourcePath, workdir);
            const args = ["-y", "-i", sourcePath];
            if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
            args.push(
                "-filter_complex",
                `[0:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v]${hasAudio ? ";[0:a]aresample=async=1:first_pts=0[a]" : ""}`,
                "-map",
                "[v]",
                "-map",
                hasAudio ? "[a]" : "1:a",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "22",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
                clipPath,
            );
            await runFfmpeg(args, { cwd: workdir });
            clips.push(clipPath);
        }
        await writeFile(join(workdir, "concat.txt"), clips.map((_, index) => `file 'clip-${index}.mp4'`).join("\n"), "utf8");
        const outputPath = join(workdir, "octaflow-remake.mp4");
        await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "-movflags", "+faststart", outputPath], { cwd: workdir });
        const durationMs = await readDurationMs(outputPath, workdir);
        const asset = await writeReferenceMediaFile(outputPath, "video", "video/mp4", true, {
            ownerUserId: run.userId,
            source: "agent",
            conversationId: run.conversationId,
            taskId: task.id,
            projectId: run.projectId,
            originalName: `${task.title || "OctalFlow 复刻成片"}.mp4`,
        });
        const serverUrl = `/api/reference-assets/${asset.token
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/")}`;
        return { url: serverUrl, serverUrl, storageKey: asset.token, storageKind: "local", mimeType: "video/mp4", durationMs, width: size.width, height: size.height };
    } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function hasAudioStream(path: string, cwd: string) {
    const result = await runFfprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1:nokey=1", path], { cwd, timeoutMs: 30_000 });
    return result.stdout.trim() === "audio";
}

async function readDurationMs(path: string, cwd: string) {
    const result = await runFfprobe(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { cwd, timeoutMs: 30_000 });
    const seconds = Number(result.stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : undefined;
}

async function downloadMedia(url: string, path: string, origin: string, cookie: string, maxBytes: number) {
    const response = url.startsWith("/") ? await fetchInternalApi(`${origin}${url}`, { headers: cookie ? { cookie } : undefined, signal: AbortSignal.timeout(3 * 60_000) }) : await fetchExternalMedia(url);
    if (!response.ok || !response.body) throw new Error(`视频片段下载失败（${response.status}）`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("视频片段超过服务器合成大小限制");
    const file = await open(path, "w");
    let bytes = 0;
    try {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                throw new Error("视频片段超过服务器合成大小限制");
            }
            await file.write(value);
        }
    } finally {
        await file.close();
    }
    if (!bytes) throw new Error("视频片段为空");
}

async function fetchExternalMedia(initialUrl: string) {
    let target = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response = await fetchSafeOutbound(target, { redirect: "manual", signal: AbortSignal.timeout(3 * 60_000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        if (!location) throw new Error("视频片段重定向地址无效");
        target = new URL(location, target).toString();
    }
    throw new Error("视频片段重定向次数过多");
}
