import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { getDolaGatewaySettings, updateDolaGatewaySettings } from "@/lib/server/dola/gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    return apiSuccess(await getDolaGatewaySettings());
}
export async function PATCH(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ enabled?: unknown; autoWatermark?: unknown; rotationLimit?: unknown; captureVerificationScreenshot?: unknown; dispatchGroups?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const patch: { enabled?: boolean; autoWatermark?: boolean; rotationLimit?: number; captureVerificationScreenshot?: boolean; dispatchGroups?: string[] | null } = {};
    if (typeof parsed.data.enabled === "boolean") patch.enabled = parsed.data.enabled;
    if (typeof parsed.data.autoWatermark === "boolean") patch.autoWatermark = parsed.data.autoWatermark;
    if (typeof parsed.data.rotationLimit === "number" && Number.isSafeInteger(parsed.data.rotationLimit) && parsed.data.rotationLimit >= 0) patch.rotationLimit = parsed.data.rotationLimit;
    if (typeof parsed.data.captureVerificationScreenshot === "boolean") patch.captureVerificationScreenshot = parsed.data.captureVerificationScreenshot;
    if (parsed.data.dispatchGroups === null || Array.isArray(parsed.data.dispatchGroups)) patch.dispatchGroups = parsed.data.dispatchGroups as string[] | null;
    try { return apiSuccess(await updateDolaGatewaySettings(patch), "Dola 网关设置已保存"); } catch (error) { return dolaRouteError(error, "保存 Dola 网关设置失败"); }
}
