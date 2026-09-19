import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { requireDolaAdmin, dolaRouteError } from "@/lib/server/dola/admin";
import { createDolaApiKey, listDolaApiKeys } from "@/lib/server/dola/gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { const access = await requireDolaAdmin(); if ("error" in access) return access.error; return apiSuccess(await listDolaApiKeys()); }
export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ name?: unknown; expiresAt?: unknown; allowedIps?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    try { return apiSuccess(await createDolaApiKey({ name: typeof parsed.data.name === "string" ? parsed.data.name : "Dola API Key", expiresAt: typeof parsed.data.expiresAt === "string" ? parsed.data.expiresAt : undefined, allowedIps: Array.isArray(parsed.data.allowedIps) ? parsed.data.allowedIps.filter((item): item is string => typeof item === "string") : [] }), "Dola API 密钥已创建"); } catch (error) { return dolaRouteError(error, "创建 Dola API 密钥失败"); }
}

