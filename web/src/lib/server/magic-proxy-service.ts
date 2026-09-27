import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { connect, isIP } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";

import { parseDocument, stringify } from "yaml";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import {
    MagicProxyRepository,
    type MagicProxyBinding,
    type MagicProxyBindings,
    type MagicProxyNodeDelayRecord,
    type MagicProxyProvider,
    type MagicProxySettings,
    type MagicProxySubscriptionGroup,
    type MagicProxySubscriptionRecord,
} from "@/lib/server/database/magic-proxy-repository";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database/postgres";
import { resolveServerProxyUrl } from "@/lib/server/proxy-dispatcher";
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
// Mihomo 容器内固定的 runtime 目录（entrypoint.sh 约定）；写入 config.yaml 的 provider 路径
// 必须是 Mihomo 视角路径，不能用 App 侧 DREAMYO_MAGIC_PROXY_PROVIDER_FILE 路径，否则容器重启后加载失败。
const MIHOMO_RUNTIME_DIR = "/root/.config/mihomo/runtime";
const EMPTY_BINDINGS: MagicProxyBindings = {
    geminiai: { enabled: false },
    geminiTools: { enabled: false },
    chatgptApi: { enabled: false },
    dola: { enabled: false },
};

type MagicProxyNode = Record<string, unknown> & { name: string; type: string };
type DecodedMagicProxySettings = {
    subscriptionUrl: string;
    nodes: MagicProxyNode[];
    subscriptions: MagicProxySubscriptionRecord[];
    nodeDelays: Record<string, MagicProxyNodeDelayRecord>;
    bindings: MagicProxyBindings;
    updatedAt: string;
};
type MihomoProviderState = Pick<DecodedMagicProxySettings, "nodes" | "bindings"> & {
    subscriptions?: MagicProxySubscriptionRecord[];
};
type MihomoProxy = { name: string; type: string; alive?: boolean; delay?: number; now?: string; all?: string[] };
type MihomoRuntimeConfig = {
    controllerUrl: URL;
    secret: string;
    providerFile: string;
    proxyUrls: Partial<Record<MagicProxyProvider, string>>;
};

export type MagicProxyPublicSubscription = {
    id: string;
    name: string;
    url: string;
    type: "remote" | "file";
    enabled: boolean;
    nodeCount: number;
    groups?: MagicProxySubscriptionGroup[];
    updatedAt: string;
    lastTestedAt?: string;
};

export type MagicProxyPublicBinding = MagicProxyBinding;
export type MagicProxyOverview = {
    configured: boolean;
    runtimeAvailable: boolean;
    lastUpdatedAt?: string;
    nodeCount: number;
    nodes: Array<{ name: string; type: string; alive?: boolean; delay?: number | null; subscriptionId?: string; subscriptionName?: string }>;
    groups: Array<{ name: string; type: string; now: string; all: string[] }>;
    subscriptionGroups?: Array<{ name: string; type: string; subId: string; subName: string; proxies: string[]; now?: string; alive?: boolean; delay?: number | null }>;
    subscriptions?: MagicProxyPublicSubscription[];
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

function maskSubscriptionUrl(rawUrl: string): string {
    if (!rawUrl || rawUrl === LOCAL_FILE_SUBSCRIPTION_URL || rawUrl.startsWith("local://")) {
        return "本地文件导入";
    }
    try {
        const parsed = new URL(rawUrl);
        parsed.username = "";
        parsed.password = "";
        for (const [key] of parsed.searchParams.entries()) {
            if (/token|key|secret|password|auth|sig|signature/i.test(key)) {
                parsed.searchParams.set(key, "******");
            }
        }
        return parsed.toString();
    } catch {
        return "远程订阅";
    }
}

let runtimeRepairKey: string | null = null;

/**
 * 启动/首次访问自愈：旧版本写入的动态 config.yaml 可能携带 Mihomo 无法解析的
 * provider 路径（会导致容器崩溃循环并阻塞部署），这里按当前设置原地重写正确配置。
 * Mihomo 处于重启循环时热重载会失败，但它重启后会读取修好的文件。
 * 同一配置版本只修复一次；设置变更后再次访问会按新版本重写。
 */
export function repairMagicProxyRuntimeConfig(): Promise<void> {
    return withRuntimeLock(async () => {
        try {
            const runtime = readRuntimeConfig();
            const settings = await readSettings();
            if (!runtime || !settings?.subscriptions?.length) return;
            if (runtimeRepairKey === settings.updatedAt) return;
            await writeAllSubscriptionFiles(runtime, settings.subscriptions).catch(() => undefined);
            await writeFailoverProviderFiles(runtime, settings).catch(() => undefined);
            await writeDynamicConfigFile(runtime, settings).catch(() => undefined);
            await reloadMihomoConfig(runtime).catch(() => undefined);
            runtimeRepairKey = settings.updatedAt;
        } catch {
            // 自愈失败不阻塞启动；订阅刷新/保存时会触发完整同步。
        }
    });
}

export async function getMagicProxyOverview(): Promise<MagicProxyOverview> {
    void repairMagicProxyRuntimeConfig();
    const settings = await readSettings();
    const runtime = readRuntimeConfig();
    const [runtimeGroups, runtimeNodes] = runtime ? await Promise.all([readMihomoGroups(runtime), readMihomoProviderNodes(runtime)]) : [null, null];
    const nodesByName = new Map((runtimeNodes || []).map((proxy) => [proxy.name, proxy]));
    const storedDelays = settings?.nodeDelays || {};

    // 聚合节点必须连同订阅来源一起计算：跨订阅重名节点会被重命名，事后按原始名反查会丢失归属。
    const aggregatedNodes = settings ? aggregateActiveNodesWithSource(settings.subscriptions) : [];
    const nodes = aggregatedNodes.map(({ node, subscriptionId, subscriptionName }) => {
        const runtimeNode = nodesByName.get(node.name);
        const storedDelay = storedDelays[node.name];

        let alive: boolean | undefined = undefined;
        let delay: number | null | undefined = undefined;

        // 持久化的测速结果（用户最近一次手动测速）优先于 Mihomo 内存历史：
        // bootstrap 未配置 provider 自动健康检查，内存历史只反映上一次测速，必然滞后。
        if (storedDelay?.alive !== undefined) {
            alive = storedDelay.alive;
        } else if (runtimeNode?.alive !== undefined) {
            alive = runtimeNode.alive;
        }

        if (storedDelay?.delay !== undefined) {
            delay = storedDelay.delay;
        } else if (runtimeNode?.delay !== undefined) {
            delay = runtimeNode.delay;
        }

        return {
            name: node.name,
            type: node.type,
            ...(alive !== undefined ? { alive } : {}),
            ...(delay !== undefined ? { delay } : {}),
            subscriptionId,
            subscriptionName,
        };
    });

    const subscriptions: MagicProxyPublicSubscription[] = (settings?.subscriptions || []).map((sub) => ({
        id: sub.id,
        name: sub.name,
        url: maskSubscriptionUrl(sub.url),
        type: sub.type,
        enabled: sub.enabled,
        nodeCount: sub.nodeCount || sub.nodes.length,
        groups: sub.groups || [],
        updatedAt: sub.updatedAt,
        lastTestedAt: sub.lastTestedAt,
    }));

    const bindings = settings?.bindings || cloneBindings(EMPTY_BINDINGS);
    const policyGroups = settings ? resolveSubscriptionPolicyGroups(settings.subscriptions) : [];
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
        ...(policyGroups.length
            ? {
                subscriptionGroups: policyGroups.map((grp) => {
                    const runtimeGroup = runtimeGroups?.find((item) => item.name === grp.name);
                    return {
                        name: grp.name,
                        type: grp.type,
                        subId: grp.subId,
                        subName: grp.subName,
                        proxies: grp.proxies,
                        ...(runtimeGroup?.now ? { now: runtimeGroup.now } : {}),
                        ...(runtimeGroup?.alive !== undefined ? { alive: runtimeGroup.alive } : {}),
                        ...(runtimeGroup?.delay !== undefined ? { delay: runtimeGroup.delay } : {}),
                    };
                }),
            }
            : {}),
        subscriptions,
        bindings,
    };
}

export async function importMagicProxySubscription(input: {
    url?: unknown;
    content?: unknown;
    name?: unknown;
    subscriptionId?: unknown;
    replace?: unknown;
}) {
    const hasFileContent = typeof input.content === "string";
    const suppliedContent = typeof input.content === "string" ? input.content : "";
    const provided = optionalText(input.url);
    const suppliedSubscriptionUrl = hasFileContent ? "" : provided ? normalizeSubscriptionUrl(provided) : "";
    const requestedSubId = optionalText(input.subscriptionId);
    const customName = optionalText(input.name);
    const shouldReplace = input.replace === true;

    return withRuntimeLock(async () => {
        const stored = hasFileContent ? await readStoredSettings() : null;
        let existing: DecodedMagicProxySettings | null;
        if (stored) {
            try {
                existing = decodeStoredSettings(stored);
            } catch (error) {
                if (!(error instanceof MagicProxyError && error.status === 500)) throw error;
                existing = null;
            }
        } else {
            existing = await readSettings();
        }

        let targetSub: MagicProxySubscriptionRecord | undefined;
        if (requestedSubId && existing?.subscriptions) {
            targetSub = existing.subscriptions.find((s) => s.id === requestedSubId);
            if (!targetSub) throw new MagicProxyError("未找到指定的订阅记录", 404);
        }

        const isRefresh = !suppliedSubscriptionUrl && !hasFileContent;
        let subscriptionUrl = "";

        if (hasFileContent) {
            subscriptionUrl = LOCAL_FILE_SUBSCRIPTION_URL;
            if (!optionalText(suppliedContent)) throw new MagicProxyError("请选择包含 Clash YAML 内容的文件", 400);
        } else if (suppliedSubscriptionUrl) {
            subscriptionUrl = suppliedSubscriptionUrl;
        } else if (isRefresh) {
            if (targetSub) {
                subscriptionUrl = targetSub.url;
            } else if (existing?.subscriptionUrl) {
                subscriptionUrl = existing.subscriptionUrl;
            }

            if (!subscriptionUrl) throw new MagicProxyError("请提供 HTTPS Clash YAML 订阅地址，或先导入一次订阅后再刷新", 400);
            if (subscriptionUrl === LOCAL_FILE_SUBSCRIPTION_URL) {
                throw new MagicProxyError("当前订阅来自本地文件，不支持自动更新，请重新选择 YAML 或文本文件导入", 409);
            }
        }

        const parsed = hasFileContent ? parseSubscriptionPayload(suppliedContent) : await fetchSubscriptionNodes(subscriptionUrl);
        const parsedNodes = parsed.nodes;
        const parsedGroups = parsed.groups;

        if (isRefresh && existing?.subscriptionUrl !== subscriptionUrl && !targetSub) {
            throw new MagicProxyError("订阅地址已在刷新期间变更，请重新刷新", 409);
        }

        let currentSubscriptions = shouldReplace ? [] : [...(existing?.subscriptions || [])];
        const now = new Date().toISOString();

        if (targetSub) {
            currentSubscriptions = currentSubscriptions.map((s) => {
                if (s.id === targetSub.id) {
                    return {
                        ...s,
                        name: customName || s.name,
                        url: subscriptionUrl,
                        nodes: parsedNodes,
                        groups: parsedGroups,
                    ...(parsed.dns ? { dns: parsed.dns } : {}),
                        nodeCount: parsedNodes.length,
                        updatedAt: now,
                    };
                }
                return s;
            });
        } else if (isRefresh && currentSubscriptions.length > 0) {
            const matchIndex = currentSubscriptions.findIndex((s) => s.url === subscriptionUrl);
            if (matchIndex >= 0) {
                currentSubscriptions[matchIndex] = {
                    ...currentSubscriptions[matchIndex],
                    nodes: parsedNodes,
                    groups: parsedGroups,
                    ...(parsed.dns ? { dns: parsed.dns } : {}),
                    nodeCount: parsedNodes.length,
                    updatedAt: now,
                };
            }
        } else {
            const existingUrlIndex = !hasFileContent ? currentSubscriptions.findIndex((s) => s.url === subscriptionUrl) : -1;
            const derivedName = customName || deriveSubscriptionName(subscriptionUrl, hasFileContent ? "本地文件订阅" : `订阅 ${currentSubscriptions.length + 1}`);

            if (existingUrlIndex >= 0) {
                currentSubscriptions[existingUrlIndex] = {
                    ...currentSubscriptions[existingUrlIndex],
                    name: customName || currentSubscriptions[existingUrlIndex].name,
                    nodes: parsedNodes,
                    groups: parsedGroups,
                    ...(parsed.dns ? { dns: parsed.dns } : {}),
                    nodeCount: parsedNodes.length,
                    updatedAt: now,
                };
            } else {
                const newSubId = `sub_${Date.now()}_${randomUUID().slice(0, 4)}`;
                const newSubRecord: MagicProxySubscriptionRecord = {
                    id: newSubId,
                    name: derivedName,
                    url: subscriptionUrl,
                    type: hasFileContent ? "file" : "remote",
                    enabled: true,
                    nodes: parsedNodes,
                    groups: parsedGroups,
                    ...(parsed.dns ? { dns: parsed.dns } : {}),
                    nodeCount: parsedNodes.length,
                    updatedAt: now,
                };
                currentSubscriptions.unshift(newSubRecord);
            }
        }

        const allActiveNodes = aggregateActiveNodes(currentSubscriptions);
        const primarySub = currentSubscriptions.find((s) => s.enabled) || currentSubscriptions[0];

        const next: DecodedMagicProxySettings = {
            subscriptionUrl: primarySub?.url || subscriptionUrl,
            nodes: allActiveNodes,
            subscriptions: currentSubscriptions,
            nodeDelays: existing?.nodeDelays || {},
            bindings: normalizeBindings(existing?.bindings || stored?.bindings, selectableBindingNames(currentSubscriptions)),
            updatedAt: now,
        };

        const runtime = requireRuntimeConfig();
        try {
            await syncMihomoProvider(next, runtime);
            await saveSettings(encodeSettings(next));
        } catch (error) {
            const rollback: MihomoProviderState = existing || { nodes: [], bindings: cloneBindings(EMPTY_BINDINGS), subscriptions: [] };
            await syncMihomoProvider(rollback, runtime).catch(() => undefined);
            throw error;
        }
        return publicImportResult(next);
    });
}

export async function updateMagicProxySubscription(input: { id: string; name?: string; enabled?: boolean }) {
    const id = optionalText(input.id);
    if (!id) throw new MagicProxyError("请提供要修改的订阅 ID", 400);

    return withRuntimeLock(async () => {
        const existing = await readSettings();
        if (!existing) throw new MagicProxyError("魔法代理尚未配置", 404);

        const subIndex = existing.subscriptions.findIndex((s) => s.id === id);
        if (subIndex === -1) throw new MagicProxyError("未找到指定的订阅", 404);

        const target = existing.subscriptions[subIndex];
        const nextSub: MagicProxySubscriptionRecord = {
            ...target,
            ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            updatedAt: new Date().toISOString(),
        };

        const updatedSubscriptions = [...existing.subscriptions];
        updatedSubscriptions[subIndex] = nextSub;

        const allActiveNodes = aggregateActiveNodes(updatedSubscriptions);
        const primarySub = updatedSubscriptions.find((s) => s.enabled) || updatedSubscriptions[0];

        const next: DecodedMagicProxySettings = {
            ...existing,
            subscriptionUrl: primarySub?.url || existing.subscriptionUrl,
            nodes: allActiveNodes,
            subscriptions: updatedSubscriptions,
            bindings: normalizeBindings(existing.bindings, selectableBindingNames(updatedSubscriptions)),
            updatedAt: new Date().toISOString(),
        };

        const runtime = requireRuntimeConfig();
        await syncMihomoProvider(next, runtime);
        await saveSettings(encodeSettings(next));

        return getMagicProxyOverview();
    });
}

export async function deleteMagicProxySubscription(id: string) {
    const subId = optionalText(id);
    if (!subId) throw new MagicProxyError("请提供要删除的订阅 ID", 400);

    return withRuntimeLock(async () => {
        const existing = await readSettings();
        if (!existing) throw new MagicProxyError("魔法代理尚未配置", 404);

        const filtered = existing.subscriptions.filter((s) => s.id !== subId);
        if (filtered.length === existing.subscriptions.length) {
            throw new MagicProxyError("未找到要删除的订阅", 404);
        }

        const allActiveNodes = aggregateActiveNodes(filtered);
        const primarySub = filtered.find((s) => s.enabled) || filtered[0];

        const next: DecodedMagicProxySettings = {
            ...existing,
            subscriptionUrl: primarySub?.url || "",
            nodes: allActiveNodes,
            subscriptions: filtered,
            bindings: normalizeBindings(existing.bindings, selectableBindingNames(filtered)),
            updatedAt: new Date().toISOString(),
        };

        const runtime = requireRuntimeConfig();
        await syncMihomoProvider(next, runtime);
        await saveSettings(encodeSettings(next));

        // 删除磁盘上的对应订阅文件
        try {
            const subFile = join(dirname(runtime.providerFile), "subscriptions", `sub_${subId}.yaml`);
            await unlink(subFile).catch(() => undefined);
        } catch {
            // ignore
        }

        return getMagicProxyOverview();
    });
}

const DELAY_TEST_URL = "https://www.gstatic.com/generate_204";
const DELAY_TEST_TIMEOUT_MS = 4000;
const GOOGLE_TEST_URL = "https://www.google.com";
// 链式链路（跳板→住宅落地→目标）整体延迟显著高于单节点，测试超时需覆盖完整链路。
const GOOGLE_TEST_TIMEOUT_MS = 12000;
const CHATGPT_TEST_URL = "https://chatgpt.com";
const CHATGPT_TEST_TIMEOUT_MS = 15000;
const DOLA_TEST_URL = "https://www.dola.com/chat/";
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

async function persistNodeDelays(results: MagicProxyDelayResult[]) {
    if (!results.length) return;
    const now = new Date().toISOString();
    try {
        await withRuntimeLock(async () => {
            const settings = await readSettings();
            if (!settings) return;
            const currentDelays: Record<string, MagicProxyNodeDelayRecord> = { ...(settings.nodeDelays || {}) };
            for (const res of results) {
                if (!res.name) continue;
                currentDelays[res.name] = {
                    delay: typeof res.delay === "number" ? res.delay : undefined,
                    alive: typeof res.delay === "number" && !res.error,
                    testedAt: now,
                };
            }
            const next: DecodedMagicProxySettings = {
                ...settings,
                nodeDelays: currentDelays,
            };
            await saveSettings(encodeSettings(next));
        });
    } catch {
        // 测速缓存持久化异常不应阻断测速流程
    }
}

export async function testMagicProxyNodeDelay(input: unknown): Promise<MagicProxyDelayResult> {
    const name = optionalText(typeof input === "object" && input ? record(input).node : input);
    if (!name) throw new MagicProxyError("请提供要测速的节点名称", 400);
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    // 失败诊断需要节点自身的 server/port 做分段探测，聚合名与订阅原始名都要能命中。
    const settings = await readSettings();
    const node = settings ? aggregateActiveNodesWithSource(settings.subscriptions).find((item) => item.node.name === name)?.node : undefined;
    const probe = await probeNodeDelay(runtime, name, node);
    // 不确定结果（超时）不落盘：写成 alive:false 会让本来可用的节点从选择列表里消失。
    if (!probe.inconclusive) void persistNodeDelays([{ name, delay: probe.delay, error: probe.error }]);
    return probe.delay !== undefined ? { name, delay: probe.delay } : { name, error: probe.error || "测速失败" };
}

export async function testMagicProxyAllNodes(): Promise<{ results: MagicProxyDelayResult[] }> {
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    const overview = await getMagicProxyOverview();
    if (!overview.runtimeAvailable) throw new MagicProxyError("魔法代理运行时当前不可用，无法测速", 503);
    // 组级测速一次返回全部节点（含 DIRECT 对照），逐节点请求对 provider 节点必然 404。
    const delays = await requestGroupDelays(runtime, DELAY_TEST_URL, DELAY_TEST_TIMEOUT_MS);
    const results = overview.nodes.map((node) => ({ name: node.name, ...interpretGroupDelay(delays, node.name) }));
    void persistNodeDelays(results);
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
        const hopDelays = delay === undefined ? await probeHopGroupDelays(runtime, provider, GOOGLE_TEST_URL, GOOGLE_TEST_TIMEOUT_MS) : new Map<string, number>();
        const error = delay === undefined ? describeChainFailure(targetDelays, baselineDelays, binding, activeNode, "Google", hopDelays) : undefined;

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
    const hopDelays = delay === undefined ? await probeHopGroupDelays(runtime, "chatgptApi", CHATGPT_TEST_URL, CHATGPT_TEST_TIMEOUT_MS) : new Map<string, number>();
    const error =
        delay === undefined
            ? activeNode === "DIRECT"
                ? `访问 ChatGPT 超时或链路阻断 (>${CHATGPT_TEST_TIMEOUT_MS}ms)；链式代理未生效，当前分组处于 DIRECT 直连状态`
                : describeChainFailure(groupDelays, baselineDelays, binding, activeNode, "ChatGPT", hopDelays)
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
    const hopDelays = delay === undefined ? await probeHopGroupDelays(runtime, "dola", DOLA_TEST_URL, DOLA_TEST_TIMEOUT_MS) : new Map<string, number>();
    const error = delay === undefined
        ? activeNode === "DIRECT"
            ? `访问 Dola 超时或链路阻断 (>${DOLA_TEST_TIMEOUT_MS}ms)；当前分组处于 DIRECT 直连状态`
            : describeChainFailure(targetDelays, baselineDelays, binding, activeNode, "Dola", hopDelays)
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
    return { error: `Mihomo 出网正常（DIRECT ${direct}ms），但该节点拨号失败；可能是节点域名解析失败或服务器/端口不可达，请刷新订阅或更换节点` };
}

/** 对单个地址做一次 TCP 可达性探测。 */
function tcpReachable(host: string, port: number) {
    return new Promise<boolean>((resolve) => {
        const socket = connect({ host, port });
        const finish = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(DELAY_TEST_TIMEOUT_MS);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

/**
 * 单节点测速失败时，从应用侧独立复测该节点的 server:port 可达性。
 * Mihomo 的健康检查端点在失败时只返回通用文案、且任何日志级别都不记录原因，
 * 因此「解析失败 / TCP 不通 / mihomo 拨号阶段失败」在界面上无法区分，只能由应用侧分段探测补足。
 */
async function diagnoseNodeEndpoint(node: MagicProxyNode | undefined): Promise<string> {
    const host = optionalText(node?.server);
    const port = Number(node?.port);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return "";
    // 节点域名可能同时有 A/AAAA 记录，任一地址可达即算可达，避免只测 IPv6 造成「不可达」误报。
    const targets = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((item) => item.address);
    if (!targets.length) {
        // 应用侧只用系统 DNS，与 mihomo 的订阅 DoH 可能不同，因此只陈述自身探测结果。
        return `；应用侧无法用系统 DNS 解析节点域名 ${host}，无法独立确认该节点可达性（若订阅要求专用 DoH 解析，属预期）`;
    }
    const probes = await Promise.all(targets.map(async (address) => tcpReachable(address, port)));
    if (!probes.some(Boolean)) {
        return `；但服务器可解析 ${host}（${targets.join("、")}）而 TCP ${port} 均不可达（端口不通或节点已下线）`;
    }
    return `；但服务器到 ${host}:${port} 的 TCP 可达，失败发生在 mihomo 拨号阶段（域名解析、凭据、协议参数或 TLS 不匹配）`;
}

async function probeNodeDelay(runtime: MihomoRuntimeConfig, name: string, node?: MagicProxyNode): Promise<{ delay?: number; error?: string; inconclusive?: boolean }> {
    // 只拨当前节点本身，绝不回退到组级测速：组级端点会带动组内全部节点并发拨号，
    // 批量测速的并发通道会因此互相拖垮容器网络，把正常节点一起判为失败。
    let response: Response;
    try {
        response = await controllerRequest(
            runtime,
            `/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}/${encodeURIComponent(name)}/healthcheck?url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=${DELAY_TEST_TIMEOUT_MS}`,
            { method: "GET", signal: AbortSignal.timeout(DELAY_TEST_TIMEOUT_MS + 5000) },
            true,
        );
    } catch (error) {
        // 控制器本身不可达（超时/拒连）才是端点不可用，此时如实上报，不再触发全组重拨。
        return { error: error instanceof Error ? error.message : "魔法代理控制器不可用" };
    }
    if (response.status === 200) {
        const payload = (await response.json().catch(() => null)) as { delay?: unknown } | null;
        const delay = Number(payload?.delay);
        if (Number.isFinite(delay) && delay > 0) return { delay };
        return { error: "节点测速未返回有效延迟，请重试" };
    }
    await response.text().catch(() => undefined);
    if (response.status === 404) {
        // 节点不在运行时 provider 中属于系统侧问题（未写入或名称不一致），必须与「节点连不上」区分开。
        return { error: "该节点未出现在 Mihomo 运行时的 provider 中；请刷新订阅后重试，若仍失败说明节点未写入运行时配置" };
    }
    const diagnosis = await diagnoseNodeEndpoint(node);
    if (response.status === 503) return { error: `节点拨号失败${diagnosis}` };
    // 504 是内核「本次没在时限内测出」，不是节点结论：并发通道密集时正常节点也会偶发超时。
    if (response.status === 504) return { error: `节点测速超时未出结果（并发压力下常见，可稍后重测）${diagnosis}`, inconclusive: true };
    return { error: `节点健康检查返回 HTTP ${response.status}${diagnosis}` };
}

/**
 * 组级测速失败节点的分步诊断：同一响应里包含 DIRECT 与跳板的真实结果，
 * 可直接定位断点在「容器出网 / 跳板 / 跳板→落地链路」哪一段。
 */
/**
 * 单独探测链式跳板组，拿到跳板节点的真实延迟。
 * 服务组的测速结果只包含链式出口节点，跳板节点不在其中，直接用服务组结果判断跳板必然查不到。
 */
async function probeHopGroupDelays(runtime: MihomoRuntimeConfig, provider: MagicProxyProvider, targetUrl: string, timeoutMs: number) {
    return requestGroupDelays(runtime, targetUrl, timeoutMs, getChainedHopGroupName(provider)).catch(() => new Map<string, number>());
}

function describeChainFailure(
    delays: Map<string, number>,
    baselineDelays: Map<string, number>,
    binding: MagicProxyBinding | undefined,
    activeNode: string,
    target: string,
    hopDelays: Map<string, number> = new Map(),
): string {
    // 容器出网基线只能用国内可直连的 gstatic 判定：google/chatgpt 目标直连本来就不通，
    // 这些目标的组测速结果里没有 DIRECT 是正常现象，不能当作出网故障的证据。
    const baselineDirect = baselineDelays.get("DIRECT");
    if (baselineDirect === undefined) {
        return `Mihomo 容器直连出网不可用，与节点无关；请检查服务器出网、Docker 网络或防火墙，并重启 magic-proxy 容器后重试`;
    }
    // 链式出口名带 provider 后缀（如 dreamyo-Chained-Exit-geminiai），必须按全部出口名精确匹配；
    // 不能用组名反查（会兜底成 chatgptApi 得到无后缀名，把链式失败误报成「节点被墙」）。
    const chainedProvider = (Object.keys(GROUP_NAMES) as MagicProxyProvider[]).find((provider) => activeNode === getChainedExitNodeName(provider));
    if (chainedProvider) {
        const hopNode = binding?.chained_config?.hop_node || "";
        // 跳板节点不属于服务组（服务组只含链式出口节点），必须用跳板组自己的探测结果判断，
        // 否则在服务组结果里永远查不到该节点，会把可用的跳板误报成「拨号失败」。
        const hopDelay = hopNode ? hopDelays.get(hopNode) ?? delays.get(hopNode) : undefined;
        if (hopDelay !== undefined) {
            return `跳板 ${hopNode} 正常（${hopDelay}ms），但 跳板→落地→目标 链路访问 ${target} 失败：请检查落地节点凭据/流量/区域是否有效（可直接在通用代理页测该节点），或更换落地出口`;
        }
        const hopBaseline = hopNode ? hopDelays.get(hopNode) ?? baselineDelays.get(hopNode) : undefined;
        if (hopNode && hopBaseline !== undefined) {
            return `跳板 ${hopNode} 可用（基线 ${hopBaseline}ms），但该目标经跳板的探测失败：请更换跳板节点并重新保存链式代理`;
        }
        if (hopNode) {
            return `跳板 ${hopNode} 拨号失败：请更换跳板节点并重新保存链式代理`;
        }
        return "链式出口链路失败：请重新保存链式代理配置";
    }
    return `该节点访问 ${target} 失败；可能是节点域名解析失败或服务器/端口不可达，请刷新订阅或更换节点`;
}

export async function updateMagicProxyBinding(input: { provider?: unknown; enabled?: unknown; node?: unknown; fallback_node?: unknown; mode?: unknown; chained_config?: unknown }) {
    const provider = magicProxyProvider(input.provider);
    if (!provider) throw new MagicProxyError("魔法代理服务标识无效", 400);
    if (typeof input.enabled !== "boolean") throw new MagicProxyError("请明确指定是否启用代理", 400);

    const mode = input.mode === "chained" ? "chained" : "magic";

    return withRuntimeLock(async () => {
        const settings = await readSettings();
        if (!settings) throw new MagicProxyError("请先导入魔法代理订阅", 409);
        const nodeNames = new Set(settings.nodes.map((node) => node.name));
        // 订阅策略组（如「自动选择」url-test）与节点一样可以作为服务出口。
        const selectableNames = new Set([...nodeNames, ...policyGroupNameSet(settings.subscriptions)]);
        const current = settings.bindings[provider] || { enabled: false };
        const nextNode = Object.prototype.hasOwnProperty.call(input, "node") ? bindingNode(input.node) : current.node;
        const nextFallback = Object.prototype.hasOwnProperty.call(input, "fallback_node") ? bindingNode(input.fallback_node) : current.fallback_node;

        if (mode === "magic") {
            if (nextNode && !selectableNames.has(nextNode)) throw new MagicProxyError("所选节点不在当前订阅中", 422);
            if (input.enabled && !nextNode) throw new MagicProxyError("启用魔法代理前请选择当前订阅中的节点", 422);
            // 兜底节点只能是真实节点：内核 fallback 组的健康检查按节点拨号，组实体不可作为兜底成员。
            if (nextFallback && !nodeNames.has(nextFallback)) throw new MagicProxyError("兜底节点不在当前订阅中", 422);
            // 主节点为自动选优策略组时无需（也不支持）兜底：策略组自身已按健康状态切换
            if (nextNode && nextFallback && selectableNames.has(nextNode) && !nodeNames.has(nextNode)) {
                throw new MagicProxyError("主节点为自动选优策略组时无需兜底节点，请清除兜底或改选真实节点作为主节点", 422);
            }
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
            let hopFallback = typeof rawConfig?.hop_fallback_node === "string" ? rawConfig.hop_fallback_node.trim() : "";
            if (hopFallback && settings.nodes.length) {
                const resolved = resolveHopNodeName(hopFallback, settings.nodes);
                if (resolved) hopFallback = resolved;
            }
            if (hopFallback && !nodeNames.has(hopFallback)) throw new MagicProxyError("跳板兜底节点不在当前订阅中", 422);
            if (hopFallback && hopFallback === hop) throw new MagicProxyError("跳板兜底节点不能与跳板节点相同", 422);
            chainedConfig = { hop_node: hop, landing_node_id: landing, ...(hopFallback ? { hop_fallback_node: hopFallback } : {}) };
        }

        const next: DecodedMagicProxySettings = {
            ...settings,
            bindings: {
                ...settings.bindings,
                [provider]: {
                    enabled: input.enabled,
                    ...(mode === "chained" ? { mode: "chained" as const } : {}),
                    ...(nextNode ? { node: nextNode } : {}),
                    ...(mode === "magic" && nextFallback && nextFallback !== nextNode ? { fallback_node: nextFallback } : {}),
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
                // 跳板兜底要新增 provider 与内核 fallback 组，必须用本次保存的设置整份重写动态配置。
                // 上面的链式同步读的是保存前的设置，拿不到本次的兜底字段。
                if (hopFailoverTarget(next.bindings[provider])) {
                    await syncMihomoProvider(next, runtime).catch(() => undefined);
                }
            } else {
                if (current.mode === "chained") {
                    await syncMihomoChainedProxyInternal({ provider });
                }
                // 兜底配置变化时先刷新 failover provider 文件并通知内核重读；
                // 首次创建时内核里还没有该 provider，PUT 404 由下方全量同步路径兜住。
                if (magicFailoverTarget(next.bindings[provider]) || magicFailoverTarget(current) || hopFailoverTarget(next.bindings[provider]) || hopFailoverTarget(current)) {
                    await writeFailoverProviderFiles(runtime, next).catch(() => undefined);
                    await reloadFailoverProvider(runtime, provider).catch(() => undefined);
                    await reloadHopFailoverProvider(runtime, provider).catch(() => undefined);
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
    // 锁空闲时做完整自愈（补齐组选中、重建链式出口、同步 sidecar 代理），
    // 锁被别的魔法代理操作占用时退化为纯读解析，绝不让生成请求排在慢操作后面。
    const repaired = await tryWithRuntimeLock(() => resolveProviderEgress(provider));
    if (repaired) return repaired;
    return readProviderEgress(provider);
}

/** 纯读解析出口：不改动内核与 sidecar 状态，只按已保存的绑定计算本次请求该走哪个出口。 */
async function readProviderEgress(provider: MagicProxyProvider): Promise<{ enabled: boolean; proxyUrl?: string; egress?: MagicProxyEgressInfo }> {
    const settings = await readSettings();
    if (!settings) {
        const generic = await ensureGenericProxyEgress(provider);
        return generic.enabled ? generic : { enabled: false };
    }
    const binding = settings.bindings[provider] || { enabled: false };
    if (binding.enabled !== true) {
        const generic = await ensureGenericProxyEgress(provider);
        return generic.enabled ? generic : { enabled: false };
    }
    const runtime = readRuntimeConfig();
    if (!runtime) throw new MagicProxyError("魔法代理运行环境未配置，请检查服务器上的 Mihomo 配置", 503);
    const proxyUrl = runtimeProxyUrl(runtime, provider);
    if (binding.mode === "chained") {
        const hop = binding.chained_config?.hop_node || "未选跳板";
        const landing = binding.chained_config?.landing_node_id || "未选落地";
        return { enabled: true, proxyUrl, egress: { mode: "chained", node_name: `链式代理(${hop} ➔ ${landing})` } };
    }
    if (!binding.node) throw new MagicProxyError("魔法代理绑定缺少节点，请在服务设置中重新选择", 409);
    return { enabled: true, proxyUrl, egress: { mode: "magic", node_name: binding.node } };
}

async function resolveProviderEgress(provider: MagicProxyProvider): Promise<{ enabled: boolean; proxyUrl?: string; egress?: MagicProxyEgressInfo }> {
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

    // 候选 URL 列表：若自动附加了 flag=clash，也准备好原始 URL 以备回退
    const candidateUrls = [subscriptionUrl];
    try {
        const parsed = new URL(subscriptionUrl);
        if (parsed.searchParams.get("flag") === "clash") {
            const withoutFlag = new URL(subscriptionUrl);
            withoutFlag.searchParams.delete("flag");
            candidateUrls.push(withoutFlag.toString());
        }
    } catch {
        // ignore
    }

    // 代理回退候选：若直接请求遇到网络重置或阻断，可尝试通过运行时的代理或系统代理出站
    const fallbackProxy = resolveSubscriptionProxyFallback();

    outerLoop: for (const targetUrl of candidateUrls) {
        for (const ua of userAgents) {
            try {
                const res = await fetchSafeOutbound(
                    targetUrl,
                    {
                        cache: "no-store",
                        redirect: "follow",
                        headers: {
                            accept: "application/yaml, text/yaml, text/plain, application/octet-stream, */*",
                            "user-agent": ua,
                        },
                        signal: AbortSignal.timeout(15000),
                    },
                    { allowProxyFakeIpSpace: true },
                );
                if (res.ok) {
                    response = res;
                    break outerLoop;
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

                // 若由于网络重置、连接中断或超时导致失败，且存在可用的回退代理，尝试一次代理重试
                if (fallbackProxy) {
                    try {
                        const fallbackRes = await fetchSafeOutbound(
                            targetUrl,
                            {
                                cache: "no-store",
                                redirect: "follow",
                                headers: {
                                    accept: "application/yaml, text/yaml, text/plain, application/octet-stream, */*",
                                    "user-agent": ua,
                                },
                                signal: AbortSignal.timeout(15000),
                            },
                            { allowProxyFakeIpSpace: true, proxyUrl: fallbackProxy },
                        );
                        if (fallbackRes.ok) {
                            response = fallbackRes;
                            break outerLoop;
                        }
                        await fallbackRes.body?.cancel().catch(() => undefined);
                    } catch {
                        // 继续下一轮或记录错误
                    }
                }

                if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.message.includes("timeout") || error.message.includes("aborted"))) {
                    lastError = new MagicProxyError("获取订阅内容超时（15秒），请检查订阅链接是否畅通，或直接使用「文件导入」粘贴订阅内容", 504);
                } else {
                    lastError = error instanceof Error ? error : new Error(String(error));
                }
            }
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
    return parseSubscriptionPayload(raw);
}

function resolveSubscriptionProxyFallback(): string {
    const fromEnv = resolveServerProxyUrl();
    if (fromEnv) return fromEnv;
    const runtime = readRuntimeConfig();
    if (runtime) {
        const candidate = runtime.proxyUrls.geminiai || runtime.proxyUrls.geminiTools;
        if (candidate) return candidate;
    }
    return "";
}

async function readBoundedSubscriptionText(response: Response, maxBytes: number) {
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0]?.trim().toLowerCase() || "";
    if (contentType && !["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain", "application/octet-stream"].includes(contentType)) {
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

export type ParsedSubscriptionResult = {
    nodes: MagicProxyNode[];
    groups: MagicProxySubscriptionGroup[];
    /** 订阅自带的 Clash dns 配置（面板常用 proxy-server-nameserver 指定节点域名专用解析） */
    dns?: Record<string, unknown>;
};

const REGION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: "🇭🇰 香港节点", pattern: /(?:香港|Hong\s*Kong|\bHK\b|🇭🇰)/i },
    { name: "🇯🇵 日本节点", pattern: /(?:日本|Japan|\bJP\b|东京|大阪|🇯🇵)/i },
    { name: "🇺🇸 美国节点", pattern: /(?:美国|United\s*States|USA|\bUS\b|洛杉矶|硅谷|纽约|🇺🇸)/i },
    { name: "🇸🇬 新加坡节点", pattern: /(?:新加坡|Singapore|\bSG\b|狮城|🇸🇬)/i },
    { name: "🇹🇼 台湾节点", pattern: /(?:台湾|Taiwan|\bTW\b|台北|新北|🇹🇼)/i },
    { name: "🇰🇷 韩国节点", pattern: /(?:韩国|Korea|\bKR\b|首尔|🇰🇷)/i },
    { name: "🇬🇧 英国节点", pattern: /(?:英国|United\s*Kingdom|\bUK\b|伦敦|🇬🇧)/i },
    { name: "🇩🇪 德国节点", pattern: /(?:德国|Germany|\bDE\b|法兰克福|🇩🇪)/i },
];

export function detectRegionalGroups(nodes: MagicProxyNode[]): MagicProxySubscriptionGroup[] {
    const groups: MagicProxySubscriptionGroup[] = [];
    for (const region of REGION_PATTERNS) {
        const matching = nodes.filter((node) => region.pattern.test(node.name)).map((n) => n.name);
        if (matching.length > 0) {
            groups.push({
                name: region.name,
                type: "url-test",
                proxies: matching,
            });
        }
    }
    return groups;
}

export function extractSubscriptionGroups(rawGroups: unknown, nodeNames: Set<string>): MagicProxySubscriptionGroup[] {
    if (!Array.isArray(rawGroups)) return [];
    const groups: MagicProxySubscriptionGroup[] = [];
    for (const item of rawGroups) {
        if (!item || typeof item !== "object") continue;
        const rec = record(item);
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        if (!name) continue;
        const type = typeof rec.type === "string" ? rec.type.trim() : "select";
        const proxies = Array.isArray(rec.proxies)
            ? rec.proxies.map((p) => String(p).trim()).filter((p) => nodeNames.has(p))
            : [];
        if (proxies.length > 0) {
            groups.push({ name, type, proxies });
        }
    }
    return groups;
}

export function deriveSubscriptionName(url?: string, fallback = "订阅"): string {
    if (!url || url === LOCAL_FILE_SUBSCRIPTION_URL) {
        return "本地文件订阅";
    }
    try {
        const parsed = new URL(url);
        const nameParam = parsed.searchParams.get("name");
        if (nameParam && nameParam.trim()) {
            return decodeURIComponent(nameParam.trim());
        }
        if (parsed.hash && parsed.hash.length > 1) {
            return decodeURIComponent(parsed.hash.slice(1).trim());
        }
        const host = parsed.hostname;
        if (host) {
            return host.replace(/^(?:sub\d*\.|api\.|subscribe\.)/i, "");
        }
    } catch {
        // ignore
    }
    return fallback;
}

export function parseSubscriptionPayload(raw: string): ParsedSubscriptionResult {
    if (Buffer.byteLength(raw, "utf8") > magicProxySubscriptionMaxBytes()) {
        throw new MagicProxyError(`订阅内容超过 ${magicProxySubscriptionMaxBytes()} 字节限制，请缩小文件或调整服务器限制`, 413);
    }

    // 1. 优先尝试作为 Clash YAML 解析
    try {
        const document = parseDocument(raw);
        if (!document.errors.length) {
            const root = record(document.toJS());
            if (Array.isArray(root.proxies) && root.proxies.length > 0) {
                const nodes = normalizeSubscriptionNodes(root.proxies);
                const nodeNames = new Set(nodes.map((n) => n.name));
                let groups = extractSubscriptionGroups(root["proxy-groups"] || root.proxyGroups, nodeNames);
                if (groups.length === 0) {
                    groups = detectRegionalGroups(nodes);
                }
                const dns = root.dns && typeof root.dns === "object" && !Array.isArray(root.dns) ? (sanitizeJson(root.dns) as Record<string, unknown>) : undefined;
                return { nodes, groups, ...(dns ? { dns } : {}) };
            }
        }
    } catch {
        // 继续尝试 Base64 或节点链接解析
    }

    // 2. 尝试作为 Base64 编码订阅或直接节点链接列表 (ss/vless/trojan/vmess) 解析
    const uriNodes = parseBase64OrUriNodeList(raw);
    if (uriNodes && uriNodes.length > 0) {
        const nodes = normalizeSubscriptionNodes(uriNodes);
        const groups = detectRegionalGroups(nodes);
        return { nodes, groups };
    }

    throw new MagicProxyError("订阅内容不是有效的 Clash YAML 或可识别的节点订阅（需包含 proxies 列表或 ss/vless/trojan/vmess 节点）", 422);
}

function parseSubscriptionNodes(raw: string): MagicProxyNode[] {
    return parseSubscriptionPayload(raw).nodes;
}

function parseBase64OrUriNodeList(raw: string): Array<Record<string, unknown>> | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // A. 尝试直接按单行节点 URI 文本解析
    const directNodes = parseNodeUriLines(trimmed);
    if (directNodes && directNodes.length > 0) return directNodes;

    // B. 尝试按 Base64 解码后解析（支持 URL-safe Base64 与多行 Base64）
    const sanitizedB64 = trimmed.replace(/[\r\n\s]+/g, "");
    if (/^[A-Za-z0-9+/=_-]+$/.test(sanitizedB64)) {
        try {
            const standardB64 = sanitizedB64.replace(/-/g, "+").replace(/_/g, "/");
            const decoded = Buffer.from(standardB64, "base64").toString("utf8");

            // 解码后可能是单行节点 URI 列表
            const decodedNodes = parseNodeUriLines(decoded);
            if (decodedNodes && decodedNodes.length > 0) return decodedNodes;

            // 解码后也可能是内嵌的 Clash YAML
            try {
                const subDoc = parseDocument(decoded);
                if (subDoc && !subDoc.errors.length) {
                    const root = record(subDoc.toJS());
                    if (Array.isArray(root.proxies) && root.proxies.length > 0) {
                        return root.proxies as Array<Record<string, unknown>>;
                    }
                }
            } catch {
                // not yaml
            }
        } catch {
            // not valid base64
        }
    }

    return null;
}

function parseNodeUriLines(text: string): Array<Record<string, unknown>> | null {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const nodes: Array<Record<string, unknown>> = [];
    for (const line of lines) {
        if (line.startsWith("ss://")) {
            const node = parseShadowsocksUri(line);
            if (node) nodes.push(node);
        } else if (line.startsWith("trojan://")) {
            const node = parseTrojanUri(line);
            if (node) nodes.push(node);
        } else if (line.startsWith("vless://")) {
            const node = parseVlessUri(line);
            if (node) nodes.push(node);
        } else if (line.startsWith("vmess://")) {
            const node = parseVmessUri(line);
            if (node) nodes.push(node);
        }
    }
    return nodes.length > 0 ? nodes : null;
}

function parseShadowsocksUri(uri: string): Record<string, unknown> | null {
    const hashIndex = uri.indexOf("#");
    const name = hashIndex !== -1 ? safeDecodeUriComponent(uri.slice(hashIndex + 1).trim()) : "";
    const withoutScheme = uri.slice(5, hashIndex !== -1 ? hashIndex : undefined);

    const atIndex = withoutScheme.indexOf("@");
    if (atIndex !== -1) {
        const userInfo = withoutScheme.slice(0, atIndex);
        const hostPortPart = withoutScheme.slice(atIndex + 1);

        let method = "";
        let password = "";
        if (userInfo.includes(":")) {
            const colon = userInfo.indexOf(":");
            method = userInfo.slice(0, colon);
            password = userInfo.slice(colon + 1);
        } else {
            try {
                const decodedUser = Buffer.from(userInfo.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
                const colon = decodedUser.indexOf(":");
                if (colon !== -1) {
                    method = decodedUser.slice(0, colon);
                    password = decodedUser.slice(colon + 1);
                }
            } catch {
                return null;
            }
        }

        const questionIndex = hostPortPart.indexOf("?");
        const hostPort = questionIndex !== -1 ? hostPortPart.slice(0, questionIndex) : hostPortPart;
        const lastColon = hostPort.lastIndexOf(":");
        if (lastColon === -1) return null;
        const server = hostPort.slice(0, lastColon);
        const port = Number(hostPort.slice(lastColon + 1));
        if (!server || !port || !method || !password) return null;

        return {
            name: name || `${server}:${port}`,
            type: "ss",
            server,
            port,
            cipher: method,
            password,
            udp: true,
        };
    } else {
        try {
            const decoded = Buffer.from(withoutScheme.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
            const at = decoded.indexOf("@");
            if (at === -1) return null;
            const user = decoded.slice(0, at);
            const hostPort = decoded.slice(at + 1);
            const userColon = user.indexOf(":");
            const lastColon = hostPort.lastIndexOf(":");
            if (userColon === -1 || lastColon === -1) return null;
            const method = user.slice(0, userColon);
            const password = user.slice(userColon + 1);
            const server = hostPort.slice(0, lastColon);
            const port = Number(hostPort.slice(lastColon + 1));
            if (!server || !port || !method || !password) return null;

            return {
                name: name || `${server}:${port}`,
                type: "ss",
                server,
                port,
                cipher: method,
                password,
                udp: true,
            };
        } catch {
            return null;
        }
    }
}

function parseTrojanUri(uri: string): Record<string, unknown> | null {
    const hashIndex = uri.indexOf("#");
    const name = hashIndex !== -1 ? safeDecodeUriComponent(uri.slice(hashIndex + 1).trim()) : "";
    const target = hashIndex !== -1 ? uri.slice(0, hashIndex) : uri;
    try {
        const url = new URL(target);
        const password = decodeURIComponent(url.username || "");
        const server = url.hostname;
        const port = Number(url.port) || 443;
        if (!password || !server) return null;

        const params = url.searchParams;
        const sni = params.get("sni") || params.get("peer") || "";
        const allowInsecure = params.get("allowInsecure") === "1" || params.get("insecure") === "1";
        const network = params.get("type") || "tcp";

        const node: Record<string, unknown> = {
            name: name || `${server}:${port}`,
            type: "trojan",
            server,
            port,
            password,
            udp: true,
            ...(sni ? { sni } : {}),
            ...(allowInsecure ? { "skip-cert-verify": true } : {}),
        };

        if (network === "ws") {
            node.network = "ws";
            const path = params.get("path");
            const host = params.get("host") || sni;
            node["ws-opts"] = {
                ...(path ? { path } : {}),
                ...(host ? { headers: { Host: host } } : {}),
            };
        } else if (network === "grpc") {
            node.network = "grpc";
            const serviceName = params.get("serviceName");
            if (serviceName) node["grpc-opts"] = { "grpc-service-name": serviceName };
        }
        return node;
    } catch {
        return null;
    }
}

function parseVlessUri(uri: string): Record<string, unknown> | null {
    const hashIndex = uri.indexOf("#");
    const name = hashIndex !== -1 ? safeDecodeUriComponent(uri.slice(hashIndex + 1).trim()) : "";
    const target = hashIndex !== -1 ? uri.slice(0, hashIndex) : uri;
    try {
        const url = new URL(target);
        const uuid = decodeURIComponent(url.username || "");
        const server = url.hostname;
        const port = Number(url.port) || 443;
        if (!uuid || !server) return null;

        const params = url.searchParams;
        const flow = params.get("flow") || "";
        const security = params.get("security") || "";
        const sni = params.get("sni") || "";
        const allowInsecure = params.get("allowInsecure") === "1" || params.get("insecure") === "1";
        const network = params.get("type") || "tcp";

        const node: Record<string, unknown> = {
            name: name || `${server}:${port}`,
            type: "vless",
            server,
            port,
            uuid,
            udp: true,
            ...(flow ? { flow } : {}),
            ...(security === "tls" || security === "reality" ? { tls: true } : {}),
            ...(sni ? { servername: sni } : {}),
            ...(allowInsecure ? { "skip-cert-verify": true } : {}),
        };

        if (security === "reality") {
            const pbk = params.get("pbk") || "";
            const sid = params.get("sid") || "";
            const fp = params.get("fp") || "chrome";
            node["reality-opts"] = {
                "public-key": pbk,
                ...(sid ? { "short-id": sid } : {}),
            };
            if (fp) node["client-fingerprint"] = fp;
        }

        if (network === "ws") {
            node.network = "ws";
            const path = params.get("path");
            const host = params.get("host") || sni;
            node["ws-opts"] = {
                ...(path ? { path } : {}),
                ...(host ? { headers: { Host: host } } : {}),
            };
        } else if (network === "grpc") {
            node.network = "grpc";
            const serviceName = params.get("serviceName");
            if (serviceName) node["grpc-opts"] = { "grpc-service-name": serviceName };
        }
        return node;
    } catch {
        return null;
    }
}

function parseVmessUri(uri: string): Record<string, unknown> | null {
    const raw = uri.slice(8).trim();
    try {
        const json = JSON.parse(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const server = String(json.add || "");
        const port = Number(json.port);
        const uuid = String(json.id || "");
        const name = String(json.ps || `${server}:${port}`);
        if (!server || !port || !uuid) return null;

        const alterId = Number(json.aid) || 0;
        const cipher = String(json.scy || "auto");
        const tls = json.tls === "tls";
        const sni = String(json.sni || json.host || "");
        const network = String(json.net || "tcp");

        const node: Record<string, unknown> = {
            name,
            type: "vmess",
            server,
            port,
            uuid,
            alterId,
            cipher,
            udp: true,
            ...(tls ? { tls: true } : {}),
            ...(sni ? { servername: sni } : {}),
        };

        if (network === "ws") {
            node.network = "ws";
            const path = String(json.path || "/");
            const host = String(json.host || sni || "");
            node["ws-opts"] = {
                ...(path ? { path } : {}),
                ...(host ? { headers: { Host: host } } : {}),
            };
        } else if (network === "grpc") {
            node.network = "grpc";
            const serviceName = String(json.path || "");
            if (serviceName) node["grpc-opts"] = { "grpc-service-name": serviceName };
        }
        return node;
    } catch {
        return null;
    }
}

function safeDecodeUriComponent(str: string): string {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

function normalizeSubscriptionNodes(value: unknown) {
    if (!Array.isArray(value) || !value.length) throw new MagicProxyError("订阅必须包含非空 proxies 节点列表", 422);
    const names = new Set<string>();
    return value.map((rawNode, index) => {
        const node = record(rawNode);
        let name = requiredText(node.name, "订阅节点缺少名称");
        const type = requiredText(node.type, `订阅节点“${name}”缺少类型`);
        if (name === "DIRECT" || Object.values(GROUP_NAMES).includes(name)) {
            name = `${name}_node`;
        }
        if (names.has(name)) {
            let disambiguated = `${name} (${index + 1})`;
            let count = index + 1;
            while (names.has(disambiguated)) {
                count += 1;
                disambiguated = `${name} (${count})`;
            }
            name = disambiguated;
        }
        names.add(name);
        const sanitized = sanitizeJson(node);
        if (!record(sanitized)) throw new MagicProxyError("订阅节点格式无效", 422);
        return { ...(sanitized as Record<string, unknown>), name, type } as MagicProxyNode;
    });
}

function normalizeSubscriptionUrl(value: string) {
    let trimmed = value.trim();
    if (trimmed.startsWith("clash://") || trimmed.startsWith("clashmeta://")) {
        try {
            const rawClashUrl = new URL(trimmed);
            const nested = rawClashUrl.searchParams.get("url");
            if (nested) trimmed = decodeURIComponent(nested).trim();
        } catch {
            // keep trimmed
        }
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new MagicProxyError("订阅地址格式无效", 400);
    }
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new MagicProxyError("订阅地址必须是未包含账号密码的 HTTPS 地址", 422);
    url.hash = "";

    // 针对机场（V2board / Xboard / SSPanel 等）订阅链接，若未指定 flag 且不是直接 yaml 文件，自动补充 flag=clash 以获取标准 Clash 配置
    if (!url.searchParams.has("flag") && isAirportSubscriptionUrl(url)) {
        url.searchParams.set("flag", "clash");
    }

    return url.toString();
}

function isAirportSubscriptionUrl(url: URL): boolean {
    const path = url.pathname.toLowerCase();
    if (path.endsWith(".yaml") || path.endsWith(".yml")) return false;
    return (
        path.includes("/api/v1/client/subscribe") ||
        path.includes("/subscribe") ||
        path.includes("/link/") ||
        path.includes("/sub/") ||
        url.searchParams.has("token")
    );
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
        const hopFallback = optionalText(chained?.hop_fallback_node);
        if (hop && allNodes?.length) {
            const resolved = resolveHopNodeName(hop, allNodes);
            if (resolved) hop = resolved;
        }
        return {
            enabled: value?.enabled === true,
            mode: "chained",
            ...(node ? { node } : {}),
            ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing, ...(hopFallback ? { hop_fallback_node: hopFallback } : {}) } } : {}),
        };
    }
    if (!node || !names.has(node)) return { enabled: false };
    const fallback = optionalText(value?.fallback_node);
    return {
        enabled: value?.enabled === true,
        node,
        ...(fallback && fallback !== node && names.has(fallback) ? { fallback_node: fallback } : {}),
    };
}

function bindingNode(value: unknown) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw new MagicProxyError("节点名称格式无效", 400);
    return value.trim();
}

export type MagicProxyPolicyGroup = {
    name: string;
    subId: string;
    subName: string;
    type: string;
    proxies: string[];
};

function reservedPolicyGroupNames(): Set<string> {
    const providers = Object.keys(GROUP_NAMES) as MagicProxyProvider[];
    return new Set<string>(["DIRECT", "REJECT", ...Object.values(GROUP_NAMES), ...Object.values(CHAINED_HOP_GROUP_NAMES), ...Object.values(FAILOVER_GROUP_NAMES), CHAINED_EXIT_NODE_NAME, ...providers.map((provider) => getChainedExitNodeName(provider))]);
}

const POLICY_GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance"]);

/**
 * 把订阅自带/按地区识别的策略组解析为可进入 Mihomo 配置的实体组。
 * 组名默认保留 Clash 原名（如「自动选择」）；只有跨订阅重名或与节点/保留名冲突时
 * 才加 `${订阅名} · ` 前缀。组员按订阅内映射到聚合后的节点名（跨订阅重名节点会被重命名），
 * 映射后不足 2 个成员的组丢弃，避免 Mihomo 配置加载失败。
 */
function resolveSubscriptionPolicyGroups(subscriptions: MagicProxySubscriptionRecord[]): MagicProxyPolicyGroup[] {
    const enabled = subscriptions.filter((sub) => sub.enabled);
    const aggregated = aggregateActiveNodesWithSource(subscriptions);
    const used = reservedPolicyGroupNames();
    for (const { node } of aggregated) used.add(node.name);

    const rawNameCounts = new Map<string, number>();
    for (const sub of enabled) {
        for (const grp of sub.groups || []) {
            if (grp.proxies.length) rawNameCounts.set(grp.name, (rawNameCounts.get(grp.name) || 0) + 1);
        }
    }

    const resolved: MagicProxyPolicyGroup[] = [];
    for (const sub of enabled) {
        // 订阅内原始节点名 → 聚合后的最终节点名（重名节点带后缀）。
        const rawToAggregated = new Map<string, string>();
        for (const { node, rawName, subscriptionId } of aggregated) {
            if (subscriptionId !== sub.id) continue;
            if (!rawToAggregated.has(rawName)) rawToAggregated.set(rawName, node.name);
        }
        for (const grp of sub.groups || []) {
            const proxies: string[] = [];
            for (const member of grp.proxies) {
                const mapped = rawToAggregated.get(member);
                if (mapped && !proxies.includes(mapped)) proxies.push(mapped);
            }
            if (proxies.length < 2) continue;
            const candidate = rawNameCounts.get(grp.name) === 1 && !used.has(grp.name) ? grp.name : `${sub.name} · ${grp.name}`;
            if (used.has(candidate)) continue;
            used.add(candidate);
            resolved.push({ name: candidate, subId: sub.id, subName: sub.name, type: grp.type && POLICY_GROUP_TYPES.has(grp.type) ? grp.type : "select", proxies });
        }
    }
    return resolved;
}

function policyGroupNameSet(subscriptions: MagicProxySubscriptionRecord[]): Set<string> {
    return new Set(resolveSubscriptionPolicyGroups(subscriptions).map((grp) => grp.name));
}

/** 绑定校验的合法出口全集：聚合节点 + 订阅策略组（如「自动选择」）。 */
function selectableBindingNames(subscriptions: MagicProxySubscriptionRecord[]): Set<string> {
    const nodes = aggregateActiveNodes(subscriptions);
    return new Set([...nodes.map((node) => node.name), ...policyGroupNameSet(subscriptions)]);
}

function aggregateActiveNodesWithSource(subscriptions: MagicProxySubscriptionRecord[]): Array<{ node: MagicProxyNode; rawName: string; subscriptionId: string; subscriptionName: string }> {
    const enabled = subscriptions.filter((s) => s.enabled);
    const nameCount = new Map<string, number>();
    for (const sub of enabled) {
        for (const node of sub.nodes) {
            nameCount.set(node.name, (nameCount.get(node.name) || 0) + 1);
        }
    }

    const result: Array<{ node: MagicProxyNode; rawName: string; subscriptionId: string; subscriptionName: string }> = [];
    const seen = new Set<string>();

    for (const sub of enabled) {
        for (const node of sub.nodes) {
            let uniqueName = node.name;
            if ((nameCount.get(node.name) || 0) > 1) {
                uniqueName = `${node.name} (${sub.name})`;
                let suffix = 2;
                // 多个订阅同名时依次递增后缀，保证每个订阅的节点都保留且归属正确。
                while (seen.has(uniqueName)) {
                    uniqueName = `${node.name} (${sub.name} ${suffix})`;
                    suffix += 1;
                }
            }
            if (!seen.has(uniqueName)) {
                seen.add(uniqueName);
                result.push({
                    node: { ...node, name: uniqueName },
                    rawName: node.name,
                    subscriptionId: sub.id,
                    subscriptionName: sub.name,
                });
            }
        }
    }
    return result;
}

function aggregateActiveNodes(subscriptions: MagicProxySubscriptionRecord[]): MagicProxyNode[] {
    return aggregateActiveNodesWithSource(subscriptions).map((item) => item.node);
}

/**
 * 为配置了兜底的服务写独立 failover provider 文件（成员按 [主节点, 兜底节点] 排序）。
 * 组员顺序跟随 provider 文件顺序、与 filter 顺序无关（实测 v1.19.30），主节点优先只能靠文件顺序保证。
 */
async function writeFailoverProviderFiles(runtime: MihomoRuntimeConfig, settings: MihomoProviderState) {
    const bindings = settings.bindings || {};
    const providers = Object.keys(GROUP_NAMES) as MagicProxyProvider[];
    if (!providers.some((provider) => magicFailoverTarget(bindings[provider]) || hopFailoverTarget(bindings[provider]))) return;
    const failoverDir = join(dirname(runtime.providerFile), "failover");
    await mkdir(failoverDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const nodeByName = new Map(settings.nodes.map((node) => [node.name, node]));
    for (const provider of providers) {
        const binding = bindings[provider];
        // 链式跳板兜底：dialer-proxy 指向的 fallback 组同样靠独立 provider 文件保证「跳板优先」顺序。
        if (binding && hopFailoverTarget(binding)) {
            const hop = nodeByName.get(binding.chained_config?.hop_node as string);
            const hopFallback = nodeByName.get(binding.chained_config?.hop_fallback_node as string);
            if (hop && hopFallback) {
                await writeFailoverFile(failoverDir, `hop-${provider}.yaml`, [hop, hopFallback]);
            }
        }
        if (!binding || !magicFailoverTarget(binding)) continue;
        const main = nodeByName.get(binding.node as string);
        const fallback = nodeByName.get(binding.fallback_node as string);
        if (!main || !fallback) continue;
        await writeFailoverFile(failoverDir, `${provider}.yaml`, [main, fallback]);
    }
}

/** 写一个 failover provider 文件（成员顺序即内核 fallback 组的优先级顺序）。 */
async function writeFailoverFile(failoverDir: string, fileName: string, nodes: MagicProxyNode[]) {
    const providerFile = join(failoverDir, fileName);
    const temporaryFile = join(failoverDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryFile, stringify({ proxies: nodes }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryFile, providerFile);
        await chmod(providerFile, 0o600);
    } catch {
        // non-blocking
    } finally {
        await unlink(temporaryFile).catch(() => undefined);
    }
}

/** 让运行中的 Mihomo 重新读取指定服务的 failover provider 文件（首次创建前该 provider 尚不存在，404 由调用方忽略）。 */
async function reloadFailoverProvider(runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const response = await controllerRequest(runtime, `/providers/proxies/${encodeURIComponent(getFailoverProviderName(provider))}`, { method: "PUT" });
    await response.body?.cancel().catch(() => undefined);
}

/** 同上，用于链式跳板的兜底 provider 文件。 */
async function reloadHopFailoverProvider(runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const response = await controllerRequest(runtime, `/providers/proxies/${encodeURIComponent(getHopFailoverProviderName(provider))}`, { method: "PUT" });
    await response.body?.cancel().catch(() => undefined);
}

async function writeAllSubscriptionFiles(runtime: MihomoRuntimeConfig, subscriptions: MagicProxySubscriptionRecord[]) {
    const runtimeDir = dirname(runtime.providerFile);
    const subscriptionsDir = join(runtimeDir, "subscriptions");
    try {
        await mkdir(subscriptionsDir, { recursive: true, mode: 0o700 });
        await chmod(subscriptionsDir, 0o700);
    } catch {
        // ignore
    }

    const currentSubIds = new Set<string>();

    for (const sub of subscriptions) {
        currentSubIds.add(sub.id);
        const subFile = join(subscriptionsDir, `sub_${sub.id}.yaml`);
        const temporaryFile = join(subscriptionsDir, `.sub_${sub.id}.${process.pid}.${randomUUID()}.tmp`);
        try {
            await writeFile(temporaryFile, stringify({ proxies: sub.nodes }), { encoding: "utf8", mode: 0o600, flag: "wx" });
            await rename(temporaryFile, subFile);
            await chmod(subFile, 0o600);
        } catch {
            // ignore
        } finally {
            await unlink(temporaryFile).catch(() => undefined);
        }
    }

    try {
        const existingFiles = await readdir(subscriptionsDir);
        for (const file of existingFiles) {
            if (file.startsWith("sub_") && file.endsWith(".yaml")) {
                const id = file.slice(4, -5);
                if (!currentSubIds.has(id)) {
                    await unlink(join(subscriptionsDir, file)).catch(() => undefined);
                }
            }
        }
    } catch {
        // ignore
    }
}

/** 订阅 dns 段里允许透传的服务器地址列表（数组或单个字符串）。 */
function dnsServerList(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => optionalText(item)).filter(Boolean);
}

/**
 * default-nameserver 必须是纯 IP（`1.1.1.1` 或 `1.1.1.1:53`），内核实测会因 DoH URL 直接拒绝整份配置
 * （`default nameserver should be pure IP`）。机场 dns 段常把 DoH 地址写进这个键，原样透传会让动态配置无法加载。
 */
function pureIpNameserverList(value: unknown): string[] {
    return dnsServerList(value).filter((item) => isIP(item.replace(/:\d+$/, "")));
}

/**
 * 容器内不可能生效的解析器地址：机场常把 `udp://127.0.0.1:7874` 这类「本机 DNS」写进 dns 段，
 * 那是给它自己客户端用的。在 mihomo 容器里 127.0.0.1 就是容器本身、该端口没有任何服务，
 * 拿它解析节点域名会瞬间被拒（表现为节点 200–700ms 内极速失败），而系统 DNS 其实完全能解析。
 */
function isContainerUnusableResolver(value: string): boolean {
    const hostPort = value.replace(/^[a-z0-9+.-]+:\/\//i, "").split("/")[0];
    const host = hostPort.replace(/^\[|\]$/g, "").replace(/:\d+$/, "").toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
}

const DEFAULT_FALLBACK_NAMESERVERS = ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"];
const DEFAULT_FALLBACK_IP_RESOLVERS = ["223.5.5.5", "119.29.29.29"];

/**
 * 把每个启用订阅声明的 `proxy-server-nameserver`（机场私有 DoH）**只绑定到该订阅自己节点的域名**。
 *
 * `proxy-server-nameserver` 会取代 `nameserver` 成为节点域名的解析器（mihomo v1.19.30 实测），
 * 而列表内条目并发竞速、死条目不影响其他条目。真正会致命的是「该订阅唯一的解析器在本容器里不可用」，
 * 因此这里先剔除容器内无意义的 loopback 地址，宁可回落系统 DNS 也不把节点域名交给一个空地址。
 * 多个机场各自带私有 DoH，只能用 nameserver-policy 按域名精确分流。
 */
function subscriptionDnsPolicy(subscriptions: MagicProxySubscriptionRecord[]): Record<string, unknown> | undefined {
    const policy: Record<string, string[]> = {};
    let defaultNameserver: string[] = [];
    for (const sub of subscriptions) {
        if (!sub.enabled || !sub.dns) continue;
        if (!defaultNameserver.length) defaultNameserver = pureIpNameserverList(sub.dns["default-nameserver"]);
        const servers = dnsServerList(sub.dns["proxy-server-nameserver"]).filter((server) => !isContainerUnusableResolver(server));
        if (!servers.length) continue;
        for (const node of sub.nodes) {
            const host = optionalText(node.server).toLowerCase();
            // IP 直连的节点不需要解析，加进策略只会让配置变长。
            if (!host || isIP(host)) continue;
            policy[host] = servers;
        }
    }
    if (!Object.keys(policy).length) return undefined;
    return {
        enable: true,
        // default-nameserver 用于解析上面这些 DoH 地址本身（必须为纯 IP，缺失时回落默认公共纯 IP DNS）。
        "default-nameserver": defaultNameserver.length ? defaultNameserver : [...DEFAULT_FALLBACK_IP_RESOLVERS],
        // 全局兜底 nameserver：nameserver-policy 仅绑定命中规则的订阅私有节点域名，
        // 未命中策略的所有其他域名（例如通用代理/链式落地节点域名 us.ipwo.net）必须由全局 nameserver 兜底解析，
        // 避免当内核启用内建 DNS 时因未配置 nameserver 导致非订阅域名解析全灭。
        nameserver: [...DEFAULT_FALLBACK_NAMESERVERS],
        "nameserver-policy": policy,
    };
}

export function generateDynamicMihomoConfig(runtime: MihomoRuntimeConfig, settings: Pick<MihomoProviderState, "subscriptions" | "bindings">): string {
    const subscriptions = settings.subscriptions || [];
    const enabledSubs = subscriptions.filter((s) => s.enabled);
    const dnsPolicy = subscriptionDnsPolicy(enabledSubs);
    const nodeNames = new Set(aggregateActiveNodes(subscriptions).map((node) => node.name));
    const policyGroups = resolveSubscriptionPolicyGroups(subscriptions);
    const policyGroupNames = policyGroups.map((grp) => grp.name);
    // 内核不允许在组 proxies 里直接引用 provider 节点名（实测 v1.19.30 报 not found）：
    // 策略组必须用 use + 组级 filter 正则圈定 provider 节点。
    const failoverProviders = (Object.keys(GROUP_NAMES) as MagicProxyProvider[]).filter((provider) => {
        const binding = settings.bindings?.[provider];
        if (!binding || !magicFailoverTarget(binding)) return false;
        const mainNode = binding.node as string;
        const fallbackNode = binding.fallback_node as string;
        return nodeNames.has(mainNode) && nodeNames.has(fallbackNode);
    });
    // 主节点拨号失败自动切兜底的内核 fallback 组；成员经独立 failover provider 文件引入，
    // 保证「主节点优先」顺序（组员顺序跟随 provider 文件顺序，与 filter 顺序无关）。
    const failoverGroups = failoverProviders.map((provider) => ({
        name: getFailoverGroupName(provider),
        type: "fallback",
        use: [getFailoverProviderName(provider)],
        url: DELAY_TEST_URL,
        interval: 300,
        lazy: true,
    }));
    const failoverGroupNames = failoverGroups.map((grp) => grp.name);

    const providers: Record<string, unknown> = {
        [PROVIDER_NAME]: {
            type: "file",
            path: join(MIHOMO_RUNTIME_DIR, PROVIDER_FILE_NAME),
        },
    };

    for (const sub of enabledSubs) {
        providers[`sub-${sanitizeProviderId(sub.id)}`] = {
            type: "file",
            path: join(MIHOMO_RUNTIME_DIR, "subscriptions", `sub_${sub.id}.yaml`),
        };
    }
    for (const provider of failoverProviders) {
        providers[getFailoverProviderName(provider)] = {
            type: "file",
            path: join(MIHOMO_RUNTIME_DIR, "failover", `${provider}.yaml`),
        };
    }
    const hopFailoverProviders = (Object.keys(GROUP_NAMES) as MagicProxyProvider[]).filter((provider) => {
        const binding = settings.bindings?.[provider];
        if (!hopFailoverTarget(binding)) return false;
        const cfg = binding?.chained_config;
        return Boolean(nodeNames.has(cfg?.hop_node as string) && nodeNames.has(cfg?.hop_fallback_node as string));
    });
    for (const provider of hopFailoverProviders) {
        providers[getHopFailoverProviderName(provider)] = {
            type: "file",
            path: join(MIHOMO_RUNTIME_DIR, "failover", `hop-${provider}.yaml`),
        };
    }

    // 服务组与跳板组必须把订阅策略组（如「自动选择」url-test）与 failover 兜底组列进 proxies，
    // 控制器才允许把组选中为服务出口——实现 Clash 同款的自动选优与兜底切换。
    const proxyGroups: Array<Record<string, unknown>> = [
        ...(["geminiai", "geminiTools", "chatgptApi", "dola"] as MagicProxyProvider[]).map((provider) => ({
            name: GROUP_NAMES[provider],
            type: "select",
            use: [PROVIDER_NAME],
            proxies: ["DIRECT", ...policyGroupNames, ...failoverGroupNames],
        })),
        ...(["geminiai", "geminiTools", "chatgptApi", "dola"] as MagicProxyProvider[]).map((provider) => ({
            name: getChainedHopGroupName(provider),
            type: "select",
            use: [PROVIDER_NAME],
            proxies: ["DIRECT", ...policyGroupNames, ...(hopFailoverProviders.includes(provider) ? [getChainedHopFailoverGroupName(provider)] : [])],
        })),
    ];

    // 跳板兜底组：成员经独立 provider 文件引入，保证「跳板优先、兜底接管」的顺序。
    for (const provider of hopFailoverProviders) {
        proxyGroups.push({
            name: getChainedHopFailoverGroupName(provider),
            type: "fallback",
            use: [getHopFailoverProviderName(provider)],
            url: DELAY_TEST_URL,
            interval: 300,
            lazy: true,
        });
    }

    for (const grp of failoverGroups) {
        proxyGroups.push(grp);
    }
    for (const grp of policyGroups) {
        proxyGroups.push({
            name: grp.name,
            type: grp.type,
            use: [PROVIDER_NAME],
            filter: providerNodeNameFilter(grp.proxies),
            ...(grp.type !== "select" ? { url: DELAY_TEST_URL, interval: 300, lazy: true } : {}),
        });
    }

    const listeners = [
        { name: "dreamyo-GeminiAIStudio", type: "mixed", listen: "0.0.0.0", port: 17890, proxy: "dreamyo-GeminiAIStudio" },
        { name: "dreamyo-GeminiTools", type: "mixed", listen: "0.0.0.0", port: 17891, proxy: "dreamyo-GeminiTools" },
        { name: "dreamyo-ChatGPTAPI", type: "mixed", listen: "0.0.0.0", port: 17892, proxy: "dreamyo-ChatGPTAPI" },
        { name: "dreamyo-DolaAPI", type: "mixed", listen: "0.0.0.0", port: 17893, proxy: "dreamyo-DolaAPI" },
    ];

    const configDoc = {
        mode: "rule",
        "log-level": "info",
        "external-controller": "0.0.0.0:9090",
        ...(runtime.secret ? { secret: runtime.secret } : {}),
        // store-selected 让重载/重启后保留各 select 组的选中项，避免服务出口静默回落 DIRECT。
        profile: { "store-selected": true },
        // 机场私有的节点域名 DoH 必须透传，否则这些节点域名解析不了、永远拨不通；
        // 但只能按订阅绑定到各自节点的域名上（见 subscriptionDnsPolicy），不可设成全局值。
        ...(dnsPolicy ? { dns: dnsPolicy } : {}),
        "proxy-providers": providers,
        "proxy-groups": proxyGroups,
        listeners,
    };

    return stringify(configDoc);
}

function sanitizeProviderId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function writeDynamicConfigFile(runtime: MihomoRuntimeConfig, settings: Pick<MihomoProviderState, "subscriptions" | "bindings">) {
    const configFile = join(dirname(runtime.providerFile), "config.yaml");
    const parent = dirname(configFile);
    const temporaryFile = join(parent, `.${basename(configFile)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        const yamlContent = generateDynamicMihomoConfig(runtime, settings);
        await writeFile(temporaryFile, yamlContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryFile, configFile);
        await chmod(configFile, 0o600);
    } catch {
        // non-blocking
    } finally {
        await unlink(temporaryFile).catch(() => undefined);
    }
}

/** 让 Mihomo 热加载磁盘上的动态 config.yaml（新策略组/Provider 即刻生效，无须重启容器）。 */
async function reloadMihomoConfig(runtime: MihomoRuntimeConfig) {
    const response = await controllerRequest(runtime, "/configs?force=true", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(MIHOMO_RUNTIME_DIR, "config.yaml") }),
    });
    await response.body?.cancel().catch(() => undefined);
}

async function syncMihomoProvider(settings: MihomoProviderState, runtime: MihomoRuntimeConfig) {
    // 订阅刷新会整体重写 Provider 文件；已启用的链式出口必须原地重建，否则分组回落 DIRECT 造成静默直连。
    const { baseNodes, chainedNodes, hopSelections } = await rebuildChainedExits(settings, runtime);

    const mergedNodes = [...baseNodes, ...chainedNodes];
    await writeProviderNodes(runtime, mergedNodes);

    if (settings.subscriptions?.length) {
        await writeAllSubscriptionFiles(runtime, settings.subscriptions).catch(() => undefined);
        await writeFailoverProviderFiles(runtime, settings).catch(() => undefined);
        await writeDynamicConfigFile(runtime, settings).catch(() => undefined);
        // config.yaml 只有热重载才会生效：新增的订阅策略组（如「自动选择」）无须重启容器即可被选中。
        // 重载失败说明生成的配置被内核拒绝（如订阅 dns 段含不支持的键），必须显式暴露而不是静默吞掉——
        // 否则后续的组选中会 400，用户只看到模糊的保存失败。
        await reloadMihomoConfig(runtime);
    }

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
        const policyNames = policyGroupNameSet(settings.subscriptions || []);
        const aggregateNames = new Set((settings.nodes || []).map((node) => node.name));
        if (binding.enabled && binding.mode === "chained") {
            await selectMihomoProxy(runtime, GROUP_NAMES[provider], hasExit ? exitName : binding.node || "DIRECT");
        } else {
            // 配置了兜底节点时选中内核 fallback 组：主节点失联由 Mihomo 健康检查自动切换兜底。
            // 目标必须与 generateDynamicMihomoConfig 的生成条件完全一致（主节点为真实节点），否则内核 400。
            const failoverUsable = Boolean(binding.enabled && binding.node && magicFailoverTarget(binding) && aggregateNames.has(binding.node as string) && aggregateNames.has(binding.fallback_node as string) && !policyNames.has(binding.node as string));
            const failoverTarget = failoverUsable ? getFailoverGroupName(provider) : binding.node;
            await selectMihomoProxy(runtime, GROUP_NAMES[provider], binding.enabled && failoverTarget ? failoverTarget : "DIRECT");
        }
    }
}

async function ensureMihomoGroupSelection(settings: DecodedMagicProxySettings, runtime: MihomoRuntimeConfig, provider: MagicProxyProvider) {
    const binding = settings.bindings[provider] || { enabled: false };
    const policyNames = policyGroupNameSet(settings.subscriptions);
    const aggregateNames = new Set((settings.nodes || []).map((node) => node.name));
    const failoverUsable = Boolean(binding.enabled && binding.node && magicFailoverTarget(binding) && aggregateNames.has(binding.node as string) && aggregateNames.has(binding.fallback_node as string) && !policyNames.has(binding.node as string));
    const failoverTarget = failoverUsable ? getFailoverGroupName(provider) : binding.node;
    const expected = binding.enabled && failoverTarget ? failoverTarget : "DIRECT";
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

const CHAINED_HOP_FAILOVER_GROUP_NAMES: Record<MagicProxyProvider, string> = {
    geminiai: "dreamyo-Chained-Hop-Failover-GeminiAIStudio",
    geminiTools: "dreamyo-Chained-Hop-Failover-GeminiTools",
    chatgptApi: "dreamyo-Chained-Hop-Failover-ChatGPTAPI",
    dola: "dreamyo-Chained-Hop-Failover-DolaAPI",
};

function getChainedHopFailoverGroupName(provider: MagicProxyProvider) {
    return CHAINED_HOP_FAILOVER_GROUP_NAMES[provider];
}

function getHopFailoverProviderName(provider: MagicProxyProvider) {
    return `dreamyo-Failover-Hop-${provider}`;
}

/** 跳板与其兜底跳板均有效且不同时，用内核 fallback 组接管 dialer-proxy 的跳板出口。 */
function hopFailoverTarget(binding: MagicProxyBinding | undefined): boolean {
    const cfg = binding?.chained_config;
    return Boolean(binding && binding.mode === "chained" && cfg?.hop_node && cfg?.hop_fallback_node && cfg.hop_node !== cfg.hop_fallback_node);
}

const FAILOVER_GROUP_NAMES: Record<MagicProxyProvider, string> = {
    geminiai: "dreamyo-Failover-GeminiAIStudio",
    geminiTools: "dreamyo-Failover-GeminiTools",
    chatgptApi: "dreamyo-Failover-ChatGPTAPI",
    dola: "dreamyo-Failover-DolaAPI",
};

function getFailoverGroupName(provider: MagicProxyProvider) {
    return FAILOVER_GROUP_NAMES[provider];
}

const FAILOVER_PROVIDER_NAME_PREFIX = "dreamyo-Failover-Src-";

function getFailoverProviderName(provider: MagicProxyProvider) {
    return `${FAILOVER_PROVIDER_NAME_PREFIX}${provider}`;
}

/** 主节点 + 兜底节点均有效且不同时，用内核 fallback 组接管服务出口。 */
function magicFailoverTarget(binding: MagicProxyBinding | undefined): boolean {
    return Boolean(binding && binding.mode !== "chained" && binding.node && binding.fallback_node && binding.node !== binding.fallback_node);
}

// Go regexp（RE2）元字符转义，用于组级 filter 精确圈定 provider 节点名。
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function providerNodeNameFilter(proxies: string[]): string {
    return `^(?:${proxies.map((proxy) => escapeRegExp(proxy)).join("|")})$`;
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
        const built = landingProxyUrl ? buildChainedExitNode(provider, binding.chained_config.hop_node, landingProxyUrl, baseNodes, binding.chained_config.hop_fallback_node || "") : null;
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

function buildChainedExitNode(provider: MagicProxyProvider, rawHop: string, landingProxyUrl: string, baseNodes: MagicProxyNode[], hopFallback = ""): { node: MagicProxyNode; hopNode: string } | null {
    const hopNode = resolveHopNodeName(rawHop, baseNodes) || (baseNodes.length > 0 ? baseNodes[0].name : "");
    const hopFallbackNode = hopFallback ? resolveHopNodeName(hopFallback, baseNodes) : "";
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
            // 配置了跳板兜底时改指向 fallback 组，跳板失联由内核自动切到备用跳板。
            "dialer-proxy": hopFallbackNode && hopFallbackNode !== hopNode ? getChainedHopFailoverGroupName(provider) : getChainedHopGroupName(provider),
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
        settings.bindings[provider]?.chained_config?.hop_fallback_node || "",
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

    // 跳板组必须选中本次跳板节点：出口的 dialer-proxy 指向该组，未选中时链路无出口（静默回落 DIRECT
    // 会让链式变成「国内直连落地」，表现为测试/生成全部超时）。显式启用链式时选中失败必须报错。
    for (const [hopProvider, hopNode] of hopSelections) {
        const isOwnHop = hasOwnExit && hopProvider === provider;
        await selectMihomoProxy(runtime, getChainedHopGroupName(hopProvider), hopNode).catch((error) => {
            if (!isOwnHop) return;
            throw new MagicProxyError(`跳板组选中「${hopNode}」失败：${error instanceof Error ? error.message : "请刷新订阅后重试"}`, 502);
        });
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

async function controllerRequest(runtime: MihomoRuntimeConfig, path: string, init: RequestInit, acceptErrorStatus = false) {
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
    // 健康检查端点用状态码表达结果：200 成功、503 节点拨号失败、404 节点不存在。
    // 这些状态本身就是结论，调用方需要读取而不能被统一抛错吞掉。
    if (acceptErrorStatus && response.status !== 401 && response.status !== 403) {
        return response;
    }
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const reason = (() => {
            try {
                const parsed = JSON.parse(detail) as { message?: string };
                return typeof parsed.message === "string" ? parsed.message : "";
            } catch {
                return detail.trim().slice(0, 200);
            }
        })();
        if (response.status === 401 || response.status === 403) {
            throw new MagicProxyError(`魔法代理控制器鉴权失败（HTTP ${response.status}），请检查应用与 Mihomo 进程的 DREAMYO_MAGIC_PROXY_SECRET 是否一致`, 502);
        }
        throw new MagicProxyError(`魔法代理控制器拒绝了配置请求（HTTP ${response.status}）${reason ? `：${reason}` : ""}`, 502);
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
    if (!stored) return null;
    const hasLegacy = Boolean(stored.subscriptionUrlCiphertext && stored.nodesCiphertext);
    const hasSubscriptions = Boolean(stored.subscriptionsCiphertext);
    if (!hasLegacy && !hasSubscriptions) return null;
    try {
        let storedSubscriptionUrl = "";
        let subscriptionUrl = "";
        if (stored.subscriptionUrlCiphertext) {
            storedSubscriptionUrl = decryptSecretValue(stored.subscriptionUrlCiphertext);
            subscriptionUrl = storedSubscriptionUrl;
            if (storedSubscriptionUrl && storedSubscriptionUrl !== LOCAL_FILE_SUBSCRIPTION_URL) {
                try {
                    subscriptionUrl = normalizeSubscriptionUrl(storedSubscriptionUrl);
                } catch {
                    // 存量配置可能保存了旧版本允许的 http 订阅地址：读取时原样保留，
                    // 严格 https 校验只在重新导入订阅时执行，避免整份配置因此不可读。
                }
            }
        }

        let subscriptions: MagicProxySubscriptionRecord[] = [];
        if (stored.subscriptionsCiphertext) {
            try {
                const parsed = JSON.parse(decryptSecretValue(stored.subscriptionsCiphertext));
                if (Array.isArray(parsed)) {
                    subscriptions = parsed.map((item) => ({
                        id: String(item.id || `sub_${Date.now()}`),
                        name: String(item.name || "未命名订阅"),
                        url: String(item.url || ""),
                        type: item.type === "file" ? ("file" as const) : ("remote" as const),
                        enabled: item.enabled !== false,
                        nodes: normalizeSubscriptionNodes(item.nodes),
                        groups: Array.isArray(item.groups) ? item.groups : [],
                        ...(item.dns && typeof item.dns === "object" && !Array.isArray(item.dns) ? { dns: item.dns as Record<string, unknown> } : {}),
                        nodeCount: typeof item.nodeCount === "number" ? item.nodeCount : (Array.isArray(item.nodes) ? item.nodes.length : 0),
                        updatedAt: String(item.updatedAt || stored.updatedAt),
                        ...(item.lastTestedAt ? { lastTestedAt: String(item.lastTestedAt) } : {}),
                    }));
                }
            } catch {
                subscriptions = [];
            }
        }

        let nodes: MagicProxyNode[] = [];
        if (stored.nodesCiphertext) {
            nodes = normalizeSubscriptionNodes(JSON.parse(decryptSecretValue(stored.nodesCiphertext)));
        } else if (subscriptions.length > 0) {
            nodes = aggregateActiveNodes(subscriptions);
        }

        // 平滑向下兼容迁移：若存量数据有旧单订阅但没有 subscriptions 数组，平滑构建初始订阅
        if (subscriptions.length === 0 && (storedSubscriptionUrl || nodes.length > 0)) {
            const legacySub: MagicProxySubscriptionRecord = {
                id: "sub_legacy",
                name: deriveSubscriptionName(storedSubscriptionUrl === LOCAL_FILE_SUBSCRIPTION_URL ? undefined : storedSubscriptionUrl, "默认订阅"),
                url: storedSubscriptionUrl || LOCAL_FILE_SUBSCRIPTION_URL,
                type: storedSubscriptionUrl === LOCAL_FILE_SUBSCRIPTION_URL ? "file" : "remote",
                enabled: true,
                nodes,
                groups: detectRegionalGroups(nodes),
                nodeCount: nodes.length,
                updatedAt: stored.updatedAt,
            };
            subscriptions = [legacySub];
        }

        let nodeDelays: Record<string, MagicProxyNodeDelayRecord> = {};
        if (stored.nodeDelaysCiphertext) {
            try {
                const parsed = JSON.parse(decryptSecretValue(stored.nodeDelaysCiphertext));
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    nodeDelays = parsed as Record<string, MagicProxyNodeDelayRecord>;
                }
            } catch {
                nodeDelays = {};
            }
        }

        if (!subscriptionUrl && subscriptions.length > 0) {
            subscriptionUrl = subscriptions[0].url;
        }

        return {
            subscriptionUrl,
            nodes,
            subscriptions,
            nodeDelays,
            // 绑定出口可以是节点或订阅策略组（如「自动选择」），读取时必须按同一全集校验，
            // 否则组绑定会在每次读取时被静默清空。
            bindings: normalizeBindings(stored.bindings, selectableBindingNames(subscriptions), nodes),
            updatedAt: stored.updatedAt,
        };
    } catch (error) {
        if (error instanceof MagicProxyError) throw error;
        throw new MagicProxyError("魔法代理已保存配置无法读取，请重新导入订阅", 500);
    }
}

function encodeSettings(settings: DecodedMagicProxySettings): MagicProxySettings {
    const subscriptions = settings.subscriptions || [];
    const nodeDelays = settings.nodeDelays || {};
    return {
        subscriptionUrlCiphertext: encryptSecretValue(settings.subscriptionUrl),
        nodesCiphertext: encryptSecretValue(JSON.stringify(settings.nodes)),
        subscriptionsCiphertext: encryptSecretValue(JSON.stringify(subscriptions)),
        nodeDelaysCiphertext: encryptSecretValue(JSON.stringify(nodeDelays)),
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
    const hasLegacy = typeof value.subscriptionUrlCiphertext === "string" && typeof value.nodesCiphertext === "string";
    const hasSubscriptions = typeof value.subscriptionsCiphertext === "string" && value.subscriptionsCiphertext.length > 0;
    if (!hasLegacy && !hasSubscriptions) return null;
    return {
        subscriptionUrlCiphertext: typeof value.subscriptionUrlCiphertext === "string" ? value.subscriptionUrlCiphertext : "",
        nodesCiphertext: typeof value.nodesCiphertext === "string" ? value.nodesCiphertext : "",
        subscriptionsCiphertext: typeof value.subscriptionsCiphertext === "string" ? value.subscriptionsCiphertext : "",
        nodeDelaysCiphertext: typeof value.nodeDelaysCiphertext === "string" ? value.nodeDelaysCiphertext : "",
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
    const fallback = optionalText(binding.fallback_node);
    const isChained = binding.mode === "chained";
    const chained = record(binding.chained_config);
    const hop = optionalText(chained.hop_node);
    const landing = optionalText(chained.landing_node_id);
    const hopFallback = optionalText(chained.hop_fallback_node);
    return {
        enabled: binding.enabled === true,
        ...(isChained ? { mode: "chained" as const } : {}),
        ...(node ? { node } : {}),
        ...(!isChained && node && fallback && fallback !== node ? { fallback_node: fallback } : {}),
        ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing, ...(hopFallback ? { hop_fallback_node: hopFallback } : {}) } } : {}),
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
    const fallback = optionalText(value.fallback_node);
    const isChained = value.mode === "chained";
    const hop = optionalText(value.chained_config?.hop_node);
    const landing = optionalText(value.chained_config?.landing_node_id);
    const hopFallback = optionalText(value.chained_config?.hop_fallback_node);
    return {
        enabled: value.enabled === true,
        ...(isChained ? { mode: "chained" as const } : {}),
        ...(node ? { node } : {}),
        ...(!isChained && node && fallback && fallback !== node ? { fallback_node: fallback } : {}),
        ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing, ...(hopFallback ? { hop_fallback_node: hopFallback } : {}) } } : {}),
    };
}

function cloneBindings(value: MagicProxyBindings): MagicProxyBindings {
    return { geminiai: cloneBinding(value.geminiai), geminiTools: cloneBinding(value.geminiTools), chatgptApi: cloneBinding(value.chatgptApi), dola: cloneBinding(value.dola) };
}

const runtimeState = globalThis as typeof globalThis & { __dreamyoMagicProxyRuntimeQueue?: Promise<void> };

/**
 * 与 withRuntimeLock 共用同一把锁，但锁被占用时**立即返回 undefined 而不是排队等待**。
 * 生成请求（GeminiAIStudio/GeminiTools/ChatGPTAPI/Dola）每次都要解析代理出口，
 * 若与订阅刷新、内核热重载、批量测速这些慢操作共用一把锁并排队，请求会被卡在「排队中」。
 */
async function tryWithRuntimeLock<T>(callback: () => Promise<T>): Promise<T | undefined> {
    if (runtimeState.__dreamyoMagicProxyRuntimeQueue) return undefined;
    return withRuntimeLock(callback);
}

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
