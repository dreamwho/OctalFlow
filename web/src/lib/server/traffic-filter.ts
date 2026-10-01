import type { TrafficFilter } from "@/lib/admin-traffic-types";

export function parseTrafficFilter(input: URLSearchParams): TrafficFilter {
    const start = input.get("start") || "";
    const end = input.get("end") || "";
    if (![start, end].every((value) => /^\d{4}-.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) || Date.parse(start) >= Date.parse(end)) {
        throw new Error("请选择带时区的有效开始和结束时间");
    }
    const filter: TrafficFilter = { start, end };
    for (const key of ["channelId", "model", "protocol", "connectionMode"] as const) {
        const value = input.get(key);
        if (value) filter[key] = value;
    }
    const port = input.get("port");
    if (port !== null && port !== "") {
        if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error("代理端口无效");
        filter.port = Number(port);
    }
    return filter;
}
