import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditMagicProxyAction, auditMagicProxyFailure, magicProxyRouteError, magicProxySubscriptionRequestBodyBytes, readMagicProxyAdminJson, requireMagicProxyAdmin } from "@/lib/server/magic-proxy-admin";
import { getMagicProxyOverview, importMagicProxySubscription } from "@/lib/server/magic-proxy-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { url?: unknown; content?: unknown };

export async function POST(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    let body: Body = {};
    const hasUrl = () => typeof body.url === "string" && Boolean(body.url.trim());
    const hasContent = () => typeof body.content === "string";
    try {
        body = await readMagicProxyAdminJson<Body>(request, magicProxySubscriptionRequestBodyBytes());
        const result = await importMagicProxySubscription(body);
        const action = hasContent() ? "admin.magic_proxy.subscription.file_import" : hasUrl() ? "admin.magic_proxy.subscription.import" : "admin.magic_proxy.subscription.refresh";
        await auditMagicProxyAction(request, access.user, action, { type: "magic_proxy_subscription", id: "default" }, { nodeCount: result.nodeCount });
        return apiSuccess(await getMagicProxyOverview(), hasContent() ? "魔法代理文件订阅已导入" : hasUrl() ? "魔法代理订阅已导入" : "魔法代理订阅已刷新");
    } catch (error) {
        const action = hasContent() ? "admin.magic_proxy.subscription.file_import" : hasUrl() ? "admin.magic_proxy.subscription.import" : "admin.magic_proxy.subscription.refresh";
        await auditMagicProxyFailure(request, access.user, action, { type: "magic_proxy_subscription", id: "default" });
        return magicProxyRouteError(error, "导入魔法代理订阅失败");
    }
}
