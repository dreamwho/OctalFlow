import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { configuredModelFallback } from "@/lib/server/model-fallback";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const capability = params.get("capability");
    if (capability !== "image" && capability !== "video") return NextResponse.json({ code: 400, data: null, msg: "仅支持图片和视频模型" }, { status: 400 });
    const settings = await getFreshAuthSettings();
    const data = configuredModelFallback(settings, user.role, params.get("model") || "", capability);
    return NextResponse.json({ code: 0, data, msg: "" }, { headers: { "Cache-Control": "no-store" } });
}
