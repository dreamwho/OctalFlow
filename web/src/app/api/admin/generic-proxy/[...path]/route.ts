import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { ChatGptApiError, chatGptRuntimeJson, sanitizeChatGptAdminResult } from "@/lib/server/chatgpt-api-service";
import { listGeminiToolsProxyEgressLogs, type GeminiToolsRequestLog } from "@/lib/server/gemini-tools-store";
import { listGeminiAiProxyEgressLogsPage, type GeminiAiRequestLog } from "@/lib/server/geminiai-request-log-store";
import { readRequestBodyText, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };

const routes: Record<string, { path: string; methods: string[] }> = {
    proxies: { path: "/api/proxy/view", methods: ["GET"] },
    "proxies/defaults": { path: "/api/proxy/defaults", methods: ["POST"] },
    "proxies/groups": { path: "/api/proxy/groups", methods: ["POST"] },
    "proxies/groups/test": { path: "/api/proxy/groups/test", methods: ["POST"] },
    "proxies/nodes/import": { path: "/api/proxy/nodes/import", methods: ["POST"] },
    "proxy/generic-bindings": { path: "/api/proxy/generic-bindings", methods: ["GET", "POST"] },
};

type GeminiProxyLogSummary = {
    id: string;
    time: string;
    summary: string;
    model?: string;
    endpoint?: string;
    outcome: string;
    display_status?: string;
    duration_ms?: number;
    account_email?: string;
    public_error?: string;
    proxy_egress?: GeminiToolsRequestLog["proxyEgress"];
    request_text?: string;
};

function mapGeminiProxyLogSummary(log: GeminiToolsRequestLog): GeminiProxyLogSummary {
    return {
        id: `gt-${log.id}`,
        time: log.createdAt,
        summary: `${log.model || ""} · ${log.path}`,
        model: log.model,
        endpoint: log.path,
        outcome: log.statusCode < 400 ? "success" : "failed",
        display_status: String(log.statusCode),
        duration_ms: log.durationMs,
        account_email: log.accountEmail,
        public_error: log.error,
        proxy_egress: log.proxyEgress,
        request_text: log.requestPreview,
    };
}

function mapGeminiLogDetail(log: GeminiToolsRequestLog) {
    return { ...mapGeminiProxyLogSummary(log), request_text: log.requestPreview || "", response: log.responsePreview ? { preview: log.responsePreview } : {} };
}

type GeminiAiProxyLogSummary = {
    id: string;
    time: string;
    summary: string;
    model?: string;
    endpoint?: string;
    outcome: string;
    display_status?: string;
    duration_ms?: number;
    account_email?: string;
    public_error?: string;
    proxy_egress?: GeminiAiRequestLog["proxyEgress"];
    request_text?: string;
};

function mapGeminiAiProxyLogSummary(log: GeminiAiRequestLog): GeminiAiProxyLogSummary {
    return {
        id: `ga-${log.id}`,
        time: log.createdAt,
        summary: `${log.model || ""} · ${log.path}`,
        model: log.model,
        endpoint: log.path,
        outcome: log.statusCode < 400 ? "success" : "failed",
        display_status: String(log.statusCode),
        duration_ms: log.durationMs,
        account_email: log.accountEmail,
        public_error: log.error,
        proxy_egress: log.proxyEgress,
        request_text: log.requestPreview,
    };
}

function mapGeminiAiLogDetail(log: GeminiAiRequestLog) {
    return { ...mapGeminiAiProxyLogSummary(log), request_text: log.requestPreview || "", response: log.responsePreview ? { preview: log.responsePreview } : {} };
}

export async function GET(request: Request, context: Context) {
    return handle(request, context);
}
export async function POST(request: Request, context: Context) {
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

    if (path === "logs" && request.method === "GET") {
        const url = new URL(request.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
        try {
            const [runtimePage, geminiToolsPage, geminiaiPage] = await Promise.all([
                chatGptRuntimeJson<{ items?: Array<Record<string, unknown>>; total?: number }>("/api/generic-proxy/logs?limit=200&offset=0"),
                listGeminiToolsProxyEgressLogs({ limit: 200, offset: 0 }),
                listGeminiAiProxyEgressLogsPage({ limit: 200, offset: 0 }),
            ]);
            const mergedAll: Array<Record<string, unknown> & { id: string; time?: string }> = [
                ...(runtimePage.items || []).map((item) => ({ ...item, id: String(item.id), time: String(item.time ?? "") })),
                ...geminiToolsPage.items.map(mapGeminiProxyLogSummary),
                ...geminiaiPage.items.map(mapGeminiAiProxyLogSummary),
            ];
            const merged = mergedAll.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));
            const items = merged.slice(offset, offset + limit);
            await safeRecordAuditLog({ action: "admin.generic_proxy.get", actor: auditActorFromRequest(request, user), target: { type: "generic_proxy", id: "logs" } });
            return apiSuccess({ items, total: merged.length, limit, offset, has_more: offset + limit < merged.length });
        } catch (error) {
            return apiCompatError(error instanceof ChatGptApiError ? error.status : 502, error instanceof ChatGptApiError ? error.message : "通用代理操作失败，请检查内部运行时日志");
        }
    }
    if (path.startsWith("logs/") && request.method === "GET" && (segments[1]?.startsWith("gt-") || segments[1]?.startsWith("ga-"))) {
        const isGeminiTools = segments[1]?.startsWith("gt-");
        try {
            if (isGeminiTools) {
                const toolsPage = await listGeminiToolsProxyEgressLogs({ limit: 200, offset: 0 });
                const toolsEntry = toolsPage.items.find((log) => log.id === segments[1].slice(3));
                if (!toolsEntry) return apiCompatError(404, "日志不存在");
                await safeRecordAuditLog({ action: "admin.generic_proxy.get", actor: auditActorFromRequest(request, user), target: { type: "generic_proxy", id: path } });
                return apiSuccess(mapGeminiLogDetail(toolsEntry));
            }
            const geminiaiPage = await listGeminiAiProxyEgressLogsPage({ limit: 200, offset: 0 });
            const geminiaiEntry = geminiaiPage.items.find((log) => log.id === segments[1].slice(3));
            if (!geminiaiEntry) return apiCompatError(404, "日志不存在");
            await safeRecordAuditLog({ action: "admin.generic_proxy.get", actor: auditActorFromRequest(request, user), target: { type: "generic_proxy", id: path } });
            return apiSuccess(mapGeminiAiLogDetail(geminiaiEntry));
        } catch {
            return apiCompatError(502, "通用代理操作失败，请检查内部运行时日志");
        }
    }

    const route =
        routes[path] ||
        (/^proxies\/groups\/[\p{L}\p{N}_-]+$/u.test(path)
            ? { path: `/api/proxy/groups/${segments[2]}`, methods: ["DELETE"] }
            : /^logs\/(?!g[ta]-)[\p{L}\p{N}_-]+$/u.test(path)
              ? { path: `/api/logs/${segments[1]}`, methods: ["GET"] }
              : null);
    if (!route || !route.methods.includes(request.method)) return apiCompatError(404, "接口不存在");
    try {
        const body = request.method === "GET" ? undefined : await readRequestBodyText(request, 64 * 1024);
        if (body) JSON.parse(body);
        const search = new URL(request.url).search;
        const data = await chatGptRuntimeJson(route.path + search, { method: request.method, ...(body ? { body } : {}), signal: request.signal });
        await safeRecordAuditLog({ action: "admin.generic_proxy.get", actor: auditActorFromRequest(request, user), target: { type: "generic_proxy", id: path } });
        return apiSuccess(sanitizeChatGptAdminResult(data));
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return apiCompatError(413, "管理请求不能超过 64KB");
        if (error instanceof SyntaxError) return apiCompatError(400, "请求 JSON 格式无效");
        return apiCompatError(error instanceof ChatGptApiError ? error.status : 502, error instanceof ChatGptApiError ? error.message : "通用代理操作失败，请检查内部运行时日志");
    }
}
