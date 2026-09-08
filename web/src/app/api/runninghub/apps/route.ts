import { apiSuccess } from "@/app/api/_shared/api-response";
import { getCurrentUser } from "@/lib/auth/session";
import { listRunningHubApps } from "@/lib/server/runninghub-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return Response.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const binding = new URL(request.url).searchParams.get("binding")?.trim() || "";
    const apps = await listRunningHubApps({ enabledOnly: true, ...(binding ? { binding } : {}) });
    return apiSuccess(
        apps.map((app) => ({ id: app.id, remoteId: app.remoteId, kind: app.kind, name: app.name, description: app.description, thumbnailUrl: app.thumbnailUrl, featureBindings: app.featureBindings, fieldCount: app.fields.length })),
    );
}
