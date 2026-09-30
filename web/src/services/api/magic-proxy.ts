export type MagicProxyProvider = "geminiai" | "geminiTools" | "chatgptApi" | "dola" | "dolaUpload";

export type MagicProxyNode = {
    name: string;
    type: string;
    alive?: boolean;
    delay?: number | null;
    subscriptionId?: string;
    subscriptionName?: string;
};

export type MagicProxyGroup = {
    name: string;
    type: string;
    now: string;
    all: string[];
};

export type MagicProxySubscriptionGroup = {
    name: string;
    type?: string;
    proxies: string[];
};

export type MagicProxyPublicSubscription = {
    id: string;
    name: string;
    url: string;
    type: "remote" | "file";
    enabled: boolean;
    nodeCount: number;
    groups: MagicProxySubscriptionGroup[];
    updatedAt: string;
    lastTestedAt?: string;
};

export type MagicProxyChainedConfig = {
    hop_node: string;
    landing_node_id: string;
    hop_fallback_node?: string;
};

export type MagicProxyBinding = {
    enabled: boolean;
    node?: string;
    /** 兜底节点：主节点拨号失败时由内核 fallback 组自动接管（仅 magic 模式）。 */
    fallback_node?: string;
    mode?: "magic" | "chained";
    chained_config?: MagicProxyChainedConfig;
};

export type MagicProxyState = {
    configured: boolean;
    runtimeAvailable: boolean;
    lastUpdatedAt?: string;
    nodeCount: number;
    nodes: MagicProxyNode[];
    groups: MagicProxyGroup[];
    subscriptionGroups?: MagicProxySubscriptionGroupView[];
    subscriptions?: MagicProxyPublicSubscription[];
    bindings: Partial<Record<MagicProxyProvider, MagicProxyBinding>> & Record<Exclude<MagicProxyProvider, "dola" | "dolaUpload">, MagicProxyBinding>;
};

export type MagicProxySubscriptionGroupView = {
    name: string;
    type: string;
    subId: string;
    subName: string;
    proxies: string[];
    now?: string;
    alive?: boolean;
    delay?: number | null;
};

export type MagicProxyBindingPatch = {
    provider: MagicProxyProvider;
    enabled: boolean;
    node?: string;
    fallback_node?: string;
    mode?: "magic" | "chained";
    chained_config?: MagicProxyChainedConfig;
};

export type MagicProxySubscriptionImport = {
    url?: string;
    content?: string;
    name?: string;
    subscriptionId?: string;
    id?: string;
    replace?: boolean;
};

export type MagicProxySubscriptionUpdate = {
    id: string;
    name?: string;
    enabled?: boolean;
};

type ApiEnvelope<T> = { code?: number; data?: T; msg?: string; error?: string };

async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(path, {
        cache: "no-store",
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !payload || (typeof payload.code === "number" && payload.code !== 0)) {
        throw new Error(payload?.msg || payload?.error || "魔法代理请求失败");
    }
    if (payload.data === undefined) throw new Error(payload.msg || "魔法代理未返回数据");
    return payload.data;
}

const json = (value: unknown) => JSON.stringify(value);

export const getMagicProxy = () => request<MagicProxyState>("/api/admin/magic-proxy");
export const getMagicProxyState = getMagicProxy;

export const importMagicProxySubscription = (input: string | MagicProxySubscriptionImport) =>
    request<MagicProxyState>("/api/admin/magic-proxy/subscription", {
        method: "POST",
        body: json(typeof input === "string" ? { url: input } : input),
    });

export const refreshMagicProxySubscription = (subscriptionId?: string) =>
    request<MagicProxyState>("/api/admin/magic-proxy/subscription", {
        method: "POST",
        body: json(subscriptionId ? { subscriptionId } : {}),
    });

export const updateMagicProxySubscriptionSetting = (input: MagicProxySubscriptionUpdate) =>
    request<MagicProxyState>("/api/admin/magic-proxy/subscription", {
        method: "PATCH",
        body: json(input),
    });

export const deleteMagicProxySubscription = (id: string) =>
    request<MagicProxyState>(`/api/admin/magic-proxy/subscription?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
    });

export const updateMagicProxyBinding = (input: MagicProxyBindingPatch) =>
    request<MagicProxyState>("/api/admin/magic-proxy", {
        method: "PATCH",
        body: json(input),
    });

export const saveMagicProxyBinding = updateMagicProxyBinding;

export type MagicProxyDelayResult = { name: string; delay?: number; error?: string };

export const testMagicProxyNode = (node: string, signal?: AbortSignal) =>
    request<MagicProxyDelayResult>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({ node }),
        signal,
    });

export const testMagicProxyAllNodes = (signal?: AbortSignal) =>
    request<{ results: MagicProxyDelayResult[] }>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({}),
        signal,
    });

export type MagicProxyGoogleTestItem = {
    service: MagicProxyProvider;
    serviceTitle: string;
    group: string;
    activeNode: string;
    enabled: boolean;
    ok: boolean;
    delay?: number;
    error?: string;
};

export type MagicProxyGoogleTestReport = {
    targetUrl: string;
    testedAt: string;
    overallOk: boolean;
    items: MagicProxyGoogleTestItem[];
};

export const testMagicProxyGoogle = (node?: string, signal?: AbortSignal) =>
    request<MagicProxyGoogleTestReport>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({ action: "testGoogle", node: node || undefined }),
        signal,
    });

export const testChatGptChain = (signal?: AbortSignal) =>
    request<MagicProxyGoogleTestReport>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({ action: "testChatGptChain" }),
        signal,
    });

export const testMagicProxyDola = (signal?: AbortSignal) =>
    request<MagicProxyGoogleTestReport>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({ action: "testDola" }),
        signal,
    });
