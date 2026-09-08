import { open, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { AgentSkill } from "@/lib/auth/store-types";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { ffmpegAvailable, runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { readReferenceAsset } from "@/lib/server/reference-asset-store";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { selectedVideoRemakeSkill, type VideoRemakeBoundary } from "@/lib/server/video-remake-orchestration";

export type VideoRemakeSourceAnalysis = {
    durationSeconds?: number;
    width?: number;
    height?: number;
    boundaries: VideoRemakeBoundary[];
    storyboardFrames?: string[];
};

export function canvasVideoRemakeSourceAsset(snapshot: unknown, userId: string, conversationId: string): CreativeAsset | undefined {
    const source = record(snapshot);
    const nodes = Array.isArray(source.nodes) ? source.nodes.map(record) : [];
    const selected = new Set(Array.isArray(source.selectedNodeIds) ? source.selectedNodeIds.filter((id): id is string => typeof id === "string") : []);
    const connections = Array.isArray(source.connections) ? source.connections.map(record) : [];
    const remakeIds = new Set(nodes.filter((node) => node.type === "video-remake" && selected.has(String(node.id || ""))).map((node) => String(node.id)));
    const connectedVideoIds = new Set(
        connections.flatMap((connection) => {
            const from = String(connection.fromNodeId || "");
            const to = String(connection.toNodeId || "");
            return remakeIds.has(from) ? [to] : remakeIds.has(to) ? [from] : [];
        }),
    );
    const video = nodes.find((node) => node.type === "video" && selected.has(String(node.id || ""))) || nodes.find((node) => node.type === "video" && connectedVideoIds.has(String(node.id || "")));
    if (!video) return undefined;
    const metadata = record(video.metadata);
    const url = [metadata.url, metadata.serverUrl, metadata.remoteUrl].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    if (!url) return undefined;
    const now = Date.now();
    return {
        id: `canvas-video-${String(video.id || "source")}`,
        userId,
        conversationId,
        ordinal: 0,
        type: "video",
        status: "ready",
        title: String(video.title || "画布参考视频"),
        serverUrl: url.startsWith("/") ? url : undefined,
        remoteUrl: url.startsWith("http") ? url : undefined,
        durationMs: positiveNumber(metadata.durationMs),
        width: positiveNumber(metadata.naturalWidth) || positiveNumber(video.width),
        height: positiveNumber(metadata.naturalHeight) || positiveNumber(video.height),
        metadata: { source: "canvas-video-reference" },
        createdAt: now,
        updatedAt: now,
    };
}

export async function enrichVideoRemakeSourceAssets(assets: CreativeAsset[], skills: AgentSkill[], origin: string, cookie: string, signal?: AbortSignal) {
    if (!selectedVideoRemakeSkill(skills) && !assets.some((asset) => asset.metadata.source === "canvas-video-reference")) return assets;
    const source = assets.find((asset) => asset.type === "video" && asset.status === "ready");
    if (!source || !(await ffmpegAvailable())) return assets;
    try {
        const analysis = await analyzeVideoRemakeSource(source, origin, cookie, signal);
        return assets.map((asset) =>
            asset.id === source.id
                ? {
                      ...asset,
                      durationMs: asset.durationMs || (analysis.durationSeconds ? Math.round(analysis.durationSeconds * 1_000) : undefined),
                      width: asset.width || analysis.width,
                      height: asset.height || analysis.height,
                      metadata: { ...asset.metadata, videoRemakeAnalysis: analysis },
                  }
                : asset,
        );
    } catch {
        return assets;
    }
}

export function videoRemakeStoryboardFrames(assets: CreativeAsset[]) {
    return assets.flatMap((asset) => {
        const analysis = record(asset.metadata.videoRemakeAnalysis);
        return Array.isArray(analysis.storyboardFrames) ? analysis.storyboardFrames.filter((value): value is string => typeof value === "string" && value.startsWith("data:image/jpeg;base64,")) : [];
    });
}

export async function analyzeVideoRemakeSource(asset: CreativeAsset, origin: string, cookie: string, signal?: AbortSignal): Promise<VideoRemakeSourceAnalysis> {
    const local = asset.storageKind === "local" && asset.storageKey ? await readReferenceAsset(asset.storageKey) : null;
    const workdir = local ? undefined : await mkdtemp(join(tmpdir(), "octaflow-source-analysis-"));
    try {
        const sourcePath = local?.filePath || join(workdir!, "source-video");
        if (!local) await downloadSource(asset.serverUrl || asset.remoteUrl || "", sourcePath, origin, cookie, signal);
        const probe = await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", sourcePath], { timeoutMs: 30_000, signal });
        const details = JSON.parse(probe.stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const threshold = sceneThreshold();
        const detected = await runFfmpeg(["-hide_banner", "-i", sourcePath, "-vf", `select=gt(scene\\,${threshold}),showinfo`, "-an", "-f", "null", "-"], { timeoutMs: 5 * 60_000, signal });
        const boundaries = Array.from(detected.stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g))
            .map((match) => Number(match[1]))
            .filter((value, index, values) => Number.isFinite(value) && value > 0 && (index === 0 || value - values[index - 1] >= 0.35))
            .map((atSeconds) => ({ atSeconds: Math.round(atSeconds * 100) / 100, kind: "hard_cut" as const }));
        const durationSeconds = positiveNumber(details.format?.duration);
        const storyboardFrames = durationSeconds ? await extractStoryboardFrames(sourcePath, workdir || tmpdir(), durationSeconds, signal) : [];
        return {
            durationSeconds,
            width: positiveNumber(details.streams?.[0]?.width),
            height: positiveNumber(details.streams?.[0]?.height),
            boundaries,
            ...(storyboardFrames.length ? { storyboardFrames } : {}),
        };
    } finally {
        if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function extractStoryboardFrames(sourcePath: string, outputDir: string, durationSeconds: number, signal?: AbortSignal) {
    const configured = Number(process.env.VIDEO_REMAKE_STORYBOARD_FRAME_LIMIT);
    const limit = Number.isSafeInteger(configured) && configured >= 2 && configured <= 12 ? configured : 8;
    const frameDir = await mkdtemp(join(outputDir, "octaflow-frames-"));
    try {
        const interval = Math.max(0.5, durationSeconds / limit);
        await runFfmpeg(["-hide_banner", "-i", sourcePath, "-vf", `fps=1/${interval},scale=640:-2:force_original_aspect_ratio=decrease`, "-frames:v", String(limit), "-q:v", "3", join(frameDir, "frame-%02d.jpg")], { timeoutMs: 3 * 60_000, signal });
        const files = (await readdir(frameDir)).filter((name) => name.endsWith(".jpg")).sort();
        return Promise.all(files.map(async (name) => `data:image/jpeg;base64,${(await readFile(join(frameDir, name))).toString("base64")}`));
    } finally {
        await rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function downloadSource(url: string, path: string, origin: string, cookie: string, signal?: AbortSignal) {
    if (!url) throw new Error("参考视频没有可分析的媒体地址");
    const response = url.startsWith("/") ? await fetchInternalApi(`${origin}${url}`, { headers: cookie ? { cookie } : undefined, signal }) : await fetchSafeOutbound(url, { redirect: "follow", signal });
    if (!response.ok || !response.body) throw new Error(`参考视频读取失败（${response.status}）`);
    const file = await open(path, "w");
    try {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await file.write(value);
        }
    } finally {
        await file.close();
    }
}

function sceneThreshold() {
    const configured = Number(process.env.VIDEO_REMAKE_SCENE_THRESHOLD);
    return Number.isFinite(configured) && configured >= 0.05 && configured <= 0.8 ? configured : 0.2;
}

function positiveNumber(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
