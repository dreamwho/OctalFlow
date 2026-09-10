import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditMagicProxyAction, auditMagicProxyFailure, magicProxyRouteError, readMagicProxyAdminJson, requireMagicProxyAdmin } from "@/lib/server/magic-proxy-admin";
import { getMagicProxyOverview, testMagicProxyAllNodes, testMagicProxyGoogleAccess, testMagicProxyNodeDelay, updateMagicProxyBinding } from "@/lib/server/magic-proxy-service";

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

export async function POST(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    let node = "";
    try {
        const body = (await readMagicProxyAdminJson(request).catch(() => ({}))) as { node?: unknown; action?: unknown };
        const action = typeof body?.action === "string" ? body.action.trim() : "";

        if (action === "testGoogle") {
            const data = await testMagicProxyGoogleAccess(body);
            await auditMagicProxyAction(request, access.user, "admin.magic_proxy.google_test", { type: "magic_proxy", id: "google" }, { ok: data.overallOk, count: data.items.length });
            return apiSuccess(data, data.overallOk ? "Google 访问测试通过" : "部分或全部通道无法正常访问 Google");
        }

        node = typeof body?.node === "string" ? body.node.trim() : "";
        const data = node ? await testMagicProxyNodeDelay(node) : await testMagicProxyAllNodes();
        await auditMagicProxyAction(request, access.user, "admin.magic_proxy.delay_test", { type: "magic_proxy", id: node || "default" }, { node: node || "all", count: node ? 1 : (data as { results?: unknown[] }).results?.length ?? 0 });
        return apiSuccess(data, node ? "节点测速完成" : "全部节点测速完成");
    } catch (error) {
        await auditMagicProxyFailure(request, access.user, "admin.magic_proxy.delay_test", { type: "magic_proxy", id: node || "default" });
        return magicProxyRouteError(error, "测速或连通性测试失败");
    }
}
