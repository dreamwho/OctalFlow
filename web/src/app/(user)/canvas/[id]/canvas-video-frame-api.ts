"use client";

export type CanvasVideoFrameAsset = {
    storageKey: string;
    serverUrl: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    atMs: number;
};

export type CanvasDepthVideoAsset = {
    storageKey: string;
    serverUrl: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export async function extractCanvasVideoFrames(input: { storageKey: string; mode: "both" | "current" | "seconds"; timeMs?: number }) {
    const response = await fetch("/api/canvas/video-frames", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => ({}))) as { data?: { firstFrame?: CanvasVideoFrameAsset; lastFrame?: CanvasVideoFrameAsset; frame?: CanvasVideoFrameAsset; frames?: CanvasVideoFrameAsset[] }; msg?: string };
    if (!response.ok || !payload.data) throw new Error(payload.msg || "视频截帧失败");
    return payload.data;
}

export async function extractCanvasVideoDepth(input: { storageKey: string }, onProgress?: (progress: { stage: string; percent?: number }) => void) {
    const response = await fetch("/api/canvas/video-depth", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(input),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.msg || "视频深度提取失败");
    }
    if (!response.body) throw new Error("视频深度提取响应为空");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    let video: CanvasDepthVideoAsset | undefined;
    try {
        while (true) {
            const { value, done } = await reader.read();
            pending += value || "";
            const lines = pending.split("\n");
            pending = lines.pop() || "";
            if (done && pending.trim()) lines.push(pending);
            for (const line of lines.filter((item) => item.trim())) {
                const event = JSON.parse(line) as { code?: number; msg?: string; progress?: { stage: string; percent?: number }; data?: { video?: CanvasDepthVideoAsset } };
                if (event.code && event.code !== 0) throw new Error(event.msg || "视频深度提取失败");
                if (event.progress) onProgress?.(event.progress);
                if (event.data?.video) video = event.data.video;
            }
            if (done) break;
        }
    } finally {
        reader.releaseLock();
    }
    if (!video) throw new Error("视频深度提取连接中断，未收到完成结果");
    return video;
}

export async function analyzeCanvasVideo(input: { storageKey: string; requestId: string }) {
    const response = await fetch("/api/canvas/video-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => ({}))) as { data?: { analysisText?: string; model?: string }; msg?: string };
    if (!response.ok || !payload.data?.analysisText) throw new Error(payload.msg || "视频分析失败");
    return payload.data;
}
