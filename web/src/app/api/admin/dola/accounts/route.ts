import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { importDolaAccounts, listDolaAccounts } from "@/lib/server/dola/account-service";
import type { DolaAccountImportItem } from "@/lib/server/dola/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    return apiSuccess({ accounts: await listDolaAccounts() });
}

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ items?: unknown[]; cookies?: unknown; name?: unknown; email?: unknown }>(request, 2_100_000);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const rawItems = Array.isArray(parsed.data.items) ? parsed.data.items : [{ cookie: parsed.data.cookies, name: parsed.data.name, email: parsed.data.email }];
    const items = rawItems.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        return [{ cookie: typeof (value.cookie ?? value.cookies) === "string" ? String(value.cookie ?? value.cookies) : "", name: typeof value.name === "string" ? value.name : undefined, email: typeof value.email === "string" ? value.email : undefined, sourceFileName: typeof value.sourceFileName === "string" ? value.sourceFileName : undefined, sourceOrdinal: typeof value.sourceOrdinal === "number" ? value.sourceOrdinal : undefined } satisfies DolaAccountImportItem];
    });
    try {
        const result = await importDolaAccounts(items);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.import", { type: "dola_accounts", id: "batch" });
        return apiSuccess(result, "Dola Cookie 导入完成");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.import", { type: "dola_accounts" });
        return dolaRouteError(error, "导入 Dola Cookie 失败");
    }
}
