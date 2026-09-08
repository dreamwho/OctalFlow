import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { runCanvasVideoDepthTask } from "@/lib/server/canvas-video-depth-task";
import { CanvasVideoOperationError } from "@/lib/server/canvas-video-source-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = { storageKey?: unknown };

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<RequestBody>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const storageKey = typeof parsed.data.storageKey === "string" ? parsed.data.storageKey.trim() : "";
    if (!storageKey) return NextResponse.json({ code: 400, data: null, msg: "视频深度提取参数无效" }, { status: 400 });
    if (request.headers.get("accept") === "application/x-ndjson") {
        let connected = true;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const send = (data: unknown) => {
                    if (connected) controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
                };
                try {
                    const result = await runCanvasVideoDepthTask({ ownerUserId: user.id, storageKey }, (progress) => send({ progress }));
                    send({ code: 0, data: result });
                } catch (error) {
                    send({ code: 502, msg: error instanceof Error ? error.message : "视频深度提取失败" });
                } finally {
                    if (connected) controller.close();
                }
            },
            cancel() {
                connected = false;
            },
        });
        return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    }
    try {
        const result = await runCanvasVideoDepthTask({ ownerUserId: user.id, storageKey });
        return NextResponse.json({ code: 0, data: result, msg: "视频深度图已保存" });
    } catch (error) {
        const status = error instanceof CanvasVideoOperationError ? error.status : 502;
        return NextResponse.json({ code: status, data: null, msg: error instanceof Error ? error.message : "视频深度提取失败" }, { status });
    }
}
