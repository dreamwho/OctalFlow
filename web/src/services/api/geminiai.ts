export type GeminiAiCapability = "text" | "image" | "video" | "search";

export type GeminiAiAccount = {
    id: string;
    name?: string;
    email?: string;
    status?: string;
    usage?: string | { used?: number; limit?: number; remaining?: number; label?: string };
    lastUsedAt?: string;
    createdAt?: string;
};

export type GeminiAiRotation = {
    enabled?: boolean;
    mode?: "round_robin" | "lru" | "least_rl" | string;
    cooldownSeconds?: number;
};

export type GeminiAiModel = {
    id: string;
    name?: string;
    channelId?: string;
    capabilities?: GeminiAiCapability[];
    capability?: GeminiAiCapability;
    supportsSearch?: boolean;
    enabled?: boolean;
    source?: string;
};

export type GeminiAiChannel = {
    id: string;
    name?: string;
    status?: string;
    models?: string[];
    modelCount?: number;
    capabilities?: GeminiAiCapability[];
};

export type GeminiAiAdminState = {
    configured: boolean;
    healthy: boolean;
    accounts: GeminiAiAccount[];
    accountsAvailable: boolean;
    activeAccountId?: string;
    rotation?: GeminiAiRotation;
    models: GeminiAiModel[];
    channel?: GeminiAiChannel;
    channels?: GeminiAiChannel[];
};

export type GeminiAiLoginSession = {
    sessionId: string;
    status?: "pending" | "completed" | "failed" | string;
    accountId?: string;
    email?: string;
    error?: string;
};

export type GeminiAiCitation = {
    title?: string;
    url?: string;
    source?: string;
};

export type GeminiAiTestResult = {
    status?: "queued" | "running" | "succeeded" | "failed" | "needs_review" | string;
    model?: string;
    elapsedMs?: number;
    text?: string;
    content?: string;
    output?: string;
    citations?: GeminiAiCitation[];
    images?: string[];
    imageUrls?: string[];
    videoUrl?: string;
    taskId?: string;
    channelId?: string;
    statusUrl?: string;
    error?: string;
};

export type GeminiAiRequestLog = {
    id: string;
    createdAt: string;
    source: "runtime" | "admin-test";
    capability: "text" | "image" | "search";
    method: string;
    path: string;
    model: string;
    accountId?: string;
    accountEmail?: string;
    statusCode: number;
    durationMs: number;
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
};

export type GeminiAiRequestStats = { total: number; success: number; failed: number; averageDurationMs: number };
export type GeminiAiLogPage = { items: GeminiAiRequestLog[]; total: number; page: number; pageSize: number; stats: GeminiAiRequestStats };

type ApiEnvelope<T> = { code?: number; data?: T; msg?: string; error?: string };

async function requestGeminiAi<T>(path: string, init?: RequestInit, allowEmptyData = false) {
    const response = await fetch(path, {
        cache: "no-store",
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | T | null;
    const envelope = payload && typeof payload === "object" && ("data" in payload || "code" in payload || "msg" in payload || "error" in payload) ? (payload as ApiEnvelope<T>) : null;
    if (!response.ok || (typeof envelope?.code === "number" && envelope.code !== 0)) throw new Error(envelope?.msg || envelope?.error || "GeminiAI 请求失败");
    if (envelope) {
        if (envelope.data === undefined) {
            if (!allowEmptyData) throw new Error(envelope.msg || envelope.error || "GeminiAI 未返回数据");
            return undefined as T;
        }
        return envelope.data as T;
    }
    if (payload === null) throw new Error("GeminiAI 返回格式无效");
    return payload as T;
}

function jsonBody(input: unknown) {
    return JSON.stringify(input);
}

export function getGeminiAiAdminState() {
    return requestGeminiAi<GeminiAiAdminState>("/api/admin/geminiai");
}

export function startGeminiAiAccountLogin(input: { name?: string; headless?: boolean; uiLocale?: string }) {
    return requestGeminiAi<GeminiAiLoginSession>("/api/admin/geminiai/accounts/login/start", { method: "POST", body: jsonBody(input) });
}

export function getGeminiAiAccountLoginStatus(sessionId: string) {
    return requestGeminiAi<GeminiAiLoginSession>(`/api/admin/geminiai/accounts/login/status/${encodeURIComponent(sessionId)}`);
}

export function importGeminiAiAccount(input: { cookies: string; name?: string; email?: string }) {
    return requestGeminiAi<GeminiAiAccount>("/api/admin/geminiai/accounts/import", { method: "POST", body: jsonBody(input) });
}

export function updateGeminiAiAccount(accountId: string, input: { name?: string }) {
    return requestGeminiAi<GeminiAiAccount>(`/api/admin/geminiai/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: jsonBody(input) });
}

export function deleteGeminiAiAccount(accountId: string) {
    return requestGeminiAi<void>(`/api/admin/geminiai/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }, true);
}

export function activateGeminiAiAccount(accountId: string) {
    return requestGeminiAi<GeminiAiAccount>(`/api/admin/geminiai/accounts/${encodeURIComponent(accountId)}/activate`, { method: "POST" });
}

export function updateGeminiAiRotation(rotation: GeminiAiRotation) {
    return requestGeminiAi<GeminiAiRotation>("/api/admin/geminiai/rotation", { method: "PATCH", body: jsonBody(rotation) });
}

export function syncGeminiAiModels() {
    return requestGeminiAi<{ models?: GeminiAiModel[] } | GeminiAiModel[]>("/api/admin/geminiai/models/sync", { method: "POST" });
}

export function updateGeminiAiModels(models: string[]) {
    return requestGeminiAi<{ models?: GeminiAiModel[] } | GeminiAiModel[]>("/api/admin/geminiai/models", { method: "PUT", body: jsonBody({ models }) });
}

export function testGeminiAiModel(input: { capability: GeminiAiCapability; model: string; prompt: string; options?: Record<string, string | number | boolean> }) {
    return requestGeminiAi<GeminiAiTestResult>("/api/admin/geminiai/test", { method: "POST", body: jsonBody(input) });
}

export function getGeminiAiTestStatus(input: Pick<GeminiAiTestResult, "taskId" | "channelId" | "statusUrl">) {
    if (input.statusUrl?.startsWith("/api/admin/geminiai/test")) return requestGeminiAi<GeminiAiTestResult>(input.statusUrl);
    if (!input.taskId || !input.channelId) throw new Error("该视频任务未返回可查询地址");
    return requestGeminiAi<GeminiAiTestResult>(`/api/admin/geminiai/test?taskId=${encodeURIComponent(input.taskId)}&channelId=${encodeURIComponent(input.channelId)}`);
}

export function getGeminiAiLogs(input: { page?: number; pageSize?: number; keyword?: string; status?: "success" | "failed"; capability?: "text" | "image" | "search" } = {}) {
    const search = new URLSearchParams();
    if (input.page) search.set("page", String(input.page));
    if (input.pageSize) search.set("pageSize", String(input.pageSize));
    if (input.keyword?.trim()) search.set("keyword", input.keyword.trim());
    if (input.status) search.set("status", input.status);
    if (input.capability) search.set("capability", input.capability);
    return requestGeminiAi<GeminiAiLogPage>(`/api/admin/geminiai/logs${search.size ? `?${search}` : ""}`);
}

export function clearGeminiAiLogs() {
    return requestGeminiAi<{ deletedCount: number }>("/api/admin/geminiai/logs", { method: "DELETE" });
}
