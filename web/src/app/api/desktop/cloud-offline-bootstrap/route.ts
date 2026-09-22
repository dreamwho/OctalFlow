import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { setSessionCookie } from "@/lib/auth/session";
import { restoreDesktopCloudUser } from "@/lib/server/desktop-cloud-user";
import { getDesktopEdition, isTrustedDesktopMainRequest } from "@/lib/server/desktop-runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
    if (getDesktopEdition() !== "commercial" || !isTrustedDesktopMainRequest(request)) return failure(403, "桌面主进程凭据无效");
    const parsed = await readJsonBodyResult<{ cloudUserId?: unknown }>(request, 1024);
    if (!parsed.ok) return failure(parsed.status, parsed.message);
    try {
        const binding = await restoreDesktopCloudUser(String(parsed.data.cloudUserId || ""));
        const response = NextResponse.json({ code: 0, data: { localUserId: binding.localUserId, cloudUserId: binding.cloudUserId, offline: true }, msg: "本地项目已解锁；云端操作需要联网" }, { headers: { "Cache-Control": "private, no-store" } });
        setSessionCookie(response, binding.sessionValue, request);
        return response;
    } catch (error) {
        return failure(403, error instanceof Error ? error.message : "本地账号恢复失败");
    }
}

function failure(status: number, msg: string) {
    return NextResponse.json({ code: status, data: null, msg }, { status, headers: { "Cache-Control": "private, no-store" } });
}
