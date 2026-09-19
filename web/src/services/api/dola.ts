export type DolaAccount = { id: string; name: string; email?: string; status: string; enabled: boolean; credentialVersion: number; quota?: Array<{ bucket: string; model?: string; remaining: number | null; limit: number | null; resetAt?: string; observedAt: string }>; requestCount: number; successCount: number; errorCount: number; activeAttempts: number; lastUsedAt?: string; lastVerifiedAt?: string; createdAt: string; updatedAt: string };
export type DolaModel = { id: string; name: string; capabilities: ["video"]; enabled: boolean; durations: number[]; aspectRatios: string[]; supportsReferenceImage: boolean; transport: "camoufox-page"; revision: string };
export type DolaProxyBinding = { enabled: boolean; mode: "direct" | "magic" | "generic" | "chained"; target: string };
export type DolaAdminState = { configured: boolean; healthy: boolean; transport: "camoufox-page"; defaultProxyMode: DolaProxyBinding["mode"]; proxy: DolaProxyBinding; accounts: DolaAccount[]; accountsAvailable: boolean; activeAccountId: string; models: DolaModel[]; channel?: Record<string, unknown>; channels?: Array<Record<string, unknown>>; gateway: { enabled: boolean; autoWatermark: boolean }; apiKeys: DolaApiKey[]; stats: { totalAccounts: number; readyAccounts: number; requestCount: number; successCount: number; errorCount: number } };
export type DolaApiKey = { id: string; name: string; prefix: string; status: "active" | "disabled"; expiresAt?: string; allowedIps: string[]; requestCount: number; lastUsedAt?: string; createdAt: string };
export type DolaTestResult = { status: string; model?: string; elapsedMs?: number; taskId?: string; statusUrl?: string; channelId?: string; verificationId?: string; conversationId?: string; videoUrl?: string; error?: string };
export type DolaRequestLogPhase = "queued" | "routing" | "auth" | "upstream" | "response" | "running" | "submitted" | "generating" | "success" | "failed" | "needs_review";
export type DolaRequestLogStatus = "success" | "failed" | "needs_review" | "pending";
export type DolaRequestLog = {
    id: string;
    createdAt: string;
    source: "runtime" | "admin-test" | "external";
    capability: "video" | "image";
    method: string;
    path: string;
    model: string;
    accountId?: string;
    accountName?: string;
    statusCode: number;
    durationMs: number;
    phase: DolaRequestLogPhase;
    taskId?: string;
    verificationId?: string;
    requestedDuration?: number;
    ratio?: string;
    requestBytes?: number;
    responseBytes?: number;
    contentType?: string;
    quotaRemaining?: number | null;
    quotaLimit?: number | null;
    clientIp?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
    proxyEgress?: { mode: "direct" | "magic" | "generic" | "chained"; nodeName?: string; address?: string };
    lifecycle?: Array<{ time: string; phase: DolaRequestLogPhase; message: string; detail?: string; durationMs?: number }>;
};
export type DolaLogPage = { items: DolaRequestLog[]; total: number; page: number; pageSize: number; stats: { total: number; success: number; failed: number; needsReview: number; pending: number; averageDurationMs: number } };
type Envelope<T> = { code?: number; data?: T; msg?: string; error?: string };

async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || (typeof payload?.code === "number" && payload.code !== 0)) throw new Error(payload?.msg || payload?.error || "Dola API 请求失败");
    return (payload?.data ?? payload) as T;
}
export function getDolaAdminState() { return request<DolaAdminState>("/api/admin/dola"); }
export function importDolaAccounts(items: Array<Record<string, unknown>>) { return request<{ results: Array<Record<string, unknown>>; summary: Record<string, number> }>("/api/admin/dola/accounts", { method: "POST", body: JSON.stringify({ items }) }); }
export function updateDolaAccount(id: string, patch: { name?: string; enabled?: boolean }) { return request<{ account: DolaAccount }>(`/api/admin/dola/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }); }
export function refreshDolaAccount(id: string) { return request<{ account: DolaAccount | null; status: string; quota: DolaAccount["quota"] }>(`/api/admin/dola/accounts/${encodeURIComponent(id)}/refresh`, { method: "POST" }); }
export function deleteDolaAccount(id: string) { return request<{ id: string; deleted: boolean }>(`/api/admin/dola/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function updateDolaModels(models: string[]) { return request<{ models: string[] }>("/api/admin/dola/models", { method: "PUT", body: JSON.stringify({ models }) }); }
export function updateDolaGateway(enabled?: boolean, autoWatermark?: boolean) { return request<{ enabled: boolean; autoWatermark: boolean }>("/api/admin/dola/gateway", { method: "PATCH", body: JSON.stringify({ ...(typeof enabled === "boolean" ? { enabled } : {}), ...(typeof autoWatermark === "boolean" ? { autoWatermark } : {}) }) }); }
export function createDolaApiKey(input: { name: string; expiresAt?: string; allowedIps?: string[] }) { return request<{ key: DolaApiKey; rawKey: string }>("/api/admin/dola/keys", { method: "POST", body: JSON.stringify(input) }); }
export function updateDolaApiKey(id: string, patch: Partial<Pick<DolaApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) { return request<DolaApiKey>(`/api/admin/dola/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }); }
export function deleteDolaApiKey(id: string) { return request<{ deleted: boolean }>(`/api/admin/dola/keys/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function testDolaVideo(input: { model: string; prompt: string; duration: number; ratio: string; references?: Array<{ dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }> }) { return request<DolaTestResult>("/api/admin/dola/test", { method: "POST", body: JSON.stringify(input) }); }
export function getDolaTestTask(taskId: string) { return request<DolaTestResult>(`/api/admin/dola/test/${encodeURIComponent(taskId)}`); }
export function getDolaLogs(input: { page?: number; pageSize?: number; keyword?: string; status?: DolaRequestLogStatus; phase?: DolaRequestLogPhase; source?: "runtime" | "admin-test" | "external"; model?: string; accountId?: string; proxyMode?: "direct" | "magic" | "generic" | "chained" } = {}) {
    const search = new URLSearchParams();
    if (input.page) search.set("page", String(input.page));
    if (input.pageSize) search.set("pageSize", String(input.pageSize));
    if (input.keyword?.trim()) search.set("keyword", input.keyword.trim());
    if (input.status) search.set("status", input.status);
    if (input.phase) search.set("phase", input.phase);
    if (input.source) search.set("source", input.source);
    if (input.model?.trim()) search.set("model", input.model.trim());
    if (input.accountId?.trim()) search.set("accountId", input.accountId.trim());
    if (input.proxyMode) search.set("proxyMode", input.proxyMode);
    return request<DolaLogPage>(`/api/admin/dola/logs${search.size ? `?${search}` : ""}`);
}
export function clearDolaLogs() { return request<{ deletedCount: number }>("/api/admin/dola/logs", { method: "DELETE" }); }
