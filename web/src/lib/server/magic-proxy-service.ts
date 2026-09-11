import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { parseDocument, stringify } from "yaml";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { MagicProxyRepository, type MagicProxyBinding, type MagicProxyBindings, type MagicProxyProvider, type MagicProxySettings } from "@/lib/server/database/magic-proxy-repository";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database/postgres";
import { fetchSafeOutbound, UnsafeOutboundUrlError } from "@/lib/server/safe-outbound-fetch";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";

const FILE_NAME = "magic-proxy.json";
const PROVIDER_NAME = "OctalFlow-Subscription";
const PROVIDER_FILE_NAME = "subscription.yaml";
const PROVIDER_ENDPOINT = `/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}`;
const LOCAL_FILE_SUBSCRIPTION_URL = "local://file-import";
const GROUP_NAMES: Record<MagicProxyProvider, string> = {
    geminiai: "OctalFlow-GeminiAIStudio",
    geminiTools: "OctalFlow-GeminiTools",
    chatgptApi: "OctalFlow-ChatGPTAPI",
};
const DEFAULT_MAGIC_PROXY_SUBSCRIPTION_MAX_BYTES = 4 * 1024 * 1024;
const MAGIC_PROXY_SUBSCRIPTION_MAX_BYTES_ENV = "OCTALAICANVAS_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES";
const EMPTY_BINDINGS: MagicProxyBindings = {
    geminiai: { enabled: false },
    geminiTools: { enabled: false },
    chatgptApi: { enabled: false },
};

type MagicProxyNode = Record<string, unknown> & { name: string; type: string };
type DecodedMagicProxySettings = { subscriptionUrl: string; nodes: MagicProxyNode[]; bindings: MagicProxyBindings; updatedAt: string };
type MihomoProviderState = Pick<DecodedMagicProxySettings, "nodes" | "bindings">;
type MihomoProxy = { name: string; type: string; alive?: boolean; delay?: number; now?: string; all?: string[] };
type MihomoRuntimeConfig = {
    controllerUrl: URL;
    secret: string;
    providerFile: string;
    proxyUrls: Partial<Record<MagicProxyProvider, string>>;
};

export type MagicProxyPublicBinding = MagicProxyBinding;
export type MagicProxyOverview = {
    configured: boolean;
    runtimeAvailable: boolean;
    lastUpdatedAt?: string;
    nodeCount: number;
    nodes: Array<{ name: string; type: string; alive?: boolean; delay?: number }>;
    groups: Array<{ name: string; type: string; now: string; all: string[] }>;
    bindings: MagicProxyBindings;
};

export class MagicProxyError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "MagicProxyError";
    }
}

export async function getMagicProxyOverview(): Promise<MagicProxyOverview> {
    const settings = await readSettings();
    const runtime = readRuntimeConfig();
    const [runtimeGroups, runtimeNodes] = runtime ? await Promise.all([readMihomoGroups(runtime), readMihomoProviderNodes(runtime)]) : [null, null];
    const nodesByName = new Map((runtimeNodes || []).map((proxy) => [proxy.name, proxy]));
    const nodes = (settings?.nodes || []).map((node) => {
        const runtimeNode = nodesByName.get(node.name);
        return {
            name: node.name,
            type: node.type,
            ...(runtimeNode?.alive !== undefined ? { alive: runtimeNode.alive } : {}),
            ...(runtimeNode?.delay !== undefined ? { delay: runtimeNode.delay } : {}),
        };
    });
    const bindings = settings?.bindings || cloneBindings(EMPTY_BINDINGS);
    return {
        configured: Boolean(settings),
        runtimeAvailable: Boolean(runtimeGroups && runtimeNodes),
        ...(settings?.updatedAt ? { lastUpdatedAt: settings.updatedAt } : {}),
        nodeCount: nodes.length,
        nodes,
        groups: (Object.keys(GROUP_NAMES) as MagicProxyProvider[]).map((provider) => {
            const group = runtimeGroups?.find((item) => item.name === GROUP_NAMES[provider]);
            return {
                name: GROUP_NAMES[provider],
                type: group?.type || "select",
                now: group?.now || "",
                all: group?.all || [],
            };
        }),
        bindings,
    };
}

export async function importMagicProxySubscription(input: { url?: unknown; content?: unknown }) {
    const hasFileContent = typeof input.content === "string";
    const suppliedContent = typeof input.content === "string" ? input.content : "";
    const provided = optionalText(input.url);
    const suppliedSubscriptionUrl = hasFileContent ? "" : provided ? normalizeSubscriptionUrl(provided) : "";
    const initial = suppliedSubscriptionUrl || hasFileContent ? null : await readSettings();
    const subscriptionUrl = hasFileContent ? LOCAL_FILE_SUBSCRIPTION_URL : suppliedSubscriptionUrl || initial?.subscriptionUrl;
    if (hasFileContent && !optionalText(suppliedContent)) throw new MagicProxyError("请选择包含 Clash YAML 内容的文件", 400);
    if (!subscriptionUrl) throw new MagicProxyError("请提供 HTTPS Clash YAML 订阅地址，或先导入一次订阅后再刷新", 400);
    if (subscriptionUrl === LOCAL_FILE_SUBSCRIPTION_URL && !hasFileContent) throw new MagicProxyError("当前订阅来自本地文件，不支持自动更新，请重新选择 YAML 或文本文件导入", 409);

    const nodes = hasFileContent ? parseSubscriptionNodes(suppliedContent) : await fetchSubscriptionNodes(subscriptionUrl);
    return withRuntimeLock(async () => {
        const existing = await readSettings();
        if (!suppliedSubscriptionUrl && !hasFileContent && existing?.subscriptionUrl !== subscriptionUrl) throw new MagicProxyError("订阅地址已在刷新期间变更，请重新刷新", 409);
        const next: DecodedMagicProxySettings = {
            subscriptionUrl,
            nodes,
            bindings: normalizeBindings(existing?.bindings, new Set(nodes.map((node) => node.name))),
            updatedAt: new Date().toISOString(),
        };
        const runtime = requireRuntimeConfig();
        try {
            await syncMihomoProvider(next, runtime);
            await saveSettings(encodeSettings(next));
        } catch (error) {
            const rollback: MihomoProviderState = existing || { nodes: [], bindings: cloneBindings(EMPTY_BINDINGS) };
            await syncMihomoProvider(rollback, runtime).catch(() => undefined);
            throw error;
        }
        return publicImportResult(next);
    });
}

const DELAY_TEST_URL = "https://www.gstatic.com/generate_204";
const DELAY_TEST_TIMEOUT_MS = 4000;
const DELAY_TEST_CONCURRENCY = 16;
const GOOGLE_TEST_URL = "https://www.google.com";
const GOOGLE_TEST_TIMEOUT_MS = 6000;

export type MagicProxyDelayResult = { name: string; delay?: number; error?: string };

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

const SERVICE_TITLES: Record<MagicProxyProvider, string> = {
    geminiai: "GeminiAIStudio (AIStudio 代理)",
    geminiTools: "GeminiTools (OAuth 代理)",
    chatgptApi: "ChatGPTAPI (逆向 API 代理)",
};

export async function testMagicProxyNodeDelay(input: unknown): Promise<MagicProxyDelayResult> {
    const name = optionalText(typeof input === "object" && input ? record(input).node : input);
    if (!name) throw new MagicProxyError("请提供要测速的节点名称", 400);
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    return { name, ...(await requestNodeDelay(runtime, name)) };
}

export async function testMagicProxyAllNodes(): Promise<{ results: MagicProxyDelayResult[] }> {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    const overview = await getMagicProxyOverview();
    if (!overview.runtimeAvailable) throw new MagicProxyError("魔法代理运行时当前不可用，无法测速", 503);
    const results = await mapWithLimit(overview.nodes.map((node) => node.name), DELAY_TEST_CONCURRENCY, async (name) => ({ name, ...(await requestNodeDelay(runtime, name)) }));
    return { results };
}

export async function testMagicProxyGoogleAccess(input?: unknown): Promise<MagicProxyGoogleTestReport> {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    const overview = await getMagicProxyOverview();
    if (!overview.runtimeAvailable) throw new MagicProxyError("魔法代理运行时当前不可用，无法测试", 503);

    const specificNode = optionalText(typeof input === "object" && input ? record(input).node : "");
    const testedAt = new Date().toISOString();

    if (specificNode) {
        let delay: number | undefined;
        let error: string | undefined;
        try {
            const response = await controllerRequest(
                runtime,
                `/proxies/${encodeURIComponent(specificNode)}/delay?url=${encodeURIComponent(GOOGLE_TEST_URL)}&timeout=${GOOGLE_TEST_TIMEOUT_MS}`,
                { method: "GET" },
            );
            const payload = record(await response.json());
            const d = Number(payload.delay);
            if (Number.isFinite(d) && d >= 0) {
                delay = d;
            } else {
                error = "返回数据无效";
            }
        } catch {
            error = `访问 Google 超时或节点阻断 (>${GOOGLE_TEST_TIMEOUT_MS}ms)`;
        }
        return {
            targetUrl: GOOGLE_TEST_URL,
            testedAt,
            overallOk: typeof delay === "number",
            items: [
                {
                    service: "geminiai",
                    serviceTitle: `指定节点 [${specificNode}]`,
                    group: specificNode,
                    activeNode: specificNode,
                    enabled: true,
                    ok: typeof delay === "number",
                    delay,
                    error,
                },
            ],
        };
    }

    const providers: MagicProxyProvider[] = ["geminiai", "geminiTools", "chatgptApi"];
    const items: MagicProxyGoogleTestItem[] = [];

    for (const provider of providers) {
        const group = GROUP_NAMES[provider];
        const binding = overview.bindings[provider];
        const title = SERVICE_TITLES[provider] || provider;

        let activeNode = "DIRECT";
        try {
            const groupInfoRes = await controllerRequest(runtime, `/proxies/${encodeURIComponent(group)}`, { method: "GET" });
            const groupInfo = record(await groupInfoRes.json());
            activeNode = optionalText(groupInfo.now) || "DIRECT";
        } catch {
            activeNode = binding?.node || "DIRECT";
        }

        const isEnabled = Boolean(binding?.enabled && activeNode !== "DIRECT");

        if (!isEnabled || activeNode === "DIRECT") {
            items.push({
                service: provider,
                serviceTitle: title,
                group,
                activeNode,
                enabled: false,
                ok: false,
                error: "服务未启用代理或处于 DIRECT 直连状态，无法访问 Google",
            });
            continue;
        }

        let delay: number | undefined;
        let error: string | undefined;
        try {
            const response = await controllerRequest(
                runtime,
                `/proxies/${encodeURIComponent(group)}/delay?url=${encodeURIComponent(GOOGLE_TEST_URL)}&timeout=${GOOGLE_TEST_TIMEOUT_MS}`,
                { method: "GET" },
            );
            const payload = record(await response.json());
            const d = Number(payload.delay);
            if (Number.isFinite(d) && d >= 0) {
                delay = d;
            } else {
                error = "返回数据无效";
            }
        } catch {
            error = `访问 Google 超时或节点阻断 (>${GOOGLE_TEST_TIMEOUT_MS}ms)`;
        }

        items.push({
            service: provider,
            serviceTitle: title,
            group,
            activeNode,
            enabled: true,
            ok: typeof delay === "number",
            delay,
            error,
        });
    }

    const overallOk = items.some((item) => item.enabled && item.ok);
    return {
        targetUrl: GOOGLE_TEST_URL,
        testedAt,
        overallOk,
        items,
    };
}

async function requestNodeDelay(runtime: MihomoRuntimeConfig, name: string): Promise<{ delay?: number; error?: string }> {
    try {
        const response = await controllerRequest(runtime, `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=${DELAY_TEST_TIMEOUT_MS}`, { method: "GET" });
        const payload = record(await response.json());
        const delay = Number(payload.delay);
        if (Number.isFinite(delay) && delay >= 0) return { delay };
        return { error: "测速结果无效" };
    } catch {
        return { error: "测速超时或节点不可用" };
    }
}

async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
        while (cursor < items.length) {
            const current = cursor++;
            results[current] = await worker(items[current]);
        }
    });
    await Promise.all(runners);
    return results;
}

export async function updateMagicProxyBinding(input: {
    provider?: unknown;
    enabled?: unknown;
    node?: unknown;
    mode?: unknown;
    chained_config?: unknown;
}) {
    const provider = magicProxyProvider(input.provider);
    if (!provider) throw new MagicProxyError("魔法代理服务标识无效", 400);
    if (typeof input.enabled !== "boolean") throw new MagicProxyError("请明确指定是否启用代理", 400);

    const mode = input.mode === "chained" ? "chained" : "magic";

    return withRuntimeLock(async () => {
        const settings = await readSettings();
        if (!settings) throw new MagicProxyError("请先导入魔法代理订阅", 409);
        const nodeNames = new Set(settings.nodes.map((node) => node.name));
        const current = settings.bindings[provider];
        const nextNode = Object.prototype.hasOwnProperty.call(input, "node") ? bindingNode(input.node) : current.node;

        if (mode === "magic") {
            if (nextNode && !nodeNames.has(nextNode)) throw new MagicProxyError("所选节点不在当前订阅中", 422);
            if (input.enabled && !nextNode) throw new MagicProxyError("启用魔法代理前请选择当前订阅中的节点", 422);
        }

        let chainedConfig: { hop_node: string; landing_node_id: string } | undefined = undefined;
        if (mode === "chained") {
            const rawConfig = input.chained_config as Record<string, unknown> | null | undefined;
            const hop = typeof rawConfig?.hop_node === "string" ? rawConfig.hop_node.trim() : "";
            const landing = typeof rawConfig?.landing_node_id === "string" ? rawConfig.landing_node_id.trim() : "";
            chainedConfig = { hop_node: hop, landing_node_id: landing };
        }

        const next: DecodedMagicProxySettings = {
            ...settings,
            bindings: {
                ...settings.bindings,
                [provider]: {
                    enabled: input.enabled,
                    ...(mode === "chained" ? { mode: "chained" as const } : {}),
                    ...(nextNode ? { node: nextNode } : {}),
                    ...(chainedConfig ? { chained_config: chainedConfig } : {}),
                },
            },
            updatedAt: new Date().toISOString(),
        };

        const runtime = requireRuntimeConfig();
        try {
            if (mode === "chained") {
                if (chainedConfig?.hop_node && chainedConfig?.landing_node_id) {
                    const { resolveGenericProxyNodeUrl } = await import("./chatgpt-api-service");
                    const landingProxyUrl = await resolveGenericProxyNodeUrl(chainedConfig.landing_node_id);
                    if (landingProxyUrl) {
                        await syncMihomoChainedProxyInternal({
                            hopNode: chainedConfig.hop_node,
                            landingProxyUrl,
                            provider,
                        });
                    }
                }
            } else {
                if (current.mode === "chained") {
                    await syncMihomoChainedProxyInternal({ provider });
                }
                await ensureMihomoGroupSelection(next, runtime, provider);
            }
            await saveSettings(encodeSettings(next));
        } catch (error) {
            await ensureMihomoGroupSelection(settings, runtime, provider).catch(() => undefined);
            throw error;
        }
        return { provider, binding: cloneBinding(next.bindings[provider]) };
    });
}

export type MagicProxyEgressInfo = { mode: "magic" | "generic" | "chained"; node_name?: string; address?: string };

function proxyAddressFromUrl(value: string) {
    try {
        const url = new URL(value.trim());
        return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch {
        return "";
    }
}

export async function ensureMagicProxyProvider(provider: MagicProxyProvider): Promise<{ enabled: boolean; proxyUrl?: string; egress?: MagicProxyEgressInfo }> {
    return withRuntimeLock(async () => {
        const settings = await readSettings();
        if (!settings) {
            const generic = await ensureGenericProxyEgress(provider);
            if (generic.enabled) return generic;
            return { enabled: false };
        }
        const binding = settings.bindings[provider];
        const isChained = binding?.mode === "chained";
        const isMagic = !isChained && binding?.enabled === true;
        const isEnabled = binding?.enabled === true;

        if (isMagic && !binding?.node) throw new MagicProxyError("魔法代理绑定缺少节点，请在服务设置中重新选择", 409);
        if (!isEnabled) {
            const generic = await ensureGenericProxyEgress(provider);
            if (generic.enabled) return generic;
            return { enabled: false };
        }

        const runtime = readRuntimeConfig();
        if (!runtime) {
            if (isEnabled) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
            return { enabled: false };
        }

        if (isChained) {
            if (provider === "geminiai") {
                const { syncGeminiAiRuntimeProxy } = await import("./geminiai-provider");
                await syncGeminiAiRuntimeProxy(runtimeProxyUrl(runtime, "geminiai"));
            }
            return {
                enabled: true,
                proxyUrl: runtimeProxyUrl(runtime, provider),
                egress: {
                    mode: "chained",
                    node_name: `链式代理(${binding?.chained_config?.hop_node || "未选跳板"} ➔ ${binding?.chained_config?.landing_node_id || "未选落地"})`,
                },
            };
        }

        await ensureMihomoGroupSelection(settings, runtime, provider);
        if (isMagic && provider === "geminiai") {
            const { syncGeminiAiRuntimeProxy } = await import("./geminiai-provider");
            await syncGeminiAiRuntimeProxy(runtimeProxyUrl(runtime, "geminiai"));
        }

        return {
            enabled: true,
            proxyUrl: runtimeProxyUrl(runtime, provider),
            egress: { mode: "magic", node_name: binding?.node },
        };
    });
}

/**
 * Generic-proxy egress fallback: resolves a concrete proxy URL through the
 * ChatGPT runtime (group targets reuse its capacity-aware node rotation).
 * Only applies to providers whose outbound requests accept a proxy URL;
 * GeminiAIStudio routes traffic through its browser session instead.
 */
async function ensureGenericProxyEgress(provider: MagicProxyProvider): Promise<{ enabled: boolean; proxyUrl?: string; egress?: MagicProxyEgressInfo }> {
    // Generic egress depends only on the ChatGPT runtime (bindings + resolve-url),
    // NOT on the Mihomo magic-proxy runtime being configured.
    let chatGptRuntimeJson: <T>(path: string, init?: RequestInit) => Promise<T>;
    let binding: { enabled?: boolean; target?: string } | undefined;
    try {
        ({ chatGptRuntimeJson } = await import("./chatgpt-api-service"));
        const payload = await chatGptRuntimeJson<{ bindings?: Record<string, { enabled?: boolean; target?: string }> }>("/api/proxy/generic-bindings");
        binding = payload?.bindings?.[provider];
    } catch {
        // ChatGPT runtime unavailable → no generic egress can be configured at all.
        return { enabled: false };
    }
    if (!binding?.enabled || !binding.target) return { enabled: false };
    if (provider === "geminiai" && binding.target.startsWith("group:")) {
        throw new MagicProxyError("GeminiAIStudio 通用代理仅支持选择单个节点", 400);
    }
    if (binding.target.startsWith("group:")) {
        const resolved = await chatGptRuntimeJson<{ proxy_url?: string }>("/api/proxy/resolve-url", { method: "POST", body: JSON.stringify({ group_id: binding.target.slice("group:".length) }) });
        return resolved.proxy_url ? { enabled: true, proxyUrl: resolved.proxy_url, egress: { mode: "generic", address: proxyAddressFromUrl(resolved.proxy_url) } } : { enabled: false };
    }
    if (binding.target.startsWith("node:")) {
        const resolved = await chatGptRuntimeJson<{ proxy_url?: string }>("/api/proxy/resolve-url", { method: "POST", body: JSON.stringify({ node_id: binding.target.slice("node:".length) }) });
        if (!resolved.proxy_url) return { enabled: false };
        if (provider === "geminiai") {
            const { syncGeminiAiRuntimeProxy } = await import("./geminiai-provider");
            await syncGeminiAiRuntimeProxy(resolved.proxy_url);
        }
        return { enabled: true, proxyUrl: resolved.proxy_url, egress: { mode: "generic", address: proxyAddressFromUrl(resolved.proxy_url) } };
    }
    return { enabled: false };
}

function publicImportResult(settings: DecodedMagicProxySettings) {
    return {
        nodeCount: settings.nodes.length,
        nodes: settings.nodes.map((node) => ({ name: node.name, type: node.type })),
        bindings: cloneBindings(settings.bindings),
        lastUpdatedAt: settings.updatedAt,
    };
}

async function fetchSubscriptionNodes(subscriptionUrl: string) {
    let response: Response;
    try {
        response = await fetchSafeOutbound(subscriptionUrl, { cache: "no-store", redirect: "follow", headers: { accept: "application/yaml, text/yaml, text/plain, */*" } }, { allowProxyFakeIpSpace: true });
    } catch (error) {
        if (error instanceof UnsafeOutboundUrlError) throw new MagicProxyError("订阅地址不允许访问，请使用可公开访问的 HTTPS Clash YAML 地址", 422);
        throw new MagicProxyError("订阅获取失败，请确认地址和访问权限", 502);
    }
    if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (status === 401 || status === 403) throw new MagicProxyError(`订阅服务器拒绝访问（HTTP ${status}），请使用服务器可直接访问的 Clash YAML 直链，不能使用需要浏览器验证的网页链接`, 502);
        throw new MagicProxyError(`订阅获取失败（HTTP ${status}），请确认地址和访问权限`, 502);
    }
    const raw = await readBoundedSubscriptionText(response, magicProxySubscriptionMaxBytes());
    return parseSubscriptionNodes(raw);
}

async function readBoundedSubscriptionText(response: Response, maxBytes: number) {
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0]?.trim().toLowerCase() || "";
    if (contentType && !["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"].includes(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new MagicProxyError("订阅响应必须是 YAML 或文本内容", 422);
    }
    const contentLength = response.headers.get("content-length")?.trim() || "";
    if (/^\d+$/.test(contentLength)) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new MagicProxyError(`订阅内容超过 ${maxBytes} 字节限制，请缩小订阅或调整服务器限制`, 413);
        }
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new MagicProxyError(`订阅内容超过 ${maxBytes} 字节限制，请缩小订阅或调整服务器限制`, 413);
            }
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        if (error instanceof MagicProxyError) throw error;
        throw new MagicProxyError("订阅内容读取失败，请稍后刷新", 502);
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new MagicProxyError("订阅内容不是有效的 UTF-8 文本", 422);
    }
}

function magicProxySubscriptionMaxBytes() {
    const configured = Number(process.env[MAGIC_PROXY_SUBSCRIPTION_MAX_BYTES_ENV]);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAGIC_PROXY_SUBSCRIPTION_MAX_BYTES;
}

function parseSubscriptionNodes(raw: string) {
    if (Buffer.byteLength(raw, "utf8") > magicProxySubscriptionMaxBytes()) throw new MagicProxyError(`订阅内容超过 ${magicProxySubscriptionMaxBytes()} 字节限制，请缩小文件或调整服务器限制`, 413);
    let document: ReturnType<typeof parseDocument>;
    try {
        document = parseDocument(raw);
    } catch {
        throw new MagicProxyError("订阅内容不是有效的 Clash YAML", 422);
    }
    if (document.errors.length) throw new MagicProxyError("订阅内容不是有效的 Clash YAML", 422);
    const root = record(document.toJS());
    return normalizeSubscriptionNodes(root.proxies);
}

function normalizeSubscriptionNodes(value: unknown) {
    if (!Array.isArray(value) || !value.length) throw new MagicProxyError("订阅必须包含非空 proxies 节点列表", 422);
    const names = new Set<string>();
    return value.map((rawNode) => {
        const node = record(rawNode);
        const name = requiredText(node.name, "订阅节点缺少名称");
        const type = requiredText(node.type, `订阅节点“${name}”缺少类型`);
        if (name === "DIRECT" || Object.values(GROUP_NAMES).includes(name)) throw new MagicProxyError("订阅节点名称与魔法代理保留名称冲突", 422);
        if (names.has(name)) throw new MagicProxyError("订阅节点名称不能重复", 422);
        names.add(name);
        const sanitized = sanitizeJson(node);
        if (!record(sanitized)) throw new MagicProxyError("订阅节点格式无效", 422);
        return { ...(sanitized as Record<string, unknown>), name, type } as MagicProxyNode;
    });
}

function normalizeSubscriptionUrl(value: string) {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new MagicProxyError("订阅地址格式无效", 400);
    }
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new MagicProxyError("订阅地址必须是未包含账号密码的 HTTPS 地址", 422);
    url.hash = "";
    return url.toString();
}

function normalizeBindings(value: MagicProxyBindings | undefined, names: Set<string>): MagicProxyBindings {
    return {
        geminiai: normalizedBinding(value?.geminiai, names),
        geminiTools: normalizedBinding(value?.geminiTools, names),
        chatgptApi: normalizedBinding(value?.chatgptApi, names),
    };
}

function normalizedBinding(value: MagicProxyBinding | undefined, names: Set<string>): MagicProxyBinding {
    const node = optionalText(value?.node);
    const isChained = value?.mode === "chained";
    if (isChained) {
        const chained = value?.chained_config;
        const hop = optionalText(chained?.hop_node);
        const landing = optionalText(chained?.landing_node_id);
        return {
            enabled: value?.enabled === true,
            mode: "chained",
            ...(node ? { node } : {}),
            ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing } } : {}),
        };
    }
    if (!node || !names.has(node)) return { enabled: false };
    return { enabled: value?.enabled === true, node };
}

function bindingNode(value: unknown) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw new MagicProxyError("节点名称格式无效", 400);
    return value.trim();
}

async function syncMihomoProvider(settings: MihomoProviderState, runtime: MihomoRuntimeConfig) {
    await writeMihomoProviderFile(runtime.providerFile, settings.nodes);
    const response = await controllerRequest(runtime, PROVIDER_ENDPOINT, {
        method: "PUT",
    });
    await response.body?.cancel().catch(() => undefined);
    const runtimeNodes = await requestMihomoProxyList(runtime, PROVIDER_ENDPOINT);
    const runtimeNodeNames = new Set(runtimeNodes.map((node) => node.name));
    const expectedNodeNames = new Set(settings.nodes.map((node) => node.name));
    if (expectedNodeNames.size !== runtimeNodeNames.size || [...expectedNodeNames].some((name) => !runtimeNodeNames.has(name))) {
        throw new MagicProxyError("Mihomo Provider 节点与当前订阅不一致，请检查共享订阅文件和 Provider 配置", 502);
    }
    for (const provider of Object.keys(GROUP_NAMES) as MagicProxyProvider[]) {
        const binding = settings.bindings[provider];
        if (provider === "chatgptApi" && !runtime.proxyUrls.chatgptApi) {
            if (binding.enabled) runtimeProxyUrl(runtime, provider);
            continue;
        }
        await selectMihomoProxy(runtime, GROUP_NAMES[provider], binding.enabled && binding.node ? binding.node : "DIRECT");
    }
}

async function ensureMihomoGroupSelection(settings: DecodedMagicProxySettings, runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const binding = settings.bindings[provider];
    const expected = binding.enabled && binding.node ? binding.node : "DIRECT";
    const groups = await readMihomoGroups(runtime);
    const group = groups?.find((item) => item.name === GROUP_NAMES[provider]);
    if (!group || !group.all?.includes(expected)) {
        await syncMihomoProvider(settings, runtime);
    } else if (group.now !== expected) {
        await selectMihomoProxy(runtime, GROUP_NAMES[provider], expected);
    }
}

async function writeMihomoProviderFile(providerFile: string, nodes: MagicProxyNode[]) {
    const parent = dirname(providerFile);
    const temporaryFile = join(parent, `.${basename(providerFile)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await chmod(parent, 0o700);
        await writeFile(temporaryFile, stringify({ proxies: nodes }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryFile, providerFile);
        await chmod(providerFile, 0o600);
    } catch {
        throw new MagicProxyError("魔法代理订阅文件写入失败，请检查共享运行目录权限", 503);
    } finally {
        await unlink(temporaryFile).catch(() => undefined);
    }
}

export function getChainedExitNodeName(provider: MagicProxyProvider = "chatgptApi") {
    return provider === "chatgptApi" ? "OctalFlow-Chained-Exit" : `OctalFlow-Chained-Exit-${provider}`;
}

export const CHAINED_EXIT_NODE_NAME = "OctalFlow-Chained-Exit";

async function syncMihomoChainedProxyInternal(input: {
    hopNode?: string;
    landingProxyUrl?: string;
    provider?: MagicProxyProvider;
}) {
    const settings = await readSettings();
    if (!settings) return;
    const runtime = requireRuntimeConfig();
    const provider = input.provider || "chatgptApi";
    const groupName = GROUP_NAMES[provider];
    const chainedNodeName = getChainedExitNodeName(provider);

    const baseNodes = settings.nodes.filter((node) => node.name !== chainedNodeName);

    const hopNode = input.hopNode?.trim();
    const landingUrl = input.landingProxyUrl?.trim();

    if (!hopNode || !landingUrl) {
        await writeMihomoProviderFile(runtime.providerFile, baseNodes);
        await controllerRequest(runtime, PROVIDER_ENDPOINT, { method: "PUT" }).catch(() => undefined);
        const binding = settings.bindings[provider];
        const targetNode = binding?.enabled && binding?.node ? binding.node : "DIRECT";
        await selectMihomoProxy(runtime, groupName, targetNode).catch(() => undefined);
        return;
    }

    let parsed: URL;
    try {
        parsed = new URL(landingUrl.includes("://") ? landingUrl : `http://${landingUrl}`);
    } catch {
        return;
    }

    const isSocks = parsed.protocol.startsWith("socks");
    const nodeType = isSocks ? "socks5" : "http";
    const port = Number(parsed.port) || (isSocks ? 1080 : 80);

    const chainedNode: MagicProxyNode = {
        name: chainedNodeName,
        type: nodeType,
        server: parsed.hostname,
        port,
        ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
        ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
        "dialer-proxy": hopNode,
    };

    const mergedNodes = [...baseNodes, chainedNode];
    await writeMihomoProviderFile(runtime.providerFile, mergedNodes);
    const reloadRes = await controllerRequest(runtime, PROVIDER_ENDPOINT, { method: "PUT" });
    await reloadRes.body?.cancel().catch(() => undefined);

    await selectMihomoProxy(runtime, groupName, chainedNodeName);
}

export async function syncMihomoChainedProxy(input: {
    hopNode?: string;
    landingProxyUrl?: string;
    provider?: MagicProxyProvider;
}) {
    return withRuntimeLock(async () => {
        return syncMihomoChainedProxyInternal(input);
    });
}

async function selectMihomoProxy(runtime: MihomoRuntimeConfig, group: string, node: string) {
    const response = await controllerRequest(runtime, `/proxies/${encodeURIComponent(group)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: node }),
    });
    await response.body?.cancel().catch(() => undefined);
}

async function readMihomoGroups(runtime: MihomoRuntimeConfig): Promise<MihomoProxy[] | null> {
    try {
        return await requestMihomoProxyList(runtime, "/proxies");
    } catch {
        return null;
    }
}

async function readMihomoProviderNodes(runtime: MihomoRuntimeConfig): Promise<MihomoProxy[] | null> {
    try {
        return await requestMihomoProxyList(runtime, PROVIDER_ENDPOINT);
    } catch {
        return null;
    }
}

async function requestMihomoProxyList(runtime: MihomoRuntimeConfig, path: string) {
    const response = await controllerRequest(runtime, path, { method: "GET" });
    try {
        const payload = record(await response.json());
        return publicMihomoProxyList(payload.proxies);
    } catch (error) {
        if (error instanceof MagicProxyError) throw error;
        throw new MagicProxyError("魔法代理控制器返回了无效的代理数据", 502);
    }
}

function publicMihomoProxyList(value: unknown): MihomoProxy[] {
    if (Array.isArray(value)) return value.flatMap((item) => publicMihomoProxy(record(item), ""));
    return Object.entries(record(value)).flatMap(([fallbackName, item]) => publicMihomoProxy(record(item), fallbackName));
}

function publicMihomoProxy(value: Record<string, unknown>, fallbackName: string): MihomoProxy[] {
    const name = optionalText(value.name) || fallbackName;
    const type = optionalText(value.type) || "unknown";
    if (!name) return [];
    const delay = currentDelay(value);
    const all = Array.isArray(value.all) ? value.all.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : undefined;
    return [
        {
            name,
            type,
            ...(typeof value.alive === "boolean" ? { alive: value.alive } : {}),
            ...(delay !== undefined ? { delay } : {}),
            ...(optionalText(value.now) ? { now: optionalText(value.now) } : {}),
            ...(all ? { all } : {}),
        },
    ];
}

function currentDelay(value: Record<string, unknown>) {
    if (Number.isFinite(value.delay) && Number(value.delay) >= 0) return Number(value.delay);
    const history = Array.isArray(value.history) ? value.history : [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const delay = record(history[index]).delay;
        if (Number.isFinite(delay) && Number(delay) >= 0) return Number(delay);
    }
    return undefined;
}

async function controllerRequest(runtime: MihomoRuntimeConfig, path: string, init: RequestInit) {
    let response: Response;
    try {
        response = await fetch(controllerEndpoint(runtime.controllerUrl, path), {
            ...init,
            headers: { authorization: `Bearer ${runtime.secret}`, ...init.headers },
            cache: "no-store",
            redirect: "error",
        });
    } catch {
        throw new MagicProxyError("魔法代理控制器不可用，请检查 Mihomo 运行状态", 503);
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MagicProxyError("魔法代理控制器拒绝了配置请求，请检查服务器运行状态", 502);
    }
    return response;
}

function controllerEndpoint(base: URL, path: string) {
    return new URL(path, `${base.protocol}//${base.host}`).toString();
}

function readRuntimeConfig(): MihomoRuntimeConfig | null {
    const controllerValue = process.env.OCTALAICANVAS_MAGIC_PROXY_CONTROLLER_URL?.trim() || "";
    const secret = process.env.OCTALAICANVAS_MAGIC_PROXY_SECRET?.trim() || "";
    const providerFile = process.env.OCTALAICANVAS_MAGIC_PROXY_PROVIDER_FILE?.trim() || "";
    const listenHost = process.env.OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST?.trim() || "";
    const geminiaiPort = port(process.env.OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_PORT);
    const geminiToolsPort = port(process.env.OCTALAICANVAS_MAGIC_PROXY_GEMINI_TOOLS_PORT);
    const chatgptApiPort = port(process.env.OCTALAICANVAS_MAGIC_PROXY_CHATGPT_API_PORT);
    const geminiaiUrl = proxyUrl(process.env.OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_URL, geminiaiPort);
    const geminiToolsUrl = proxyUrl(process.env.OCTALAICANVAS_MAGIC_PROXY_GEMINI_TOOLS_URL, geminiToolsPort);
    if (!controllerValue || secret.length < 32 || !isMagicProxyProviderFile(providerFile) || !isMagicProxyListenHost(listenHost) || !geminiaiPort || !geminiToolsPort || geminiaiPort === geminiToolsPort || !geminiaiUrl || !geminiToolsUrl) return null;
    try {
        const controllerUrl = new URL(controllerValue);
        const controllerPort = port(controllerUrl.port);
        if (!["http:", "https:"].includes(controllerUrl.protocol) || !controllerPort || controllerUrl.username || controllerUrl.password || controllerUrl.pathname !== "/" || controllerUrl.search || controllerUrl.hash) return null;
        const chatgptApiUrl = proxyUrl(process.env.OCTALAICANVAS_MAGIC_PROXY_CHATGPT_API_URL, chatgptApiPort);
        const chatgptApiProxyUrl = chatgptApiPort && chatgptApiPort !== controllerPort && chatgptApiPort !== geminiaiPort && chatgptApiPort !== geminiToolsPort ? chatgptApiUrl : "";
        return {
            controllerUrl,
            secret,
            providerFile,
            proxyUrls: { geminiai: geminiaiUrl, geminiTools: geminiToolsUrl, ...(chatgptApiProxyUrl ? { chatgptApi: chatgptApiProxyUrl } : {}) },
        };
    } catch {
        return null;
    }
}

function requireRuntimeConfig() {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查 Mihomo 控制器、订阅文件、监听地址和两个独立端口", 503);
    return runtime;
}

function runtimeProxyUrl(runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const value = runtime.proxyUrls[provider];
    if (value) return value;
    if (provider === "chatgptApi") {
        throw new MagicProxyError("ChatGPTAPI 魔法代理监听未配置，请同时设置 OCTALAICANVAS_MAGIC_PROXY_CHATGPT_API_PORT 和 OCTALAICANVAS_MAGIC_PROXY_CHATGPT_API_URL，并使用独立端口", 503);
    }
    throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
}

function proxyUrl(value: string | undefined, expectedPort: number) {
    if (!value || !expectedPort) return "";
    try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return "";
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        return port === expectedPort ? url.toString() : "";
    } catch {
        return "";
    }
}

function port(value: string | undefined) {
    const parsed = Number(value?.trim());
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 0;
}

function isMagicProxyListenHost(value: string) {
    return value === "0.0.0.0" || value === "127.0.0.1";
}

function isMagicProxyProviderFile(value: string) {
    return isAbsolute(value) && basename(value) === PROVIDER_FILE_NAME;
}

async function readSettings(): Promise<DecodedMagicProxySettings | null> {
    const stored = isPostgresDatabaseEnabled() ? await (await postgresRepository()).get() : await readFileSettings();
    if (!stored?.subscriptionUrlCiphertext || !stored.nodesCiphertext) return null;
    try {
        const storedSubscriptionUrl = decryptSecretValue(stored.subscriptionUrlCiphertext);
        const subscriptionUrl = storedSubscriptionUrl === LOCAL_FILE_SUBSCRIPTION_URL ? storedSubscriptionUrl : normalizeSubscriptionUrl(storedSubscriptionUrl);
        const nodes = normalizeSubscriptionNodes(JSON.parse(decryptSecretValue(stored.nodesCiphertext)));
        return {
            subscriptionUrl,
            nodes,
            bindings: normalizeBindings(stored.bindings, new Set(nodes.map((node) => node.name))),
            updatedAt: stored.updatedAt,
        };
    } catch (error) {
        if (error instanceof MagicProxyError) throw error;
        throw new MagicProxyError("魔法代理已保存配置无法读取，请重新导入订阅", 500);
    }
}

function encodeSettings(settings: DecodedMagicProxySettings): MagicProxySettings {
    return {
        subscriptionUrlCiphertext: encryptSecretValue(settings.subscriptionUrl),
        nodesCiphertext: encryptSecretValue(JSON.stringify(settings.nodes)),
        bindings: cloneBindings(settings.bindings),
        updatedAt: settings.updatedAt,
    };
}

async function saveSettings(settings: MagicProxySettings) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).save(settings);
    return withJsonDataFileLock(FILE_NAME, async () => {
        await writeJsonDataFile(FILE_NAME, settings);
        return settings;
    });
}

async function readFileSettings() {
    const value = await readJsonDataFile<Partial<MagicProxySettings>>(FILE_NAME, {});
    if (typeof value.subscriptionUrlCiphertext !== "string" || typeof value.nodesCiphertext !== "string") return null;
    return {
        subscriptionUrlCiphertext: value.subscriptionUrlCiphertext,
        nodesCiphertext: value.nodesCiphertext,
        bindings: storedBindings(value.bindings),
        updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? new Date(value.updatedAt).toISOString() : new Date().toISOString(),
    } satisfies MagicProxySettings;
}

function storedBindings(value: unknown): MagicProxyBindings {
    const bindings = record(value);
    return {
        geminiai: storedBinding(bindings.geminiai),
        geminiTools: storedBinding(bindings.geminiTools),
        chatgptApi: storedBinding(bindings.chatgptApi),
    };
}

function storedBinding(value: unknown): MagicProxyBinding {
    const binding = record(value);
    const node = optionalText(binding.node);
    const isChained = binding.mode === "chained";
    const chained = record(binding.chained_config);
    const hop = optionalText(chained.hop_node);
    const landing = optionalText(chained.landing_node_id);
    return {
        enabled: binding.enabled === true,
        ...(isChained ? { mode: "chained" as const } : {}),
        ...(node ? { node } : {}),
        ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing } } : {}),
    };
}

async function postgresRepository() {
    await ensurePostgresSchema();
    return new MagicProxyRepository({ query: postgresQuery });
}

function sanitizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new MagicProxyError("订阅节点包含无效数值", 422);
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, seen));
    if (!value || typeof value !== "object") throw new MagicProxyError("订阅节点包含不支持的数据类型", 422);
    if (seen.has(value)) throw new MagicProxyError("订阅节点包含循环数据", 422);
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) continue;
        result[key] = sanitizeJson(item, seen);
    }
    seen.delete(value);
    return result;
}

function requiredText(value: unknown, message: string) {
    const result = optionalText(value);
    if (!result) throw new MagicProxyError(message, 422);
    return result;
}

function optionalText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function magicProxyProvider(value: unknown): MagicProxyProvider | null {
    return value === "geminiai" || value === "geminiTools" || value === "chatgptApi" ? value : null;
}

function cloneBinding(value: MagicProxyBinding): MagicProxyBinding {
    const node = optionalText(value.node);
    const isChained = value.mode === "chained";
    const hop = optionalText(value.chained_config?.hop_node);
    const landing = optionalText(value.chained_config?.landing_node_id);
    return {
        enabled: value.enabled === true,
        ...(isChained ? { mode: "chained" as const } : {}),
        ...(node ? { node } : {}),
        ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing } } : {}),
    };
}

function cloneBindings(value: MagicProxyBindings): MagicProxyBindings {
    return { geminiai: cloneBinding(value.geminiai), geminiTools: cloneBinding(value.geminiTools), chatgptApi: cloneBinding(value.chatgptApi) };
}

const runtimeState = globalThis as typeof globalThis & { __octalaicanvasMagicProxyRuntimeQueue?: Promise<void> };

async function withRuntimeLock<T>(callback: () => Promise<T>) {
    const previous = runtimeState.__octalaicanvasMagicProxyRuntimeQueue || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    runtimeState.__octalaicanvasMagicProxyRuntimeQueue = queued;
    await previous.catch(() => undefined);
    try {
        return await callback();
    } finally {
        release();
        if (runtimeState.__octalaicanvasMagicProxyRuntimeQueue === queued) delete runtimeState.__octalaicanvasMagicProxyRuntimeQueue;
    }
}
