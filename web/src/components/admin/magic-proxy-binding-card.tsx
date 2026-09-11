"use client";

import { Alert, App, Button, Select, Segmented, Switch, Tag } from "antd";
import { ArrowRight, CheckCircle2, Network, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import {
    getMagicProxy,
    testMagicProxyGoogle,
    updateMagicProxyBinding,
    type MagicProxyGoogleTestReport,
    type MagicProxyNode,
    type MagicProxyProvider,
    type MagicProxyState,
} from "@/services/api/magic-proxy";
import {
    genericProxyRequest,
    getGenericProxyBindings,
    saveGenericProxyBinding,
    type ChatGptProxyView,
    type GenericProxyBindings,
} from "@/services/api/generic-proxy";

const providerLabels: Record<MagicProxyProvider, string> = {
    geminiai: "GeminiAIStudio",
    geminiTools: "GeminiTools",
    chatgptApi: "GPTAPI",
};

export function magicProxyBindingValidationMessage(enabled: boolean, node?: string) {
    return enabled && !node?.trim() ? "启用魔法代理前请选择代理节点" : "";
}

type ProxySource = "magic" | "generic" | "chained";

export function MagicProxyBindingCard({ provider }: { provider: MagicProxyProvider }) {
    const { message } = App.useApp();
    const [state, setState] = useState<MagicProxyState | null>(null);
    const [genericBindings, setGenericBindings] = useState<GenericProxyBindings | null>(null);
    const [genericView, setGenericView] = useState<ChatGptProxyView | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [source, setSource] = useState<ProxySource>("magic");
    const [node, setNode] = useState("");
    const [target, setTarget] = useState("");
    const [hopNode, setHopNode] = useState("");
    const [landingNodeId, setLandingNodeId] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testReport, setTestReport] = useState<MagicProxyGoogleTestReport | null>(null);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [nextState, nextGeneric, nextGenericView] = await Promise.all([
                getMagicProxy(),
                getGenericProxyBindings().catch(() => null),
                genericProxyRequest<ChatGptProxyView>("proxies").catch(() => null),
            ]);
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
                setSource("magic");
                setEnabled(false);
            }

            setNode(magicBinding?.node || "");
            setTarget(genericBinding?.target || "");
            setHopNode(magicBinding?.chained_config?.hop_node || "");
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
                    label: `${item.name || item.id} · ${item.url} [${group.name}]`,
                });
            }
        }
        if (landingNodeId && !options.some((item) => item.value === landingNodeId)) {
            options.unshift({ value: landingNodeId, label: `节点 ${landingNodeId} (当前配置)` });
        }
        return options;
    }, [genericView?.groups, landingNodeId]);

    // 跳板节点选项列表（从 Clash 订阅中选取）
    const nodes = state?.nodes || [];
    const hopOptions = useMemo(() => {
        const options = nodes.map((item: MagicProxyNode) => ({
            value: item.name,
            label: `${item.name} (${item.type})`,
        }));
        if (hopNode && !options.some((item) => item.value === hopNode)) {
            options.unshift({ value: hopNode, label: `${hopNode} (当前配置)` });
        }
        return options;
    }, [hopNode, nodes]);

    const persistSourceSwitch = (nextSource: ProxySource) => {
        // 允许直接切入对应视图进行配置，不作前置报错阻断
        setSource(nextSource);
    };

    const persist = async (
        nextEnabled: boolean,
        nextSource: ProxySource,
        overrides: { node?: string; target?: string; hopNode?: string; landingNodeId?: string } = {}
    ) => {
        const effectiveNode = overrides.node ?? node;
        const effectiveTarget = overrides.target ?? target;
        const effectiveHop = overrides.hopNode ?? hopNode;
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
                await updateMagicProxyBinding({ provider, enabled: false }).catch(() => undefined);
                await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else if (nextSource === "magic") {
                await updateMagicProxyBinding({ provider, enabled: true, mode: "magic", node: effectiveNode });
                await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else if (nextSource === "chained") {
                await updateMagicProxyBinding({
                    provider,
                    enabled: true,
                    mode: "chained",
                    chained_config: {
                        hop_node: effectiveHop,
                        landing_node_id: effectiveLanding,
                    },
                });
                await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else {
                await updateMagicProxyBinding({ provider, enabled: false }).catch(() => undefined);
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

    const handleGoogleTest = async () => {
        setTesting(true);
        setTestReport(null);
        try {
            const report = await testMagicProxyGoogle();
            setTestReport(report);
            const currentItem = report.items.find((i) => i.service === provider);
            if (currentItem?.ok) {
                message.success(`${providerLabels[provider]} Google 连通性测试通过 (${currentItem.delay} ms)`);
            } else {
                message.warning(currentItem?.error || "Google 连通性测试未通过，请检查节点状态");
            }
        } catch (testErr) {
            message.error(testErr instanceof Error ? testErr.message : "测试 Google 连通性失败");
        } finally {
            setTesting(false);
        }
    };

    const nodeOptions = useMemo(() => {
        const options = nodes.map((item: MagicProxyNode) => ({ value: item.name, label: `${item.name} · ${item.type}` }));
        if (node && !options.some((option) => option.value === node)) options.unshift({ value: node, label: `${node} · 当前绑定` });
        return options;
    }, [node, nodes]);

    const configured = state?.configured === true;
    const runtimeAvailable = state?.runtimeAvailable === true;
    const magicUnavailableReason = !configured ? "请先在魔法代理页面导入订阅" : !runtimeAvailable ? "魔法代理运行时当前不可用" : !nodes.length ? "暂无可用代理节点" : "";
    const genericUnavailableReason = !(genericView?.groups || []).length ? "请先在通用代理页面添加分组或节点" : "";
    const description = provider === "geminiTools" ? "仅控制当前 Provider 是否使用代理及其出口来源；GeminiTools 账号列表中的账号启用开关仍保持原有含义。" : "仅控制当前 Provider 是否使用代理及其出口来源。";

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
                            <span className="text-sm font-medium text-zinc-950 dark:text-zinc-100">启用代理</span>
                            <Tag color={enabled ? "success" : "default"} className="m-0">
                                {enabled ? "已启用" : "未启用"}
                            </Tag>
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">选择代理方式后仅显示所选方式的配置内容；配置并保存后立即生效。</p>
                    </div>
                    <div className="shrink-0 pt-0.5">
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
                    </div>
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
                            { value: "magic", label: "魔法代理" },
                            { value: "generic", label: "通用代理" },
                            { value: "chained", label: "链式代理" },
                        ]}
                    />
                </div>

                {source === "magic" ? (
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
                                disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length}
                                onChange={(value: string) => {
                                    setNode(value);
                                    void persist(true, "magic", { node: value });
                                }}
                            />
                        </div>
                        {magicActive && node ? <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">当前节点已保存，立即生效。</div> : null}
                    </div>
                ) : source === "generic" ? (
                    <div className="min-w-0">
                        <label htmlFor={`generic-proxy-target-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                            通用代理出口（节点或整组）
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
                                <span className="rounded bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                                    {providerLabels[provider]}
                                </span>
                                <ArrowRight className="size-3 text-sky-500 shrink-0" />
                                <span className="rounded bg-sky-100 px-2 py-0.5 font-medium text-sky-800 dark:bg-sky-900/60 dark:text-sky-200">
                                    跳板: {hopNode || "未选择魔法节点"}
                                </span>
                                <ArrowRight className="size-3 text-sky-500 shrink-0" />
                                <span className="rounded bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200">
                                    落地: {landingOptions.find((o) => o.value === landingNodeId)?.label.split(" · ")[0] || "未选择通用落地节点"}
                                </span>
                                <ArrowRight className="size-3 text-sky-500 shrink-0" />
                                <span className="rounded bg-purple-100 px-2 py-0.5 font-medium text-purple-800 dark:bg-purple-900/60 dark:text-purple-200">
                                    Google 官方服务
                                </span>
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
                                    disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length}
                                    onChange={(value: string) => setHopNode(value)}
                                />
                                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                                    流量第一跳：通过加密隧道出海，建议选择低延迟专线。
                                </div>
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
                                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                                    流量终点站：由境外跳板连接此节点，最终以该纯净住宅 IP 访问 Google。
                                </div>
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
                            <div className="flex items-center gap-2">
                                <Button
                                    size="small"
                                    icon={<Zap className="size-3.5 text-amber-500" />}
                                    loading={testing}
                                    disabled={saving || !hopNode || !landingNodeId}
                                    onClick={() => void handleGoogleTest()}
                                >
                                    测试 Google 连通性
                                </Button>
                                <Button
                                    type="primary"
                                    size="small"
                                    icon={<CheckCircle2 className="size-3.5" />}
                                    loading={saving}
                                    disabled={!hopNode || !landingNodeId}
                                    onClick={() => void persist(true, "chained", { hopNode, landingNodeId })}
                                >
                                    保存并启用链式代理
                                </Button>
                            </div>
                        </div>

                        {/* Google 连通性测试结果面板 */}
                        {testReport ? (
                            <div className="mt-2 rounded-lg border border-zinc-200/80 bg-white/80 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/80">
                                <div className="font-medium text-zinc-800 dark:text-zinc-200">
                                    Google 连通性测试报告 ({testReport.testedAt}):
                                </div>
                                <div className="mt-1.5 space-y-1">
                                    {testReport.items
                                        .filter((i) => i.service === provider)
                                        .map((item) => (
                                            <div key={item.service} className="flex items-center justify-between">
                                                <span className="text-zinc-600 dark:text-zinc-400">
                                                    {item.serviceTitle} ({item.group} ➔ {item.activeNode}):
                                                </span>
                                                {item.ok ? (
                                                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                                        连通正常 · 延迟 {item.delay} ms
                                                    </span>
                                                ) : (
                                                    <span className="font-medium text-rose-500">
                                                        异常: {item.error || "连接超时"}
                                                    </span>
                                                )}
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
    return { value: node.name, label: `${node.name} · ${node.type}` };
}
