import { NextResponse } from "next/server";

import { getPublicUsersByIds } from "@/lib/auth/store";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser, serializeCurrentUser } from "@/lib/auth/session";
import {
    approveDesktopDeviceAuthorization, DesktopDeviceAuthError, exchangeDesktopDeviceCode,
    getDesktopDeviceAuthorization, getDesktopDeviceSessionUserId, refreshDesktopDeviceSession,
    revokeDesktopDeviceSession, startDesktopDeviceAuthorization,
} from "@/lib/server/desktop-device-auth";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { AUTH_LOGIN_RATE_LIMIT, checkAuthRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ action: string }> };
const privateHeaders = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: Context) {
    const { action } = await context.params;
    try {
        if (action === "request") {
            const user = await getCurrentUser();
            if (!user) return error(401, "请先登录云端账号");
            return ok(await getDesktopDeviceAuthorization(new URL(request.url).searchParams.get("code")));
        }
        if (action === "me") {
            const userId = await getDesktopDeviceSessionUserId(bearerToken(request));
            const user = (await getPublicUsersByIds([userId]))[0];
            if (!user || user.status !== "active") return error(401, "云端账号不可用");
            return ok({ user: serializeCurrentUser(user) });
        }
        return error(404, "接口不存在");
    } catch (cause) { return handleError(cause); }
}

export async function POST(request: Request, context: Context) {
    const { action } = await context.params;
    if (!["start", "approve", "exchange", "refresh", "revoke"].includes(action)) return error(404, "接口不存在");
    const parsed = await readJsonBodyResult<Record<string, unknown>>(request, 2048);
    if (!parsed.ok) return error(parsed.status, parsed.message);
    try {
        if (action === "start") {
            const limit = await checkAuthRateLimit("desktop-device-start", request, "", AUTH_LOGIN_RATE_LIMIT);
            if (!limit.allowed) return error(429, "设备授权请求过于频繁", rateLimitHeaders(limit));
            const started = await startDesktopDeviceAuthorization(parsed.data.deviceLabel);
            const verificationUrl = new URL("/desktop/authorize", resolvePublicRequestOrigin(request));
            verificationUrl.searchParams.set("code", started.userCode);
            return ok({ ...started, verificationUrl: verificationUrl.toString() });
        }
        if (action === "approve") {
            const user = await getCurrentUser();
            if (!user) return error(401, "请先登录云端账号");
            const limit = await checkAuthRateLimit("desktop-device-approve", request, user.id, AUTH_LOGIN_RATE_LIMIT);
            if (!limit.allowed) return error(429, "设备授权操作过于频繁", rateLimitHeaders(limit));
            return ok(await approveDesktopDeviceAuthorization(parsed.data.userCode, user.id));
        }
        if (action === "exchange") {
            const result = await exchangeDesktopDeviceCode(parsed.data.deviceCode);
            return NextResponse.json({ code: result.status === "pending" ? 202 : 0, data: result, msg: result.status === "pending" ? "等待用户在网页确认" : "设备授权成功" }, { status: result.status === "pending" ? 202 : 200, headers: privateHeaders });
        }
        if (action === "refresh") return ok(await refreshDesktopDeviceSession(parsed.data.refreshToken));
        await revokeDesktopDeviceSession(parsed.data.refreshToken);
        return ok({ revoked: true });
    } catch (cause) { return handleError(cause); }
}

function bearerToken(request: Request) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") || "");
    return match?.[1] || "";
}
function ok(data: unknown) { return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: privateHeaders }); }
function error(status: number, msg: string, headers: HeadersInit = {}) {
    return NextResponse.json({ code: status, data: null, msg }, { status, headers: { ...privateHeaders, ...headers } });
}
function handleError(cause: unknown) {
    if (cause instanceof DesktopDeviceAuthError) return error(cause.status, cause.message);
    console.error("Desktop device authorization failed", cause);
    return error(500, "设备授权服务暂不可用");
}
