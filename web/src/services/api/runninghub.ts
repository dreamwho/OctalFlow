export type RunningHubAdminSettings = { enabled: boolean; apiBaseUrl: string; hasApiKey: boolean; instanceType: "standard" | "plus"; updatedAt: string };
export type RunningHubAdminApp = {
    id: string;
    remoteId: string;
    kind: "ai-app" | "workflow";
    name: string;
    description: string;
    thumbnailUrl: string;
    enabled: boolean;
    featureBindings: string[];
    fields: Array<{ nodeId: string; fieldName: string; label: string; type: string; defaultValue: string; options: string[] }>;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
};
export type RunningHubAdminTask = { id: string; imageTaskId?: string; userId?: string; appId?: string; remoteTaskId?: string; status: "queued" | "running" | "success" | "failed" | "cancelled"; error?: string; resultUrls: string[]; createdAt: string; updatedAt: string; completedAt?: string };
export type RunningHubAdminLog = { id: string; taskId?: string; appId?: string; phase: "account" | "sync" | "upload" | "submit" | "query" | "cancel"; path: string; statusCode: number; durationMs: number; error?: string; createdAt: string };
export type RunningHubAdminOverview = { settings: RunningHubAdminSettings; apps: RunningHubAdminApp[]; tasks: RunningHubAdminTask[]; logs: RunningHubAdminLog[]; account: unknown; accountError: string };
export type RunningHubCatalogApp = Pick<RunningHubAdminApp, "id" | "remoteId" | "kind" | "name" | "description" | "thumbnailUrl" | "featureBindings"> & { fieldCount: number };

export async function getRunningHubAdminOverview(refreshAccount = false) {
    const response = await fetch(`/api/admin/runninghub${refreshAccount ? "?account=1" : ""}`, { cache: "no-store" });
    return readData<RunningHubAdminOverview>(response, "读取 RunningHub 配置失败");
}

export async function updateRunningHubAdmin(payload: Record<string, unknown>) {
    const response = await fetch("/api/admin/runninghub", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return readData<unknown>(response, "RunningHub 操作失败");
}

export async function listRunningHubCatalogApps(binding: string) {
    const response = await fetch(`/api/runninghub/apps?binding=${encodeURIComponent(binding)}`, { cache: "no-store" });
    return readData<RunningHubCatalogApp[]>(response, "读取 RunningHub 应用失败");
}

async function readData<T>(response: Response, fallback: string): Promise<T> {
    const payload = (await response.json().catch(() => null)) as { data?: T; msg?: string; error?: string } | null;
    if (!response.ok || payload?.data === undefined || payload?.data === null) throw new Error(payload?.msg || payload?.error || fallback);
    return payload.data;
}
