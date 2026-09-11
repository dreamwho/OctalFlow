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
export type ChatGptLogStatus = "" | "success" | "failed" | "limited";
export type ChatGptLogField = { label: string; value: string; copyable?: boolean; wide?: boolean };
export type ChatGptLogTimelineStep = { key: string; label: string; category: string; value_ms: number; value_text: string; tone: string; status_label: string; time: string; description: string };
export type ChatGptLogTimeline = {
    segments: Array<{ key: string; label: string; category: string; value_ms: number; value_text: string; tone: string }>;
    legend_items: Array<{ key: string; label: string; category: string; tone: string }>;
    groups: Array<{ key: string; label: string; steps: ChatGptLogTimelineStep[] }>;
};
export type ChatGptLogPresentation = {
    request?: { kind?: string; primary?: string; secondary?: string };
    execution?: { primary?: string; secondary?: string };
    status?: { label?: string; tone?: string };
    result?: { text?: string; diagnostics?: string };
    summary_text?: string;
    duration?: { text?: string; breakdown?: string; tone?: string };
    is_failure?: boolean;
};
export type ChatGptLogSummary = {
    id: string;
    time?: string;
    type?: string;
    summary?: string;
    business?: string;
    outcome?: string;
    display_status?: string;
    endpoint?: string;
    model?: string;
    started_at?: string;
    ended_at?: string;
    duration_ms?: number;
    key_id?: string;
    key_name?: string;
    role?: string;
    account_email?: string;
    conversation_id?: string;
    status_code?: number;
    error_code?: string;
    public_error?: string;
    image_requested_count?: number;
    image_succeeded_count?: number;
    image_failed_count?: number;
    image_result_status?: string;
    preview_image_url?: string;
    attempt_count?: number;
    switch_count?: number;
    recovered_after_switch?: boolean;
    proxy_egress?: { mode?: string; group_id?: string; node_id?: string; node_name?: string; address?: string };
    presentation?: ChatGptLogPresentation;
};
export type ChatGptLogAttempt = {
    slot?: number;
    attempt?: number;
    account_email?: string;
    conversation_id?: string;
    status?: string;
    outcome?: string;
    result_status?: string;
    duration_ms?: number;
    status_code?: number;
    error_code?: string;
    error_label?: string;
    public_error?: string;
    upstream_error?: string;
    upstream_text?: string;
    switched_account?: boolean | null;
    timings_ms?: Record<string, number>;
    monitor?: Record<string, unknown>;
    presentation?: { status?: { label?: string; tone?: string }; failure_label?: string; switch_label?: string; error_code_text?: string; status_code_text?: string; timeline?: ChatGptLogTimeline };
};
export type ChatGptLogDetail = ChatGptLogSummary & {
    request_text?: string;
    request_text_full?: string;
    request_text_truncated?: boolean;
    request_shape?: Record<string, unknown>;
    response?: Record<string, unknown>;
    request_meta?: { lifecycle?: Array<{ time: string; status: string; message: string }>; [key: string]: unknown };
    upstream_error?: string;
    upstream_text?: string;
    image_urls?: string[];
    attempts?: ChatGptLogAttempt[];
    timings_ms?: Record<string, number>;
    perf?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    monitor?: Record<string, unknown>;
    detail_presentation?: {
        primary_fields?: ChatGptLogField[];
        diagnostic_fields?: ChatGptLogField[];
        auto_expand_timeline?: boolean;
        timeline?: ChatGptLogTimeline;
        attempt_groups?: Array<{ slot?: number; slot_label?: string; attempt_count?: number; attempt_text?: string; switch_count?: number; switch_text?: string; status?: { label?: string; tone?: string } }>;
    };
};
export type ChatGptLogPage = {
    items: ChatGptLogSummary[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
    facets_scope?: string;
    stats_scope?: string;
    total_scope?: string;
    facets?: { statuses?: Record<string, number>; endpoints?: Record<string, number>; models?: Record<string, number>; accounts?: Record<string, number> };
    stats?: { total?: number; success?: number; text_review?: number; failed?: number; limited?: number; image?: number };
};
export type ChatGptProxyRuntimeMode = "native" | "magic";
export type ChatGptProxyNativeSource = "manual" | "ipwo";
export type ChatGptProxyRuntime = {
    enabled: boolean;
    mode: ChatGptProxyRuntimeMode;
    native_source: ChatGptProxyNativeSource;
    magicConfigured: boolean;
    ipwoConfigured: boolean;
};
export type ChatGptProxyRuntimePatch = Partial<ChatGptProxyRuntime>;
export type ChatGptProxyProbe = {
    id: string;
    name: string;
    url: string;
    ok: boolean;
    status_code: number;
    latency_ms: number;
    error?: string | null;
    egress_ip?: string | null;
    loc?: string | null;
};

export type ChatGptProxyDiagnostics = {
    proxy?: {
        scheme?: string;
        host?: string;
        port?: number;
        has_auth?: boolean;
        username_masked?: string | null;
    };
    server_context?: {
        server_public_ip?: string | null;
        server_os?: string;
    };
    dns?: {
        ok: boolean;
        latency_ms: number;
        resolved_ips?: string[];
        error?: string | null;
    };
    tcp?: {
        ok: boolean;
        latency_ms: number;
        error?: string | null;
    };
    probes?: ChatGptProxyProbe[];
    analysis?: {
        stage?: string;
        title?: string;
        summary?: string;
        suggestions?: string[];
    };
};

export type ChatGptProxyHealth = {
    state: "healthy" | "unhealthy" | "unknown" | string;
    latency_ms?: number | null;
    error?: string | null;
    diagnostics?: ChatGptProxyDiagnostics | null;
};

export type ChatGptProxyReference = { mode: "direct" | "group" | "node" | "custom"; group_id?: string; node_id?: string; url?: string };
export type ChatGptProxyNode = { id: string; name: string; url: string; enabled: boolean; image_concurrency_limit: number; notes: string; health?: ChatGptProxyHealth };
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

export const getChatGptLogs = (params: { limit?: number; offset?: number; search?: string; status?: Exclude<ChatGptLogStatus, ""> } = {}) => {
    const query = new URLSearchParams(
        Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)]),
    );
    return chatGptApiRequest<ChatGptLogPage>(`logs?${query}`);
};

export const getChatGptProxyRuntime = (init?: RequestInit) => chatGptApiRequest<ChatGptProxyRuntime>("proxy-selection", init);

export const updateChatGptProxyRuntime = (input: ChatGptProxyRuntimePatch, init?: RequestInit) => chatGptApiRequest<ChatGptProxyRuntime>("proxy-selection", { ...init, method: "PATCH", body: JSON.stringify(input) });

export type ChatGptProxyNodeTestResult = {
    status: "passed" | "failed";
    latency_ms: number;
    error_message?: string;
    details?: { target_url?: string };
};

export async function testChatGptProxyNode(groupId: string, nodeId: string, timeoutMs = 15_000) {
    const payload = await chatGptApiRequest<{ results?: Array<{ node_id?: string; result?: { ok?: boolean; latency_ms?: number; error?: string; status?: number } }> }>("proxies/groups/test", {
        method: "POST",
        body: JSON.stringify({ id: groupId, node_id: nodeId }),
        signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    });
    const row = payload.results?.find((item) => item.node_id === nodeId)?.result || payload.results?.[0]?.result;
    return {
        result: {
            status: row?.ok ? "passed" : "failed",
            latency_ms: Number(row?.latency_ms || 0),
            ...(row?.error ? { error_message: row.error } : {}),
            details: { target_url: nodeId },
        } satisfies ChatGptProxyNodeTestResult,
    };
}
