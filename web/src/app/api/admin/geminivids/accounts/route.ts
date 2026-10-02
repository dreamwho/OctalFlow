import { apiSuccess } from "@/app/api/_shared/api-response";
import { auditGeminiVidsAdminAction, auditGeminiVidsAdminFailure, geminiVidsRouteError, readGeminiVidsAdminJson, requireGeminiVidsAdmin } from "@/lib/server/geminivids-admin";
import { importGeminiVidsCookies, importGeminiVidsFromGeminiAi, listGeminiVidsAccounts } from "@/lib/server/geminivids-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    try {
        return apiSuccess(await listGeminiVidsAccounts());
    } catch (error) {
        return geminiVidsRouteError(error, "读取 GeminiVids 账号失败");
    }
}

export async function POST(request: Request) {
    const access = await requireGeminiVidsAdmin();
    if ("error" in access) return access.error;
    const body = await readGeminiVidsAdminJson<{ cookies?: string; storageState?: Record<string, unknown>; fromGeminiAi?: boolean; name?: string; email?: string; vidsDocId?: string }>(request);
    try {
        let data: unknown;
        if (body.fromGeminiAi) {
            data = await importGeminiVidsFromGeminiAi();
        } else {
            data = await importGeminiVidsCookies({ cookies: body.cookies, storageState: body.storageState, name: body.name, email: body.email, vidsDocId: body.vidsDocId });
        }
        await auditGeminiVidsAdminAction(request, access.user, "admin.geminivids.accounts.import", { type: "geminivids_account" });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiVidsAdminFailure(request, access.user, "admin.geminivids.accounts.import", { type: "geminivids_account" });
        return geminiVidsRouteError(error, "导入 GeminiVids 账号失败");
    }
}
