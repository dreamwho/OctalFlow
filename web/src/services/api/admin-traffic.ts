import { DEFAULT_TRAFFIC_DISPLAY_UNIT } from "@/lib/traffic-format";
import type { AdminRequestTrafficReport, AdminTrafficTaskFilter, AdminTrafficTaskReport, AdminTrafficSummary, TrafficFilter } from "@/lib/admin-traffic-types";

type AdminApiPayload<T> = {
    code?: number;
    data?: T;
    msg?: string;
};

async function readAdminTrafficPayload<T>(response: Response, fallbackMessage: string): Promise<T> {
    const payload = (await response.json()) as AdminApiPayload<T> | T;
    if (!response.ok) {
        const message = typeof payload === "object" && payload !== null && "msg" in payload && typeof payload.msg === "string" ? payload.msg : fallbackMessage;
        throw new Error(message);
    }
    if (typeof payload === "object" && payload !== null && "code" in payload && typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(typeof payload.msg === "string" ? payload.msg : fallbackMessage);
    }
    if (typeof payload === "object" && payload !== null && "data" in payload && payload.data !== undefined) return payload.data as T;
    return payload as T;
}

function appendTrafficFilter(query: URLSearchParams, filter: TrafficFilter) {
    for (const key of ["channelId", "model", "protocol", "connectionMode", "port"] as const) {
        const value = filter[key];
        if (value !== undefined && value !== "") query.set(key, String(value));
    }
}

function appendTaskFilter(query: URLSearchParams, filter: AdminTrafficTaskFilter) {
    appendTrafficFilter(query, filter);
    for (const key of ["requestId", "taskId", "attemptId"] as const) {
        const value = filter[key];
        if (value) query.set(key, value);
    }
}

export async function getAdminTraffic(filter: TrafficFilter) {
    const query = new URLSearchParams({ start: filter.start, end: filter.end });
    appendTrafficFilter(query, filter);
    const response = await fetch(`/api/admin/traffic?${query}`, { cache: "no-store" });
    return readAdminTrafficPayload<AdminTrafficSummary>(response, "读取流量统计失败");
}

/** Fetch all traffic groups for the visible request-log page in one request. */
export type AdminRequestTrafficQuery = {
    requestIds?: string[];
    taskIds?: string[];
};

export async function getAdminRequestTraffic(requestIdsOrQuery: string[] | AdminRequestTrafficQuery, signal?: AbortSignal): Promise<AdminRequestTrafficReport> {
    const query = Array.isArray(requestIdsOrQuery) ? { requestIds: requestIdsOrQuery } : requestIdsOrQuery;
    const requestIds = Array.from(new Set((query.requestIds || []).map((value) => value.trim()).filter(Boolean)));
    const taskIds = Array.from(new Set((query.taskIds || []).map((value) => value.trim()).filter(Boolean)));
    if (!requestIds.length && !taskIds.length) return { displayUnit: DEFAULT_TRAFFIC_DISPLAY_UNIT, items: [] };
    const response = await fetch("/api/admin/traffic/requests", {
        method: "POST",
        cache: "no-store",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestIds, ...(taskIds.length ? { taskIds } : {}) }),
    });
    return readAdminTrafficPayload<AdminRequestTrafficReport>(response, "读取请求流量失败");
}

/** Fetch paged task/request groups using the same window and filters as the global panel. */
export async function getAdminTrafficTasks(filter: AdminTrafficTaskFilter, signal?: AbortSignal): Promise<AdminTrafficTaskReport> {
    const query = new URLSearchParams({ start: filter.start, end: filter.end });
    appendTaskFilter(query, filter);
    if (filter.page !== undefined) query.set("page", String(filter.page));
    if (filter.pageSize !== undefined) query.set("pageSize", String(filter.pageSize));
    const response = await fetch(`/api/admin/traffic/tasks?${query}`, { cache: "no-store", signal });
    return readAdminTrafficPayload<AdminTrafficTaskReport>(response, "读取任务流量失败");
}
