import { ChatGptApiError, chatGptErrorMessage, chatGptRuntimeRequest, getChatGptRuntimeConfig, readChatGptSignedMedia, resolveChatGptReferences, rewriteChatGptMedia, rewriteChatGptStream, syncChatGptMagicProxy } from "@/lib/server/chatgpt-api-service";
import { MAX_MEDIA_PROXY_BYTES } from "@/lib/server/media-response-limit";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";
import { UnsafeOutboundUrlError } from "@/lib/server/safe-outbound-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
    return handle(request, context);
}
export async function POST(request: Request, context: Context) {
    return handle(request, context);
}
const errorResponse = (message: string, status: number) => Response.json({ error: { message } }, { status });

async function handle(request: Request, context: Context) {
    const path = (await context.params).path.join("/");
    try {
        if (request.method === "GET" && path.startsWith("media/")) return await readChatGptSignedMedia(`/${path.slice(6)}`, new URL(request.url), request.signal);
        const allowed = request.method === "GET" ? path === "v1/models" : ["v1/chat/completions", "v1/responses", "v1/images/generations", "v1/images/edits"].includes(path);
        if (!allowed) return errorResponse("GPTAPI 不支持该接口", 404);
        const key = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
        if (!key || key === getChatGptRuntimeConfig().apiKey) return errorResponse("请使用 GPTAPI 页面创建的调用密钥", 401);
        const authorization = await chatGptRuntimeRequest("/integration/auth", { signal: request.signal }, key);
        if (!authorization.ok) {
            await authorization.body?.cancel();
            return errorResponse("GPTAPI 密钥无效或已停用", 401);
        }
        const identity = (await authorization.json()) as { authenticated?: boolean; role?: string };
        if (identity.authenticated !== true || identity.role !== "user") return errorResponse("调用密钥权限无效", 403);
        const gateway = await chatGptRuntimeRequest("/integration/gateway", { signal: request.signal });
        if (!gateway.ok) throw new ChatGptApiError("读取 ChatGPT 网关状态失败", 503);
        if (((await gateway.json()) as { enabled?: boolean }).enabled !== true) return errorResponse("ChatGPT 网关已停用", 503);
        let body: BodyInit | undefined;
        const headers = new Headers();
        if (request.method === "POST") {
            const bytes = await readRequestBodyBytes(request, MAX_MEDIA_PROXY_BYTES);
            const contentType = request.headers.get("content-type") || "application/json";
            if (contentType.startsWith("multipart/form-data")) {
                const form = await new Response(bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
                const result = new FormData();
                for (const [name, value] of form.entries()) result.append(name, typeof value === "string" ? String(await resolveChatGptReferences(value, name, request.signal)) : value);
                body = result;
            } else if (contentType.includes("application/json")) {
                body = JSON.stringify(await resolveChatGptReferences(JSON.parse(new TextDecoder().decode(bytes)), "", request.signal));
                headers.set("content-type", "application/json");
            } else return errorResponse("只支持 JSON 或 multipart/form-data", 415);
        }
        await syncChatGptMagicProxy();
        const response = await chatGptRuntimeRequest(`/${path}`, { method: request.method, headers, body, signal: request.signal }, key);
        if (!response.ok) return errorResponse(chatGptErrorMessage(await response.json().catch(() => null)), response.status);
        const origin = new URL(request.url).origin;
        if (response.headers.get("content-type")?.includes("text/event-stream") && response.body)
            return new Response(rewriteChatGptStream(response.body, origin), { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
        return Response.json(rewriteChatGptMedia(await response.json(), origin), { status: response.status, headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return errorResponse("请求超过媒体上传大小限制", 413);
        if (error instanceof SyntaxError) return errorResponse("请求 JSON 格式无效", 400);
        if (error instanceof UnsafeOutboundUrlError) return errorResponse("参考图片地址不允许访问", 422);
        return errorResponse(error instanceof ChatGptApiError ? error.message : "GPTAPI 请求失败，请检查运行时日志", error instanceof ChatGptApiError ? error.status : 502);
    }
}
