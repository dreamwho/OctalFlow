import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { setDolaAccountsGroup } from "@/lib/server/dola/account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ ids?: unknown; group?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const ids = Array.isArray(parsed.data.ids) ? parsed.data.ids.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, 200) : [];
    const group = typeof parsed.data.group === "string" ? parsed.data.group : null;
    if (!ids.length) return apiCompatError(400, "请选择要设置分组的账号");
    if (group === null) return apiCompatError(400, "请提供分组名称（传空字符串清除分组）");
    try {
        const result = await setDolaAccountsGroup(ids, group);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.batchGroup", { type: "dola_account", label: `${result.updated} 个账号 → ${group.trim() || "未分组"}` });
        return apiSuccess(result, group.trim() ? `已将 ${result.updated} 个账号设为分组「${group.trim()}」` : `已清除 ${result.updated} 个账号的分组`);
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.batchGroup", { type: "dola_account" });
        return dolaRouteError(error, "批量设置 Dola 账号分组失败");
    }
}
