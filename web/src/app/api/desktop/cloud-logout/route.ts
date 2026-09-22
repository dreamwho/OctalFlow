import { NextResponse } from "next/server";

import { clearCurrentSession, clearSessionCookie } from "@/lib/auth/session";
import { getDesktopEdition, isTrustedDesktopRequest } from "@/lib/server/desktop-runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
    if (getDesktopEdition() !== "commercial" || !isTrustedDesktopRequest(request)) return NextResponse.json({ code: 403, data: null, msg: "桌面会话无效" }, { status: 403 });
    await clearCurrentSession();
    const response = NextResponse.json({ code: 0, data: null, msg: "已退出" }, { headers: { "Cache-Control": "private, no-store" } });
    clearSessionCookie(response, request);
    return response;
}
