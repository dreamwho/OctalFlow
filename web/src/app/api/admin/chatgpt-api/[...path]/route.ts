import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { ChatGptApiError, chatGptRuntimeJson, chatGptRuntimeRequest, sanitizeChatGptAdminResult, syncChatGptMagicProxy, updateChatGptProxySelection } from "@/lib/server/chatgpt-api-service";
import { getChatGptSavedModels, saveChatGptModels } from "@/lib/server/chatgpt-api-models";
import { readRequestBodyText, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;
type Context = { params: Promise<{ path: string[] }> };
const routes: Record<string, { path: string; methods: string[] }> = {
    health: { path: "/integration/health", methods: ["GET"] },
    accounts: { path: "/api/accounts", methods: ["GET", "POST", "DELETE"] },
    "accounts/batch-update": { path: "/api/accounts/batch-update", methods: ["POST"] },
    "accounts/update": { path: "/api/accounts/update", methods: ["POST"] },
    "accounts/refresh": { path: "/api/accounts/refresh", methods: ["POST"] },
    "model-catalog": { path: "/api/model-catalog", methods: ["GET"] },
    keys: { path: "/api/auth/users", methods: ["GET", "POST"] },
    logs: { path: "/api/logs", methods: ["GET"] },
    statistics: { path: "/integration/statistics", methods: ["GET"] },
    proxies: { path: "/api/proxy/view", methods: ["GET"] },
    "proxies/defaults": { path: "/api/proxy/defaults", methods: ["POST"] },
    "proxies/groups": { path: "/api/proxy/groups", methods: ["POST"] },
    "proxies/groups/test": { path: "/api/proxy/groups/test", methods: ["POST"] },
    "proxies/nodes/import": { path: "/api/proxy/nodes/import", methods: ["POST"] },
    "proxy-selection": { path: "/integration/proxy-selection", methods: ["GET", "PATCH"] },
    ipwo: { path: "/integration/ipwo", methods: ["GET", "PATCH"] },
    gateway: { path: "/integration/gateway", methods: ["GET", "PATCH"] },
};

export async function GET(request: Request, context: Context) {
    return handle(request, context);
}
export async function POST(request: Request, context: Context) {
    return handle(request, context);
}
export async function PATCH(request: Request, context: Context) {
    return handle(request, context);
}
export async function PUT(request: Request, context: Context) {
    return handle(request, context);
}
export async function DELETE(request: Request, context: Context) {
    return handle(request, context);
}

async function handle(request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return apiCompatError(401, "请先登录");
    if (!hasAdminPermission(user, "upstream.manage")) return apiCompatError(403, "需要上游配置管理权限");
    const rawSegments = (await context.params).path;
    const segments = rawSegments.map((part) => {
        try {
            return decodeURIComponent(part);
        } catch {
            return part;
        }
    });
    if (segments.some((part) => !/^[\p{L}\p{N}_-]+$/u.test(part))) return apiCompatError(404, "接口不存在");
    const path = segments.join("/");
    try {
        let data: unknown;
        if (path === "models" && ["GET", "PUT"].includes(request.method)) {
            data = request.method === "GET" ? await getChatGptSavedModels() : await saveChatGptModels(JSON.parse(await readRequestBodyText(request, 64 * 1024)));
        } else if (path === "ipwo/test" && request.method === "POST") {
            const body = await readRequestBodyText(request, 64 * 1024);
            if (body) JSON.parse(body);
            const response = await chatGptRuntimeRequest("/integration/ipwo/test", {
                method: "POST",
                ...(body ? { body } : {}),
                signal: request.signal,
            });
            const contentType = response.headers.get("content-type") || "";
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                throw new ChatGptApiError("IPWO 检测启动失败", response.status);
            }
            if (!response.body || !/^application\/x-ndjson(?:;|$)/i.test(contentType)) {
                await response.body?.cancel().catch(() => undefined);
                throw new ChatGptApiError("IPWO 检测响应格式无效", 502);
            }
            await safeRecordAuditLog({ action: "admin.chatgpt_api.post", actor: auditActorFromRequest(request, user), target: { type: "chatgpt_api", id: path } });
            return new Response(response.body, {
                status: response.status,
                headers: {
                    "content-type": "application/x-ndjson; charset=utf-8",
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                    "x-accel-buffering": "no",
                },
            });
        } else {
            const route =
                routes[path] ||
                (/^logs\/[\w-]+$/.test(path)
                    ? { path: `/api/${path}`, methods: ["GET"] }
                    : /^keys\/[\w-]+$/.test(path)
                    ? { path: `/api/auth/users/${segments[1]}`, methods: ["POST", "DELETE"] }
                    : /^accounts\/operations\/[\w-]+$/.test(path)
                      ? { path: `/api/${path}`, methods: ["GET"] }
                        : /^proxies\/groups\/[\p{L}\p{N}_-]+$/u.test(path)
                            ? { path: `/api/proxy/groups/${segments[2]}`, methods: ["DELETE"] }
                        : null);
            if (!route || !route.methods.includes(request.method)) return apiCompatError(404, "接口不存在");
            const body = request.method === "GET" ? undefined : await readRequestBodyText(request, 64 * 1024);
            const parsedBody = body ? JSON.parse(body) : undefined;
            if (path === "accounts/refresh") await syncChatGptMagicProxy();
            const search = new URL(request.url).search;
            data =
                path === "proxy-selection" && request.method === "PATCH"
                    ? await updateChatGptProxySelection(parsedBody)
                    : await chatGptRuntimeJson(route.path + search, { method: request.method, ...(body ? { body } : {}), signal: request.signal });
            data = sanitizeChatGptAdminResult(data, path === "keys" && request.method === "POST");
        }
        await safeRecordAuditLog({ action: `admin.chatgpt_api.${request.method.toLowerCase()}`, actor: auditActorFromRequest(request, user), target: { type: "chatgpt_api", id: path } });
        return apiSuccess(data);
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return apiCompatError(413, "管理请求不能超过 64KB");
        if (error instanceof SyntaxError) return apiCompatError(400, "请求 JSON 格式无效");
        return apiCompatError(error instanceof ChatGptApiError ? error.status : 502, error instanceof ChatGptApiError ? error.message : "GPTAPI 操作失败，请检查内部运行时日志");
    }
}
