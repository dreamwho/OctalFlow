import { apiSuccess } from "@/app/api/_shared/api-response";
import { dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { queryDolaTask } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    try {
        return apiSuccess(await queryDolaTask((await context.params).taskId));
    } catch (error) {
        return dolaRouteError(error, "查询 Dola 测试任务失败");
    }
}
