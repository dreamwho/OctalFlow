import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { saveDolaModels } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ models?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const models = Array.isArray(parsed.data.models) ? parsed.data.models.filter((item): item is string => typeof item === "string") : [];
    try {
        const result = await saveDolaModels(models);
        await auditDolaAdminAction(request, access.user, "admin.dola.models.update", { type: "dola_provider", id: "primary" });
        return apiSuccess(result, "Dola 模型已保存");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.models.update", { type: "dola_provider", id: "primary" });
        return dolaRouteError(error, "保存 Dola 模型失败");
    }
}

