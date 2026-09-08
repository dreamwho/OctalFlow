import { getFreshAuthSettings, setAuthSettings, type AuthSettings, type LogicalModelCapability, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { normalizeModelId } from "@/lib/model-capability";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { ChatGptApiError, chatGptRuntimeJson, getChatGptRuntimeConfig } from "@/lib/server/chatgpt-api-service";

export const CHATGPT_API_PROTOCOL = "chatgpt-api" as const;
export const CHATGPT_API_CHANNEL_ID = "chatgpt-api";
export const CHATGPT_API_CHANNEL_NAME = "GPTAPI";
const CHATGPT_API_RUNTIME_PATHS = new Set(["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/images/generations", "/v1/images/edits"]);

type ChatGptApiCatalog = {
    chat_models?: unknown;
    image_models?: unknown;
};

type CatalogModel = {
    id: string;
    capability: LogicalModelCapability;
};

export async function getChatGptModelCatalog() {
    const raw = await chatGptRuntimeJson<ChatGptApiCatalog>("/api/model-catalog", { method: "GET" });
    const catalog = selectedCatalogModels([...stringList(raw.chat_models), ...stringList(raw.image_models)], raw);
    const unique = [...new Map(catalog.map((model) => [normalizeModelId(model.id), model])).values()];
    return {
        models: unique.map((model) => model.id),
        modelCapabilities: Object.fromEntries(unique.map((model) => [normalizeModelId(model.id), model.capability])),
        modelConfigs: Object.fromEntries(unique.map((model) => [normalizeModelId(model.id), protocolModelConfig(CHATGPT_API_PROTOCOL, model.capability, model.id)!])),
        discoveredCount: unique.length,
        totalCount: unique.length,
        catalogSupported: true,
        provider: CHATGPT_API_PROTOCOL,
    };
}

let chatGptModelChangeQueue: Promise<void> = Promise.resolve();

export async function getChatGptSavedModels(): Promise<{ models: string[] }> {
    const channel = chatGptApiChannel(await getFreshAuthSettings());
    return { models: [...(channel?.models || [])] };
}

export function saveChatGptModels(input: { models?: unknown }) {
    return serializeChatGptModelChange(() => saveChatGptModelsInternal(input));
}

async function saveChatGptModelsInternal(input: { models?: unknown }) {
    const requested = requestedModels(input.models);
    const settings = await getFreshAuthSettings();
    const existing = chatGptApiChannel(settings);

    // This validates the server-owned runtime configuration. Its key is never persisted in a channel.
    await getChatGptRuntimeConfig();

    const selected = requested.length ? selectedCatalogModels(requested, await chatGptRuntimeJson<ChatGptApiCatalog>("/api/model-catalog", { method: "GET" })) : [];

    const base = applyChannelProtocol(
        {
            ...(existing || defaultChannel()),
            id: CHATGPT_API_CHANNEL_ID,
            name: CHATGPT_API_CHANNEL_NAME,
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            models: selected.map((model) => model.id),
            enabled: selected.length > 0,
            hasApiKey: false,
            clearApiKey: false,
        },
        CHATGPT_API_PROTOCOL,
    );
    const modelCapabilities = Object.fromEntries(selected.map((model) => [normalizeModelId(model.id), model.capability]));
    const modelConfigs = Object.fromEntries(
        selected.map((model) => {
            const config = protocolModelConfig(CHATGPT_API_PROTOCOL, model.capability, model.id);
            if (!config) throw new ChatGptApiError("GPTAPI 渠道缺少模型路由配置", 500);
            return [normalizeModelId(model.id), config];
        }),
    );
    const channel: SystemModelChannel = {
        ...base,
        apiKey: "",
        hasApiKey: false,
        clearApiKey: false,
        advancedConfig: {
            ...base.advancedConfig!,
            protocol: CHATGPT_API_PROTOCOL,
            modelCapabilities,
            modelConfigs,
        },
    };
    const channels = existing ? settings.systemChannels.map((item) => (item.id === CHATGPT_API_CHANNEL_ID ? channel : item)) : [...settings.systemChannels, channel];
    const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, channels);
    const defaultModels = normalizeDefaultModelsConfig(settings.defaultModels, logicalModels, channels);
    await setAuthSettings({ systemChannels: channels, logicalModels, defaultModels });
    return { models: channel.models, channel: publicChannel(channel) };
}

export function normalizeChatGptApiRuntimePath(value: string) {
    const input = value.trim();
    if (!input || !input.startsWith("/") || input.startsWith("//") || /(?:^|\/)\.\.?(?:\/|$)/.test(input)) return "";
    try {
        const url = new URL(input, "http://chatgpt-api.internal");
        if (url.origin !== "http://chatgpt-api.internal") return "";
        const pathname = url.pathname.startsWith("/v1/") ? url.pathname : `/v1${url.pathname}`;
        return CHATGPT_API_RUNTIME_PATHS.has(pathname) ? `${pathname}${url.search}` : "";
    } catch {
        return "";
    }
}

export function isChatGptApiRuntimePath(value: string) {
    return Boolean(normalizeChatGptApiRuntimePath(value));
}

function chatGptApiChannel(settings: AuthSettings) {
    return settings.systemChannels.find((channel) => channel.id === CHATGPT_API_CHANNEL_ID);
}

function defaultChannel(): SystemModelChannel {
    return { id: CHATGPT_API_CHANNEL_ID, name: CHATGPT_API_CHANNEL_NAME, baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: false };
}

function publicChannel(channel: SystemModelChannel) {
    return { id: channel.id, name: channel.name, enabled: channel.enabled, models: [...channel.models] };
}

function requestedModels(value: unknown) {
    if (!Array.isArray(value)) throw new ChatGptApiError("models 必须为数组", 400);
    const seen = new Set<string>();
    const models: string[] = [];
    for (const item of value) {
        const model = text(item);
        if (!model || model.length > 200) throw new ChatGptApiError("models 只能包含有效的模型 ID", 400);
        const key = normalizeModelId(model);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        models.push(model);
    }
    return models;
}

function selectedCatalogModels(requested: string[], catalog: ChatGptApiCatalog) {
    const available = new Map<string, CatalogModel>();
    for (const id of stringList(catalog.chat_models)) available.set(normalizeModelId(id), { id, capability: "text" });
    for (const id of stringList(catalog.image_models)) available.set(normalizeModelId(id), { id, capability: "image" });
    if (!available.size) throw new ChatGptApiError("GPTAPI 返回的模型目录无效", 502);
    const selected = requested.map((model) => available.get(normalizeModelId(model)));
    if (selected.some((model) => !model)) throw new ChatGptApiError("所选模型不在 GPTAPI 当前目录中", 422);
    return selected as CatalogModel[];
}

function serializeChatGptModelChange<T>(operation: () => Promise<T>) {
    const result = chatGptModelChangeQueue.then(operation, operation);
    chatGptModelChangeQueue = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function stringList(value: unknown) {
    return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
