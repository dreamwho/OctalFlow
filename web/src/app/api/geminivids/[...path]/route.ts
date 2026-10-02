import { NextResponse } from "next/server";

import { authorizeGeminiVidsApiKey, getGeminiVidsGatewaySettings } from "@/lib/server/geminivids-gateway-store";
import { GeminiVidsProviderError, geminiVidsRuntimeRequest, isGeminiVidsRuntimePath } from "@/lib/server/geminivids-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(request: Request) {
    return (request.headers.get("x-forwarded-for")?.split(",")[0] || request.headers.get("x-real-ip") || "").trim();
}

function extractKey(request: Request) {
    const authorization = request.headers.get("authorization") || "";
    if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
    return request.headers.get("x-api-key")?.trim() || "";
}

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
    const { path } = await context.params;
    const runtimePath = `/${(path || []).join("/")}${new URL(request.url).search}`;
    if (!isGeminiVidsRuntimePath(runtimePath)) return NextResponse.json({ error: "GeminiVids 不支持该接口" }, { status: 404 });

    const rawKey = extractKey(request);
    if (!rawKey) return NextResponse.json({ error: "缺少 API 密钥" }, { status: 401 });
    const gateway = await getGeminiVidsGatewaySettings();
    if (!gateway.enabled) return NextResponse.json({ error: "GeminiVids 网关未启用" }, { status: 503 });
    const apiKey = await authorizeGeminiVidsApiKey(rawKey, clientIp(request));
    if (!apiKey) return NextResponse.json({ error: "API 密钥无效或已过期" }, { status: 401 });

    try {
        const upstream = await geminiVidsRuntimeRequest(runtimePath, {
            method: request.method,
            headers: { "content-type": request.headers.get("content-type") || "", accept: request.headers.get("accept") || "" },
            body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
            signal: request.signal,
        }, { logSource: "external" });
        const headers = new Headers();
        const contentType = upstream.headers.get("content-type");
        if (contentType) headers.set("content-type", contentType);
        const length = upstream.headers.get("content-length");
        if (length) headers.set("content-length", length);
        return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
        const status = error instanceof GeminiVidsProviderError ? error.status : 502;
        const message = error instanceof Error ? error.message : "GeminiVids 网关请求失败";
        return NextResponse.json({ error: message }, { status });
    }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
