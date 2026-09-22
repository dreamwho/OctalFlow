import { chatGptRuntimeJson } from "@/lib/server/chatgpt-api-service";
import { DolaProviderError } from "./provider";

export type DolaProxyEgress = { mode: "direct" | "magic" | "generic" | "chained"; target?: string; nodeName?: string; address?: string };
export type DolaProxyBinding = { enabled: boolean; mode: DolaProxyEgress["mode"]; target: string };
/** Provider contract uses `managed` for any server-managed Dola egress mode. */
export function dolaProviderProxyMode(egress: DolaProxyEgress): "direct" | "managed" {
    return egress.mode === "direct" ? "direct" : "managed";
}

/**
 * Dola uses the same generic proxy registry as GeminiAIStudio. Only the
 * opaque node/group reference is persisted; the resolved URL is request-local
 * and is never returned to the browser or written to Dola logs.
 */
export async function getDolaProxyBinding(): Promise<DolaProxyBinding> {
    // The Dola overview must expose the same effective source that the request
    // resolver will use. Read the provider binding first so a saved magic or
    // chained selection is not incorrectly presented as a generic/direct mode.
    try {
        const { getMagicProxyOverview } = await import("@/lib/server/magic-proxy-service");
        const overview = await getMagicProxyOverview();
        const binding = overview.bindings.dola;
        if (binding?.enabled) {
            const mode = binding.mode === "chained" ? "chained" : "magic";
            return { enabled: true, mode, target: mode === "chained" ? binding.chained_config?.landing_node_id || binding.chained_config?.hop_node || "chained" : binding.node || "" };
        }
    } catch {
        // Keep the generic binding fallback available when Mihomo is offline.
    }
    try {
        const payload = await chatGptRuntimeJson<{ bindings?: Record<string, { enabled?: boolean; target?: string }> }>("/api/proxy/generic-bindings");
        const binding = payload.bindings?.dola;
        return { enabled: binding?.enabled === true, mode: binding?.enabled === true ? "generic" : "direct", target: typeof binding?.target === "string" ? binding.target.trim() : "" };
    } catch {
        return { enabled: false, mode: "direct", target: "" };
    }
}

export async function resolveDolaProxyEgress(): Promise<{ proxyUrl?: string; egress: DolaProxyEgress }> {
    try {
        // The same resolver used by GeminiAIStudio owns all three egress modes.
        // Keep the import lazy because the resolver itself can call back into the
        // generic proxy runtime when the selected source is a node/group.
        const { ensureMagicProxyProvider } = await import("@/lib/server/magic-proxy-service");
        const resolved = await ensureMagicProxyProvider("dola");
        if (!resolved.enabled || !resolved.proxyUrl) return { egress: { mode: "direct" } };
        const mode = resolved.egress?.mode === "magic" || resolved.egress?.mode === "chained" ? resolved.egress.mode : "generic";
        const nodeName = resolved.egress?.node_name?.trim() || undefined;
        const address = resolved.egress?.address?.trim() || undefined;
        const target = nodeName || address;
        return { proxyUrl: resolved.proxyUrl, egress: { mode, target, nodeName, address } };
    } catch (error) {
        if (error instanceof DolaProviderError) throw error;
        const message = error instanceof Error ? error.message : "Dola 代理出口不可用";
        throw new DolaProviderError(message, 503, "proxy_unavailable");
    }
}
