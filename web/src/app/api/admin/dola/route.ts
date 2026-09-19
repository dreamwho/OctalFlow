import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { getDolaOverview } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    try {
        const data = await getDolaOverview();
        await auditDolaAdminAction(request, access.user, "admin.dola.view", { type: "dola_provider", id: "primary" });
        return apiSuccess(data);
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.view", { type: "dola_provider", id: "primary" });
        return dolaRouteError(error, "读取 Dola 状态失败");
    }
}

