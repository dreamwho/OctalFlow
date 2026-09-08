import { realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { ffmpegAvailable, runFfprobe } from "@/lib/server/ffmpeg";
import { getServerDataDir } from "@/lib/server/data-dir";
import { getLocalMediaRegistration, type LocalMediaRegistration } from "@/lib/server/local-media-registry";
import { assertObjectStorageConfigured, getObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";
import { getObjectBytes } from "@/lib/server/object-storage-client";

export class CanvasVideoOperationError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

export type AuthorizedCanvasVideoSource = {
    storageKey: string;
    registration: LocalMediaRegistration;
};

export type CanvasVideoProbe = {
    durationMs: number;
    width?: number;
    height?: number;
    frameRate?: string;
    audio: { present: boolean; codec?: string; channels?: number; sampleRate?: number };
};

export async function authorizeCanvasVideoSource(input: { ownerUserId: string; storageKey: string }): Promise<AuthorizedCanvasVideoSource> {
    const storageKey = normalizeCanvasVideoStorageKey(input.storageKey);
    const registration = await getLocalMediaRegistration(storageKey);
    if (!registration || (registration.scope !== "reference" && registration.scope !== "generation") || registration.type !== "video" || registration.ownerUserId !== input.ownerUserId)
        throw new CanvasVideoOperationError("视频素材不存在或无权操作");
    return { storageKey, registration };
}

export async function materializeCanvasVideoSource(source: AuthorizedCanvasVideoSource, workdir: string) {
    if (source.registration.storageProvider !== "object") {
        const root = resolve(getServerDataDir(), source.registration.scope === "generation" ? "generation-assets" : "reference-assets");
        const sourcePath = resolve(root, source.storageKey);
        if (!isInsideRoot(sourcePath, root)) throw new CanvasVideoOperationError("视频素材文件不存在或已过期", 404);
        try {
            const [realRoot, realSourcePath] = await Promise.all([realpath(root), realpath(sourcePath)]);
            if (!isInsideRoot(realSourcePath, realRoot) || !(await stat(realSourcePath)).isFile()) throw new Error("missing local file");
            return realSourcePath;
        } catch {
            throw new CanvasVideoOperationError("视频素材文件不存在或已过期", 404);
        }
    }
    if (!source.registration.externalObjectKey) throw new CanvasVideoOperationError("视频所在外部存储不可用", 503);
    try {
        const config = await getObjectStorageRuntimeConfig();
        assertObjectStorageConfigured(config);
        if (source.registration.externalStorageId && source.registration.externalStorageId !== config.id) throw new Error("storage mismatch");
        const sourcePath = join(workdir, "source-video");
        await writeFile(sourcePath, await getObjectBytes(config, source.registration.externalObjectKey));
        return sourcePath;
    } catch {
        throw new CanvasVideoOperationError("视频所在外部存储不可用", 503);
    }
}

export async function probeCanvasVideoSource(sourcePath: string): Promise<CanvasVideoProbe> {
    if (!(await ffmpegAvailable())) throw new CanvasVideoOperationError("当前服务器未安装 FFmpeg，无法处理视频", 503);
    try {
        const result = await runFfprobe(
            ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels,sample_rate:format=duration", "-of", "json", sourcePath],
            { timeoutMs: 30_000 },
        );
        const parsed = JSON.parse(result.stdout) as {
            streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; channels?: number; sample_rate?: string | number }>;
            format?: { duration?: string | number };
        };
        const durationSeconds = Number(parsed.format?.duration);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("invalid duration");
        const video = parsed.streams?.find((stream) => stream.codec_type === "video");
        if (!video) throw new Error("missing video stream");
        const detectedFrameRate = videoFrameRate(video);
        const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
        return {
            durationMs: Math.round(durationSeconds * 1_000),
            ...(positive(video.width) ? { width: positive(video.width) } : {}),
            ...(positive(video.height) ? { height: positive(video.height) } : {}),
            ...(detectedFrameRate ? { frameRate: detectedFrameRate } : {}),
            audio: {
                present: Boolean(audio),
                ...(audio?.codec_name ? { codec: audio.codec_name } : {}),
                ...(positive(audio?.channels) ? { channels: positive(audio?.channels) } : {}),
                ...(positive(audio?.sample_rate) ? { sampleRate: positive(audio?.sample_rate) } : {}),
            },
        };
    } catch (error) {
        if (error instanceof CanvasVideoOperationError) throw error;
        throw new CanvasVideoOperationError("无法读取视频媒体信息", 502);
    }
}

export function normalizeCanvasVideoStorageKey(value: string) {
    const storageKey = value.trim().replace(/\\/g, "/");
    if (!storageKey) throw new CanvasVideoOperationError("视频素材标识无效");
    return storageKey;
}

function positive(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function frameRate(value: unknown) {
    if (typeof value !== "string") return undefined;
    const match = value.trim().match(/^(\d+)\/(\d+)$/);
    if (!match) return undefined;
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator > 0 && denominator > 0 ? `${numerator}/${denominator}` : undefined;
}

function videoFrameRate(video: { avg_frame_rate?: string; r_frame_rate?: string }) {
    return frameRate(video.avg_frame_rate) || frameRate(video.r_frame_rate);
}

function isInsideRoot(filePath: string, root: string) {
    return filePath !== root && filePath.startsWith(`${root}${sep}`);
}
