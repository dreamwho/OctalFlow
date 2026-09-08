export type DreaminaRuntime = {
    installed: boolean;
    authorized: boolean;
    version?: string;
    commit?: string;
    buildTime?: string;
    account?: {
        userIdMasked: string;
        vipLevel: string;
        totalCredit: number;
    };
    checkedAt: string;
    error?: string;
};

export type DreaminaModelCapability = "image" | "video";

export type DreaminaModel = {
    id: string;
    upstreamModel: string;
    displayName: string;
    capability: DreaminaModelCapability;
    command: string;
    description: string;
    vipOnly?: boolean;
};

export type DreaminaStatsRange = "all" | "week" | "month" | "year";

export type DreaminaStats = {
    range: DreaminaStatsRange;
    startAt?: string;
    endAt: string;
    timeZone: string;
    total: number;
    success: number;
    failed: number;
    needsReview: number;
    officialCredits: number;
    observedCredits: number;
};

export type DreaminaOverview = {
    runtime: DreaminaRuntime;
    models: {
        enabledModelIds: string[];
        catalog: DreaminaModel[];
    };
    stats: DreaminaStats;
};

export type DreaminaLog = {
    id: string;
    createdAt: string;
    command: string;
    model: string;
    status: string;
    submissionId?: string;
    succeededAt?: string;
    failedAt?: string;
    beforeCredit?: number;
    afterCredit?: number;
    observedCreditDelta?: number;
    creditObservation: "official" | "unavailable" | "observed" | "ambiguous" | "inconsistent";
    durationMs?: number;
    error?: string;
    requestSummary: Record<string, unknown>;
    submissionSummary: Record<string, unknown>;
    resultSummary: Record<string, unknown>;
};

export type DreaminaLogPage = {
    items: DreaminaLog[];
    total: number;
    page: number;
    pageSize: number;
};

type ApiEnvelope<T> = { code?: number; data?: T; msg?: string; error?: string };

async function request<T>(path: string, init?: RequestInit, allowEmptyData = false) {
    const response = await fetch(path, {
        cache: "no-store",
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !payload || (typeof payload.code === "number" && payload.code !== 0)) {
        throw new Error(payload?.msg || payload?.error || "即梦 CLI 请求失败");
    }
    if (payload.data === undefined) {
        if (allowEmptyData) return undefined as T;
        throw new Error(payload.msg || payload.error || "即梦 CLI 未返回数据");
    }
    return payload.data;
}

const json = (value: unknown) => JSON.stringify(value);

export const getDreaminaOverview = () => request<DreaminaOverview>("/api/admin/dreamina");

export const getDreaminaStats = (range: DreaminaStatsRange = "all") => request<DreaminaStats>(`/api/admin/dreamina/stats?range=${range}`);

export const refreshDreaminaStatus = () => request<unknown>("/api/admin/dreamina/refresh", { method: "POST" }, true);

export const saveDreaminaModels = (modelIds: string[]) =>
    request<{ enabledModelIds: string[] }>("/api/admin/dreamina/models", {
        method: "PUT",
        body: json({ modelIds }),
    });

export function getDreaminaLogs(input: { page?: number; pageSize?: number; status?: string; command?: string } = {}) {
    const search = new URLSearchParams();
    if (input.page !== undefined) search.set("page", String(input.page));
    if (input.pageSize !== undefined) search.set("pageSize", String(input.pageSize));
    if (input.status?.trim()) search.set("status", input.status.trim());
    if (input.command?.trim()) search.set("command", input.command.trim());
    return request<DreaminaLogPage>(`/api/admin/dreamina/logs${search.size ? `?${search}` : ""}`);
}

export const clearDreaminaLogs = () => request<{ deletedCount?: number }>("/api/admin/dreamina/logs", { method: "DELETE" }, true);

// Keep the provider name explicit for callers that distinguish the CLI channel.
export const getDreaminaCliOverview = getDreaminaOverview;
export const getDreaminaCliStats = getDreaminaStats;
export const refreshDreaminaCliStatus = refreshDreaminaStatus;
export const saveDreaminaCliModels = saveDreaminaModels;
export const getDreaminaCliLogs = getDreaminaLogs;
export const clearDreaminaCliLogs = clearDreaminaLogs;

export type DreaminaCliRuntime = DreaminaRuntime;
export type DreaminaCliModel = DreaminaModel;
export type DreaminaCliOverview = DreaminaOverview;
export type DreaminaCliLog = DreaminaLog;
export type DreaminaCliLogPage = DreaminaLogPage;
