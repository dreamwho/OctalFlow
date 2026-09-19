import { getAuthSettings, setAuthSettings, type AuthSettings, type SystemModelChannel } from "@/lib/auth/store";
import { inlineRemoteImageResult } from "@/app/api/image-tasks/image-task-support";
import { applyChannelProtocol, channelConnectionReady, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { normalizeModelId } from "@/lib/model-capability";
import { synchronizeLogicalModelsWithChannels, normalizeDefaultModelsConfig, channelModelCapability } from "@/lib/model-routing-config";
import { parseModelCatalog } from "@/lib/server/admin-model-catalog";
import { type GeminiAiApiKey, type GeminiAiGatewaySettings, getGeminiAiGatewaySettings, listGeminiAiApiKeys } from "@/lib/server/geminiai-gateway-store";
import { GEMINIAI_CHANNEL_ID, GEMINIAI_CHANNEL_NAME, GEMINIAI_PROTOCOL, GeminiAiProviderError, geminiAiHealth, geminiAiProviderConfigured, geminiAiSidecarRequest } from "@/lib/server/geminiai-provider";
import { writePersistentMediaDataUrl } from "@/lib/server/reference-asset-store";
import type { ResolvedLogicalModel } from "@/lib/server/logical-model-router";

export type GeminiAiTestCapability = "text" | "image" | "search";
export type GeminiAiCatalogCapability = "text" | "image" | "search" | "video";
export type GeminiAiCatalogModel = {
    id: string;
    name: string;
    capabilities: GeminiAiCatalogCapability[];
    enabled: boolean;
    channelId?: string;
    source?: "geminiai" | "gemini";
};
export type GeminiAiAccount = {
    id: string;
    name: string;
    email?: string;
    status?: string;
    usage?: Record<string, string | number | boolean>;
    createdAt?: string;
    lastUsedAt?: string;
};
export type GeminiAiRotation = { enabled: boolean; mode?: "round_robin" | "lru" | "least_rl"; cooldownSeconds?: number; accounts?: Record<string, unknown> };

const GEMINIAI_UNSUPPORTED_MODEL_NAME = /(?:^|[-_.\s/])(video|veo|audio|tts|speech|voice|music|sound|lyria|live)(?:$|[-_.\s/])/i;
const GEMINIAI_IMAGE_MODEL_NAME = /(?:^|[-_.\s/])(image|images|img|imagen)(?:$|[-_.\s/])|nano[-_.\s]?banana/i;
const ROTATION_MODES = new Set<NonNullable<GeminiAiRotation["mode"]>>(["round_robin", "lru", "least_rl"]);

export async function getGeminiAiOverview() {
    const settings = await getAuthSettings();
    const channel = geminiAiChannel(settings);
    const savedModels = configuredGeminiAiModels(channel);
    const configured = geminiAiProviderConfigured();
    const [gateway, apiKeys] = await Promise.all([getGeminiAiGatewaySettings(), listGeminiAiApiKeys()]);
    if (!configured) {
        return overviewData({
            configured: false,
            healthy: false,
            accounts: [],
            accountsAvailable: false,
            activeAccountId: "",
            rotation: { enabled: false },
            models: savedModels,
            channel,
            settings,
            gateway,
            apiKeys,
        });
    }

    const [healthy, accountsResult, activeResult, rotationResult, catalogResult] = await Promise.all([
        geminiAiHealth(),
        settled(listGeminiAiAccounts(), [] as GeminiAiAccount[]),
        quiet(getGeminiAiActiveAccountId(), ""),
        quiet(getGeminiAiRotation(), { enabled: false } as GeminiAiRotation),
        quiet(listGeminiAiCatalog(), [] as GeminiAiCatalogModel[]),
    ]);
    return overviewData({
        configured: true,
        healthy,
        accounts: accountsResult.value,
        accountsAvailable: accountsResult.available,
        activeAccountId: activeResult,
        rotation: rotationResult,
        models: mergeCatalogModels(catalogResult, savedModels),
        channel,
        settings,
        gateway,
        apiKeys,
    });
}

export async function listGeminiAiAccounts() {
    const payload = await sidecarJson("/accounts");
    return accountItems(payload)
        .map(normalizeAccount)
        .filter((account): account is GeminiAiAccount => Boolean(account));
}

export async function getGeminiAiActiveAccountId() {
    const payload = await sidecarJson("/accounts/active");
    const record = responseRecord(payload);
    return stringValue(record?.id ?? record?.accountId ?? record?.account_id, 200);
}

export async function startGeminiAiLogin(input: { name?: unknown; headless?: unknown; uiLocale?: unknown }) {
    const payload = await sidecarJson("/accounts/login/start", {
        method: "POST",
        body: JSON.stringify({
            ...(stringValue(input.name, 120) ? { name: stringValue(input.name, 120) } : {}),
            ...(typeof input.headless === "boolean" ? { headless: input.headless } : {}),
            ...(stringValue(input.uiLocale, 32) ? { ui_locale: stringValue(input.uiLocale, 32) } : {}),
        }),
    });
    const record = responseRecord(payload);
    const sessionId = stringValue(record?.sessionId ?? record?.session_id ?? record?.id, 200);
    if (!sessionId) throw new GeminiAiProviderError("GeminiAI 未返回授权会话", 502);
    return { sessionId, status: stringValue(record?.status, 60) || "pending" };
}

export async function getGeminiAiLoginStatus(sessionId: string) {
    const normalized = identifier(sessionId, "授权会话");
    const payload = await sidecarJson(`/accounts/login/status/${encodeURIComponent(normalized)}`);
    const record = responseRecord(payload);
    const error = safeSidecarMessage(record?.error);
    return {
        sessionId: stringValue(record?.sessionId ?? record?.session_id ?? record?.id, 200) || normalized,
        status: stringValue(record?.status, 60) || "pending",
        ...(stringValue(record?.accountId ?? record?.account_id, 200) ? { accountId: stringValue(record?.accountId ?? record?.account_id, 200) } : {}),
        ...(stringValue(record?.email, 320) ? { email: stringValue(record?.email, 320) } : {}),
        ...(error ? { error } : {}),
    };
}

export async function importGeminiAiCookies(input: { cookies?: unknown; name?: unknown; email?: unknown; accountId?: unknown }) {
    const cookies = stringValue(input.cookies, 2_000_000);
    if (!cookies) throw new GeminiAiProviderError("请粘贴有效的 Cookie", 400);
    const payload = await sidecarJson("/accounts/import-cookies", {
        method: "POST",
        body: JSON.stringify({
            cookies,
            ...(stringValue(input.name, 120) ? { name: stringValue(input.name, 120) } : {}),
            ...(stringValue(input.email, 320) ? { email: stringValue(input.email, 320) } : {}),
            ...(stringValue(input.accountId, 200) ? { account_id: stringValue(input.accountId, 200) } : {}),
        }),
    });
    const account = normalizeAccount(responseRecord(payload));
    if (!account) throw new GeminiAiProviderError("GeminiAI 未返回已导入账号", 502);
    return account;
}

export async function activateGeminiAiAccount(accountId: string) {
    const id = identifier(accountId, "账号");
    const payload = await sidecarJson(`/accounts/${encodeURIComponent(id)}/activate`, { method: "POST" });
    return normalizeAccount(responseRecord(payload)) || { id, name: id };
}

export async function renameGeminiAiAccount(accountId: string, name: unknown) {
    const id = identifier(accountId, "账号");
    const normalizedName = stringValue(name, 120);
    if (!normalizedName) throw new GeminiAiProviderError("请输入账号名称", 400);
    const payload = await sidecarJson(`/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: normalizedName }) });
    return normalizeAccount(responseRecord(payload)) || { id, name: normalizedName };
}

export async function deleteGeminiAiAccount(accountId: string) {
    const id = identifier(accountId, "账号");
    await sidecarJson(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { id };
}

export async function getGeminiAiRotation(): Promise<GeminiAiRotation> {
    return normalizeRotation(await sidecarJson("/rotation"));
}

export async function setGeminiAiRotation(input: { mode?: unknown; cooldownSeconds?: unknown }) {
    const mode = stringValue(input.mode, 40) as GeminiAiRotation["mode"];
    if (!mode || !ROTATION_MODES.has(mode)) throw new GeminiAiProviderError("轮换模式无效", 400);
    const cooldownSeconds = optionalPositiveNumber(input.cooldownSeconds);
    return normalizeRotation(
        await sidecarJson("/rotation/mode", {
            method: "POST",
            body: JSON.stringify({ mode, ...(cooldownSeconds !== undefined ? { cooldown_seconds: cooldownSeconds } : {}) }),
        }),
    );
}

export async function listGeminiAiCatalog(): Promise<GeminiAiCatalogModel[]> {
    const payload = await sidecarJson("/v1/models");
    return parseModelCatalog(payload, "provider", GEMINIAI_PROTOCOL)
        .filter((entry) => !GEMINIAI_UNSUPPORTED_MODEL_NAME.test(entry.id))
        .flatMap((entry) => {
            const image = entry.capability === "image" || GEMINIAI_IMAGE_MODEL_NAME.test(entry.id);
            const capability = image ? "image" : entry.capability === "text" ? "text" : "";
            return capability ? [{ id: entry.id, name: entry.id, capabilities: capability === "text" ? (["text", "search"] as GeminiAiCatalogCapability[]) : (["image"] as GeminiAiCatalogCapability[]), enabled: false, source: "geminiai" as const }] : [];
        });
}

export async function saveGeminiAiModelSelection(input: { models?: unknown }) {
    const requested = uniqueStrings(input.models, 200, 200);
    const catalog = await listGeminiAiCatalog();
    const available = new Map(catalog.map((model) => [normalizeModelId(model.id), model]));
    const selected = requested.map((model) => available.get(normalizeModelId(model))).filter((model): model is GeminiAiCatalogModel => Boolean(model));
    if (selected.length !== requested.length) throw new GeminiAiProviderError("所选模型不在 GeminiAI 已同步目录中", 422);

    const settings = await getAuthSettings();
    const existing = geminiAiChannel(settings);
    const base = applyChannelProtocol(
        {
            ...(existing || defaultGeminiAiChannel()),
            id: existing?.id || GEMINIAI_CHANNEL_ID,
            name: GEMINIAI_CHANNEL_NAME,
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            models: selected.map((model) => model.id),
            enabled: true,
        },
        GEMINIAI_PROTOCOL,
    );
    const modelConfigs = Object.fromEntries(
        selected.flatMap((model) => {
            const capability = model.capabilities.includes("image") ? ("image" as const) : ("text" as const);
            const config = protocolModelConfig(GEMINIAI_PROTOCOL, capability, model.id);
            return config ? [[normalizeModelId(model.id), config] as const] : [];
        }),
    );
    const channel: SystemModelChannel = {
        ...base,
        apiKey: "",
        hasApiKey: false,
        advancedConfig: {
            ...base.advancedConfig!,
            modelCapabilities: Object.fromEntries(selected.map((model) => [normalizeModelId(model.id), model.capabilities.includes("image") ? "image" : "text"] as const)),
            modelConfigs,
        },
    };
    const channels = existing ? settings.systemChannels.map((item) => (item.id === existing.id ? channel : item)) : [...settings.systemChannels, channel];
    const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, channels);
    const defaultModels = normalizeDefaultModelsConfig(settings.defaultModels, logicalModels, channels);
    await setAuthSettings({ systemChannels: channels, logicalModels, defaultModels });
    return { channel: publicChannel(channel), models: selected.map((model) => ({ ...model, enabled: true })) };
}

export async function runGeminiAiTextTest(input: { model?: unknown; prompt?: unknown }) {
    const model = await assertCatalogModel(input.model, "text");
    const prompt = promptText(input.prompt);
    const payload = await sidecarJson("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: prompt }] }),
    });
    const text = openAiText(payload);
    if (!text) throw new GeminiAiProviderError("GeminiAI 未返回文本结果", 502);
    return { model: model.id, text };
}

export async function runGeminiAiSearchTest(input: { model?: unknown; prompt?: unknown }) {
    const model = await assertCatalogModel(input.model, "text");
    const prompt = promptText(input.prompt);
    const payload = await sidecarJson(`/v1beta/models/${encodeURIComponent(model.id)}:generateContent`, {
        method: "POST",
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ googleSearchRetrieval: {} }] }),
    });
    const text = nativeGeminiText(payload);
    if (!text) throw new GeminiAiProviderError("GeminiAI 搜索未返回文本结果", 502);
    return { model: model.id, text, citations: nativeGeminiCitations(payload) };
}

export async function runGeminiAiImageTest(input: { userId: string; model?: unknown; prompt?: unknown; aspectRatio?: unknown; imageSize?: unknown }) {
    const model = await assertCatalogModel(input.model, "image");
    const prompt = promptText(input.prompt);
    const requestedAspectRatio = stringValue(input.aspectRatio, 16);
    const aspectRatio = requestedAspectRatio && requestedAspectRatio.toLowerCase() !== "auto" ? requestedAspectRatio : undefined;
    const imageSize = stringValue(input.imageSize, 8).toUpperCase() || "1K";
    const payload = await sidecarJson("/v1/images/generations", {
        method: "POST",
        body: JSON.stringify({ model: model.id, prompt, n: 1, aspect_ratio: aspectRatio, image_size: imageSize, google_search: false, image_search: false }),
    });
    const images = await persistGeminiAiImages(imageValues(payload), input.userId);
    if (!images.length) throw new GeminiAiProviderError("GeminiAI 未返回图片结果", 502);
    return { model: model.id, images };
}

export function resolveSavedGeminiVideoCandidates(settings: AuthSettings) {
    const candidates = new Map<string, GeminiAiCatalogModel>();
    for (const logical of settings.logicalModels) {
        if (!logical.enabled || logical.capability !== "video") continue;
        for (const binding of logical.bindings.filter((item) => item.enabled)) {
            const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled && item.advancedConfig?.protocol === "gemini" && channelConnectionReady(item));
            if (!channel || !channel.models.some((model) => sameModel(model, binding.upstreamModel)) || channelModelCapability(channel, binding.upstreamModel) !== "video") continue;
            const key = `${channel.id}:${normalizeModelId(binding.upstreamModel)}`;
            candidates.set(key, { id: binding.upstreamModel, name: logical.name || binding.upstreamModel, capabilities: ["video"], enabled: true, channelId: channel.id, source: "gemini" });
        }
    }
    return Array.from(candidates.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveSavedGeminiVideoModel(settings: AuthSettings, model: string, channelId = "") {
    const candidates = resolveSavedGeminiVideoCandidates(settings);
    return candidates.find((candidate) => (!channelId || candidate.channelId === channelId) && sameModel(candidate.id, model)) || null;
}

export function resolveSavedGeminiVideoBinding(settings: AuthSettings, model: string, channelId: string): ResolvedLogicalModel | null {
    for (const logical of settings.logicalModels) {
        if (!logical.enabled || logical.capability !== "video") continue;
        for (const binding of logical.bindings.filter((item) => item.enabled && item.channelId === channelId && sameModel(item.upstreamModel, model))) {
            const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled && item.advancedConfig?.protocol === "gemini" && channelConnectionReady(item));
            if (!channel || !channel.models.some((item) => sameModel(item, binding.upstreamModel)) || channelModelCapability(channel, binding.upstreamModel) !== "video") continue;
            return { logicalModelId: logical.id, upstreamModel: binding.upstreamModel, channelId: channel.id, channel };
        }
    }
    return null;
}

async function assertCatalogModel(value: unknown, capability: Exclude<GeminiAiTestCapability, "search">) {
    const id = identifier(stringValue(value, 200), "模型");
    const model = (await listGeminiAiCatalog()).find((item) => sameModel(item.id, id));
    if (!model || !model.capabilities.includes(capability)) throw new GeminiAiProviderError("该模型不支持所选测试能力", 422);
    return model;
}

async function sidecarJson(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    const response = await geminiAiSidecarRequest(path, { ...init, headers });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const root = objectValue(payload);
        const detail = safeRecord(root?.detail);
        const providerMessage = stringValue(detail?.message ?? root?.detail, 500);
        const providerType = stringValue(detail?.type, 80);
        const message =
            providerType === "account_access_denied"
                ? safeSidecarMessage(providerMessage)
                : /caller does not have permission|permission denied|禁止访问|paid api key/i.test(providerMessage)
                  ? "Google AI Studio 页面原生通道未能使用当前账号调用该模型；请在对应授权 Profile 中确认模型仍可运行后重试。"
                  : response.status === 401 || response.status === 403
                    ? "GeminiAI 服务鉴权失败"
                    : "GeminiAI 服务请求失败";
        throw new GeminiAiProviderError(message, response.status >= 400 && response.status < 600 ? response.status : 502);
    }
    if (payload === null) throw new GeminiAiProviderError("GeminiAI 服务返回了无效数据", 502);
    return payload;
}

function overviewData(input: {
    configured: boolean;
    healthy: boolean;
    accounts: GeminiAiAccount[];
    accountsAvailable: boolean;
    activeAccountId: string;
    rotation: GeminiAiRotation;
    models: GeminiAiCatalogModel[];
    channel: SystemModelChannel | undefined;
    settings: AuthSettings;
    gateway: GeminiAiGatewaySettings;
    apiKeys: GeminiAiApiKey[];
}) {
    return {
        configured: input.configured,
        healthy: input.healthy,
        accounts: input.accounts,
        accountsAvailable: input.accountsAvailable,
        activeAccountId: input.activeAccountId || undefined,
        rotation: input.rotation,
        models: [...input.models, ...resolveSavedGeminiVideoCandidates(input.settings)],
        channels: input.channel ? [publicChannel(input.channel)] : [],
        ...(input.channel ? { channel: publicChannel(input.channel) } : {}),
        gateway: input.gateway,
        apiKeys: input.apiKeys,
    };
}

function configuredGeminiAiModels(channel: SystemModelChannel | undefined) {
    if (!channel) return [] as GeminiAiCatalogModel[];
    return channel.models.flatMap((id) => {
        const capability = channelModelCapability(channel, id);
        return capability === "text"
            ? [{ id, name: id, capabilities: ["text", "search"] as GeminiAiCatalogCapability[], enabled: true, source: "geminiai" as const }]
            : capability === "image"
              ? [{ id, name: id, capabilities: ["image"] as GeminiAiCatalogCapability[], enabled: true, source: "geminiai" as const }]
              : [];
    });
}

function mergeCatalogModels(catalog: GeminiAiCatalogModel[], configured: GeminiAiCatalogModel[]) {
    const enabled = new Set(configured.map((model) => normalizeModelId(model.id)));
    const models = new Map<string, GeminiAiCatalogModel>();
    for (const model of [...catalog, ...configured]) {
        const key = normalizeModelId(model.id);
        const current = models.get(key);
        models.set(key, { ...(current || model), ...model, enabled: enabled.has(key) || model.enabled });
    }
    return Array.from(models.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function geminiAiChannel(settings: Pick<AuthSettings, "systemChannels">) {
    return settings.systemChannels.find((channel) => channel.advancedConfig?.protocol === GEMINIAI_PROTOCOL);
}

function defaultGeminiAiChannel(): SystemModelChannel {
    return { id: GEMINIAI_CHANNEL_ID, name: GEMINIAI_CHANNEL_NAME, baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: true };
}

function publicChannel(channel: SystemModelChannel) {
    return { id: channel.id, name: GEMINIAI_CHANNEL_NAME, enabled: channel.enabled, models: [...channel.models] };
}

function normalizeAccount(value: Record<string, unknown> | undefined): GeminiAiAccount | null {
    const id = stringValue(value?.id ?? value?.accountId ?? value?.account_id, 200);
    if (!id) return null;
    const usage = safeRecord(value?.usage);
    return {
        id,
        name: stringValue(value?.name ?? value?.label, 120) || id,
        ...(stringValue(value?.email, 320) ? { email: stringValue(value?.email, 320) } : {}),
        status: stringValue(value?.status, 80) || (stringValue(value?.email, 320) ? "ready" : "unknown"),
        ...(usage ? { usage } : {}),
        ...(dateValue(value?.createdAt ?? value?.created_at) ? { createdAt: dateValue(value?.createdAt ?? value?.created_at)! } : {}),
        ...(dateValue(value?.lastUsedAt ?? value?.last_used_at ?? value?.last_used) ? { lastUsedAt: dateValue(value?.lastUsedAt ?? value?.last_used_at ?? value?.last_used)! } : {}),
    };
}

function normalizeRotation(value: unknown): GeminiAiRotation {
    const record = objectValue(value) || {};
    const rawMode = stringValue(record.mode ?? record.strategy, 40).replace(/-/g, "_") as GeminiAiRotation["mode"];
    const cooldownSeconds = optionalPositiveNumber(record.cooldownSeconds ?? record.cooldown_seconds);
    const accounts = objectValue(record.accounts);
    return { enabled: Boolean(record.enabled), ...(rawMode && ROTATION_MODES.has(rawMode) ? { mode: rawMode } : {}), ...(cooldownSeconds !== undefined ? { cooldownSeconds } : {}), ...(accounts ? { accounts } : {}) };
}

function accountItems(value: unknown) {
    if (Array.isArray(value)) return value.map(objectValue).filter((item): item is Record<string, unknown> => Boolean(item));
    const record = responseRecord(value);
    const values = record?.accounts ?? record?.items;
    return Array.isArray(values) ? values.map(objectValue).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function openAiText(value: unknown) {
    const record = objectValue(value);
    const choice = Array.isArray(record?.choices) ? objectValue(record.choices[0]) : undefined;
    const message = objectValue(choice?.message);
    return contentText(message?.content ?? choice?.text);
}

function nativeGeminiText(value: unknown) {
    const record = objectValue(value);
    const candidate = Array.isArray(record?.candidates) ? objectValue(record.candidates[0]) : undefined;
    const content = objectValue(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return parts
        .map((part) => stringValue(objectValue(part)?.text, 100_000))
        .filter(Boolean)
        .join("\n")
        .trim();
}

function nativeGeminiCitations(value: unknown) {
    const record = objectValue(value);
    const candidate = Array.isArray(record?.candidates) ? objectValue(record.candidates[0]) : undefined;
    const grounding = objectValue(candidate?.groundingMetadata ?? candidate?.grounding_metadata);
    const rawChunks = grounding?.groundingChunks ?? grounding?.grounding_chunks;
    const chunks: unknown[] = Array.isArray(rawChunks) ? rawChunks : [];
    return chunks.flatMap((chunk) => {
        const web = objectValue(objectValue(chunk)?.web);
        const url = stringValue(web?.uri ?? web?.url, 2_000);
        return /^https?:\/\//i.test(url) ? [{ ...(stringValue(web?.title, 500) ? { title: stringValue(web?.title, 500) } : {}), url }] : [];
    });
}

function imageValues(value: unknown) {
    const record = objectValue(value);
    const items = Array.isArray(record?.data) ? record.data : [];
    return items.flatMap((item) => {
        const image = objectValue(item) || {};
        const url = stringValue(image.url, 4_000_000);
        if (/^(?:https?:|data:image\/)/i.test(url)) return [url];
        const b64 = stringValue(image.b64_json, 20_000_000);
        const mimeType = stringValue(image.mime_type ?? image.mimeType, 100);
        return b64 && /^[A-Za-z0-9+/=\s]+$/.test(b64) ? [`data:${/^image\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : "image/png"};base64,${b64.replace(/\s+/g, "")}`] : [];
    });
}

async function persistGeminiAiImages(images: string[], userId: string) {
    if (!userId.trim()) throw new GeminiAiProviderError("图片测试缺少当前用户", 500);
    return Promise.all(
        images.map(async (image, index) => {
            const inline = image.startsWith("data:image/") ? image : (await inlineRemoteImageResult(image, "", "")).dataUrl;
            if (!inline.startsWith("data:image/")) throw new GeminiAiProviderError("GeminiAI 图片无法安全保存到本站", 502);
            const asset = await writePersistentMediaDataUrl(inline, "image", {
                ownerUserId: userId,
                source: "geminiai-admin-test",
                originalName: `geminiai-test-${index + 1}.png`,
            });
            return asset.url || `/api/reference-assets/${asset.token}`;
        }),
    );
}

function contentText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (!Array.isArray(value)) return "";
    return value
        .map((item) => stringValue(objectValue(item)?.text, 100_000))
        .filter(Boolean)
        .join("\n")
        .trim();
}

function promptText(value: unknown) {
    const prompt = stringValue(value, 20_000);
    if (!prompt) throw new GeminiAiProviderError("请输入测试提示词", 400);
    return prompt;
}

function identifier(value: string, label: string) {
    const normalized = value.trim();
    if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new GeminiAiProviderError(`${label}无效`, 400);
    return normalized;
}

function uniqueStrings(value: unknown, limit: number, length: number) {
    if (!Array.isArray(value)) throw new GeminiAiProviderError("模型列表格式无效", 400);
    return Array.from(new Set(value.map((item) => stringValue(item, length)).filter(Boolean))).slice(0, limit);
}

function objectValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function responseRecord(value: unknown) {
    const record = objectValue(value);
    return objectValue(record?.data) || record;
}

function stringValue(value: unknown, length: number) {
    return typeof value === "string" ? value.trim().slice(0, length) : "";
}

function safeSidecarMessage(value: unknown) {
    const message = stringValue(value, 500);
    if (!message) return "";
    return message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]").replace(/\b(cookie|authorization|x-api-key|api[_-]?key|token)\s*([=:])\s*[^\s,;]+/gi, "$1$2[REDACTED]");
}

function optionalPositiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function dateValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "";
}

function safeRecord(value: unknown): Record<string, string | number | boolean> | undefined {
    const record = objectValue(value);
    if (!record) return undefined;
    const entries = Object.entries(record)
        .filter(([, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .slice(0, 20)
        .map(([key, item]) => [key.slice(0, 80), typeof item === "string" ? item.slice(0, 500) : item] as const);
    return entries.length ? (Object.fromEntries(entries) as Record<string, string | number | boolean>) : undefined;
}

function sameModel(left: string, right: string) {
    return normalizeModelId(left) === normalizeModelId(right);
}

async function quiet<T>(promise: Promise<T>, fallback: T) {
    try {
        return await promise;
    } catch {
        return fallback;
    }
}

async function settled<T>(promise: Promise<T>, fallback: T) {
    try {
        return { available: true, value: await promise };
    } catch {
        return { available: false, value: fallback };
    }
}
