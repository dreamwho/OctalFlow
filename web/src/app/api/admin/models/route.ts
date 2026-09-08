import { hasAdminPermission } from "@/lib/admin-permissions";
import { NextResponse } from "next/server";

import { AGNES_RECOMMENDED_CONFIG, isAgnesApiBaseUrl } from "@/lib/agnes-model-catalog";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { buildGlobalAiOpcSelection, getGlobalAiOpcPresetForModel, isGlobalAiOpcBaseUrl, resolveGlobalAiOpcCatalogPresets } from "@/lib/globalaiopc-catalog";
import { inferModelCapability, normalizeModelId } from "@/lib/model-capability";
import { isProviderTimeoutError, resolveAdminChannelCredentials, sanitizeProviderMessage } from "@/lib/server/admin-channel-config";
import {
    buildModelCatalogUrls,
    configuredModelCatalog,
    isModelCatalogUnsupported,
    mergeModelCatalogEntries,
    mergeModelConfigs,
    modelConfigsFromOperations,
    modelCapabilitiesRecord,
    nextModelsPageUrl,
    normalizeModelConfigs,
    officialModelCatalog,
    officialModelConfigs,
    parseModelCatalog,
    parseModelConfigs,
} from "@/lib/server/admin-model-catalog";
import { isProviderBusinessError, readProviderError } from "@/lib/server/provider-task-config";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { isSafeOutboundUrl } from "@/lib/server/security";
import { channelProtocolDefinition, protocolAuthHeaders, protocolModelConfig, resolveChannelAuthMode } from "@/lib/channel-protocol-registry";
import type { SystemChannelAdvancedConfig, SystemChannelProtocol } from "@/lib/auth/store";
import { GEMINIAI_PROTOCOL } from "@/lib/server/geminiai-provider";
import { listGeminiAiCatalog } from "@/lib/server/geminiai-service";
import { getChatGptModelCatalog } from "@/lib/server/chatgpt-api-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

configureServerProxyDispatcher();

type ModelsPayload = {
    channelId?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    apiFormat?: unknown;
    protocol?: unknown;
    authMode?: unknown;
    authHeader?: unknown;
    authPrefix?: unknown;
    globalAiOpcPreset?: unknown;
    globalAiOpcPresets?: unknown;
    createPath?: unknown;
    modelCatalogPaths?: unknown;
    configuredModels?: unknown;
    modelCapabilities?: unknown;
    modelConfigs?: unknown;
    operationConfigs?: unknown;
};

type ModelsResponse = Record<string, unknown> & {
    error?: { message?: string };
    msg?: string;
};

const MODEL_FETCH_COOLDOWN_MS = 30_000;
const MODEL_FETCH_TIMEOUT_MS = 60_000;
const MODEL_FETCH_MAX_PAGES = 20;
const globalCooldownStore = globalThis as typeof globalThis & { __octalaicanvasProModelFetchCooldowns?: Map<string, number> };
const modelFetchCooldowns = (globalCooldownStore.__octalaicanvasProModelFetchCooldowns ??= new Map<string, number>());

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "upstream.manage")) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    const [body, settings] = await Promise.all([readJsonBody<ModelsPayload>(request), getAuthSettings()]);
    const selectedChannelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    const selectedChannel = selectedChannelId ? settings.systemChannels.find((channel) => channel.id === selectedChannelId) : undefined;
    const selectedProtocol = typeof body.protocol === "string" ? body.protocol : selectedChannel?.advancedConfig?.protocol;
    if (selectedProtocol === "chatgpt-api") {
        try {
            return NextResponse.json(await getChatGptModelCatalog());
        } catch {
            return NextResponse.json({ error: "拉取 GPTAPI 模型目录失败，请检查 GPTAPI 运行时是否已启动" }, { status: 502 });
        }
    }
    if (selectedProtocol === GEMINIAI_PROTOCOL) {
        try {
            const catalog = await listGeminiAiCatalog();
            const modelConfigs = Object.fromEntries(
                catalog.flatMap((model) => {
                    const capability = model.capabilities.includes("image") ? ("image" as const) : ("text" as const);
                    const config = protocolModelConfig(GEMINIAI_PROTOCOL, capability, model.id);
                    return config ? [[normalizeModelId(model.id), config] as const] : [];
                }),
            );
            return NextResponse.json({
                models: catalog.map((model) => model.id),
                modelCapabilities: Object.fromEntries(catalog.map((model) => [normalizeModelId(model.id), model.capabilities.includes("image") ? "image" : "text"])),
                modelConfigs,
                discoveredCount: catalog.length,
                totalCount: catalog.length,
                catalogSupported: true,
                provider: GEMINIAI_PROTOCOL,
            });
        } catch (error) {
            return NextResponse.json({ error: "拉取 GeminiAI 模型目录失败，请检查服务器端 GeminiAI 服务配置" }, { status: 502 });
        }
    }
    const { baseUrl, apiKey, apiFormat, savedChannel } = resolveAdminChannelCredentials(settings, body);
    if (!baseUrl) return NextResponse.json({ error: "请先填写 Base URL 和 API Key" }, { status: 400 });

    const advancedConfig = {
        ...(savedChannel?.advancedConfig || {}),
        ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
        ...(body.authMode !== undefined ? { authMode: body.authMode } : {}),
        ...(body.authHeader !== undefined ? { authHeader: body.authHeader } : {}),
        ...(body.authPrefix !== undefined ? { authPrefix: body.authPrefix } : {}),
        ...(body.globalAiOpcPreset !== undefined ? { globalAiOpcPreset: body.globalAiOpcPreset } : {}),
        ...(body.globalAiOpcPresets !== undefined ? { globalAiOpcPresets: body.globalAiOpcPresets } : {}),
        ...(body.createPath !== undefined ? { createPath: body.createPath } : {}),
    } as SystemChannelAdvancedConfig;
    const configuredModels = body.configuredModels !== undefined ? body.configuredModels : savedChannel?.models;
    const configuredCapabilities = body.modelCapabilities !== undefined ? body.modelCapabilities : savedChannel?.advancedConfig?.modelCapabilities;
    const configuredConfigs = normalizeModelConfigs(body.modelConfigs !== undefined ? body.modelConfigs : savedChannel?.advancedConfig?.modelConfigs);
    const configuredCatalog = configuredModelCatalog(configuredModels, configuredCapabilities, configuredConfigs);
    const operationConfigs = body.operationConfigs !== undefined ? body.operationConfigs : savedChannel?.advancedConfig?.operationConfigs;
    const protocol = (typeof body.protocol === "string" ? body.protocol : advancedConfig.protocol || "auto") as SystemChannelProtocol;
    const protocolDefinition = channelProtocolDefinition(protocol);
    advancedConfig.protocol = protocolDefinition.id;
    advancedConfig.authMode = resolveChannelAuthMode(advancedConfig);
    if (!apiKey && advancedConfig.authMode !== "none") return NextResponse.json({ error: "请先填写 Base URL 和 API Key" }, { status: 400 });
    const modelCatalogPaths = body.modelCatalogPaths ?? savedChannel?.advancedConfig?.modelCatalogPaths ?? protocolDefinition.modelCatalogPaths;
    const hasConfiguredCatalog = Array.isArray(modelCatalogPaths) && modelCatalogPaths.some((path) => typeof path === "string" && path.trim());

    if (protocolDefinition.builtInModels?.length && !hasConfiguredCatalog) {
        const builtInCatalog = protocolDefinition.builtInModels.map(({ id, capability }) => ({ id, capability, source: "official" as const }));
        // 渠道已维护过模型列表时只补全现有模型的预置配置，不再把用户删除的预置模型重新合并回来。
        const merged = mergeModelCatalogEntries(configuredCatalog, configuredCatalog.length ? builtInCatalog.filter((item) => configuredCatalog.some((configured) => normalizeModelId(configured.id) === normalizeModelId(item.id))) : builtInCatalog);
        const builtInConfigs = Object.fromEntries(
            protocolDefinition.builtInModels.flatMap(({ id, capability }) => {
                const config = protocolModelConfig(protocol, capability, id);
                return config ? [[normalizeModelId(id), config] as const] : [];
            }),
        );
        const modelConfigs = mergeModelConfigs(merged, configuredConfigs, modelConfigsFromOperations(merged, operationConfigs), builtInConfigs);
        return NextResponse.json({
            models: merged.map((entry) => entry.id),
            modelCapabilities: modelCapabilitiesRecord(merged, modelConfigs),
            modelConfigs,
            discoveredCount: builtInCatalog.length,
            totalCount: merged.length,
            catalogSupported: false,
            provider: protocol,
        });
    }

    if (protocol === "yumeng" && !hasConfiguredCatalog) {
        return NextResponse.json({ error: "昱梦新版只确认了 V2 任务接口，官方文档未提供 V2 模型目录；系统不会降级请求 /v1/models。请先手动填写模型 ID，或在上游确认 V2 模型目录路径后再同步。" }, { status: 422 });
    }

    const globalAiOpcPresets = resolveGlobalAiOpcCatalogPresets(baseUrl, advancedConfig);
    if (globalAiOpcPresets.length) {
        const selection = buildGlobalAiOpcSelection(globalAiOpcPresets.map((preset) => preset.id));
        const discovered = selection.models.map((id) => ({ id, capability: getGlobalAiOpcPresetForModel(id)?.capability || inferModelCapability(id), source: "official" as const }));
        const merged = mergeModelCatalogEntries(configuredCatalog, discovered);
        const modelConfigs = mergeModelConfigs(merged, configuredConfigs, modelConfigsFromOperations(merged, operationConfigs));
        return NextResponse.json({
            models: merged.map((entry) => entry.id),
            modelCapabilities: modelCapabilitiesRecord(merged, modelConfigs),
            modelConfigs,
            discoveredCount: discovered.length,
            totalCount: merged.length,
            globalAiOpcPresets: selection.presetIds,
        });
    }
    if (advancedConfig.protocol === "globalaiopc" || isGlobalAiOpcBaseUrl(baseUrl)) return NextResponse.json({ error: "未识别到 GlobalAiOpc 接口范围，请检查 Base URL 或重新选择接口范围" }, { status: 400 });

    if (!(await isSafeOutboundUrl(baseUrl, { allowCredentials: false, allowProxyFakeIpSpace: true }))) return NextResponse.json({ error: "Base URL 不允许访问内网或保留地址" }, { status: 400 });
    const modelCatalogUrls = buildModelCatalogUrls(baseUrl, apiFormat, modelCatalogPaths);
    if (!modelCatalogUrls.length) return NextResponse.json({ error: "模型目录路径必须与 Base URL 同源" }, { status: 400 });

    const cooldownKey = `${currentUser.id}:${baseUrl.toLowerCase()}`;
    const waitMs = (modelFetchCooldowns.get(cooldownKey) || 0) - Date.now();
    if (waitMs > 0) return NextResponse.json({ error: `拉取模型过于频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试` }, { status: 429 });
    modelFetchCooldowns.set(cooldownKey, Date.now() + MODEL_FETCH_COOLDOWN_MS);

    try {
        const providerCatalog = [] as ReturnType<typeof parseModelCatalog>;
        let providerConfigs = {} as ReturnType<typeof parseModelConfigs>;
        let catalogSucceeded = false;
        const visited = new Set<string>();

        for (const catalogUrl of modelCatalogUrls) {
            let nextUrl = catalogUrl;
            for (let page = 0; nextUrl && page < MODEL_FETCH_MAX_PAGES && !visited.has(nextUrl); page += 1) {
                visited.add(nextUrl);
                const response = await fetchSafeOutbound(
                    nextUrl,
                    {
                        headers: protocolAuthHeaders(apiKey, advancedConfig, apiFormat),
                        cache: "no-store",
                        signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
                    },
                    { allowProxyFakeIpSpace: true },
                );
                const payload = (await response.json().catch(() => ({}))) as ModelsResponse;
                if (!response.ok || isProviderBusinessError(payload)) {
                    if (isModelCatalogUnsupported(response.status, payload) || [404, 405, 501].includes(response.status)) break;
                    modelFetchCooldowns.delete(cooldownKey);
                    return NextResponse.json({ error: sanitizeProviderMessage(readProviderError(payload) || payload.msg || payload.error?.message || `拉取模型失败：${response.status}`, [apiKey]) }, { status: 502 });
                }
                catalogSucceeded = true;
                const pageCatalog = parseModelCatalog(payload, "provider", protocol);
                providerCatalog.splice(0, providerCatalog.length, ...mergeModelCatalogEntries(providerCatalog, pageCatalog));
                providerConfigs = { ...providerConfigs, ...parseModelConfigs(payload, protocol) };
                nextUrl = nextModelsPageUrl(nextUrl, payload, apiFormat, pageCatalog.at(-1)?.id || providerCatalog.at(-1)?.id || "");
            }
        }

        const officialCatalog = officialModelCatalog(baseUrl);
        const discovered = mergeModelCatalogEntries(providerCatalog, officialCatalog);
        const merged = mergeModelCatalogEntries(configuredCatalog, providerCatalog, officialCatalog);
        if (!merged.length) {
            modelFetchCooldowns.delete(cooldownKey);
            if (!catalogSucceeded) return NextResponse.json({ error: "该上游未提供模型列表接口，请在高级设置的“模型列表”手动填写模型名称；手工模型会在后续拉取时保留。" }, { status: 422 });
            return NextResponse.json({ error: "接口请求成功，但返回内容中没有识别到模型列表" }, { status: 502 });
        }

        const agnes = isAgnesApiBaseUrl(baseUrl);
        const strictConfigs = Object.fromEntries(
            merged.flatMap((entry) => {
                if (!protocolDefinition.strict) return [];
                const configuredProtocol = configuredConfigs[normalizeModelId(entry.id)]?.protocol;
                if (configuredProtocol && configuredProtocol !== protocol) return [];
                const config = protocolModelConfig(protocol, entry.capability, entry.id);
                return config ? [[normalizeModelId(entry.id), config] as const] : [];
            }),
        );
        const modelConfigs = mergeModelConfigs(merged, configuredConfigs, modelConfigsFromOperations(merged, operationConfigs), providerConfigs, officialModelConfigs(baseUrl), strictConfigs);
        return NextResponse.json({
            models: merged.map((entry) => entry.id),
            modelCapabilities: modelCapabilitiesRecord(merged, modelConfigs),
            modelConfigs,
            discoveredCount: discovered.length,
            totalCount: merged.length,
            catalogSupported: catalogSucceeded,
            ...(!catalogSucceeded ? { warning: "上游未公开模型目录，已保留现有手工模型。" } : {}),
            ...(agnes ? { provider: "agnes", recommendedConfig: AGNES_RECOMMENDED_CONFIG } : {}),
        });
    } catch (error) {
        modelFetchCooldowns.delete(cooldownKey);
        console.error("Admin model fetch failed", sanitizeProviderMessage(error, [apiKey]));
        return NextResponse.json({ error: isProviderTimeoutError(error) ? "拉取模型超时，请稍后重试" : "拉取模型失败，请检查接口地址和网络" }, { status: 502 });
    }
}
