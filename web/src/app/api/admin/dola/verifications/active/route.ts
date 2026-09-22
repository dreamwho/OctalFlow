import { apiSuccess } from "@/app/api/_shared/api-response";
import { requireDolaAdmin, dolaRouteError } from "@/lib/server/dola/admin";
import { dolaRuntimeRequest } from "@/lib/server/dola/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    try {
        const response = await dolaRuntimeRequest("/v1/verifications/headed-tests");
        if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
        const result = await response.json() as { items: Array<{ verificationId: string; accountId: string; createdAt: string }> };
        return apiSuccess(result.items, "已读取进行中的有头测试");
    } catch (error) { return dolaRouteError(error, "读取有头测试会话失败"); }
}
