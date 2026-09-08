import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { getCurrentUser } from "@/lib/auth/session";
import { getDreaminaCliPublicStatus } from "@/lib/server/dreamina-cli-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return apiCompatError(401, "请先登录");
    return apiSuccess(await getDreaminaCliPublicStatus());
}
