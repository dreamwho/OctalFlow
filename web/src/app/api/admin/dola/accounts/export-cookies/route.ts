import { apiCompatError } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { exportDolaGoogleAccountCookies } from "@/lib/server/dola/account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ accountIds?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const accountIds = parsed.data.accountIds;
    if (accountIds !== undefined && (!Array.isArray(accountIds) || !accountIds.every((id) => typeof id === "string" && id.trim()))) {
        return apiCompatError(400, "accountIds 必须是账号 ID 数组");
    }
    try {
        const cookies = await exportDolaGoogleAccountCookies(accountIds as string[] | undefined);
        await auditDolaAdminAction(request, access.user, "admin.dola.account.export_cookies", { type: "dola_accounts", id: "google" }, { count: cookies.length });
        const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
        return new Response(`${cookies.join("\n")}\n`, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="Dola-Google-Cookies-${date}.txt"`,
                "Cache-Control": "private, no-store, max-age=0",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.account.export_cookies", { type: "dola_accounts", id: "google" });
        return dolaRouteError(error, "批量导出 Dola Cookie 失败");
    }
}
