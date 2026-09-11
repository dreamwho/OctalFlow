export type MagicProxyProvider = "geminiai" | "geminiTools" | "chatgptApi";

export type MagicProxyNode = {
    name: string;
    type: string;
    alive?: boolean;
    delay?: number | null;
};

export type MagicProxyGroup = {
    name: string;
    type: string;
    now: string;
    all: string[];
};

export type MagicProxyBinding = {
    enabled: boolean;
    node?: string;
    mode?: "magic";
};

export type MagicProxyState = {
    configured: boolean;
    runtimeAvailable: boolean;
    lastUpdatedAt?: string;
    nodeCount: number;
    nodes: MagicProxyNode[];
    groups: MagicProxyGroup[];
    bindings: Record<MagicProxyProvider, MagicProxyBinding>;
};

export type MagicProxyBindingPatch = {
    provider: MagicProxyProvider;
    enabled: boolean;
    node?: string;
    mode?: "magic";
};

export type MagicProxySubscriptionImport = { url?: string; content?: string };

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

export const refreshMagicProxySubscription = () =>
    request<MagicProxyState>("/api/admin/magic-proxy/subscription", {
        method: "POST",
        body: json({}),
    });

export const updateMagicProxyBinding = (input: MagicProxyBindingPatch) =>
    request<MagicProxyState>("/api/admin/magic-proxy", {
        method: "PATCH",
        body: json(input),
    });

export const saveMagicProxyBinding = updateMagicProxyBinding;

export type MagicProxyDelayResult = { name: string; delay?: number; error?: string };

export const testMagicProxyNode = (node: string) =>
    request<MagicProxyDelayResult>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({ node }),
    });

export const testMagicProxyAllNodes = () =>
    request<{ results: MagicProxyDelayResult[] }>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({}),
    });

export type MagicProxyGoogleTestItem = {
    service: "geminiai" | "geminiTools" | "chatgptApi";
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

export const testMagicProxyGoogle = (node?: string) =>
    request<MagicProxyGoogleTestReport>("/api/admin/magic-proxy", {
        method: "POST",
        body: json({ action: "testGoogle", node: node || undefined }),
    });
