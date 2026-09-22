import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { startDolaHeadedAccountTest } from "@/lib/server/dola/service";
import { DolaProviderError } from "@/lib/server/dola/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const accountId = (await context.params).accountId;
    try {
        const parsed = await readJsonBodyResult(request);
        if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
        const body = parsed.data as Record<string, unknown>;
        const mode = body.mode;
        if (mode !== "direct" && mode !== "magic" && mode !== "generic" && mode !== "chained") throw new DolaProviderError("请选择测试代理方式", 400);
        const target = typeof body.target === "string" ? body.target.trim() : "";
        if (mode !== "direct" && !target) throw new DolaProviderError("请选择测试代理节点", 400);
        const result = await startDolaHeadedAccountTest(accountId, { mode, target });
        await auditDolaAdminAction(request, access.user, "admin.dola.account.headed_test", { type: "dola_account", id: accountId }, { mode, target });
        return apiSuccess(result, "已打开独立 Camoufox 有头测试窗口");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.headed_test", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "启动 Dola 有头测试失败");
    }
}
