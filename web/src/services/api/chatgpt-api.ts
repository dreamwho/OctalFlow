export type ChatGptAccount = {
    id: string;
    display_name: string;
    email: string;
    source_plan_label: string;
    status_label: string;
    status_reason: string;
    enabled: boolean;
    quota_label: string;
    success_count: number;
    failure_count: number;
};
export type ChatGptAccountPage = { items: ChatGptAccount[]; total: number };
export type ChatGptModelCatalog = { chat_models: string[]; image_models: string[]; source: { chat: string; image: string } };
export type ChatGptKey = { id: string; name: string; enabled: boolean; created_at?: string; last_used_at?: string };
export type ChatGptGateway = { enabled: boolean };
export type ChatGptProxyRuntimeMode = "native" | "magic";
export type ChatGptProxyNativeSource = "manual" | "ipwo";
export type ChatGptProxyRuntime = {
    enabled: boolean;
    mode: ChatGptProxyRuntimeMode;
    native_source: ChatGptProxyNativeSource;
    magicConfigured: boolean;
    ipwoConfigured: boolean;
};
export type ChatGptProxyRuntimePatch = Pick<ChatGptProxyRuntime, "enabled" | "mode" | "native_source">;
export type ChatGptProxyReference = { mode: "direct" | "group" | "custom"; group_id?: string; url?: string };
export type ChatGptProxyNode = { id: string; name: string; url: string; enabled: boolean; image_concurrency_limit: number; notes: string; health?: { state: string; latency_ms?: number | null; error?: string | null } };
export type ChatGptProxyGroup = {
    id: string;
    name: string;
    enabled: boolean;
    strategy: "request_random" | "time_window" | "round_robin";
    rotation_interval_minutes: number;
    notes: string;
    nodes: ChatGptProxyNode[];
    can_delete: boolean;
    references: string[];
};
export type ChatGptProxyView = { revision: string; default_reference: ChatGptProxyReference; fallback_reference: ChatGptProxyReference | null; effective_default: { label: string }; effective_fallback: { label: string }; groups: ChatGptProxyGroup[] };
export type ChatGptStatistics = {
    runtime: {
        runtime_mode: "docker" | "native";
        instance_name: string;
        distribution: string;
        kernel_version: string;
        architecture: string;
        python_version: string;
        cpu_capacity: number;
        service_started_at: string;
        service_uptime_seconds: number;
        process_cpu_percent: number | null;
        process_memory_bytes: number | null;
        process_memory_percent: number | null;
        memory_scope: "container" | "system" | "visible";
        memory_percent: number | null;
        storage_percent: number | null;
        network_rx_bytes_per_sec: number | null;
        network_tx_bytes_per_sec: number | null;
    };
    time_range: "24h" | "7d" | "30d";
    totals: { total: number; success: number; final_failed: number; success_rate: number | null; avg_success_duration_ms: number | null };
    switching: { requests: number; count: number; recovered: number; recovery_rate: number | null };
    buckets: Array<{ label: string; start_at: string; total_calls: number; success_calls: number; final_failed_calls: number; success_rate: number | null; avg_success_duration_ms: number | null }>;
    trend: { labels: string[]; model_success_requests: Record<string, number[]>; model_avg_success_duration_ms: Record<string, Array<number | null>> };
};

export async function chatGptApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/admin/chatgpt-api/${path}`, {
        cache: "no-store",
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; data?: T; msg?: string } | null;
    if (!response.ok || payload?.code !== 0 || payload.data === undefined) throw new Error(payload?.msg || "GPTAPI 操作失败");
    return payload.data;
}

export const getChatGptProxyRuntime = (init?: RequestInit) => chatGptApiRequest<ChatGptProxyRuntime>("proxy-selection", init);

export const updateChatGptProxyRuntime = (input: ChatGptProxyRuntimePatch, init?: RequestInit) => chatGptApiRequest<ChatGptProxyRuntime>("proxy-selection", { ...init, method: "PATCH", body: JSON.stringify(input) });
