import { Agent, fetch as undiciFetch } from "undici";
import type { AdminTrafficSummary, AdminTrafficTaskReport, AdminRequestTrafficReport, TrafficFilter } from "@/lib/admin-traffic-types";
import { GENERATION_TRANSPORT_TIMEOUT_MS } from "@/lib/server/generation-http-lifecycle";
import type { TrafficContext } from "./traffic-context";

const internalDispatcher = new Agent({ headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS, bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS });

export function trafficMeterConfigured() {
    return Boolean(process.env.DREAMYO_TRAFFIC_METER_URL?.trim());
}

async function meterRequest(path: string, init: { method?: string; body?: string; signal?: AbortSignal | null } = {}) {
    const base = process.env.DREAMYO_TRAFFIC_METER_URL?.trim();
    const key = process.env.DREAMYO_TRAFFIC_METER_KEY?.trim();
    if (!base || !key) throw new Error("全局流量计量服务尚未配置");
    const response = await undiciFetch(`${base.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers: { "x-traffic-key": key, "content-type": "application/json" },
        dispatcher: internalDispatcher,
        redirect: "error",
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`流量计量服务请求失败（HTTP ${response.status}）`);
    }
    return response;
}

export async function createTrafficLease(proxyUrl: string | undefined, context: TrafficContext, pinnedTargets: Array<{ hostname: string; address: string }>, signal?: AbortSignal | null) {
    if (!trafficMeterConfigured()) return null;
    const response = await meterRequest("/internal/leases", { method: "POST", body: JSON.stringify({ proxyUrl: proxyUrl || null, context, pinnedTargets }), signal });
    const lease = (await response.json()) as { leaseId: string; proxyUrl: string };
    if (!lease.leaseId || !lease.proxyUrl) throw new Error("流量计量服务返回的连接无效");
    return {
        ...lease,
        async release() {
            const response = await meterRequest(`/internal/leases/${encodeURIComponent(lease.leaseId)}`, { method: "DELETE" });
            await response.body?.cancel();
        },
    };
}

export async function queryGlobalTraffic(filter: TrafficFilter): Promise<AdminTrafficSummary> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") params.set(key, String(value));
    const response = await meterRequest(`/internal/traffic?${params}`);
    return (await response.json()) as AdminTrafficSummary;
}

export async function queryTaskTraffic(filter: TrafficFilter & { page: number; pageSize: number }): Promise<AdminTrafficTaskReport> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") params.set(key, String(value));
    return (await (await meterRequest(`/internal/traffic/tasks?${params}`)).json()) as AdminTrafficTaskReport;
}

export async function queryRequestTraffic(requestIds: string[], taskIds: string[] = []): Promise<AdminRequestTrafficReport> {
    return (await (await meterRequest("/internal/traffic/requests", { method: "POST", body: JSON.stringify({ requestIds, taskIds }) })).json()) as AdminRequestTrafficReport;
}
