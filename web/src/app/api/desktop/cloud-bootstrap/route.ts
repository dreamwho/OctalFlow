import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { setSessionCookie } from "@/lib/auth/session";
import { bindDesktopCloudUser, type DesktopCloudIdentity } from "@/lib/server/desktop-cloud-user";
import { getDesktopEdition, isTrustedDesktopMainRequest } from "@/lib/server/desktop-runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
    if (getDesktopEdition() !== "commercial" || !isTrustedDesktopMainRequest(request)) return failure(403, "桌面会话无效");
    const parsed = await readJsonBodyResult<{ accessToken?: unknown }>(request, 2048);
    if (!parsed.ok) return failure(parsed.status, parsed.message);
    if (typeof parsed.data.accessToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.data.accessToken)) return failure(400, "云端设备凭据无效");
    const origin = cloudOrigin();
    if (!origin) return failure(503, "云端站点地址未配置");
    try {
        const response = await fetch(new URL("/api/desktop/devices/me", origin), {
            headers: { Authorization: `Bearer ${parsed.data.accessToken}` },
            redirect: "error",
            cache: "no-store",
        });
        if (!response.ok) return failure(401, "云端登录已失效，请重新授权设备");
        const payload = await response.json() as { data?: { user?: DesktopCloudIdentity } };
        if (!payload.data?.user || payload.data.user.status !== "active") return failure(401, "云端账号不可用");
        const binding = await bindDesktopCloudUser(payload.data.user);
        const result = NextResponse.json({ code: 0, data: { localUserId: binding.localUserId, cloudUserId: binding.cloudUserId }, msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
        setSessionCookie(result, binding.sessionValue, request);
        return result;
    } catch (error) {
        console.error("Commercial desktop cloud bootstrap failed", error);
        return failure(503, "连接云端失败，请检查网络后重试");
    }
}

function cloudOrigin() {
    try {
        const url = new URL(process.env.DREAMYO_DESKTOP_CLOUD_ORIGIN || "");
        const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
        return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && (url.protocol === "https:" || (url.protocol === "http:" && loopback && process.env.DREAMYO_DESKTOP_PACKAGED !== "1")) ? url.origin : "";
    } catch { return ""; }
}

function failure(status: number, msg: string) {
    return NextResponse.json({ code: status, data: null, msg }, { status, headers: { "Cache-Control": "private, no-store" } });
}
