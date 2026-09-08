import { apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBody } from "@/lib/auth/request";
import { auditRunningHubAction, requireRunningHubAdmin, runningHubRouteError } from "@/lib/server/runninghub-admin";
import { cancelRunningHubTask, getRunningHubAccountStatus, syncRunningHubApp } from "@/lib/server/runninghub-service";
import {
    clearRunningHubRequestLogs,
    deleteRunningHubApp,
    getRunningHubPublicSettings,
    listRunningHubApps,
    listRunningHubRequestLogs,
    listRunningHubTasks,
    updateRunningHubSettings,
    upsertRunningHubApp,
    type RunningHubApp,
} from "@/lib/server/runninghub-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireRunningHubAdmin(request);
    if ("error" in access) return access.error;
    try {
        const url = new URL(request.url);
        const [settings, apps, tasks, logs] = await Promise.all([getRunningHubPublicSettings(), listRunningHubApps(), listRunningHubTasks(Number(url.searchParams.get("taskLimit") || 100)), listRunningHubRequestLogs(Number(url.searchParams.get("logLimit") || 100))]);
        let account: unknown = null;
        let accountError = "";
        if (url.searchParams.get("account") === "1" && settings.enabled && settings.hasApiKey) {
            try {
                account = await getRunningHubAccountStatus();
            } catch (error) {
                accountError = error instanceof Error ? error.message : "账户状态读取失败";
            }
        }
        return apiSuccess({ settings, apps, tasks, logs, account, accountError });
    } catch (error) {
        return runningHubRouteError(error, "读取 RunningHub 配置失败");
    }
}

export async function PATCH(request: Request) {
    const access = await requireRunningHubAdmin(request);
    if ("error" in access) return access.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request, 256 * 1024);
        const action = typeof body.action === "string" ? body.action : "settings";
        if (action === "settings") {
            const settings = await updateRunningHubSettings({
                enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
                apiBaseUrl: typeof body.apiBaseUrl === "string" ? body.apiBaseUrl : undefined,
                apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
                clearApiKey: body.clearApiKey === true,
                instanceType: typeof body.instanceType === "string" ? body.instanceType : undefined,
            });
            await auditRunningHubAction(request, access.user, "admin.runninghub.settings.update", { type: "runninghub", id: "default" }, { enabled: settings.enabled, apiBaseUrl: settings.apiBaseUrl, instanceType: settings.instanceType });
            return apiSuccess(settings);
        }
        if (action === "upsert-app") {
            const raw = body.app && typeof body.app === "object" ? (body.app as Partial<RunningHubApp>) : {};
            const app = await upsertRunningHubApp({ ...raw, remoteId: String(raw.remoteId || ""), kind: raw.kind === "workflow" ? "workflow" : "ai-app", name: String(raw.name || "") });
            await auditRunningHubAction(request, access.user, "admin.runninghub.app.upsert", { type: "runninghub_app", id: app.id, label: app.name }, { kind: app.kind, remoteId: app.remoteId, bindings: app.featureBindings });
            return apiSuccess(app);
        }
        if (action === "delete-app") {
            const id = String(body.id || "");
            const deleted = await deleteRunningHubApp(id);
            await auditRunningHubAction(request, access.user, "admin.runninghub.app.delete", { type: "runninghub_app", id });
            return apiSuccess({ deleted });
        }
        if (action === "sync-app") {
            const app = await syncRunningHubApp(String(body.id || ""));
            await auditRunningHubAction(request, access.user, "admin.runninghub.app.sync", { type: "runninghub_app", id: app.id, label: app.name }, { fieldCount: app.fields.length });
            return apiSuccess(app);
        }
        if (action === "cancel-task") {
            const task = await cancelRunningHubTask(String(body.id || ""));
            await auditRunningHubAction(request, access.user, "admin.runninghub.task.cancel", { type: "runninghub_task", id: task.id });
            return apiSuccess(task);
        }
        if (action === "clear-logs") {
            const cleared = await clearRunningHubRequestLogs();
            await auditRunningHubAction(request, access.user, "admin.runninghub.logs.clear", { type: "runninghub_log", id: "all" }, { cleared });
            return apiSuccess({ cleared });
        }
        return runningHubRouteError(new Error("不支持的 RunningHub 操作"), "不支持的 RunningHub 操作");
    } catch (error) {
        return runningHubRouteError(error, "保存 RunningHub 配置失败");
    }
}
