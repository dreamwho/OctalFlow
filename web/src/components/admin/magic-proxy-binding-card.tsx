"use client";

import { Alert, App, Button, Select, Segmented, Switch, Tag } from "antd";
import { ArrowRight, CheckCircle2, Network, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getMagicProxy, testChatGptChain, testMagicProxyDola, testMagicProxyGoogle, testMagicProxyNode, updateMagicProxyBinding, type MagicProxyDelayResult, type MagicProxyGoogleTestReport, type MagicProxyNode, type MagicProxyProvider, type MagicProxyState } from "@/services/api/magic-proxy";
import { genericProxyRequest, getGenericProxyBindings, saveGenericProxyBinding, type ChatGptProxyView, type GenericProxyBindings } from "@/services/api/generic-proxy";

const providerLabels: Record<MagicProxyProvider, string> = {
    geminiai: "GeminiAIStudio",
    geminiTools: "GeminiTools",
    chatgptApi: "GPTAPI",
    dola: "Dola API",
    dolaUpload: "Dola 参考图上传",
};

export function magicProxyBindingValidationMessage(enabled: boolean, node?: string) {
    return enabled && !node?.trim() ? "启用魔法代理前请选择代理节点" : "";
}

type ProxySource = "direct" | "magic" | "generic" | "chained";

export function MagicProxyBindingCard({ provider }: { provider: MagicProxyProvider }) {
    const { message } = App.useApp();
    const [state, setState] = useState<MagicProxyState | null>(null);
    const [genericBindings, setGenericBindings] = useState<GenericProxyBindings | null>(null);
    const [genericView, setGenericView] = useState<ChatGptProxyView | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [source, setSource] = useState<ProxySource>("magic");
    const [node, setNode] = useState("");
    const [fallbackNode, setFallbackNode] = useState("");
    const [target, setTarget] = useState("");
    const [hopNode, setHopNode] = useState("");
    const [hopFallbackNode, setHopFallbackNode] = useState("");
    const [landingNodeId, setLandingNodeId] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testReport, setTestReport] = useState<MagicProxyGoogleTestReport | null>(null);
    const [nodeTest, setNodeTest] = useState<MagicProxyDelayResult | null>(null);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [nextState, nextGeneric, nextGenericView] = await Promise.all([getMagicProxy(), provider === "dolaUpload" ? getGenericProxyBindings() : getGenericProxyBindings().catch(() => null), genericProxyRequest<ChatGptProxyView>("proxies").catch(() => null)]);
            setState(nextState);
            setGenericBindings(nextGeneric);
            setGenericView(nextGenericView);
            const magicBinding = nextState.bindings?.[provider];
            const genericBinding = nextGeneric?.bindings?.[provider];
            const isChained = magicBinding?.mode === "chained";

            if (isChained && magicBinding?.enabled) {
                setSource("chained");
                setEnabled(true);
            } else if (genericBinding?.enabled === true) {
                setSource("generic");
                setEnabled(true);
            } else if (magicBinding?.enabled === true) {
                setSource("magic");
                setEnabled(true);
            } else if (isChained) {
                setSource("chained");
                setEnabled(false);
            } else {
                setSource(provider === "dolaUpload" ? "direct" : "magic");
                setEnabled(false);
            }

            setNode(magicBinding?.node || "");
            setFallbackNode(magicBinding?.fallback_node || "");
            setTarget(genericBinding?.target || "");
            setHopNode(magicBinding?.chained_config?.hop_node || "");
            setHopFallbackNode(magicBinding?.chained_config?.hop_fallback_node || "");
            setLandingNodeId(magicBinding?.chained_config?.landing_node_id || "");
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "读取代理绑定失败");
        } finally {
            setLoading(false);
        }
    }, [provider]);

    useEffect(() => {
        void load();
    }, [load]);

    const genericOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const group of genericView?.groups || []) {
            if (provider !== "geminiai") options.push({ value: `group:${group.id}`, label: `整组 · ${group.name}（${group.nodes.length} 个节点自动切换）` });
            for (const item of group.nodes) {
                options.push({ value: `node:${item.id}`, label: `节点 · ${item.name || item.id}（${group.name}）` });
            }
        }
        if (target && !options.some((option) => option.value === target)) options.unshift({ value: target, label: `${target} · 当前绑定` });
        return options;
    }, [genericView, provider, target]);

    // 落地单节点选项列表（从通用代理的所有节点中选取）
    const landingOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const group of genericView?.groups || []) {
            for (const item of group.nodes || []) {
                options.push({
                    value: item.id,
                    label: `${item.name || item.id} [${group.name}]`,
                });
            }
        }
        if (landingNodeId && !options.some((item) => item.value === landingNodeId)) {
            options.unshift({ value: landingNodeId, label: `节点 ${landingNodeId} (当前配置)` });
        }
        return options;
    }, [genericView?.groups, landingNodeId]);

    // 跳板节点选项列表（从 Clash 订阅中选取，按订阅分组）
    const nodes = state?.nodes || [];
    // 不可用节点（最近测速失败）不进入选择列表，避免选到失效节点
    const selectableNodes = useMemo(() => nodes.filter((item) => item.alive !== false), [nodes]);
    const hopSelectGroups = useMemo(() => groupMagicProxyOptions(selectableNodes), [selectableNodes]);
    const hopOptions = useMemo(() => {
        const groups = hopSelectGroups.map((grp) => ({ ...grp, options: [...grp.options] }));
        if (hopNode && !flatMagicProxyOptions(groups).some((item) => item.value === hopNode)) {
            groups.unshift({ label: "当前配置", options: [{ value: hopNode, label: `${hopNode} (当前配置)` }] });
        }
        return groups;
    }, [hopNode, hopSelectGroups]);

    const persistSourceSwitch = (nextSource: ProxySource) => {
        if (provider === "dolaUpload" && nextSource === "direct") {
            void persist(false, "direct");
            return;
        }
        // 允许直接切入对应视图进行配置，不作前置报错阻断
        setSource(nextSource);
    };

    const persist = async (
        nextEnabled: boolean,
        nextSource: ProxySource,
        overrides: { node?: string; fallbackNode?: string; target?: string; hopNode?: string; hopFallbackNode?: string; landingNodeId?: string } = {},
    ) => {
        const effectiveNode = overrides.node ?? node;
        const effectiveFallback = overrides.fallbackNode ?? fallbackNode;
        const effectiveTarget = overrides.target ?? target;
        const effectiveHop = overrides.hopNode ?? hopNode;
        const effectiveHopFallback = overrides.hopFallbackNode ?? hopFallbackNode;
        const effectiveLanding = overrides.landingNodeId ?? landingNodeId;

        if (nextEnabled && nextSource === "magic") {
            const validationMessage = magicProxyBindingValidationMessage(true, effectiveNode);
            if (validationMessage) {
                message.error(validationMessage);
                return;
            }
        }

        if (nextEnabled && nextSource === "generic" && !effectiveTarget) {
            message.error("启用通用代理前请先选择代理节点或整组，选择后自动生效");
            return;
        }

        if (nextEnabled && nextSource === "chained") {
            if (!effectiveHop || !effectiveLanding) {
                message.error("启用链式代理前请先选择跳板节点与落地出口");
                return;
            }
        }

        const previous = { enabled, source };
        setEnabled(nextEnabled);
        setSaving(true);
        setError("");
        try {
            if (!nextEnabled) {
                if (provider === "dolaUpload") await updateMagicProxyBinding({ provider, enabled: false });
                else await updateMagicProxyBinding({ provider, enabled: false }).catch(() => undefined);
                if (provider === "dolaUpload") await saveGenericProxyBinding({ provider, enabled: false });
                else await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else if (nextSource === "magic") {
                await updateMagicProxyBinding({ provider, enabled: true, mode: "magic", node: effectiveNode, fallback_node: effectiveFallback || "" });
                if (provider === "dolaUpload") await saveGenericProxyBinding({ provider, enabled: false });
                else await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else if (nextSource === "chained") {
                await updateMagicProxyBinding({
                    provider,
                    enabled: true,
                    mode: "chained",
                    chained_config: {
                        hop_node: effectiveHop,
                        landing_node_id: effectiveLanding,
                        ...(effectiveHopFallback ? { hop_fallback_node: effectiveHopFallback } : {}),
                    },
                });
                if (provider === "dolaUpload") await saveGenericProxyBinding({ provider, enabled: false });
                else await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else {
                if (provider === "dolaUpload") await updateMagicProxyBinding({ provider, enabled: false });
                else await updateMagicProxyBinding({ provider, enabled: false }).catch(() => undefined);
                await saveGenericProxyBinding({ provider, enabled: true, target: effectiveTarget });
            }
            await load();
            message.success(`${providerLabels[provider]} 代理设置已保存`);
        } catch (saveError) {
            setEnabled(previous.enabled);
            setSource(previous.source);
            const nextError = saveError instanceof Error ? saveError.message : "保存代理设置失败";
            setError(nextError);
            message.error(nextError);
        } finally {
            setSaving(false);
        }
    };

    // 魔法代理模式只需要验证「当前节点能不能用」，复用单节点探测（失败时会给出解析/端口/拨号阶段的具体断点）。
    const handleNodeTest = async () => {
        if (!node) return;
        setTesting(true);
        setNodeTest(null);
        try {
            const result = await testMagicProxyNode(node);
            setNodeTest(result);
            if (typeof result.delay === "number") message.success(`当前节点连通性通过 (${result.delay} ms)`);
            else message.warning(result.error || "当前节点连通性未通过");
        } catch (testError) {
            message.error(testError instanceof Error ? testError.message : "测试当前节点连通性失败");
        } finally {
            setTesting(false);
        }
    };

    const handleGoogleTest = async () => {
        setTesting(true);
        setTestReport(null);
        try {
            const report = provider === "chatgptApi" ? await testChatGptChain() : provider === "dola" ? await testMagicProxyDola() : await testMagicProxyGoogle();
            setTestReport(report);
            const currentItem = report.items.find((i) => i.service === provider) || report.items[0];
            const serviceTarget = provider === "chatgptApi" ? "ChatGPT" : provider === "dola" ? "Dola" : "Google";
            if (currentItem?.ok) {
                message.success(`${providerLabels[provider]} ${serviceTarget} 连通性测试通过 (${currentItem.delay} ms)`);
            } else {
                message.warning(currentItem?.error || `${serviceTarget} 连通性测试未通过，请检查节点状态`);
            }
        } catch (testErr) {
            message.error(testErr instanceof Error ? testErr.message : `测试 ${provider === "chatgptApi" ? "ChatGPT" : provider === "dola" ? "Dola" : "Google"} 连通性失败`);
        } finally {
            setTesting(false);
        }
    };

    const nodeSelectGroups = useMemo(() => {
        // 订阅策略组（如「自动选择」url-test）与节点一样可作为服务出口，自动选优当前最快节点。
        const policyOptions: MagicProxySelectOption[] = (state?.subscriptionGroups || []).map((grp) => {
            const delaySuffix = typeof grp.delay === "number" && grp.delay > 0 ? ` (${grp.delay}ms)` : grp.alive === false ? " (不可用)" : "";
            const nowSuffix = grp.now ? ` · 当前 ${grp.now}` : "";
            return { value: grp.name, label: `${grp.name} · ${grp.type} 自动选优${nowSuffix}${delaySuffix}` };
        });
        const extraGroups: MagicProxySelectGroup[] = policyOptions.length ? [{ label: "订阅策略组", options: policyOptions }] : [];
        return groupMagicProxyOptions(selectableNodes, extraGroups);
    }, [selectableNodes, state?.subscriptionGroups]);

    const nodeOptions = useMemo(() => {
        const groups = nodeSelectGroups.map((grp) => ({ ...grp, options: [...grp.options] }));
        if (node && !flatMagicProxyOptions(groups).some((option) => option.value === node)) {
            groups.unshift({ label: "当前绑定", options: [{ value: node, label: `${node} · 当前绑定` }] });
        }
        return groups;
    }, [node, nodeSelectGroups]);

    const configured = state?.configured === true;
    const runtimeAvailable = state?.runtimeAvailable === true;
    const magicUnavailableReason = !configured ? "请先在魔法代理页面导入订阅" : !runtimeAvailable ? "魔法代理运行时当前不可用" : !nodes.length ? "暂无可用代理节点" : "";
    const genericUnavailableReason = !(genericView?.groups || []).length ? "请先在通用代理页面添加分组或节点" : "";
    const description = provider === "dolaUpload" ? "独立选择 ImageX 的 Apply、二进制上传与 Commit 出口；生成提交继续使用上方 Dola API 出口。" : provider === "geminiTools" ? "仅控制当前 Provider 是否使用代理及其出口来源；GeminiTools 账号列表中的账号启用开关仍保持原有含义。" : "仅控制当前 Provider 是否使用代理及其出口来源。";

    const magicActive = enabled && source === "magic";
    const chainedActive = enabled && source === "chained";

    return (
        <Panel>
            <PanelHeader
                title={`${providerLabels[provider]} · 代理管理`}
                description={description}
                actions={
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-4 p-3 sm:p-4">
                {error ? <Alert type="error" showIcon message="代理绑定读取或保存失败" description={error} /> : null}
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-zinc-950 dark:text-zinc-100">{provider === "dolaUpload" ? "上传出口" : "启用代理"}</span>
                            <Tag color={enabled ? "success" : "default"} className="m-0">
                                {enabled ? "已启用" : provider === "dolaUpload" ? "直连" : "未启用"}
                            </Tag>
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">选择{provider === "dolaUpload" ? "上传出口" : "代理方式"}后仅显示对应配置；保存后立即生效。</p>
                    </div>
                    {provider !== "dolaUpload" ? <div className="shrink-0 pt-0.5">
                        <Switch
                            aria-label="启用代理"
                            checked={enabled}
                            disabled={loading || saving}
                            loading={saving}
                            onChange={(checked) => {
                                if (checked) {
                                    if (source === "magic" && node) {
                                        void persist(true, "magic", { node });
                                        return;
                                    }
                                    if (source === "generic" && target) {
                                        void persist(true, "generic", { target });
                                        return;
                                    }
                                    if (source === "chained" && hopNode && landingNodeId) {
                                        void persist(true, "chained", { hopNode, landingNodeId });
                                        return;
                                    }
                                    setEnabled(true);
                                    message.info("请选择并保存代理出口，保存后自动生效");
                                    return;
                                }
                                void persist(false, source);
                            }}
                        />
                    </div> : null}
                </div>

                <div className="min-w-0">
                    <label htmlFor={`proxy-source-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                        代理方式
                    </label>
                    <Segmented
                        id={`proxy-source-${provider}`}
                        aria-label="代理方式"
                        value={source}
                        disabled={saving}
                        onChange={(value) => persistSourceSwitch(value as ProxySource)}
                        options={[
                            ...(provider === "dolaUpload" ? [{ value: "direct", label: "直连" }] : []),
                            { value: "magic", label: "魔法代理" },
                            { value: "generic", label: "通用代理" },
                            { value: "chained", label: "链式代理" },
                        ]}
                    />
                </div>

                {source === "direct" ? <p className="text-xs text-zinc-500 dark:text-zinc-400">参考图通过服务器网络直连 ImageX，Dola 生成提交仍使用独立设置的出口。</p> : source === "magic" ? (
                    <div className="min-w-0">
                        <label htmlFor={`magic-proxy-node-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                            魔法节点
                        </label>
                        <div className="min-w-0 sm:max-w-sm">
                            <Select
                                id={`magic-proxy-node-${provider}`}
                                aria-label="魔法节点"
                                className="w-full"
                                value={node || undefined}
                                placeholder={magicUnavailableReason || "请选择魔法节点"}
                                options={nodeOptions}
                                showSearch
                                optionFilterProp="label"
                                disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length}
                                onChange={(value: string) => {
                                    setNode(value);
                                    void persist(true, "magic", { node: value });
                                }}
                            />
                        </div>
                        {magicActive && node ? (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                <Button
                                    size="small"
                                    icon={<Zap className="size-3.5 text-amber-500" />}
                                    loading={testing}
                                    disabled={saving || !node}
                                    onClick={() => void handleNodeTest()}
                                >
                                    测试当前节点连通性
                                </Button>
                                {nodeTest ? (
                                    <Tag color={typeof nodeTest.delay === "number" ? "success" : "error"} className="m-0 max-w-full whitespace-normal text-left">
                                        {typeof nodeTest.delay === "number" ? `连通正常 ${nodeTest.delay} ms` : nodeTest.error}
                                    </Tag>
                                ) : null}
                                <span className="text-xs text-zinc-500 dark:text-zinc-400">当前节点已保存，立即生效。</span>
                            </div>
                        ) : null}

                        <label htmlFor={`magic-proxy-fallback-${provider}`} className="mb-1.5 mt-4 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                            兜底节点（可选）
                        </label>
                        <div className="min-w-0 sm:max-w-sm">
                            <Select
                                id={`magic-proxy-fallback-${provider}`}
                                aria-label="兜底节点"
                                className="w-full"
                                value={fallbackNode || undefined}
                                placeholder="主节点失联时自动切换的节点"
                                options={nodeSelectGroups}
                                allowClear
                                showSearch
                                optionFilterProp="label"
                                disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length || !node}
                                onClear={() => {
                                    setFallbackNode("");
                                    void persist(true, "magic", { fallbackNode: "" });
                                }}
                                onChange={(value: string) => {
                                    if (!value) return;
                                    setFallbackNode(value);
                                    void persist(true, "magic", { fallbackNode: value });
                                }}
                            />
                        </div>
                        <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            {magicActive && fallbackNode ? (
                                <span>主节点无法连通时，由 Mihomo 健康检查自动切换到兜底节点，恢复后自动切回主节点。</span>
                            ) : (
                                <span>设置后主节点拨号失败时会自动使用兜底节点接管本次连接，恢复后切回主节点。</span>
                            )}
                        </div>
                    </div>
                ) : source === "generic" ? (
                    <div className="min-w-0">
                        <label htmlFor={`generic-proxy-target-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                            代理管理出口（节点或整组）
                        </label>
                        <div className="min-w-0 sm:max-w-md">
                            <Select
                                id={`generic-proxy-target-${provider}`}
                                aria-label="通用代理出口"
                                className="w-full"
                                value={target || undefined}
                                placeholder={genericUnavailableReason || "选择节点或整组"}
                                options={genericOptions}
                                disabled={loading || saving || Boolean(genericUnavailableReason)}
                                onChange={(value: string) => {
                                    setTarget(value);
                                    void persist(true, "generic", { target: value });
                                }}
                            />
                        </div>
                        {enabled && source === "generic" && target ? (
                            <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">当前出口已保存，立即生效；整组选择时每次请求按容量随机切换节点，单节点固定出口。</div>
                        ) : (
                            <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">选择节点或整组后自动启用通用代理{provider === "geminiai" ? "；GeminiAIStudio 浏览器会话将随出口切换自动重启" : ""}。</div>
                        )}
                    </div>
                ) : (
                    /* 链式代理配置面板 */
                    <div className="space-y-4 rounded-xl border border-sky-100 bg-sky-50/40 p-3.5 dark:border-sky-950/60 dark:bg-sky-950/20 sm:p-4">
                        {/* 拓扑示意图 */}
                        <div className="rounded-lg border border-sky-200/80 bg-white/90 p-3 dark:border-sky-900/60 dark:bg-zinc-900/80">
                            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-sky-800 dark:text-sky-300">
                                <Network className="size-3.5 text-sky-600 dark:text-sky-400" />
                                <span>链式代理数据链路 (dialer-proxy 级联拓扑)</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                                <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{providerLabels[provider]}</span>
                                <ArrowRight className="size-3 text-sky-500 shrink-0" />
                                <span className="rounded bg-sky-100 px-2 py-0.5 font-medium text-sky-800 dark:bg-sky-900/60 dark:text-sky-200">跳板: {hopNode || "未选择魔法节点"}</span>
                                <ArrowRight className="size-3 text-sky-500 shrink-0" />
                                <span className="rounded bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200">
                                    落地: {landingOptions.find((o) => o.value === landingNodeId)?.label.split(" · ")[0] || "未选择通用落地节点"}
                                </span>
                                <ArrowRight className="size-3 text-sky-500 shrink-0" />
                                <span className="rounded bg-purple-100 px-2 py-0.5 font-medium text-purple-800 dark:bg-purple-900/60 dark:text-purple-200">{provider === "chatgptApi" ? "ChatGPT 官方服务" : provider === "dolaUpload" ? "ImageX 上传服务" : provider === "dola" ? "Dola 官方服务" : "Google 官方服务"}</span>
                            </div>
                            <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                                💡 <strong>工作原理</strong>：国内服务器经由 Clash 加密隧道出海连接至境外跳板节点，跳板节点在境外直连 IPWO 等住宅代理落地并鉴权，彻底规避运营商防火墙重置阻断 (curl 56)，获得纯净住宅出口。
                            </div>
                        </div>

                        {/* 跳板与落地选择网格 */}
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="min-w-0">
                                <label htmlFor={`chained-hop-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                    1. 前置跳板节点 (魔法代理 / Clash 专线)
                                </label>
                                <Select
                                    id={`chained-hop-${provider}`}
                                    aria-label="跳板节点"
                                    className="w-full"
                                    value={hopNode || undefined}
                                    placeholder={magicUnavailableReason || "请选择跳板节点 (如香港/新加坡专线)"}
                                    options={hopOptions}
                                    showSearch
                                    optionFilterProp="label"
                                    disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length}
                                    onChange={(value: string) => setHopNode(value)}
                                />
                                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">流量第一跳：通过加密隧道出海，建议选择低延迟专线。</div>
                                <label htmlFor={`chained-hop-fallback-${provider}`} className="mb-1.5 mt-3 block text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                    跳板兜底节点（可选）
                                </label>
                                <Select
                                    id={`chained-hop-fallback-${provider}`}
                                    aria-label="跳板兜底节点"
                                    className="w-full"
                                    value={hopFallbackNode || undefined}
                                    placeholder="跳板失联时自动切换的备用跳板"
                                    options={hopSelectGroups}
                                    allowClear
                                    showSearch
                                    optionFilterProp="label"
                                    disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length || !hopNode}
                                    onClear={() => {
                                        setHopFallbackNode("");
                                        void persist(true, "chained", { hopNode, hopFallbackNode: "", landingNodeId });
                                    }}
                                    onChange={(value: string) => {
                                        if (!value) return;
                                        setHopFallbackNode(value);
                                        void persist(true, "chained", { hopNode, hopFallbackNode: value, landingNodeId });
                                    }}
                                />
                                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">设置后跳板拨号失败时由内核自动切到备用跳板，恢复后切回主跳板。</div>
                            </div>

                            <div className="min-w-0">
                                <label htmlFor={`chained-landing-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-800 dark:text-zinc-200">
                                    2. 后置落地出口 (通用代理 / IPWO 节点)
                                </label>
                                <Select
                                    id={`chained-landing-${provider}`}
                                    aria-label="落地节点"
                                    className="w-full"
                                    value={landingNodeId || undefined}
                                    placeholder={genericUnavailableReason || "请选择通用代理落地节点"}
                                    options={landingOptions}
                                    disabled={loading || saving || !landingOptions.length}
                                    onChange={(value: string) => setLandingNodeId(value)}
                                />
                                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">流量终点站：由境外跳板连接此节点，最终以该纯净住宅 IP 访问 {provider === "chatgptApi" ? "ChatGPT" : provider === "dolaUpload" ? "ImageX" : provider === "dola" ? "Dola" : "Google"}。</div>
                            </div>
                        </div>

                        {/* 保存与测试操作栏 */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                            <div className="flex items-center gap-2">
                                <Tag color={chainedActive ? "success" : "default"} className="m-0">
                                    {chainedActive ? "链式代理生效中" : "链式代理未启用"}
                                </Tag>
                                {chainedActive ? (
                                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                                        <ShieldCheck className="size-3.5" />
                                        <span>已接管 {providerLabels[provider]} 出站流量</span>
                                    </span>
                                ) : null}
                            </div>
                            <div className="flex items-center gap-2.5">
                                {provider !== "dolaUpload" ? <Button
                                    icon={<Zap className="size-3.5 text-amber-500" />}
                                    loading={testing}
                                    disabled={saving || !hopNode || !landingNodeId}
                                    onClick={() => void handleGoogleTest()}
                                    className="h-9 px-3.5 rounded-lg border-purple-200/80 bg-white text-zinc-800 hover:!border-purple-400 hover:!text-purple-700 hover:bg-purple-50/50 dark:border-purple-900/60 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:!border-purple-500 dark:hover:!text-purple-300 font-medium text-xs sm:text-sm shadow-sm transition-all"
                                >
                                    测试 {provider === "chatgptApi" ? "ChatGPT" : provider === "dola" ? "Dola" : "Google"} 连通性
                                </Button> : null}
                                <Button
                                    type="primary"
                                    icon={<CheckCircle2 className="size-3.5" />}
                                    loading={saving}
                                    disabled={!hopNode || !landingNodeId}
                                    onClick={() => void persist(true, "chained", { hopNode, landingNodeId })}
                                    className="h-9 px-4 rounded-lg font-medium text-xs sm:text-sm !border-0 text-white shadow-[0_4px_14px_rgba(110,83,246,0.38)] hover:shadow-[0_6px_20px_rgba(110,83,246,0.48)] hover:brightness-105 active:scale-[0.98] transition-all"
                                    style={
                                        (!hopNode || !landingNodeId || saving)
                                            ? undefined
                                            : {
                                                background: "linear-gradient(125deg, #4e46e9, #6e53f6 55%, #8979ff)",
                                                border: "none",
                                                color: "#ffffff",
                                            }
                                    }
                                >
                                    保存并启用链式代理
                                </Button>
                            </div>
                        </div>

                        {/* 连通性测试结果面板 */}
                        {provider !== "dolaUpload" && testReport ? (
                            <div className="mt-2 rounded-lg border border-zinc-200/80 bg-white/80 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/80">
                                <div className="font-medium text-zinc-800 dark:text-zinc-200">
                                    {provider === "chatgptApi" ? "ChatGPT" : provider === "dola" ? "Dola" : "Google"} 连通性测试报告 ({testReport.testedAt}):
                                </div>
                                <div className="mt-1.5 space-y-1">
                                    {testReport.items
                                        .filter((i) => i.service === provider)
                                        .map((item) => (
                                            <div key={item.service} className="flex items-center justify-between">
                                                <span className="text-zinc-600 dark:text-zinc-400">
                                                    {item.serviceTitle} ({item.group} ➔ {item.activeNode}):
                                                </span>
                                                {item.ok ? <span className="font-medium text-emerald-600 dark:text-emerald-400">连通正常 · 延迟 {item.delay} ms</span> : <span className="font-medium text-rose-500">异常: {item.error || "连接超时"}</span>}
                                            </div>
                                        ))}
                                </div>
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
        </Panel>
    );
}

export function magicProxyNodeOption(node: MagicProxyNode) {
    let delaySuffix = "";
    if (typeof node.delay === "number" && node.delay > 0) {
        delaySuffix = ` (${node.delay}ms)`;
    } else if (node.alive === false) {
        delaySuffix = " (不可用)";
    }
    const subPrefix = node.subscriptionName ? `[${node.subscriptionName}] ` : "";
    return { value: node.name, label: `${subPrefix}${node.name} · ${node.type}${delaySuffix}` };
}

type MagicProxySelectOption = { value: string; label: string };
type MagicProxySelectGroup = { label: string; options: MagicProxySelectOption[] };

/** 节点数量随订阅增长，按订阅分组并支持搜索，避免平铺长列表难以选择。 */
export function groupMagicProxyOptions(nodes: MagicProxyNode[], extraGroups: MagicProxySelectGroup[] = []): MagicProxySelectGroup[] {
    const bySub = new Map<string, MagicProxySelectOption[]>();
    for (const item of nodes) {
        const key = item.subscriptionName || "未分组订阅";
        if (!bySub.has(key)) bySub.set(key, []);
        bySub.get(key)!.push(magicProxyNodeOption(item));
    }
    return [...extraGroups, ...[...bySub.entries()].map(([label, options]) => ({ label, options }))];
}

export function flatMagicProxyOptions(groups: MagicProxySelectGroup[]): MagicProxySelectOption[] {
    return groups.flatMap((grp) => grp.options);
}
