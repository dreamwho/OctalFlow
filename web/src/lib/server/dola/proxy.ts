import { chatGptRuntimeJson } from "@/lib/server/chatgpt-api-service";
import { DolaProviderError } from "./provider";

export type DolaProxyEgress = { mode: "direct" | "magic" | "generic" | "chained"; target?: string; nodeName?: string; address?: string };
export type DolaProxyBinding = { enabled: boolean; mode: DolaProxyEgress["mode"]; target: string };
export type DolaLoginProxySelection = { mode: "default" | DolaProxyEgress["mode"]; target?: string };
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

/** ImageX gets its own Mihomo listener/binding; it never inherits the browser submission route. */
export async function resolveDolaImagexUploadEgress(hasReferences = true): Promise<{ mode: "direct" | "managed"; proxyUrl?: string; source: DolaProxyEgress["mode"] }> {
    if (!hasReferences) return { mode: "direct", source: "direct" };
    const { ensureMagicProxyProvider } = await import("@/lib/server/magic-proxy-service");
    const resolved = await ensureMagicProxyProvider("dolaUpload");
    if (!resolved.enabled) return { mode: "direct", source: "direct" };
    if (!resolved.proxyUrl || !["magic", "generic", "chained"].includes(resolved.egress?.mode || "")) {
        throw new DolaProviderError("Dola 参考图上传代理未就绪，请检查独立上传出口", 503, "proxy_unavailable");
    }
    return { mode: "managed", proxyUrl: resolved.proxyUrl, source: resolved.egress!.mode };
}

export function dolaRequestHasReferences(payload: Record<string, unknown>) {
    return Boolean((Array.isArray(payload.references) && payload.references.length)
        || (Array.isArray(payload.images) && payload.images.length)
        || (typeof payload.image === "string" && payload.image.trim())
        || (typeof payload.first_frame === "string" && payload.first_frame.trim())
        || (typeof payload.last_frame === "string" && payload.last_frame.trim()));
}

/** A Google authorization selection changes only this browser, never the saved Dola binding. */
export async function resolveDolaLoginProxySelection(selection: DolaLoginProxySelection = { mode: "default" }): Promise<{ proxyUrl?: string; egress: DolaProxyEgress }> {
    if (selection.mode === "default") return resolveDolaProxyEgress();
    if (selection.mode === "direct") return { egress: { mode: "direct" } };
    if (selection.mode === "generic") {
        if (!selection.target?.startsWith("node:") || !selection.target.slice(5)) throw new DolaProviderError("请选择通用代理节点", 400);
        const { resolveGenericProxyNodeUrl } = await import("@/lib/server/chatgpt-api-service");
        const proxyUrl = await resolveGenericProxyNodeUrl(selection.target.slice(5));
        if (!proxyUrl) throw new DolaProviderError("所选通用代理节点不可用", 409);
        return { proxyUrl, egress: { mode: "generic", target: selection.target } };
    }
    const binding = await getDolaProxyBinding();
    if (!binding.enabled || binding.mode !== selection.mode || !binding.target || binding.target !== selection.target) {
        throw new DolaProviderError("所选代理节点与 Dola 当前绑定不一致，请先在代理管理保存该出口", 409);
    }
    const proxy = await resolveDolaProxyEgress();
    if (proxy.egress.mode !== selection.mode || !proxy.proxyUrl) throw new DolaProviderError("所选 Dola 代理出口尚未就绪", 503);
    return proxy;
}
