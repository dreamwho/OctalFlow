import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { requireDolaAdmin, dolaRouteError } from "@/lib/server/dola/admin";
import { deleteDolaApiKey, updateDolaApiKey } from "@/lib/server/dola/gateway-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ keyId: string }> };
export async function PATCH(request: Request, context: Context) { const access = await requireDolaAdmin(); if ("error" in access) return access.error; const parsed = await readJsonBodyResult<Record<string, unknown>>(request); if (!parsed.ok) return apiCompatError(parsed.status, parsed.message); try { const result = await updateDolaApiKey((await context.params).keyId, parsed.data as never); return result ? apiSuccess(result, "Dola API 密钥已更新") : apiCompatError(404, "Dola API 密钥不存在"); } catch (error) { return dolaRouteError(error, "更新 Dola API 密钥失败"); } }
export async function DELETE(request: Request, context: Context) { const access = await requireDolaAdmin(); if ("error" in access) return access.error; try { return apiSuccess(await deleteDolaApiKey((await context.params).keyId), "Dola API 密钥已删除"); } catch (error) { return dolaRouteError(error, "删除 Dola API 密钥失败"); } }

