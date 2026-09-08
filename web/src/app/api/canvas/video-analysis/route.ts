import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { analyzeCanvasVideo } from "@/lib/server/canvas-video-analysis-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { CanvasVideoOperationError } from "@/lib/server/canvas-video-source-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = { storageKey?: unknown; requestId?: unknown };

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<RequestBody>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const storageKey = typeof parsed.data.storageKey === "string" ? parsed.data.storageKey.trim() : "";
    const requestId = typeof parsed.data.requestId === "string" ? parsed.data.requestId.trim() : "";
    if (!storageKey || !requestId) return NextResponse.json({ code: 400, data: null, msg: "视频分析参数无效" }, { status: 400 });
    try {
        const result = await analyzeCanvasVideo({
            ownerUserId: user.id,
            storageKey,
            requestId,
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
        });
        const response = NextResponse.json({ code: 0, data: { analysisText: result.analysisText, model: result.model }, msg: "视频分析已完成" });
        if (typeof result.pointsRemaining === "number") response.headers.set("x-octalaicanvas-points-remaining", String(result.pointsRemaining));
        return response;
    } catch (error) {
        const status = error instanceof CanvasVideoOperationError ? error.status : 502;
        return NextResponse.json({ code: status, data: null, msg: error instanceof Error ? error.message : "视频分析失败" }, { status });
    }
}
