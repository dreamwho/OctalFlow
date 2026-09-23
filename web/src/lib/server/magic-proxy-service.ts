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
const PROVIDER_NAME = "dreamyo-Subscription";
const PROVIDER_FILE_NAME = "subscription.yaml";
const PROVIDER_ENDPOINT = `/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}`;
const LOCAL_FILE_SUBSCRIPTION_URL = "local://file-import";
const GROUP_NAMES: Record<MagicProxyProvider, string> = {
    geminiai: "dreamyo-GeminiAIStudio",
    geminiTools: "dreamyo-GeminiTools",
    chatgptApi: "dreamyo-ChatGPTAPI",
    dola: "dreamyo-DolaAPI",
};
const DEFAULT_MAGIC_PROXY_SUBSCRIPTION_MAX_BYTES = 4 * 1024 * 1024;
const MAGIC_PROXY_SUBSCRIPTION_MAX_BYTES_ENV = "DREAMYO_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES";
const EMPTY_BINDINGS: MagicProxyBindings = {
    geminiai: { enabled: false },
    geminiTools: { enabled: false },
    chatgptApi: { enabled: false },
    dola: { enabled: false },
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
        const stored = hasFileContent ? await readStoredSettings() : null;
        let existing: DecodedMagicProxySettings | null;
        if (hasFileContent) {
            try {
                existing = decodeStoredSettings(stored);
            } catch (error) {
                if (!(error instanceof MagicProxyError && error.status === 500)) throw error;
                // Explicit file import is the recovery path when the old key or ciphertext is unreadable.
                existing = null;
            }
        } else {
            existing = await readSettings();
        }
        if (!suppliedSubscriptionUrl && !hasFileContent && existing?.subscriptionUrl !== subscriptionUrl) throw new MagicProxyError("订阅地址已在刷新期间变更，请重新刷新", 409);
        const next: DecodedMagicProxySettings = {
            subscriptionUrl,
            nodes,
            bindings: normalizeBindings(existing?.bindings || stored?.bindings, new Set(nodes.map((node) => node.name))),
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
const GOOGLE_TEST_URL = "https://www.google.com";
// 链式链路（跳板→住宅落地→目标）整体延迟显著高于单节点，测试超时需覆盖完整链路。
const GOOGLE_TEST_TIMEOUT_MS = 12000;
const CHATGPT_TEST_URL = "https://chatgpt.com";
const CHATGPT_TEST_TIMEOUT_MS = 15000;
const DOLA_TEST_URL = "https://www.dola.com";
const DOLA_TEST_TIMEOUT_MS = 15000;

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
    dola: "Dola API (Camoufox 代理)",
};

export async function testMagicProxyNodeDelay(input: unknown): Promise<MagicProxyDelayResult> {
    const name = optionalText(typeof input === "object" && input ? record(input).node : input);
    if (!name) throw new MagicProxyError("请提供要测速的节点名称", 400);
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    return { name, ...(await probeNodeDelay(runtime, name)) };
}

export async function testMagicProxyAllNodes(): Promise<{ results: MagicProxyDelayResult[] }> {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    const overview = await getMagicProxyOverview();
    if (!overview.runtimeAvailable) throw new MagicProxyError("魔法代理运行时当前不可用，无法测速", 503);
    // 组级测速一次返回全部节点（含 DIRECT 对照），逐节点请求对 provider 节点必然 404。
    const delays = await requestGroupDelays(runtime, DELAY_TEST_URL, DELAY_TEST_TIMEOUT_MS);
    const results = overview.nodes.map((node) => ({ name: node.name, ...interpretGroupDelay(delays, node.name) }));
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
        const delays = await requestGroupDelays(runtime, GOOGLE_TEST_URL, GOOGLE_TEST_TIMEOUT_MS);
        const delay = delays.get(specificNode);
        const error = delay !== undefined ? undefined : specificNode === "DIRECT" ? `访问 Google 超时或节点阻断 (>${GOOGLE_TEST_TIMEOUT_MS}ms)` : interpretGroupDelay(delays, specificNode).error;
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

    const providers: MagicProxyProvider[] = ["geminiai", "geminiTools", "chatgptApi", "dola"];
    const items: MagicProxyGoogleTestItem[] = [];

    // 容器出网基线用国内可直连的 gstatic；目标延迟单独按 google 探测（国内直连 google 必然失败，
    // 该结果里没有 DIRECT 属正常，不可作为出网故障依据）。
    const baselineDelays = await requestGroupDelays(runtime, DELAY_TEST_URL, DELAY_TEST_TIMEOUT_MS).catch(() => new Map<string, number>());
    let targetDelays = new Map<string, number>();
    try {
        targetDelays = await requestGroupDelays(runtime, GOOGLE_TEST_URL, GOOGLE_TEST_TIMEOUT_MS);
    } catch {
        targetDelays = new Map();
    }

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

        const delay = targetDelays.get(activeNode);
        const error = delay === undefined ? describeChainFailure(targetDelays, baselineDelays, binding, activeNode, "Google") : undefined;

        items.push({
            service: provider,
            serviceTitle: title,
            group,
            activeNode,
            enabled: true,
            ok: delay !== undefined,
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

/**
 * GPTAPI 链式代理的全链路连通性测试：通过 Mihomo 控制器让 `dreamyo-ChatGPTAPI`
 * 分组的当前生效节点（链式模式下为 跳板→落地 的 dialer-proxy 链）真实访问 ChatGPT
 * 上游主机，复刻 GeminiAIStudio「测试 Google 连通性」的验证方式。
 */
export async function testChatGptChainAccess(): Promise<MagicProxyGoogleTestReport> {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    const overview = await getMagicProxyOverview();
    if (!overview.runtimeAvailable) throw new MagicProxyError("魔法代理运行时当前不可用，无法测试", 503);

    const group = GROUP_NAMES.chatgptApi;
    const binding = overview.bindings.chatgptApi;
    const testedAt = new Date().toISOString();

    let activeNode = "DIRECT";
    try {
        const groupInfoRes = await controllerRequest(runtime, `/proxies/${encodeURIComponent(group)}`, { method: "GET" });
        activeNode = optionalText(record(await groupInfoRes.json()).now) || "DIRECT";
    } catch {
        activeNode = binding?.node || "DIRECT";
    }

    // 出网基线用 gstatic；目标延迟单独探测 chatgpt.com（国内直连必失败，结果里无 DIRECT 属正常）。
    const baselineDelays = await requestGroupDelays(runtime, DELAY_TEST_URL, DELAY_TEST_TIMEOUT_MS, group).catch(() => new Map<string, number>());
    let groupDelays = new Map<string, number>();
    try {
        groupDelays = await requestGroupDelays(runtime, CHATGPT_TEST_URL, CHATGPT_TEST_TIMEOUT_MS, group);
    } catch {
        groupDelays = new Map();
    }
    const delay = groupDelays.get(activeNode);
    const error =
        delay === undefined
            ? activeNode === "DIRECT"
                ? `访问 ChatGPT 超时或链路阻断 (>${CHATGPT_TEST_TIMEOUT_MS}ms)；链式代理未生效，当前分组处于 DIRECT 直连状态`
                : describeChainFailure(groupDelays, baselineDelays, binding, activeNode, "ChatGPT")
            : undefined;

    return {
        targetUrl: CHATGPT_TEST_URL,
        testedAt,
        overallOk: typeof delay === "number",
        items: [
            {
                service: "chatgptApi",
                serviceTitle: SERVICE_TITLES.chatgptApi || "ChatGPTAPI",
                group,
                activeNode,
                enabled: Boolean(binding?.enabled),
                ok: typeof delay === "number",
                delay,
                ...(error ? { error } : {}),
            },
        ],
    };
}

/** Dola's proxy tab must test the Dola origin itself, never reuse a Google probe as success evidence. */
export async function testMagicProxyDolaAccess(): Promise<MagicProxyGoogleTestReport> {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查 Mihomo 运行状态", 503);
    const overview = await getMagicProxyOverview();
    if (!overview.runtimeAvailable) throw new MagicProxyError("魔法代理运行时当前不可用，无法测试", 503);
    const provider: MagicProxyProvider = "dola";
    const group = GROUP_NAMES[provider];
    const binding = overview.bindings[provider];
    const testedAt = new Date().toISOString();
    let activeNode = "DIRECT";
    try {
        const groupInfoRes = await controllerRequest(runtime, `/proxies/${encodeURIComponent(group)}`, { method: "GET" });
        activeNode = optionalText(record(await groupInfoRes.json()).now) || "DIRECT";
    } catch {
        activeNode = binding?.node || "DIRECT";
    }
    const baselineDelays = await requestGroupDelays(runtime, DELAY_TEST_URL, DELAY_TEST_TIMEOUT_MS, group).catch(() => new Map<string, number>());
    const targetDelays = await requestGroupDelays(runtime, DOLA_TEST_URL, DOLA_TEST_TIMEOUT_MS, group).catch(() => new Map<string, number>());
    const delay = targetDelays.get(activeNode);
    const error = delay === undefined
        ? activeNode === "DIRECT"
            ? `访问 Dola 超时或链路阻断 (>${DOLA_TEST_TIMEOUT_MS}ms)；当前分组处于 DIRECT 直连状态`
            : describeChainFailure(targetDelays, baselineDelays, binding, activeNode, "Dola")
        : undefined;
    return {
        targetUrl: DOLA_TEST_URL,
        testedAt,
        overallOk: typeof delay === "number",
        items: [{ service: provider, serviceTitle: SERVICE_TITLES[provider], group, activeNode, enabled: Boolean(binding?.enabled), ok: typeof delay === "number", delay, ...(error ? { error } : {}) }],
    };
}

/**
 * mihomo 的 `/proxies/:name/delay` 只覆盖顶层代理表，file provider 的订阅节点不在其中
 * （一律 404 "Resource not found" 秒回）；组级 `/group/:name/delay` 会对组内全部节点
 * （含订阅节点与 DIRECT）发起真实拨号并返回延迟映射，是节点测速的唯一正确通道。
 * 组级测速要等组内最慢节点完成，控制器请求超时必须大于逐节点 urltest 超时。
 */
async function requestGroupDelays(runtime: MihomoRuntimeConfig, targetUrl: string, timeoutMs: number, group = GROUP_NAMES.geminiai): Promise<Map<string, number>> {
    const response = await controllerRequest(runtime, `/group/${encodeURIComponent(group)}/delay?url=${encodeURIComponent(targetUrl)}&timeout=${timeoutMs}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs + 5000) });
    const payload = record(await response.json());
    const delays = new Map<string, number>();
    for (const [name, value] of Object.entries(payload)) {
        const delay = Number(value);
        if (Number.isFinite(delay) && delay >= 0) delays.set(name, delay);
    }
    return delays;
}

function interpretGroupDelay(delays: Map<string, number>, name: string): { delay?: number; error?: string } {
    const delay = delays.get(name);
    if (delay !== undefined) return { delay };
    if (name === "DIRECT") return { error: "测速超时或节点不可用" };
    const direct = delays.get("DIRECT");
    // 失败节点不在组测速结果里；用同一响应中的 DIRECT 区分「容器出网异常」与「节点拨号失败」。
    if (direct === undefined) {
        return { error: "Mihomo 容器直连出网不可用，与节点无关；请检查服务器出网、Docker 网络或防火墙，并重启 magic-proxy 容器后重试" };
    }
    return { error: `Mihomo 出网正常（DIRECT ${direct}ms），但该节点拨号失败；节点可能已失效或被墙，请刷新订阅或更换节点` };
}

async function probeNodeDelay(runtime: MihomoRuntimeConfig, name: string): Promise<{ delay?: number; error?: string }> {
    const delays = await requestGroupDelays(runtime, DELAY_TEST_URL, DELAY_TEST_TIMEOUT_MS);
    return interpretGroupDelay(delays, name);
}

/**
 * 组级测速失败节点的分步诊断：同一响应里包含 DIRECT 与跳板的真实结果，
 * 可直接定位断点在「容器出网 / 跳板 / 跳板→落地链路」哪一段。
 */
function describeChainFailure(delays: Map<string, number>, baselineDelays: Map<string, number>, binding: MagicProxyBinding | undefined, activeNode: string, target: string): string {
    // 容器出网基线只能用国内可直连的 gstatic 判定：google/chatgpt 目标直连本来就不通，
    // 这些目标的组测速结果里没有 DIRECT 是正常现象，不能当作出网故障的证据。
    const baselineDirect = baselineDelays.get("DIRECT");
    if (baselineDirect === undefined) {
        return `Mihomo 容器直连出网不可用，与节点无关；请检查服务器出网、Docker 网络或防火墙，并重启 magic-proxy 容器后重试`;
    }
    if (activeNode === getChainedExitNodeName(magicProxyProviderByGroup(activeNode))) {
        const hopNode = binding?.chained_config?.hop_node || "";
        const hopDelay = hopNode ? delays.get(hopNode) : undefined;
        if (hopDelay !== undefined) {
            return `跳板 ${hopNode} 正常（${hopDelay}ms），但 跳板→落地→目标 链路访问 ${target} 失败：请检查落地节点凭据/流量/区域是否有效（可直接在通用代理页测该节点），或更换落地出口`;
        }
        const hopBaseline = hopNode ? baselineDelays.get(hopNode) : undefined;
        if (hopNode && hopBaseline !== undefined) {
            return `跳板 ${hopNode} 可用（基线 ${hopBaseline}ms），但该目标经跳板的探测失败：请更换跳板节点并重新保存链式代理`;
        }
        if (hopNode) {
            return `跳板 ${hopNode} 拨号失败：请更换跳板节点并重新保存链式代理`;
        }
        return "链式出口链路失败：请重新保存链式代理配置";
    }
    return `该节点访问 ${target} 失败；节点可能已失效或被墙，请刷新订阅或更换节点`;
}

function magicProxyProviderByGroup(groupName: string): MagicProxyProvider {
    return (Object.keys(GROUP_NAMES) as MagicProxyProvider[]).find((provider) => GROUP_NAMES[provider] === groupName) || "chatgptApi";
}

export async function updateMagicProxyBinding(input: { provider?: unknown; enabled?: unknown; node?: unknown; mode?: unknown; chained_config?: unknown }) {
    const provider = magicProxyProvider(input.provider);
    if (!provider) throw new MagicProxyError("魔法代理服务标识无效", 400);
    if (typeof input.enabled !== "boolean") throw new MagicProxyError("请明确指定是否启用代理", 400);

    const mode = input.mode === "chained" ? "chained" : "magic";

    return withRuntimeLock(async () => {
        const settings = await readSettings();
        if (!settings) throw new MagicProxyError("请先导入魔法代理订阅", 409);
        const nodeNames = new Set(settings.nodes.map((node) => node.name));
        const current = settings.bindings[provider] || { enabled: false };
        const nextNode = Object.prototype.hasOwnProperty.call(input, "node") ? bindingNode(input.node) : current.node;

        if (mode === "magic") {
            if (nextNode && !nodeNames.has(nextNode)) throw new MagicProxyError("所选节点不在当前订阅中", 422);
            if (input.enabled && !nextNode) throw new MagicProxyError("启用魔法代理前请选择当前订阅中的节点", 422);
        }

        let chainedConfig: { hop_node: string; landing_node_id: string } | undefined = undefined;
        if (mode === "chained") {
            const rawConfig = input.chained_config as Record<string, unknown> | null | undefined;
            let hop = typeof rawConfig?.hop_node === "string" ? rawConfig.hop_node.trim() : "";
            const landing = typeof rawConfig?.landing_node_id === "string" ? rawConfig.landing_node_id.trim() : "";
            if (hop && settings.nodes.length) {
                const resolved = resolveHopNodeName(hop, settings.nodes);
                if (resolved) hop = resolved;
            }
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
        if (input.enabled) runtimeProxyUrl(runtime, provider);
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
            if (provider === "chatgptApi") {
                const { syncChatGptApiRuntimeProxy } = await import("./chatgpt-api-service");
                const proxyUrl = next.bindings.chatgptApi?.enabled ? runtimeProxyUrl(runtime, "chatgptApi") : undefined;
                await syncChatGptApiRuntimeProxy(proxyUrl, next.bindings.chatgptApi?.mode).catch(() => undefined);
            }
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
        const binding = settings.bindings[provider] || { enabled: false };
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
            const chainedNodeName = getChainedExitNodeName(provider);
            const providerNodes = await readMihomoProviderNodes(runtime);
            const exitAlive = providerNodes?.some((node) => node.name === chainedNodeName) ?? false;
            const chainedConfig = binding?.chained_config;
            if (!exitAlive && chainedConfig?.hop_node && chainedConfig?.landing_node_id) {
                // 订阅刷新等场景会重写 Provider 文件并丢失链式出口，这里按已保存配置原地重建。
                const landingProxyUrl = await resolveChainedLandingUrl(chainedConfig.landing_node_id);
                if (landingProxyUrl) {
                    await syncMihomoChainedProxyInternal({ hopNode: chainedConfig.hop_node, landingProxyUrl, provider });
                } else {
                    await selectMihomoProxy(runtime, GROUP_NAMES[provider], chainedNodeName).catch(() => undefined);
                }
            } else {
                // 出口健在时仍需保证跳板组选中（dialer-proxy 依赖该组提供跳板出口）。
                if (chainedConfig?.hop_node) {
                    await selectMihomoProxy(runtime, getChainedHopGroupName(provider), chainedConfig.hop_node).catch(() => undefined);
                }
                await selectMihomoProxy(runtime, GROUP_NAMES[provider], chainedNodeName).catch(() => undefined);
            }
            if (provider === "geminiai") {
                const { syncGeminiAiRuntimeProxy } = await import("./geminiai-provider");
                await syncGeminiAiRuntimeProxy(runtimeProxyUrl(runtime, "geminiai"));
            } else if (provider === "chatgptApi") {
                const { syncChatGptApiRuntimeProxy } = await import("./chatgpt-api-service");
                await syncChatGptApiRuntimeProxy(runtimeProxyUrl(runtime, "chatgptApi"), "chained").catch(() => undefined);
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
        } else if (isMagic && provider === "chatgptApi") {
            const { syncChatGptApiRuntimeProxy } = await import("./chatgpt-api-service");
            await syncChatGptApiRuntimeProxy(runtimeProxyUrl(runtime, "chatgptApi"), "magic").catch(() => undefined);
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
        const resolved = await chatGptRuntimeJson<{ proxy_url?: string; node_name?: string; node_id?: string }>("/api/proxy/resolve-url", { method: "POST", body: JSON.stringify({ group_id: binding.target.slice("group:".length) }) });
        const nodeName = resolved.node_name || resolved.node_id || binding.target.slice("group:".length);
        return resolved.proxy_url ? { enabled: true, proxyUrl: resolved.proxy_url, egress: { mode: "generic", address: proxyAddressFromUrl(resolved.proxy_url), node_name: nodeName } } : { enabled: false };
    }
    if (binding.target.startsWith("node:")) {
        const resolved = await chatGptRuntimeJson<{ proxy_url?: string; node_name?: string; node_id?: string }>("/api/proxy/resolve-url", { method: "POST", body: JSON.stringify({ node_id: binding.target.slice("node:".length) }) });
        if (!resolved.proxy_url) return { enabled: false };
        if (provider === "geminiai") {
            const { syncGeminiAiRuntimeProxy } = await import("./geminiai-provider");
            await syncGeminiAiRuntimeProxy(resolved.proxy_url);
        }
        const nodeName = resolved.node_name || resolved.node_id || binding.target.slice("node:".length);
        return { enabled: true, proxyUrl: resolved.proxy_url, egress: { mode: "generic", address: proxyAddressFromUrl(resolved.proxy_url), node_name: nodeName } };
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
    const userAgents = ["clash.meta", "ClashforWindows/0.20.39", "ClashMeta/1.18.0 Mihomo/1.18.0"];
    let lastError: Error | null = null;
    let response: Response | null = null;

    for (const ua of userAgents) {
        try {
            const res = await fetchSafeOutbound(
                subscriptionUrl,
                {
                    cache: "no-store",
                    redirect: "follow",
                    headers: {
                        accept: "application/yaml, text/yaml, text/plain, */*",
                        "user-agent": ua,
                    },
                    signal: AbortSignal.timeout(15000),
                },
                { allowProxyFakeIpSpace: true },
            );
            if (res.ok) {
                response = res;
                break;
            }
            await res.body?.cancel().catch(() => undefined);
            if (res.status === 401 || res.status === 403) {
                throw new MagicProxyError(`订阅服务器拒绝访问（HTTP ${res.status}），请使用服务器可直接访问的 Clash YAML 直链，不能使用需要浏览器验证的网页链接`, 502);
            }
            response = res;
            break;
        } catch (error) {
            if (error instanceof MagicProxyError) throw error;
            if (error instanceof UnsafeOutboundUrlError) throw new MagicProxyError("订阅地址不允许访问，请使用可公开访问的 HTTPS Clash YAML 地址", 422);
            if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.message.includes("timeout") || error.message.includes("aborted"))) {
                throw new MagicProxyError("获取订阅内容超时（15秒），请检查订阅链接是否畅通，或直接使用「文件导入」粘贴订阅内容", 504);
            }
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }

    if (!response || !response.ok) {
        if (lastError instanceof MagicProxyError) throw lastError;
        const status = response?.status;
        if (status === 401 || status === 403) {
            throw new MagicProxyError(`订阅服务器拒绝访问（HTTP ${status}），请在右侧使用「YAML / 文本文件导入」粘贴内容`, 502);
        }
        throw new MagicProxyError(`订阅获取失败${status ? `（HTTP ${status}）` : ""}，请确认地址和访问权限，或使用「文件导入」粘贴订阅内容`, 502);
    }
    const raw = await readBoundedSubscriptionText(response, magicProxySubscriptionMaxBytes());
    return parseSubscriptionNodes(raw);
}

async function readBoundedSubscriptionText(response: Response, maxBytes: number) {
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0]?.trim().toLowerCase() || "";
    if (contentType && !["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"].includes(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new MagicProxyError(`订阅地址返回的是 ${contentType}（通常是网页验证、公告或拦截页，不是 Clash 配置）；请在本地浏览器打开订阅链接，把 YAML 内容保存后用「YAML / 文本文件导入」上传`, 422);
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

export function cleanNodeName(name: string): string {
    return (
        name
            // 清理 emoji / 国旗等代理名称常见装饰符号
            .replace(/[\uD83C-\uDBFF\uDC00-\uDFFF]+/g, "")
            .replace(/[\u2600-\u27BF\uFE00-\uFE0F\u200D]/g, "")
            .replace(/[\[\]【】()（）|·_\-]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

export function resolveHopNodeName(rawHop: string, availableNodes: Array<{ name: string }>): string | null {
    const hop = rawHop?.trim();
    if (!hop || !availableNodes || availableNodes.length === 0) return null;

    // 1. 完全精确匹配
    const exact = availableNodes.find((n) => n.name === hop);
    if (exact) return exact.name;

    // 2. 剥离 emoji、国旗、方括号符号后的标准匹配 (如 "🇭🇰 香港 01" 对比 "香港 01")
    const cleanedHop = cleanNodeName(hop).toLowerCase();
    if (cleanedHop) {
        const cleanedMatch = availableNodes.find((n) => cleanNodeName(n.name).toLowerCase() === cleanedHop);
        if (cleanedMatch) return cleanedMatch.name;

        // 3. 子串包含匹配 (如 "香港 01" 对比 "香港 01 专线" 或 vice versa)
        const inclusionMatch = availableNodes.find((n) => {
            const cleanedCandidate = cleanNodeName(n.name).toLowerCase();
            return (cleanedCandidate && cleanedCandidate.includes(cleanedHop)) || (cleanedHop && cleanedHop.includes(cleanedCandidate));
        });
        if (inclusionMatch) return inclusionMatch.name;
    }

    return null;
}

function normalizeBindings(value: MagicProxyBindings | undefined, names: Set<string>, allNodes?: MagicProxyNode[]): MagicProxyBindings {
    return {
        geminiai: normalizedBinding(value?.geminiai, names, allNodes),
        geminiTools: normalizedBinding(value?.geminiTools, names, allNodes),
        chatgptApi: normalizedBinding(value?.chatgptApi, names, allNodes),
        dola: normalizedBinding(value?.dola, names, allNodes),
    };
}

function normalizedBinding(value: MagicProxyBinding | undefined, names: Set<string>, allNodes?: MagicProxyNode[]): MagicProxyBinding {
    const node = optionalText(value?.node);
    const isChained = value?.mode === "chained";
    if (isChained) {
        const chained = value?.chained_config;
        let hop = optionalText(chained?.hop_node);
        const landing = optionalText(chained?.landing_node_id);
        if (hop && allNodes?.length) {
            const resolved = resolveHopNodeName(hop, allNodes);
            if (resolved) hop = resolved;
        }
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
    // 订阅刷新会整体重写 Provider 文件；已启用的链式出口必须原地重建，否则分组回落 DIRECT 造成静默直连。
    const { baseNodes, chainedNodes, hopSelections } = await rebuildChainedExits(settings, runtime);

    const mergedNodes = [...baseNodes, ...chainedNodes];
    await writeProviderNodes(runtime, mergedNodes);
    const runtimeNodes = await requestMihomoProxyList(runtime, PROVIDER_ENDPOINT);
    const runtimeNodeNames = new Set(runtimeNodes.map((node) => node.name));
    const expectedNodeNames = new Set(mergedNodes.map((node) => node.name));
    if (expectedNodeNames.size !== runtimeNodeNames.size || [...expectedNodeNames].some((name) => !runtimeNodeNames.has(name))) {
        throw new MagicProxyError("Mihomo Provider 节点与当前订阅不一致，请检查共享订阅文件和 Provider 配置", 502);
    }
    // 出口重建后同步恢复跳板组选中（dialer-proxy 依赖该组提供跳板出口）。
    for (const [provider, hopNode] of hopSelections) {
        await selectMihomoProxy(runtime, getChainedHopGroupName(provider), hopNode).catch(() => undefined);
    }
    await alignMihomoGroupSelections(runtime, settings, chainedNodes);
}

/**
 * 出口未被重建（如链式落地解析失败）时，分组必须回退到绑定魔法节点或 DIRECT，
 * 不能停留在已从文件移除的链式出口名上——stale 选择会让测试与业务请求全部落空。
 * override 用于强制指定某个 Provider 的分组目标（保存链式时磁盘绑定尚未更新，以本次调用意图为准）。
 */
async function alignMihomoGroupSelections(runtime: MihomoRuntimeConfig, settings: MihomoProviderState, chainedNodes: MagicProxyNode[], override?: { provider: MagicProxyProvider; target: string }) {
    for (const provider of Object.keys(GROUP_NAMES) as MagicProxyProvider[]) {
        if (override && provider === override.provider) {
            await selectMihomoProxy(runtime, GROUP_NAMES[provider], override.target);
            continue;
        }
        const binding = settings.bindings[provider] || { enabled: false };
        if ((provider === "chatgptApi" || provider === "dola") && !runtime.proxyUrls[provider]) {
            if (binding.enabled) runtimeProxyUrl(runtime, provider);
            continue;
        }
        const exitName = getChainedExitNodeName(provider);
        const hasExit = chainedNodes.some((node) => node.name === exitName);
        if (binding.enabled && binding.mode === "chained") {
            await selectMihomoProxy(runtime, GROUP_NAMES[provider], hasExit ? exitName : binding.node || "DIRECT");
        } else {
            await selectMihomoProxy(runtime, GROUP_NAMES[provider], binding.enabled && binding.node ? binding.node : "DIRECT");
        }
    }
}

async function ensureMihomoGroupSelection(settings: DecodedMagicProxySettings, runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const binding = settings.bindings[provider] || { enabled: false };
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
    return provider === "chatgptApi" ? "dreamyo-Chained-Exit" : `dreamyo-Chained-Exit-${provider}`;
}

export const CHAINED_EXIT_NODE_NAME = "dreamyo-Chained-Exit";

const CHAINED_HOP_GROUP_NAMES: Record<MagicProxyProvider, string> = {
    geminiai: "dreamyo-Chained-Hop-GeminiAIStudio",
    geminiTools: "dreamyo-Chained-Hop-GeminiTools",
    chatgptApi: "dreamyo-Chained-Hop-ChatGPTAPI",
    dola: "dreamyo-Chained-Hop-DolaAPI",
};

function getChainedHopGroupName(provider: MagicProxyProvider) {
    return CHAINED_HOP_GROUP_NAMES[provider];
}

/**
 * 依据已保存的链式绑定重建全部 Provider 的链式出口节点。
 * override 用于把某个 Provider 的出口替换为本次调用显式提供的节点（传 null 表示本次移除）。
 * 每次重写 Provider 文件都必须整体重建，否则会把其他 Provider 的链式出口静默清掉。
 * 返回 hopSelections：各 Provider 出口实际使用的跳板节点名（用于把跳板组选中到该节点）。
 */
async function rebuildChainedExits(settings: MihomoProviderState, runtime: MihomoRuntimeConfig, override?: { provider: MagicProxyProvider; node: MagicProxyNode | null }) {
    const providers = Object.keys(GROUP_NAMES) as MagicProxyProvider[];
    const exitNames = new Set(providers.map((provider) => getChainedExitNodeName(provider)));
    const baseNodes = settings.nodes.filter((node) => !exitNames.has(node.name));

    const chainedNodes: MagicProxyNode[] = [];
    const hopSelections = new Map<MagicProxyProvider, string>();
    for (const provider of providers) {
        if (override && provider === override.provider) {
            if (override.node) chainedNodes.push(override.node);
            continue;
        }
        const binding = settings.bindings[provider] || { enabled: false };
        if (!binding.enabled || binding.mode !== "chained" || !binding.chained_config?.hop_node || !binding.chained_config?.landing_node_id) continue;
        const landingProxyUrl = await resolveChainedLandingUrl(binding.chained_config.landing_node_id);
        const built = landingProxyUrl ? buildChainedExitNode(provider, binding.chained_config.hop_node, landingProxyUrl, baseNodes) : null;
        if (built) {
            chainedNodes.push(built.node);
            hopSelections.set(provider, built.hopNode);
        }
    }
    return { baseNodes, chainedNodes, hopSelections };
}

async function writeProviderNodes(runtime: MihomoRuntimeConfig, nodes: MagicProxyNode[]) {
    await writeMihomoProviderFile(runtime.providerFile, nodes);
    const response = await controllerRequest(runtime, PROVIDER_ENDPOINT, {
        method: "PUT",
    });
    await response.body?.cancel().catch(() => undefined);
}

async function resolveChainedLandingUrl(nodeId: string) {
    if (!nodeId) return "";
    try {
        const { resolveGenericProxyNodeUrl } = await import("./chatgpt-api-service");
        return (await resolveGenericProxyNodeUrl(nodeId)) || "";
    } catch {
        return "";
    }
}

function buildChainedExitNode(provider: MagicProxyProvider, rawHop: string, landingProxyUrl: string, baseNodes: MagicProxyNode[]): { node: MagicProxyNode; hopNode: string } | null {
    const hopNode = resolveHopNodeName(rawHop, baseNodes) || (baseNodes.length > 0 ? baseNodes[0].name : "");
    const landingUrl = landingProxyUrl?.trim();
    if (!hopNode || !landingUrl) return null;

    let parsed: URL;
    try {
        parsed = new URL(landingUrl.includes("://") ? landingUrl : `http://${landingUrl}`);
    } catch {
        return null;
    }

    const isSocks = parsed.protocol.startsWith("socks");
    const isHttps = parsed.protocol === "https:";
    const port = Number(parsed.port) || (isSocks ? 1080 : isHttps ? 443 : 80);

    return {
        hopNode,
        node: {
            name: getChainedExitNodeName(provider),
            type: isSocks ? "socks5" : "http",
            server: parsed.hostname,
            port,
            ...(isHttps ? { tls: true } : {}),
            ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
            ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
            // dialer-proxy 只能解析全局命名空间：必须指向预置跳板组，引用 provider 节点名会在拨号时报 not found。
            "dialer-proxy": getChainedHopGroupName(provider),
        },
    };
}

async function syncMihomoChainedProxyInternal(input: { hopNode?: string; landingProxyUrl?: string; provider?: MagicProxyProvider }) {
    const settings = await readSettings();
    if (!settings) return;
    const runtime = requireRuntimeConfig();
    const provider = input.provider || "chatgptApi";
    const chainedNodeName = getChainedExitNodeName(provider);

    const built = buildChainedExitNode(
        provider,
        input.hopNode?.trim() || "",
        input.landingProxyUrl?.trim() || "",
        settings.nodes.filter((node) => node.name !== chainedNodeName),
    );
    const { baseNodes, chainedNodes, hopSelections } = await rebuildChainedExits(settings, runtime, {
        provider,
        node: built?.node ?? null,
    });
    if (built) hopSelections.set(provider, built.hopNode);
    const hasOwnExit = chainedNodes.some((node) => node.name === chainedNodeName);

    const mergedNodes = [...baseNodes, ...chainedNodes];
    try {
        await writeProviderNodes(runtime, mergedNodes);
    } catch (error) {
        // 移除自身出口的清理路径保持旧的容错语义；显式启用链式时才要求写入成功。
        if (hasOwnExit) throw error;
    }

    // 跳板组必须选中本次跳板节点：出口的 dialer-proxy 指向该组，未选中时链路无出口。
    for (const [hopProvider, hopNode] of hopSelections) {
        await selectMihomoProxy(runtime, getChainedHopGroupName(hopProvider), hopNode).catch(() => undefined);
    }

    // 重写文件后统一对齐全部分组选择：出口缺失的 Provider 回退到魔法节点，
    // 避免分组停留在已被移除的链式出口名上（stale 选择会让链路静默失效）。
    try {
        await alignMihomoGroupSelections(runtime, settings, chainedNodes, hasOwnExit ? { provider, target: chainedNodeName } : undefined);
    } catch (error) {
        if (hasOwnExit) throw error;
    }
}

export async function syncMihomoChainedProxy(input: { hopNode?: string; landingProxyUrl?: string; provider?: MagicProxyProvider }) {
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
            signal: init.signal || AbortSignal.timeout(10000),
            headers: { authorization: `Bearer ${runtime.secret}`, ...init.headers },
            cache: "no-store",
            redirect: "error",
        });
    } catch {
        throw new MagicProxyError("魔法代理控制器不可用，请检查 Mihomo 运行状态", 503);
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
            throw new MagicProxyError(`魔法代理控制器鉴权失败（HTTP ${response.status}），请检查应用与 Mihomo 进程的 DREAMYO_MAGIC_PROXY_SECRET 是否一致`, 502);
        }
        throw new MagicProxyError(`魔法代理控制器拒绝了配置请求（HTTP ${response.status}）`, 502);
    }
    return response;
}

function controllerEndpoint(base: URL, path: string) {
    return new URL(path, `${base.protocol}//${base.host}`).toString();
}

function readRuntimeConfig(): MihomoRuntimeConfig | null {
    const controllerValue = process.env.DREAMYO_MAGIC_PROXY_CONTROLLER_URL?.trim() || "";
    const secret = process.env.DREAMYO_MAGIC_PROXY_SECRET?.trim() || "";
    const providerFile = process.env.DREAMYO_MAGIC_PROXY_PROVIDER_FILE?.trim() || "";
    const listenHost = process.env.DREAMYO_MAGIC_PROXY_LISTEN_HOST?.trim() || "";
    const geminiaiPort = port(process.env.DREAMYO_MAGIC_PROXY_GEMINIAI_PORT);
    const geminiToolsPort = port(process.env.DREAMYO_MAGIC_PROXY_GEMINI_TOOLS_PORT);
    const chatgptApiPort = port(process.env.DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT);
    const dolaPort = port(process.env.DREAMYO_MAGIC_PROXY_DOLA_PORT);
    const geminiaiUrl = proxyUrl(process.env.DREAMYO_MAGIC_PROXY_GEMINIAI_URL, geminiaiPort);
    const geminiToolsUrl = proxyUrl(process.env.DREAMYO_MAGIC_PROXY_GEMINI_TOOLS_URL, geminiToolsPort);
    if (!controllerValue || secret.length < 32 || !isMagicProxyProviderFile(providerFile) || !isMagicProxyListenHost(listenHost) || !geminiaiPort || !geminiToolsPort || geminiaiPort === geminiToolsPort || !geminiaiUrl || !geminiToolsUrl) return null;
    try {
        const controllerUrl = new URL(controllerValue);
        const controllerPort = port(controllerUrl.port);
        if (!["http:", "https:"].includes(controllerUrl.protocol) || !controllerPort || controllerUrl.username || controllerUrl.password || controllerUrl.pathname !== "/" || controllerUrl.search || controllerUrl.hash) return null;
        const chatgptApiUrl = proxyUrl(process.env.DREAMYO_MAGIC_PROXY_CHATGPT_API_URL, chatgptApiPort);
        const dolaUrl = proxyUrl(process.env.DREAMYO_MAGIC_PROXY_DOLA_URL, dolaPort);
        const chatgptApiProxyUrl = chatgptApiPort && chatgptApiPort !== controllerPort && chatgptApiPort !== geminiaiPort && chatgptApiPort !== geminiToolsPort ? chatgptApiUrl : "";
        const dolaProxyUrl = dolaPort && dolaPort !== controllerPort && dolaPort !== geminiaiPort && dolaPort !== geminiToolsPort && dolaPort !== chatgptApiPort ? dolaUrl : "";
        return {
            controllerUrl,
            secret,
            providerFile,
            proxyUrls: {
                geminiai: geminiaiUrl,
                geminiTools: geminiToolsUrl,
                ...(chatgptApiProxyUrl ? { chatgptApi: chatgptApiProxyUrl } : {}),
                ...(dolaProxyUrl ? { dola: dolaProxyUrl } : {}),
            },
        };
    } catch {
        return null;
    }
}

function requireRuntimeConfig() {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查 Mihomo 控制器、订阅文件、监听地址和独立端口", 503);
    return runtime;
}

function runtimeProxyUrl(runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const value = runtime.proxyUrls[provider];
    if (value) return value;
    if (provider === "chatgptApi") {
        throw new MagicProxyError("ChatGPTAPI 魔法代理监听未配置，请同时设置 DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT 和 DREAMYO_MAGIC_PROXY_CHATGPT_API_URL，并使用独立端口", 503);
    }
    if (provider === "dola") {
        throw new MagicProxyError("Dola API 魔法代理监听未配置，请同时设置 DREAMYO_MAGIC_PROXY_DOLA_PORT 和 DREAMYO_MAGIC_PROXY_DOLA_URL，并使用独立端口", 503);
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
    return decodeStoredSettings(await readStoredSettings());
}

async function readStoredSettings(): Promise<MagicProxySettings | null> {
    return isPostgresDatabaseEnabled() ? (await postgresRepository()).get() : readFileSettings();
}

function decodeStoredSettings(stored: MagicProxySettings | null): DecodedMagicProxySettings | null {
    if (!stored?.subscriptionUrlCiphertext || !stored.nodesCiphertext) return null;
    try {
        const storedSubscriptionUrl = decryptSecretValue(stored.subscriptionUrlCiphertext);
        let subscriptionUrl = storedSubscriptionUrl;
        if (storedSubscriptionUrl !== LOCAL_FILE_SUBSCRIPTION_URL) {
            try {
                subscriptionUrl = normalizeSubscriptionUrl(storedSubscriptionUrl);
            } catch {
                // 存量配置可能保存了旧版本允许的 http 订阅地址：读取时原样保留，
                // 严格 https 校验只在重新导入订阅时执行，避免整份配置因此不可读。
            }
        }
        const nodes = normalizeSubscriptionNodes(JSON.parse(decryptSecretValue(stored.nodesCiphertext)));
        return {
            subscriptionUrl,
            nodes,
            bindings: normalizeBindings(stored.bindings, new Set(nodes.map((node) => node.name)), nodes),
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
        dola: storedBinding(bindings.dola),
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
    return value === "geminiai" || value === "geminiTools" || value === "chatgptApi" || value === "dola" ? value : null;
}

function cloneBinding(value: MagicProxyBinding | undefined): MagicProxyBinding {
    value = value || { enabled: false };
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
    return { geminiai: cloneBinding(value.geminiai), geminiTools: cloneBinding(value.geminiTools), chatgptApi: cloneBinding(value.chatgptApi), dola: cloneBinding(value.dola) };
}

const runtimeState = globalThis as typeof globalThis & { __dreamyoMagicProxyRuntimeQueue?: Promise<void> };

async function withRuntimeLock<T>(callback: () => Promise<T>) {
    const previous = runtimeState.__dreamyoMagicProxyRuntimeQueue || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    runtimeState.__dreamyoMagicProxyRuntimeQueue = queued;
    await previous.catch(() => undefined);
    try {
        return await callback();
    } finally {
        release();
        if (runtimeState.__dreamyoMagicProxyRuntimeQueue === queued) delete runtimeState.__dreamyoMagicProxyRuntimeQueue;
    }
}
