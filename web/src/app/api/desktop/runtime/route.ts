import { NextResponse } from "next/server";

import { getDesktopRuntimeInfo } from "@/lib/server/desktop-runtime";

export const runtime = "nodejs";

export async function GET() {
    const desktop = getDesktopRuntimeInfo();
    if (!desktop) return NextResponse.json({ code: 404, data: null, msg: "当前不是桌面运行环境" }, { status: 404 });
    return NextResponse.json({ code: 0, data: desktop, msg: "ok" });
}
