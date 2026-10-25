import { after, NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { authorizedGeminiAiVideoNotification, recoverNotifiedGeminiAiVideo } from "@/lib/server/geminiai-video-notification";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    if (!authorizedGeminiAiVideoNotification(request)) return NextResponse.json({ code: 401, data: null, msg: "Provider 认证失败" }, { status: 401 });
    const parsed = await readJsonBodyResult<{ upstreamTaskId?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: 400, data: null, msg: parsed.message }, { status: parsed.status });
    const id = parsed.data?.upstreamTaskId;
    if (typeof id !== "string" || !/^vt_[0-9a-f]{16}$/.test(id)) return NextResponse.json({ code: 400, data: null, msg: "Omni 任务 ID 无效" }, { status: 400 });
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    after(() => recoverNotifiedGeminiAiVideo(id, origin).catch((error) => console.warn("Omni completion recovery deferred", { upstreamTaskId: id, error: error instanceof Error ? error.message : String(error) })));
    return NextResponse.json({ code: 0, data: null, msg: "生成完成通知已受理" });
}
