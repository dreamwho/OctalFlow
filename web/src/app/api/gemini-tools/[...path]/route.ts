import { authorizeGeminiToolsApiKey, recordGeminiToolsApiKeyTokens } from "@/lib/server/gemini-tools-store";
import { geminiToolsRuntimeRequest } from "@/lib/server/gemini-tools-service";
import { getClientIp } from "@/lib/server/security";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

type Context = { params: Promise<{ path: string[] }> };

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request, context: Context) {
    return proxy(request, context);
}

export async function POST(request: Request, context: Context) {
    return proxy(request, context);
}

async function proxy(request: Request, context: Context) {
    const rawKey = apiKey(request);
    if (!rawKey) return jsonWithCors({ error: { message: "缺少 GeminiTools API Key" } }, 401);
    const key = await authorizeGeminiToolsApiKey(rawKey, getClientIp(request));
    if (!key) return jsonWithCors({ error: { message: "GeminiTools API Key 无效、已过期或来源 IP 不允许" } }, 401);
    const { path } = await context.params;
    let body: string | undefined;
    try {
        body = request.method === "GET" ? undefined : new TextDecoder().decode(await readRequestBodyBytes(request, 4 * 1024 * 1024));
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return jsonWithCors({ error: { message: error.message } }, error.status);
        throw error;
    }
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    const accept = request.headers.get("accept");
    if (contentType) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    const response = await geminiToolsRuntimeRequest(`/${path.join("/")}${new URL(request.url).search}`, { method: request.method, headers, body }, { keyPrefix: key.prefix });
    if (response.ok) {
        const usage = Number(response.headers.get("x-gemini-tools-total-tokens") || 0);
        if (usage > 0) await recordGeminiToolsApiKeyTokens(key.id, usage);
    }
    const outHeaders = new Headers(response.headers);
    for (const [header, val] of Object.entries(CORS_HEADERS)) {
        outHeaders.set(header, val);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
    });
}

function jsonWithCors(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            ...CORS_HEADERS,
        },
    });
}

function apiKey(request: Request) {
    const authorization = request.headers.get("authorization")?.trim() || "";
    if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, "").trim();
    return request.headers.get("x-api-key")?.trim() || "";
}
