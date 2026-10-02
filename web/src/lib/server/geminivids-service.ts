import { getAuthSettings, setAuthSettings, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { normalizeModelId } from "@/lib/model-capability";
import { synchronizeLogicalModelsWithChannels, normalizeDefaultModelsConfig } from "@/lib/model-routing-config";
import { getGeminiVidsGatewaySettings, listGeminiVidsApiKeys } from "@/lib/server/geminivids-gateway-store";
import { GEMINIVIDS_CHANNEL_ID, GEMINIVIDS_CHANNEL_NAME, GEMINIVIDS_PROTOCOL, GeminiVidsProviderError, geminiVidsHealth, geminiVidsProviderConfigured, geminiVidsSidecarRequest } from "@/lib/server/geminivids-provider";
import { geminiVidsRequestStats } from "@/lib/server/geminivids-request-log-store";

export type GeminiVidsAccount = {
    id: string;
    name: string;
    email?: string | null;
    status?: string;
    vids_doc_id?: string | null;
    created_at?: string;
    last_used?: string | null;
    last_error?: string | null;
};

export const GEMINIVIDS_CATALOG_MODELS = [{ id: "google-vids-omni", name: "Google Vids Omni", capability: "video" as const }];

export async function getGeminiVidsOverview() {
    const settings = await getAuthSettings();
    const channel = geminiVidsChannel(settings);
    const configured = geminiVidsProviderConfigured();
    const [gateway, apiKeys, stats] = await Promise.all([getGeminiVidsGatewaySettings(), listGeminiVidsApiKeys(), geminiVidsRequestStats()]);
    if (!configured) {
        return { configured: false, healthy: false, enabled: channel?.enabled !== false, accounts: [] as GeminiVidsAccount[], activeAccountId: "", channelExists: Boolean(channel), models: GEMINIVIDS_CATALOG_MODELS, gateway, apiKeys, stats };
    }
    const [healthy, accounts, active, proxyState] = await Promise.all([
        geminiVidsHealth(),
        listGeminiVidsAccounts().catch(() => [] as GeminiVidsAccount[]),
        sidecarJson("/accounts/active").catch(() => null),
        sidecarJson("/runtime/proxy").catch(() => null),
    ]);
    return {
        configured: true,
        healthy,
        enabled: channel?.enabled !== false,
        channelExists: Boolean(channel),
        accounts,
        activeAccountId: (active as GeminiVidsAccount | null)?.id || "",
        models: GEMINIVIDS_CATALOG_MODELS,
        gateway,
        apiKeys,
        stats,
        proxyUrl: (proxyState as { proxy_url?: string } | null)?.proxy_url || "",
    };
}

export async function listGeminiVidsAccounts(): Promise<GeminiVidsAccount[]> {
    const payload = await sidecarJson("/accounts");
    return Array.isArray(payload) ? (payload as GeminiVidsAccount[]) : [];
}

export function geminiVidsChannel(settings: { systemChannels: SystemModelChannel[] }) {
    return settings.systemChannels.find((channel) => channel.id === GEMINIVIDS_CHANNEL_ID || channel.advancedConfig?.protocol === GEMINIVIDS_PROTOCOL) || null;
}

/** 启用并落库 GeminiVids 渠道（模型目录来自协议注册表 builtInModels）。 */
export async function enableGeminiVidsChannel() {
    const settings = await getAuthSettings();
    const existing = geminiVidsChannel(settings);
    const base = applyChannelProtocol(
        {
            ...(existing || {
                id: GEMINIVIDS_CHANNEL_ID,
                name: GEMINIVIDS_CHANNEL_NAME,
                baseUrl: "",
                apiKey: "",
                apiFormat: "openai",
                models: GEMINIVIDS_CATALOG_MODELS.map((model) => model.id),
                enabled: true,
            }),
            name: GEMINIVIDS_CHANNEL_NAME,
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            models: GEMINIVIDS_CATALOG_MODELS.map((model) => model.id),
            enabled: true,
        },
        GEMINIVIDS_PROTOCOL,
    );
    const modelConfigs = Object.fromEntries(
        GEMINIVIDS_CATALOG_MODELS.flatMap((model) => {
            const config = protocolModelConfig(GEMINIVIDS_PROTOCOL, model.capability, model.id);
            return config ? [[normalizeModelId(model.id), config] as const] : [];
        }),
    );
    const channel: SystemModelChannel = {
        ...base,
        apiKey: "",
        hasApiKey: false,
        advancedConfig: {
            ...base.advancedConfig!,
            modelCapabilities: Object.fromEntries(GEMINIVIDS_CATALOG_MODELS.map((model) => [normalizeModelId(model.id), model.capability] as const)),
            modelConfigs,
        },
    };
    const channels = existing ? settings.systemChannels.map((item) => (item.id === existing.id ? channel : item)) : [...settings.systemChannels, channel];
    const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, channels);
    const defaultModels = normalizeDefaultModelsConfig(settings.defaultModels, logicalModels, channels);
    await setAuthSettings({ systemChannels: channels, logicalModels, defaultModels });
    return channel;
}

export async function setGeminiVidsChannelEnabled(enabled: boolean) {
    const settings = await getAuthSettings();
    const existing = geminiVidsChannel(settings);
    if (!existing) throw new GeminiVidsProviderError("GeminiVids 渠道尚未初始化", 404);
    const channels = settings.systemChannels.map((item) => (item.id === existing.id ? { ...item, enabled } : item));
    await setAuthSettings({ systemChannels: channels });
    return { enabled };
}

export async function importGeminiVidsCookies(input: { cookies?: string; storageState?: Record<string, unknown>; name?: string; email?: string; vidsDocId?: string }) {
    const body = input.cookies
        ? { cookies: input.cookies, ...(input.name ? { name: input.name } : {}), ...(input.email ? { email: input.email } : {}), ...(input.vidsDocId ? { vids_doc_id: input.vidsDocId } : {}) }
        : { storage_state: input.storageState, ...(input.name ? { name: input.name } : {}), ...(input.email ? { email: input.email } : {}), ...(input.vidsDocId ? { vids_doc_id: input.vidsDocId } : {}) };
    if (!input.cookies && !input.storageState) throw new GeminiVidsProviderError("请提供 Cookie 字符串或 storage_state JSON", 400);
    return sidecarJson(input.cookies ? "/accounts/import-cookies" : "/accounts/import-storage-state", { method: "POST", body: JSON.stringify(body) });
}

/** 从本机 GeminiAI 账号目录复制授权（同源 storage_state，一次点击完成导入）。 */
export async function importGeminiVidsFromGeminiAi() {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const dataRoot = process.env.DREAMYO_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
    const dir = process.env.DREAMYO_GEMINIAI_ACCOUNTS_DIR?.trim() || path.join(dataRoot, "geminiai", "accounts");
    let registry: { accounts?: Record<string, { email?: string | null; name?: string }> } = {};
    try {
        registry = JSON.parse(await readFile(path.join(dir, "registry.json"), "utf8"));
    } catch {
        throw new GeminiVidsProviderError(`未找到 GeminiAI 账号目录（${dir}）`, 404);
    }
    const results: { account_id: string; email?: string | null }[] = [];
    const errors: { email: string; error: string }[] = [];
    for (const [accountId, meta] of Object.entries(registry.accounts || {})) {
        try {
            const storageState = JSON.parse(await readFile(path.join(dir, accountId, "auth.json"), "utf8"));
            const imported = (await importGeminiVidsCookies({
                storageState,
                name: meta.name || meta.email || accountId,
                email: meta.email || undefined,
            })) as { account_id: string; email?: string | null };
            results.push({ account_id: imported.account_id, email: imported.email ?? meta.email ?? null });
        } catch (error) {
            errors.push({ email: meta.email || accountId, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { imported: results, failed: errors };
}

export async function deleteGeminiVidsAccount(accountId: string) {
    return sidecarJson(`/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
}

export async function activateGeminiVidsAccount(accountId: string) {
    return sidecarJson(`/accounts/${encodeURIComponent(accountId)}/activate`, { method: "POST" });
}

export async function updateGeminiVidsAccount(accountId: string, patch: { name?: string; vidsDocId?: string; status?: "active" | "invalid" }) {
    return sidecarJson(`/accounts/${encodeURIComponent(accountId)}`, {
        method: "PUT",
        body: JSON.stringify({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.vidsDocId !== undefined ? { vids_doc_id: patch.vidsDocId } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
        }),
    });
}

export async function geminiVidsVideoTest(input: { prompt?: string; aspectRatio?: string; resolution?: string; durationSeconds?: number; imageDataUrl?: string }) {
    const prompt = (input.prompt || "").trim();
    if (!prompt) throw new GeminiVidsProviderError("请输入测试提示词", 400);
    const aspect = input.aspectRatio === "9:16" ? "9:16" : "16:9";
    const resolution = input.resolution === "1080p" ? "1080p" : "720p";
    const duration = Math.max(4, Math.min(10, Math.floor(Number(input.durationSeconds) || 5)));
    const image = (input.imageDataUrl || "").trim();
    if (image && !/^data:image\/(png|jpeg);base64,/i.test(image)) throw new GeminiVidsProviderError("参考图仅支持 data:image/png 或 data:image/jpeg 的 Base64", 400);
    return sidecarJson("/v1/videos", {
        method: "POST",
        body: JSON.stringify({ prompt, aspect_ratio: aspect, resolution, duration_seconds: duration, ...(image ? { images: [image] } : {}) }),
    });
}

export async function geminiVidsVideoStatus(taskId: string) {
    return sidecarJson(`/v1/videos/${encodeURIComponent(taskId)}`);
}

export async function syncGeminiVidsProxy(proxyUrl: string) {
    const { syncGeminiVidsRuntimeProxy } = await import("@/lib/server/geminivids-provider");
    return syncGeminiVidsRuntimeProxy(proxyUrl);
}

async function sidecarJson(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await geminiVidsSidecarRequest(path, { ...init, headers }, { logSource: "admin-test" });
    const text = await response.text();
    if (!response.ok) {
        let message = `GeminiVids 服务返回 HTTP ${response.status}`;
        try {
            const payload = JSON.parse(text) as { detail?: { message?: string } | string };
            message = typeof payload.detail === "string" ? payload.detail : payload.detail?.message || message;
        } catch {
            /* keep default */
        }
        throw new GeminiVidsProviderError(message, response.status);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new GeminiVidsProviderError("GeminiVids 服务返回了无效 JSON", 502);
    }
}
