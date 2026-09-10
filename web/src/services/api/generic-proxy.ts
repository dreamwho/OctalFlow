import type { ChatGptLogPage, ChatGptLogStatus, ChatGptProxyGroup, ChatGptProxyNode, ChatGptProxyReference, ChatGptProxyView } from "./chatgpt-api";

export type { ChatGptLogPage, ChatGptLogStatus, ChatGptProxyGroup, ChatGptProxyNode, ChatGptProxyReference, ChatGptProxyView };

export async function genericProxyRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/admin/generic-proxy/${path}`, {
        cache: "no-store",
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; data?: T; msg?: string } | null;
    if (!response.ok || payload?.code !== 0 || payload.data === undefined) throw new Error(payload?.msg || "通用代理操作失败");
    return payload.data;
}

export type GenericProxyBindings = { bindings: Record<string, { enabled: boolean; target: string }>; revision: string };

export const getGenericProxyBindings = () => genericProxyRequest<GenericProxyBindings>("proxy/generic-bindings");

export const saveGenericProxyBinding = (input: { provider: string; enabled: boolean; target?: string }) =>
    genericProxyRequest<GenericProxyBindings>("proxy/generic-bindings", { method: "POST", body: JSON.stringify(input) });

export const getGenericProxyLogs = (params: { limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams(
        Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
    );
    return genericProxyRequest<ChatGptLogPage>(`logs?${query}`);
};
