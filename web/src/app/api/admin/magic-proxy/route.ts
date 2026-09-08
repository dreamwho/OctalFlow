import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditMagicProxyAction, auditMagicProxyFailure, magicProxyRouteError, readMagicProxyAdminJson, requireMagicProxyAdmin } from "@/lib/server/magic-proxy-admin";
import { getMagicProxyOverview, updateMagicProxyBinding } from "@/lib/server/magic-proxy-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await getMagicProxyOverview();
        await auditMagicProxyAction(request, access.user, "admin.magic_proxy.view", { type: "magic_proxy", id: "default" });
        return apiSuccess(data);
    } catch (error) {
        await auditMagicProxyFailure(request, access.user, "admin.magic_proxy.view", { type: "magic_proxy", id: "default" });
        return magicProxyRouteError(error, "读取魔法代理状态失败");
    }
}

export async function PATCH(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    try {
        const result = await updateMagicProxyBinding(await readMagicProxyAdminJson(request));
        await auditMagicProxyAction(request, access.user, "admin.magic_proxy.binding.update", { type: "magic_proxy_binding", id: result.provider }, { enabled: result.binding.enabled, nodeConfigured: Boolean(result.binding.node) });
        return apiSuccess(await getMagicProxyOverview(), "魔法代理绑定已保存");
    } catch (error) {
        await auditMagicProxyFailure(request, access.user, "admin.magic_proxy.binding.update", { type: "magic_proxy_binding" });
        return magicProxyRouteError(error, "保存魔法代理绑定失败");
    }
}
