"use client";

import { Alert, App, Button, Card, Divider, Select, Space, Spin, Tag, Typography } from "antd";
import { ArrowRight, CheckCircle2, Network, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getMagicProxy, type MagicProxyState } from "@/services/api/magic-proxy";
import { getChatGptProxies, testChatGptProxyNode, type ChatGptProxyGroup, type ChatGptProxyNodeTestResult, type ChatGptProxyReference, type ChatGptProxyView } from "@/services/api/chatgpt-api";
import { genericProxyRequest } from "@/services/api/generic-proxy";
import type { ChatGptProxyRuntimeController } from "./use-chatgpt-proxy-runtime";

const { Text } = Typography;

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

export function ChatGptChainedProxyPanel({ proxyRuntime }: { proxyRuntime: ChatGptProxyRuntimeController }) {
    const { message } = App.useApp();
    const [magicState, setMagicState] = useState<MagicProxyState | null>(null);
    const [genericGroups, setGenericGroups] = useState<ChatGptProxyGroup[]>([]);
    const [hopNode, setHopNode] = useState("");
    const [landingNodeId, setLandingNodeId] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<ChatGptProxyNodeTestResult | null>(null);
    const [error, setError] = useState("");
    const mounted = useRef(false);

    const load = useCallback(async () => {
        if (mounted.current) {
            setLoading(true);
            setError("");
        }
        try {
            const [nextMagic, genericData] = await Promise.all([
                getMagicProxy().catch(() => null),
                getChatGptProxies().catch(() => genericProxyRequest<ChatGptProxyView>("proxies").catch(() => null)),
            ]);
            if (!mounted.current) return;
            setMagicState(nextMagic);
            const groups = genericData?.groups || (genericData as { proxy_groups?: ChatGptProxyGroup[] } | null)?.proxy_groups || [];
            setGenericGroups(groups);

            const currentHop = proxyRuntime.runtime?.chained_config?.hop_magic_node_name || nextMagic?.bindings.chatgptApi?.node || "";
            const currentLanding = proxyRuntime.runtime?.chained_config?.landing_generic_node_id || "";
            setHopNode(currentHop);
            setLandingNodeId(currentLanding);
        } catch (reason) {
            if (mounted.current) setError(errorMessage(reason, "读取链式代理配置依赖失败"));
        } finally {
            if (mounted.current) setLoading(false);
        }
    }, [proxyRuntime.runtime?.chained_config]);

    useEffect(() => {
        mounted.current = true;
        void load();
        return () => {
            mounted.current = false;
        };
    }, [load]);

    // 跳板节点选项（Clash 订阅中的魔法节点）
    const hopOptions = useMemo(() => {
        const options = (magicState?.nodes || []).map((item) => ({
            value: item.name,
            label: `${item.name} (${item.type})`,
        }));
        if (hopNode && !options.some((item) => item.value === hopNode)) {
            options.unshift({ value: hopNode, label: `${hopNode} (当前保存)` });
        }
        return options;
    }, [hopNode, magicState?.nodes]);

    // 落地出口选项（通用代理节点列表，平铺全部组内节点与 IPWO 节点）
    const landingOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const group of genericGroups) {
            for (const node of group.nodes || []) {
                const nodeName = node.name || node.id;
                const nodeAddress = node.url || "";
                options.push({
                    value: node.id,
                    label: nodeAddress ? `${nodeName} · ${nodeAddress} [${group.name}]` : `${nodeName} [${group.name}]`,
                });
            }
        }
        if (landingNodeId && !options.some((item) => item.value === landingNodeId)) {
            options.unshift({ value: landingNodeId, label: `节点 ${landingNodeId} (当前配置)` });
        }
        return options;
    }, [landingNodeId, genericGroups]);

    // 选中的落地节点展示名
    const selectedLandingName = useMemo(() => {
        const match = landingOptions.find((opt) => opt.value === landingNodeId);
        return match ? match.label : landingNodeId || "未指定落地出口";
    }, [landingOptions, landingNodeId]);

    const canSave = Boolean(hopNode.trim() && landingNodeId.trim());

    const handleSave = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        setError("");
        try {
            await proxyRuntime.save({
                enabled: true,
                mode: "chained",
                native_source: proxyRuntime.runtime?.native_source || "manual",
                chained_config: {
                    hop_magic_node_name: hopNode.trim(),
                    landing_generic_node_id: landingNodeId.trim(),
                },
            });
            message.success("链式代理配置已保存并同步至 Mihomo 运行时");
        } catch (reason) {
            const nextErr = errorMessage(reason, "保存链式代理配置失败");
            setError(nextErr);
            message.error(nextErr);
        } finally {
            if (mounted.current) setSaving(false);
        }
    };

    const handleTest = async () => {
        if (!landingNodeId.trim() || testing) return;
        setTesting(true);
        setTestResult(null);
        setError("");
        try {
            const selectedNode = genericGroups.flatMap((group) => group.nodes || []).find((node) => node.id === landingNodeId.trim());
            const selectedGroup = genericGroups.find((group) => group.nodes?.some((node) => node.id === landingNodeId.trim()));
            if (!selectedNode || !selectedGroup) throw new Error("落地节点所属代理组不存在，请刷新后重试");
            const res = await testChatGptProxyNode(selectedGroup.id, selectedNode.id, 15000, true);
            if (!mounted.current) return;
            setTestResult(res.result);
            if (res.result.status === "passed") {
                message.success(`连通性测试成功：延迟 ${res.result.latency_ms} ms`);
            } else {
                message.warning(`连通性测试未通过：${res.result.error_message || "响应异常"}`);
            }
        } catch (reason) {
            if (mounted.current) {
                const nextErr = errorMessage(reason, "测试连通性请求失败");
                setError(nextErr);
                message.error(nextErr);
            }
        } finally {
            if (mounted.current) setTesting(false);
        }
    };

    return (
        <Panel>
            <PanelHeader
                title="链式代理 (Chained Proxy) 架构配置"
                description="采用「魔法代理加密跳板 ➔ 通用代理 (IPWO) 落地出口」的级联隧道模式，彻底消除国内机房或本地服务器直连海外代理端口遭阻断的 Connection reset 报错，并获得住宅 IP 极高防封纯净度。"
            />
            <div className="space-y-6 p-4 sm:p-6">
                {/* 链路示意拓扑卡片 */}
                <div className="rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50/60 via-indigo-50/40 to-slate-50/60 p-4 dark:border-blue-900/40 dark:from-blue-950/20 dark:via-indigo-950/20 dark:to-zinc-900/30">
                    <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Network className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                            <span className="text-xs font-semibold tracking-wide text-blue-900 dark:text-blue-200">
                                链式级联数据流向 (dialer-proxy 拓扑)
                            </span>
                        </div>
                        <Tag color="blue" className="m-0 text-xs">自动热重载生效</Tag>
                    </div>
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between text-xs text-zinc-700 dark:text-zinc-300">
                        <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 shadow-xs dark:bg-zinc-800/80">
                            <Zap className="h-3.5 w-3.5 text-amber-500" />
                            <span>ChatGPT API 进程</span>
                        </div>
                        <ArrowRight className="hidden h-4 w-4 text-zinc-400 md:block" />
                        <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 shadow-xs dark:bg-zinc-800/80">
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                            <span>
                                跳板：{hopNode ? <strong className="text-blue-600 dark:text-blue-400">{hopNode}</strong> : <span className="text-zinc-400">未选跳板</span>}
                            </span>
                        </div>
                        <ArrowRight className="hidden h-4 w-4 text-zinc-400 md:block" />
                        <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 shadow-xs dark:bg-zinc-800/80">
                            <CheckCircle2 className="h-3.5 w-3.5 text-indigo-500" />
                            <span className="max-w-[200px] truncate" title={selectedLandingName}>
                                落地：{landingNodeId ? <strong className="text-indigo-600 dark:text-indigo-400">{selectedLandingName}</strong> : <span className="text-zinc-400">未选落地</span>}
                            </span>
                        </div>
                        <ArrowRight className="hidden h-4 w-4 text-zinc-400 md:block" />
                        <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 shadow-xs dark:bg-zinc-800/80">
                            <span className="font-medium text-emerald-600 dark:text-emerald-400">OpenAI 官方网关</span>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="flex h-36 items-center justify-center">
                        <Spin tip="正在载入可用跳板与落地节点..." />
                    </div>
                ) : (
                    <div className="grid gap-6 md:grid-cols-2">
                        {/* 步骤 1：配置跳板节点 */}
                        <Card size="small" className="border-zinc-200 dark:border-zinc-800">
                            <div className="space-y-3">
                                <div>
                                    <div className="flex items-center justify-between">
                                        <Text strong className="text-sm">第一步：选择前置跳板 (魔法节点)</Text>
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<RefreshCw className="h-3 w-3" />}
                                            onClick={() => void load()}
                                        >
                                            刷新
                                        </Button>
                                    </div>
                                    <p className="mt-1 text-xs text-zinc-500">
                                        由 Clash 订阅中的海外专线（如香港、日本）作为跳板，负责在本地服务器与海外之间建立稳定加密通道。
                                    </p>
                                </div>
                                <Select
                                    placeholder="请选择跳板节点 (Clash 订阅)"
                                    className="w-full"
                                    value={hopNode || undefined}
                                    onChange={(val) => setHopNode(val)}
                                    options={hopOptions}
                                    showSearch
                                    filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
                                />
                                {!magicState?.nodes.length ? (
                                    <Alert
                                        type="warning"
                                        showIcon
                                        className="text-xs"
                                        title="暂无可用魔法节点，请先在「上游配置 ➔ 魔法代理」导入 Clash 订阅。"
                                    />
                                ) : null}
                            </div>
                        </Card>

                        {/* 步骤 2：配置落地节点 */}
                        <Card size="small" className="border-zinc-200 dark:border-zinc-800">
                            <div className="space-y-3">
                                <div>
                                    <div className="flex items-center justify-between">
                                        <Text strong className="text-sm">第二步：选择后置落地出口 (通用代理/IPWO)</Text>
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<RefreshCw className="h-3 w-3" />}
                                            onClick={() => void load()}
                                        >
                                            刷新
                                        </Button>
                                    </div>
                                    <p className="mt-1 text-xs text-zinc-500">
                                        选择在「通用代理」中添加的 IPWO 动态住宅节点或其他代理节点作为真实对外出口。
                                    </p>
                                </div>
                                <Select
                                    placeholder="请选择落地节点 (通用代理/IPWO)"
                                    className="w-full"
                                    value={landingNodeId || undefined}
                                    onChange={(val) => {
                                        setLandingNodeId(val);
                                        setTestResult(null);
                                    }}
                                    options={landingOptions}
                                    showSearch
                                    filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
                                />
                                {!landingOptions.length ? (
                                    <Alert
                                        type="warning"
                                        showIcon
                                        className="text-xs"
                                        title="暂无可用通用代理节点，请先在「上游配置 ➔ 通用代理」添加 IPWO 或 HTTP/SOCKS5 节点。"
                                    />
                                ) : null}
                            </div>
                        </Card>
                    </div>
                )}

                {error ? <Alert type="error" showIcon title={error} /> : null}

                {/* 连通性测试报告区域 */}
                {testResult ? (
                    <div className="rounded-lg border border-zinc-200 p-4 text-xs dark:border-zinc-800">
                        <div className="flex items-center justify-between">
                            <span className="font-medium">连通性测试反馈：</span>
                            <Tag color={testResult.status === "passed" ? "success" : "error"}>
                                {testResult.status === "passed" ? "连通正常" : "测试未通过"}
                            </Tag>
                        </div>
                        <div className="mt-2 space-y-1 text-zinc-600 dark:text-zinc-400">
                            <div>耗时延迟：<strong>{testResult.latency_ms} ms</strong></div>
                            {testResult.details?.target_url ? <div>目标验证地址：{testResult.details.target_url}</div> : null}
                            {testResult.error_message ? <div className="text-red-500">错误详情：{testResult.error_message}</div> : null}
                        </div>
                    </div>
                ) : null}

                {/* 底部操作控制区 */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                    <div className="text-xs text-zinc-500">
                        当前状态：{proxyRuntime.runtime?.mode === "chained" && proxyRuntime.runtime.enabled ? (
                            <Tag color="success" className="ml-1">链式代理运行中</Tag>
                        ) : (
                            <Tag color="default" className="ml-1">未启用链式代理</Tag>
                        )}
                    </div>
                    <Space>
                        <Button
                            onClick={() => void handleTest()}
                            loading={testing}
                            disabled={!landingNodeId || testing}
                        >
                            测试落地节点
                        </Button>
                        <Button
                            type="primary"
                            onClick={() => void handleSave()}
                            loading={saving || proxyRuntime.saving}
                            disabled={!canSave || saving || proxyRuntime.saving}
                        >
                            保存并启用链式代理
                        </Button>
                    </Space>
                </div>
            </div>
        </Panel>
    );
}
