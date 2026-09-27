import { apiSuccess } from "@/app/api/_shared/api-response";
import {
    auditMagicProxyAction,
    auditMagicProxyFailure,
    magicProxyRouteError,
    magicProxySubscriptionRequestBodyBytes,
    readMagicProxyAdminJson,
    requireMagicProxyAdmin,
} from "@/lib/server/magic-proxy-admin";
import {
    deleteMagicProxySubscription,
    getMagicProxyOverview,
    importMagicProxySubscription,
    updateMagicProxySubscription,
} from "@/lib/server/magic-proxy-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ImportBody = {
    url?: unknown;
    content?: unknown;
    name?: unknown;
    id?: unknown;
    subscriptionId?: unknown;
    replace?: unknown;
};

type PatchBody = {
    id?: unknown;
    name?: unknown;
    enabled?: unknown;
};

export async function GET() {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    try {
        return apiSuccess(await getMagicProxyOverview());
    } catch (error) {
        return magicProxyRouteError(error, "读取魔法代理订阅失败");
    }
}

export async function POST(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    let body: ImportBody = {};
    const hasUrl = () => typeof body.url === "string" && Boolean(body.url.trim());
    const hasContent = () => typeof body.content === "string";
    const subId = () => (typeof body.subscriptionId === "string" ? body.subscriptionId : typeof body.id === "string" ? body.id : undefined);

    try {
        body = await readMagicProxyAdminJson<ImportBody>(request, magicProxySubscriptionRequestBodyBytes());
        const result = await importMagicProxySubscription({
            ...body,
            subscriptionId: subId(),
        });
        const action = hasContent()
            ? "admin.magic_proxy.subscription.file_import"
            : hasUrl()
            ? "admin.magic_proxy.subscription.import"
            : "admin.magic_proxy.subscription.refresh";
        await auditMagicProxyAction(
            request,
            access.user,
            action,
            { type: "magic_proxy_subscription", id: subId() || "default" },
            { nodeCount: result.nodeCount },
        );
        return apiSuccess(
            await getMagicProxyOverview(),
            hasContent() ? "魔法代理文件订阅已导入" : hasUrl() ? "魔法代理订阅已导入" : "魔法代理订阅已刷新",
        );
    } catch (error) {
        const action = hasContent()
            ? "admin.magic_proxy.subscription.file_import"
            : hasUrl()
            ? "admin.magic_proxy.subscription.import"
            : "admin.magic_proxy.subscription.refresh";
        await auditMagicProxyFailure(request, access.user, action, { type: "magic_proxy_subscription", id: subId() || "default" });
        return magicProxyRouteError(error, "导入魔法代理订阅失败");
    }
}

export async function PATCH(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    try {
        const body = await readMagicProxyAdminJson<PatchBody>(request, 1024 * 16);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) return magicProxyRouteError(new Error("请指定要更新的订阅 ID"), "订阅 ID 缺失");
        const overview = await updateMagicProxySubscription({
            id,
            name: typeof body.name === "string" ? body.name : undefined,
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        await auditMagicProxyAction(
            request,
            access.user,
            "admin.magic_proxy.subscription.update",
            { type: "magic_proxy_subscription", id },
            { enabled: body.enabled, name: body.name },
        );
        return apiSuccess(overview, "订阅已更新");
    } catch (error) {
        await auditMagicProxyFailure(request, access.user, "admin.magic_proxy.subscription.update", { type: "magic_proxy_subscription" });
        return magicProxyRouteError(error, "更新订阅失败");
    }
}

export async function DELETE(request: Request) {
    const access = await requireMagicProxyAdmin();
    if ("error" in access) return access.error;
    try {
        const url = new URL(request.url);
        let id = url.searchParams.get("id")?.trim() || "";
        if (!id) {
            const body = await readMagicProxyAdminJson<{ id?: unknown }>(request, 1024 * 8).catch(() => ({ id: undefined }));
            if (typeof body.id === "string") id = body.id.trim();
        }
        if (!id) return magicProxyRouteError(new Error("请指定要删除的订阅 ID"), "订阅 ID 缺失");

        const overview = await deleteMagicProxySubscription(id);
        await auditMagicProxyAction(
            request,
            access.user,
            "admin.magic_proxy.subscription.delete",
            { type: "magic_proxy_subscription", id },
        );
        return apiSuccess(overview, "订阅已删除");
    } catch (error) {
        await auditMagicProxyFailure(request, access.user, "admin.magic_proxy.subscription.delete", { type: "magic_proxy_subscription" });
        return magicProxyRouteError(error, "删除订阅失败");
    }
}
