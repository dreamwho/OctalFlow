import { MAX_MEDIA_PROXY_BYTES } from "@/lib/server/media-response-limit";
import { geminiAiRuntimeRequest } from "@/lib/server/geminiai-provider";
import { authorizeGeminiAiApiKey, getGeminiAiGatewaySettings } from "@/lib/server/geminiai-gateway-store";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";
import { getClientIp } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type Context = { params: Promise<{ path: string[] }> };
const OPENAI_POST_PATHS = new Set(["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"]);
const errorResponse = (message: string, status: number) => Response.json({ error: { message } }, { status });

export async function GET(request: Request, context: Context) {
    return handle(request, context);
}

export async function POST(request: Request, context: Context) {
    return handle(request, context);
}

async function handle(request: Request, context: Context) {
    const routePath = normalizeExternalPath(`/${(await context.params).path.join("/")}`);
    if (!routePath || request.method !== (routePath === "/v1/models" ? "GET" : "POST")) return errorResponse("GeminiAIStudio 不支持该接口", 404);
    const rawKey = apiKey(request);
    if (!rawKey) return errorResponse("缺少 GeminiAIStudio API 密钥", 401);
    const key = await authorizeGeminiAiApiKey(rawKey, getClientIp(request));
    if (!key) return errorResponse("GeminiAIStudio API 密钥无效、已过期或来源 IP 不允许", 401);
    if (!(await getGeminiAiGatewaySettings()).enabled) return errorResponse("GeminiAIStudio 网关已停用", 503);
    let body: BodyInit | undefined;
    try {
        body = request.method === "GET" ? undefined : await readRequestBodyBytes(request, MAX_MEDIA_PROXY_BYTES);
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return errorResponse(error.message, error.status);
        throw error;
    }
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    const accept = request.headers.get("accept");
    if (contentType) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    const clientIp = getClientIp(request);
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    const userAgent = request.headers.get("user-agent");
    if (userAgent) headers.set("user-agent", userAgent);
    const search = new URL(request.url).search;
    const response = await geminiAiRuntimeRequest(`${routePath}${search}`, { method: request.method, headers, body, signal: request.signal }, { logSource: "external" });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "cache-control"]) {
        const value = response.headers.get(name);
        if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}

function normalizeExternalPath(value: string) {
    const trimmed = value.replace(/\/+$/, "") || "/";
    const withVersion = trimmed.startsWith("/v1/") ? trimmed : `/v1${trimmed}`;
    return withVersion === "/v1/models" || OPENAI_POST_PATHS.has(withVersion) ? withVersion : "";
}

function apiKey(request: Request) {
    const authorization = request.headers.get("authorization")?.trim() || "";
    if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, "").trim();
    return request.headers.get("x-api-key")?.trim() || "";
}
