import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { startDolaAccountVerification } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const accountId = (await context.params).accountId;
    try {
        const result = await startDolaAccountVerification(accountId);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.verify", { type: "dola_account", id: accountId });
        return apiSuccess(result, result.status === "verification_required" ? "已打开安全验证会话" : result.verificationId ? "已打开账号页面诊断会话" : "Dola 账号状态正常");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.verify", { type: "dola_account", id: accountId });
        return dolaRouteError(error, "启动 Dola 账号验证失败");
    }
}
