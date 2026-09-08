import { auditGeminiToolsAction, requireGeminiToolsAdmin } from "@/lib/server/gemini-tools-admin";
import { completeGeminiToolsOAuth, GeminiToolsError } from "@/lib/server/gemini-tools-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireGeminiToolsAdmin();
    if ("error" in access) return callbackPage(false, "管理员登录状态已失效，请返回后台重新登录并授权", "*");
    const url = new URL(request.url);
    const state = url.searchParams.get("state")?.trim() || "";
    const code = url.searchParams.get("code")?.trim() || "";
    const providerError = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (providerError) return callbackPage(false, `Google 授权未完成：${providerError}`, "*");
    if (!state || !code) return callbackPage(false, "Google 授权回调缺少 code 或 state", "*");
    try {
        const data = await completeGeminiToolsOAuth({ code, state });
        await auditGeminiToolsAction(request, access.user, "admin.gemini_tools.oauth.complete", { type: "google_account", id: data.account.id, label: data.account.email });
        return callbackPage(true, `已添加 ${data.account.email}`, data.openerOrigin);
    } catch (error) {
        return callbackPage(false, error instanceof GeminiToolsError ? error.message : "Google 授权处理失败", "*");
    }
}

function callbackPage(ok: boolean, message: string, origin: string) {
    const payload = JSON.stringify({ type: "octalflow-gemini-tools-oauth", ok, message }).replace(/</g, "\\u003c");
    const target = JSON.stringify(origin).replace(/</g, "\\u003c");
    const title = ok ? "授权完成" : "授权失败";
    return new Response(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f4f5;color:#18181b}.card{max-width:420px;margin:24px;padding:28px;border:1px solid #e4e4e7;border-radius:16px;background:#fff;box-shadow:0 12px 32px #0001}h1{font-size:20px;margin:0 0 10px}p{color:#52525b;line-height:1.6;margin:0}</style></head><body><main class="card"><h1>${title}</h1><p>${escapeHtml(message)}</p></main><script>if(window.opener){window.opener.postMessage(${payload},${target});setTimeout(()=>window.close(),350)}</script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
