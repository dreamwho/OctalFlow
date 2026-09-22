import { NextResponse, type NextRequest } from "next/server";
import { getTrustedProxyHops } from "@/lib/server/trusted-proxy";

export function proxy(request: NextRequest) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const contentSecurityPolicy = buildContentSecurityPolicy(nonce, request.headers.get("host") || request.nextUrl.hostname, publicRequestProtocol(request));
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", contentSecurityPolicy);

    if (process.env.DREAMYO_DESKTOP_EDITION === "commercial") {
        const pathname = request.nextUrl.pathname;
        if (["/", "/login", "/register", "/install"].includes(pathname)) return NextResponse.redirect(new URL("/desktop/connect", process.env.DREAMYO_INTERNAL_ORIGIN || request.url));
        if (pathname === "/desktop/authorize" || isAdminLocalCloudPath(pathname)) return securedJsonResponse({ code: 403, data: null, msg: "商用桌面版的云端业务必须通过云端 API" }, 403, contentSecurityPolicy);
        if (isCommercialUnroutedGenerationPath(pathname)) return securedJsonResponse({ code: 503, data: null, msg: "商用桌面模型路由尚未启用，请先使用 WEB 版生成" }, 503, contentSecurityPolicy);
    }
    if (process.env.DREAMYO_DESKTOP_EDITION === "admin") {
        const pathname = request.nextUrl.pathname;
        if (pathname === "/admin/setup") return NextResponse.redirect(new URL("/admin?section=channels", process.env.DREAMYO_INTERNAL_ORIGIN || request.url));
        if (["/", "/login", "/register", "/install"].includes(pathname)) {
            return NextResponse.redirect(new URL("/api/desktop/bootstrap?next=/canvas", process.env.DREAMYO_INTERNAL_ORIGIN || request.url));
        }
        if (pathname === "/desktop/authorize" || isAdminLocalCloudPath(pathname)) return securedJsonResponse({ code: 403, data: null, msg: "管理员本地版不提供云端账户与商业服务" }, 403, contentSecurityPolicy);
    }

    if (!request.nextUrl.pathname.startsWith("/api/") || request.nextUrl.pathname.startsWith("/api/billing/webhooks/") || ["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        return securedNextResponse(requestHeaders, contentSecurityPolicy);
    }

    const requestOrigin = publicRequestOrigin(request);
    const origin = request.headers.get("origin");
    if (origin && origin !== requestOrigin) return securedJsonResponse({ error: "跨站请求已被拦截" }, 403, contentSecurityPolicy);

    const referer = request.headers.get("referer");
    if (referer) {
        try {
            if (new URL(referer).origin !== requestOrigin) return securedJsonResponse({ error: "跨站请求已被拦截" }, 403, contentSecurityPolicy);
        } catch {
            return securedJsonResponse({ error: "请求来源无效" }, 403, contentSecurityPolicy);
        }
    }

    return securedNextResponse(requestHeaders, contentSecurityPolicy);
}

function isAdminLocalCloudPath(pathname: string) {
    const roots = ["/billing", "/works", "/community", "/gallery", "/me", "/announcements", "/prompts", "/profile", "/u", "/share", "/api/billing", "/api/cloud-storage", "/api/works", "/api/community", "/api/public", "/api/announcements", "/api/prompts", "/api/cdk", "/api/points", "/api/referrals", "/api/auth/account-deletion", "/api/auth/logout", "/api/auth/profile", "/api/auth/password", "/api/auth/mfa", "/api/auth/data-export", "/api/auth/email-code", "/api/auth/login", "/api/auth/register", "/api/auth/wechat", "/api/admin/billing", "/api/admin/cloud-storage", "/api/admin/users", "/api/admin/announcements", "/api/admin/works", "/api/admin/prompts", "/api/admin/referrals", "/api/admin/object-storage"];
    return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

function isCommercialUnroutedGenerationPath(pathname: string) {
    const roots = ["/api/ai", "/api/agent", "/api/create", "/api/dola", "/api/geminiai", "/api/gemini-tools", "/api/chatgpt-api", "/api/dreamina", "/api/image-tasks", "/api/video-tasks", "/api/video-generation-tasks", "/api/audio-tasks", "/api/text-tasks", "/api/canvas/video-analysis", "/api/canvas/dola-watermark", "/api/drama/analyze", "/api/drama/review", "/api/drama/render", "/api/qwen-audio", "/api/minimax"];
    return /^\/api\/canvas\/projects\/[^/]+\/assistant-conversations(?:\/|$)/.test(pathname) || roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export const config = {
    matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};

function securedNextResponse(requestHeaders: Headers, contentSecurityPolicy: string) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
}

function securedJsonResponse(body: unknown, status: number, contentSecurityPolicy: string) {
    const response = NextResponse.json(body, { status });
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
}

function buildContentSecurityPolicy(nonce: string, host: string, protocol: string) {
    const isDev = process.env.NODE_ENV !== "production";
    const hostname = host
        .toLowerCase()
        .replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
        .replace(/:\d+$/, "");
    const localCanvasHost = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    return [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        "font-src 'self' data: https:",
        `connect-src 'self' https:${isDev ? " http: ws: wss:" : localCanvasHost ? " http://localhost:* http://127.0.0.1:*" : ""}`,
        "worker-src 'self' blob:",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        ...(isDev || localCanvasHost || protocol !== "https" ? [] : ["upgrade-insecure-requests"]),
    ].join("; ");
}

function publicRequestProtocol(request: NextRequest) {
    const forwardedProto = getTrustedProxyHops() > 0 ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() : "";
    return forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : request.nextUrl.protocol.replace(/:$/, "").toLowerCase();
}

function publicRequestOrigin(request: NextRequest) {
    const trustForwarded = getTrustedProxyHops() > 0;
    const forwardedProto = trustForwarded ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : "";
    const forwardedHost = trustForwarded ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : "";
    const protocol = forwardedProto || request.nextUrl.protocol.replace(/:$/, "");
    const host = forwardedHost || request.headers.get("host") || request.nextUrl.host;
    try {
        const origin = new URL(`${protocol}://${host}`);
        return origin.protocol === "http:" || origin.protocol === "https:" ? origin.origin : request.nextUrl.origin;
    } catch {
        return request.nextUrl.origin;
    }
}
