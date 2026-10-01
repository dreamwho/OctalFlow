import type { TrafficDisplayUnit } from "@/lib/traffic-format";

export type TrafficFilter = {
    start: string;
    end: string;
    channelId?: string;
    model?: string;
    protocol?: string;
    connectionMode?: string;
    port?: number;
};

export type TrafficItem = {
    requestId?: string;
    taskId?: string;
    attemptId?: string;
    channelId: string;
    channelName: string;
    model: string;
    protocol: string;
    connectionMode: string;
    role: string;
    attributionScope?: "exact" | "shared_browser";
    address: string;
    port: number;
    uploadBytes: number;
    downloadBytes: number;
    totalBytes: number;
};

/** A request/task grouping returned by the administrator traffic endpoints. */
export type RequestTrafficSummary = {
    requestId?: string;
    taskId?: string;
    uploadBytes: number;
    downloadBytes: number;
    totalBytes: number;
    firstSeenAt: string;
    lastSeenAt: string;
    items: TrafficItem[];
};

export type AdminRequestTrafficReport = {
    displayUnit: TrafficDisplayUnit;
    items: RequestTrafficSummary[];
    tasks?: RequestTrafficSummary[];
};

export type AdminTrafficTaskReport = {
    displayUnit: TrafficDisplayUnit;
    page: number;
    pageSize: number;
    total: number;
    items: RequestTrafficSummary[];
};

export type AdminTrafficTaskFilter = TrafficFilter & {
    page?: number;
    pageSize?: number;
    requestId?: string;
    taskId?: string;
    attemptId?: string;
};

export type AdminTrafficSummary = {
    start: string;
    end: string;
    boundary: string;
    uploadBytes: number;
    downloadBytes: number;
    totalBytes: number;
    displayUnit: TrafficDisplayUnit;
    items: TrafficItem[];
    options: {
        channels: Array<{ id: string; name: string }>;
        models: string[];
        connectionModes: string[];
    };
    coverage?: Array<{ source: string; status: string; message: string }>;
};
