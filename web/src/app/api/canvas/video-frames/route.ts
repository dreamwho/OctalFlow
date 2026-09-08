import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { extractCanvasVideoFrames } from "@/lib/server/canvas-video-frame-service";
import { CanvasVideoOperationError } from "@/lib/server/canvas-video-source-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = { storageKey?: unknown; mode?: unknown; timeMs?: unknown };

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<RequestBody>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const storageKey = typeof parsed.data.storageKey === "string" ? parsed.data.storageKey.trim() : "";
    const mode = parsed.data.mode === "current" ? "current" : parsed.data.mode === "seconds" ? "seconds" : parsed.data.mode === "both" ? "both" : "";
    if (!storageKey || !mode) return NextResponse.json({ code: 400, data: null, msg: "视频截帧参数无效" }, { status: 400 });
    try {
        const result = await extractCanvasVideoFrames({ ownerUserId: user.id, storageKey, mode, timeMs: typeof parsed.data.timeMs === "number" ? parsed.data.timeMs : undefined });
        return NextResponse.json({ code: 0, data: result, msg: "视频帧已保存" });
    } catch (error) {
        const status = error instanceof CanvasVideoOperationError ? error.status : 502;
        return NextResponse.json({ code: status, data: null, msg: error instanceof Error ? error.message : "视频截帧失败" }, { status });
    }
}
