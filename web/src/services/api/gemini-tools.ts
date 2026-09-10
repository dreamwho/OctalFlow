export type GeminiToolsQuota = { model: string; displayName: string; remainingPercent?: number; resetTime?: string; supportsImages?: boolean; supportsThinking?: boolean };
export type GeminiToolsAccount = {
    id: string;
    email: string;
    name: string;
    picture?: string;
    status: "active" | "disabled" | "invalid";
    proxyEnabled: boolean;
    priority: number;
    planType?: string;
    quotas: GeminiToolsQuota[];
    requestCount: number;
    totalTokens: number;
    errorCount: number;
    note?: string;
    lastUsedAt?: string;
    createdAt: string;
    updatedAt: string;
};
export type GeminiToolsApiKey = { id: string; name: string; prefix: string; status: "active" | "disabled"; expiresAt?: string; allowedIps: string[]; requestCount: number; totalTokens: number; lastUsedAt?: string; createdAt: string };
export type GeminiToolsLog = {
    id: string;
    createdAt: string;
    protocol: "openai" | "gemini" | "anthropic" | "admin-test";
    method?: string;
    path: string;
    model: string;
    accountId?: string;
    accountEmail?: string;
    statusCode: number;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    imageRequestedCount?: number;
    imageSucceededCount?: number;
    imageFailedCount?: number;
    clientIp?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    error?: string;
    keyPrefix?: string;
    requestPreview?: string;
    responsePreview?: string;
    proxyEgress?: { mode: "magic" | "generic"; node_name?: string; address?: string };
    phase?: "queued" | "running" | "success" | "failed";
    lifecycle?: Array<{ time: string; phase: "queued" | "running" | "success" | "failed"; message: string }>;
};
export type GeminiToolsGateway = { enabled: boolean; strategy: "round_robin" | "priority"; sessionStickiness: boolean };
export type GeminiToolsModel = { id: string; name: string; enabled: boolean; available: boolean };
export type GeminiToolsOverview = {
    configured: boolean;
    healthy: boolean;
    accounts: GeminiToolsAccount[];
    apiKeys: GeminiToolsApiKey[];
    gateway: GeminiToolsGateway;
    logs: { items: GeminiToolsLog[]; total: number; page: number; pageSize: number };
    models: GeminiToolsModel[];
    channel?: { id: string; name: string; enabled: boolean; models: string[] };
    oauthRedirectUri?: string;
};
export type GeminiToolsModelCatalogSync = {
    accountResults: Array<{ id: string; ok: boolean; error?: string }>;
    discoveredModels: Array<Pick<GeminiToolsModel, "id" | "name">>;
    newModels: Array<Pick<GeminiToolsModel, "id" | "name">>;
    enabledNewModelIds: string[];
    overview: GeminiToolsOverview;
};

type Envelope<T> = { code?: number; data?: T; msg?: string; error?: string };

async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !payload || (typeof payload.code === "number" && payload.code !== 0)) throw new Error(payload?.msg || payload?.error || "GeminiTools 请求失败");
    if (payload.data === undefined) throw new Error(payload.msg || "GeminiTools 未返回数据");
    return payload.data;
}

const json = (value: unknown) => JSON.stringify(value);
const id = (value: string) => encodeURIComponent(value);

export const getGeminiToolsOverview = () => request<GeminiToolsOverview>("/api/admin/gemini-tools");
export const startGeminiToolsOAuth = () =>
    request<{ authUrl: string; redirectUri: string }>("/api/admin/gemini-tools/oauth/start", {
        method: "POST",
        headers: { "x-octalflow-browser-origin": window.location.origin },
    });
export const updateGeminiToolsAccount = (accountId: string, patch: Partial<Pick<GeminiToolsAccount, "name" | "note" | "status" | "proxyEnabled" | "priority">>) =>
    request<GeminiToolsAccount>(`/api/admin/gemini-tools/accounts/${id(accountId)}`, { method: "PATCH", body: json(patch) });
export const deleteGeminiToolsAccount = (accountId: string) => request<{ deleted: true }>(`/api/admin/gemini-tools/accounts/${id(accountId)}`, { method: "DELETE" });
export const refreshGeminiToolsAccount = (accountId: string) => request<GeminiToolsAccount>(`/api/admin/gemini-tools/accounts/${id(accountId)}/refresh`, { method: "POST" });
export const refreshAllGeminiToolsAccounts = () => request<Array<{ id: string; ok: boolean; error?: string }>>("/api/admin/gemini-tools/accounts/refresh", { method: "POST" });
export const saveGeminiToolsModels = (models: string[]) => request<{ channel: GeminiToolsOverview["channel"]; models: GeminiToolsModel[] }>("/api/admin/gemini-tools/models", { method: "PUT", body: json({ models }) });
export const syncGeminiToolsModels = (input: { enableNewModels?: boolean } = {}) => request<GeminiToolsModelCatalogSync>("/api/admin/gemini-tools/models/sync", { method: "POST", body: json(input) });
export const saveGeminiToolsGateway = (gateway: Partial<GeminiToolsGateway>) => request<GeminiToolsGateway>("/api/admin/gemini-tools/gateway", { method: "PATCH", body: json(gateway) });
export const createGeminiToolsApiKey = (input: { name: string; expiresAt?: string; allowedIps?: string[] }) => request<{ key: GeminiToolsApiKey; rawKey: string }>("/api/admin/gemini-tools/keys", { method: "POST", body: json(input) });
export const updateGeminiToolsApiKey = (keyId: string, patch: Partial<Pick<GeminiToolsApiKey, "name" | "status" | "expiresAt" | "allowedIps">>) =>
    request<GeminiToolsApiKey>(`/api/admin/gemini-tools/keys/${id(keyId)}`, { method: "PATCH", body: json(patch) });
export const deleteGeminiToolsApiKey = (keyId: string) => request<{ deleted: true }>(`/api/admin/gemini-tools/keys/${id(keyId)}`, { method: "DELETE" });
export const getGeminiToolsLogs = (params: { page?: number; pageSize?: number; keyword?: string; status?: "success" | "failed"; model?: string; accountId?: string; protocol?: string } = {}) => {
    const query = new URLSearchParams(
        Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)]),
    );
    return request<GeminiToolsOverview["logs"]>(`/api/admin/gemini-tools/logs?${query}`);
};
export const clearGeminiToolsLogs = () => request<{ count: number }>("/api/admin/gemini-tools/logs", { method: "DELETE" });
export const testGeminiToolsText = (input: { model: string; prompt: string }) => request<{ model: string; text: string }>("/api/admin/gemini-tools/test", { method: "POST", body: json(input) });
