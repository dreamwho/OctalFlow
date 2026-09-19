import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { appendDolaRequestLog } from "@/lib/server/dola/log-store";
import { createDolaWatermarkResolution } from "@/lib/server/dola/watermark-service";
import { DolaWatermarkError } from "@/lib/server/dola/watermark-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const startedAt = Date.now();
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<{ storageKey?: unknown; payload?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const storageKey = typeof parsed.data.storageKey === "string" ? parsed.data.storageKey.trim() : "";
    if (!parsed.data.payload) return NextResponse.json({ code: 400, data: null, msg: "Dola 去水印缺少源视频信息" }, { status: 400 });
    try {
        const result = await createDolaWatermarkResolution({ ownerUserId: user.id, storageKey: storageKey || undefined, payload: parsed.data.payload });
        void appendDolaRequestLog({
            source: "runtime",
            capability: "video",
            method: "POST",
            path: "/api/canvas/dola-watermark",
            model: "dola-watermark-resolver",
            statusCode: 200,
            durationMs: Date.now() - startedAt,
            phase: "success",
            requestPreview: JSON.stringify({ storageKey, payloadType: typeof parsed.data.payload }),
            responsePreview: JSON.stringify({ downloadUrl: result.downloadUrl.slice(0, 100) + "...", variant: result.variant }),
        }).catch(() => {});
        return NextResponse.json({ code: 0, data: result, msg: "Dola 去水印地址已解析" });
    } catch (error) {
        const status = error instanceof DolaWatermarkError && error.code === "UNSAFE_URL" ? 422 : error instanceof Error && /无权|不存在/.test(error.message) ? 403 : 502;
        const errMsg = error instanceof Error ? error.message : "Dola 去水印失败";
        void appendDolaRequestLog({
            source: "runtime",
            capability: "video",
            method: "POST",
            path: "/api/canvas/dola-watermark",
            model: "dola-watermark-resolver",
            statusCode: status,
            durationMs: Date.now() - startedAt,
            phase: "failed",
            error: errMsg,
            requestPreview: JSON.stringify({ storageKey, payloadType: typeof parsed.data.payload }),
            responsePreview: JSON.stringify({ error: errMsg, code: error instanceof DolaWatermarkError ? error.code : undefined }),
        }).catch(() => {});
        return NextResponse.json({ code: status, data: null, msg: errMsg }, { status });
    }
}
