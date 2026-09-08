import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { importGeminiAiCookies } from "@/lib/server/geminiai-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { cookies?: unknown; name?: unknown; email?: unknown; accountId?: unknown; account_id?: unknown };

export async function POST(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<Body>(request, 2_100_000);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try {
        const account = await importGeminiAiCookies({ ...parsed.data, accountId: parsed.data.accountId ?? parsed.data.account_id });
        // Deliberately do not include the request body, cookie length, or any
        // upstream response fragments in audit metadata.
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.account.cookies_import", { type: "geminiai_account", id: account.id, label: account.name });
        return apiSuccess({ account }, "Google 账号已导入");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.account.cookies_import", { type: "geminiai_account" });
        return geminiAiRouteError(error, "导入 Google Cookie 失败");
    }
}
