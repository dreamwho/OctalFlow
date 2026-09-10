"use client";

import { Alert, App, Button, Empty, Input, Tag } from "antd";
import { FileText, Gauge, Globe, RefreshCw, ShieldCheck, Terminal, Upload, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { MagicProxyTestModal } from "@/components/admin/magic-proxy-test-modal";
import { getMagicProxy, importMagicProxySubscription, refreshMagicProxySubscription, testMagicProxyAllNodes, testMagicProxyNode, type MagicProxyDelayResult, type MagicProxyGroup, type MagicProxyNode, type MagicProxyState } from "@/services/api/magic-proxy";

export function AdminMagicProxySection() {
    const { message } = App.useApp();
    const [state, setState] = useState<MagicProxyState | null>(null);
    const [subscriptionUrl, setSubscriptionUrl] = useState("");
    const [subscriptionFile, setSubscriptionFile] = useState<File | null>(null);
    const subscriptionFileInputRef = useRef<HTMLInputElement>(null);
    const [loading, setLoading] = useState(true);
    const [action, setAction] = useState<"import" | "file-import" | "refresh" | "">("");
    const [error, setError] = useState("");
    const [delayResults, setDelayResults] = useState<Record<string, MagicProxyDelayResult>>({});
    const [testingNode, setTestingNode] = useState("");
    const [testingAll, setTestingAll] = useState(false);
    const [testModalOpen, setTestModalOpen] = useState(false);
    const [testModalAutoStart, setTestModalAutoStart] = useState(false);
    const [testModalGoogle, setTestModalGoogle] = useState(false);

    const runNodeDelayTest = async (node: string) => {
        if (!node || testingAll || testingNode) return;
        setTestingNode(node);
        try {
            const result = await testMagicProxyNode(node);
            setDelayResults((prev) => ({ ...prev, [node]: result }));
            if (result.error) message.warning(`${node}：${result.error}`);
        } catch (testError) {
            message.error(testError instanceof Error ? testError.message : "节点测速失败");
        } finally {
            setTestingNode("");
        }
    };

    const runAllDelayTest = async () => {
        if (testingAll || testingNode) return;
        setTestingAll(true);
        try {
            const { results } = await testMagicProxyAllNodes();
            setDelayResults((prev) => ({ ...prev, ...Object.fromEntries(results.map((item) => [item.name, item])) }));
            const failed = results.filter((item) => item.error).length;
            if (failed) message.warning(`测速完成：${results.length - failed} 个节点可用，${failed} 个失败`);
            else message.success(`测速完成：${results.length} 个节点全部可用`);
        } catch (testError) {
            message.error(testError instanceof Error ? testError.message : "节点测速失败");
        } finally {
            setTestingAll(false);
        }
    };

    const loadState = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setState(await getMagicProxy());
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "读取魔法代理状态失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadState();
    }, [loadState]);

    const importSubscription = async () => {
        const url = subscriptionUrl.trim();
        if (!url) {
            message.error("请输入订阅地址");
            return;
        }
        setAction("import");
        setError("");
        try {
            setState(await importMagicProxySubscription(url));
            setSubscriptionUrl("");
            message.success("魔法代理订阅已导入并替换");
        } catch (importError) {
            const nextError = importError instanceof Error ? importError.message : "导入魔法代理订阅失败";
            setError(nextError);
            message.error(nextError);
        } finally {
            setAction("");
        }
    };

    const importSubscriptionFile = async () => {
        if (!subscriptionFile) {
            message.error("请选择 YAML 或文本文件");
            return;
        }
        setAction("file-import");
        setError("");
        try {
            const content = await subscriptionFile.text();
            setState(await importMagicProxySubscription({ content }));
            setSubscriptionFile(null);
            if (subscriptionFileInputRef.current) subscriptionFileInputRef.current.value = "";
            message.success("魔法代理文件订阅已导入并替换");
        } catch (importError) {
            const nextError = importError instanceof Error ? importError.message : "导入魔法代理文件失败";
            setError(nextError);
            message.error(nextError);
        } finally {
            setAction("");
        }
    };

    const refreshSubscription = async () => {
        setAction("refresh");
        setError("");
        try {
            setState(await refreshMagicProxySubscription());
            message.success("魔法代理订阅已更新");
        } catch (refreshError) {
            const nextError = refreshError instanceof Error ? refreshError.message : "更新魔法代理订阅失败";
            setError(nextError);
            message.error(nextError);
        } finally {
            setAction("");
        }
    };

    const nodeCount = state?.nodeCount ?? state?.nodes.length ?? 0;

    return (
        <div className="space-y-4">
            {error ? (
                <Alert
                    type="error"
                    showIcon
                    message="魔法代理操作失败"
                    description={error}
                    action={
                        <Button size="small" onClick={() => void loadState()}>
                            重试
                        </Button>
                    }
                />
            ) : null}

            <Panel>
                <PanelHeader
                    title="魔法代理"
                    description="导入或更新订阅，并查看当前运行时状态、分组和节点。GeminiAIStudio 与 GeminiTools 的节点绑定请分别在各自 Provider 页面设置。"
                    actions={
                        <Button icon={<RefreshCw className="size-4" />} loading={loading && !action} onClick={() => void loadState()}>
                            刷新状态
                        </Button>
                    }
                />
                <div className="space-y-4 p-3 sm:p-5">
                    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                        <div className="min-w-0">
                            <label htmlFor="magic-proxy-subscription" className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                订阅地址导入
                            </label>
                            <Input.Password id="magic-proxy-subscription" value={subscriptionUrl} autoComplete="new-password" placeholder="输入订阅地址，导入后不会回显" onChange={(event) => setSubscriptionUrl(event.target.value)} />
                            <div className="mt-3 flex min-w-0 flex-wrap gap-2">
                                <Button type="primary" icon={<ShieldCheck className="size-4" />} loading={action === "import"} onClick={() => void importSubscription()}>
                                    导入/替换订阅
                                </Button>
                            </div>
                        </div>
                        <div className="min-w-0">
                            <label htmlFor="magic-proxy-subscription-file" className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                YAML / 文本文件导入
                            </label>
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <input
                                    ref={subscriptionFileInputRef}
                                    id="magic-proxy-subscription-file"
                                    type="file"
                                    accept=".yaml,.yml,.txt,text/yaml,text/plain"
                                    className="sr-only"
                                    onChange={(event) => setSubscriptionFile(event.target.files?.[0] || null)}
                                />
                                <Button icon={<Upload className="size-4" />} onClick={() => subscriptionFileInputRef.current?.click()}>
                                    选择文件
                                </Button>
                                <span className="min-w-0 max-w-full truncate text-xs text-zinc-500 dark:text-zinc-400" title={subscriptionFile?.name}>
                                    {subscriptionFile?.name || "支持 .yaml、.yml、.txt，内容需包含 Clash proxies"}
                                </span>
                                <Button type="primary" ghost disabled={!subscriptionFile} loading={action === "file-import"} icon={<FileText className="size-4" />} onClick={() => void importSubscriptionFile()}>
                                    导入文件
                                </Button>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button disabled={!state?.configured} loading={action === "refresh"} onClick={() => void refreshSubscription()}>
                            更新订阅地址
                        </Button>
                        <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">已保存的订阅地址不会回填；文件导入后如需更新，请重新选择文件导入。</p>
                    </div>

                    <div className="grid gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-2 xl:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-800">
                        <StatusMetric label="订阅状态" value={loading && !state ? "读取中" : state?.configured ? "已配置" : "未配置"} detail={state?.configured ? "订阅信息已由服务端保存" : "请先导入一份订阅"} />
                        <StatusMetric
                            label="运行时"
                            value={loading && !state ? "读取中" : state?.runtimeAvailable ? "可用" : "不可用"}
                            detail={state?.runtimeAvailable ? "可以读取当前节点状态" : "运行时暂不可用"}
                            tone={state?.runtimeAvailable ? "success" : "warning"}
                        />
                        <StatusMetric label="节点数" value={state ? String(nodeCount) : "—"} detail="当前订阅中的可选节点" />
                        <StatusMetric label="最近更新" value={state ? formatMagicProxyDate(state.lastUpdatedAt) : "—"} detail="服务端订阅更新时间" />
                    </div>
                </div>
            </Panel>

            <Panel>
                <PanelHeader title="代理分组" description="展示运行时返回的分组名称、类型、当前节点和节点数量，不展示订阅密钥或服务端信息。" />
                {state?.groups.length ? (
                    <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4">
                        {state.groups.map((group) => (
                            <MagicProxyGroupCard key={`${group.type}-${group.name}`} group={group} />
                        ))}
                    </div>
                ) : (
                    <Empty className="my-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? "正在读取分组" : "暂无代理分组"} />
                )}
            </Panel>

            <Panel>
                <PanelHeader
                    title="代理节点"
                    description="节点列表仅显示名称、类型、存活状态和延迟；Provider 节点绑定请在 GeminiAIStudio 或 GeminiTools 页面完成。测速通过节点请求外部连通性检查地址，结果仅表示节点当前可用性。"
                    actions={
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                icon={<Globe className="size-4 text-blue-500" />}
                                disabled={loading || !state?.runtimeAvailable}
                                onClick={() => {
                                    setTestModalAutoStart(false);
                                    setTestModalGoogle(true);
                                    setTestModalOpen(true);
                                }}
                            >
                                测试 Google 访问
                            </Button>
                            <Button
                                icon={<Terminal className="size-4" />}
                                disabled={loading || !state?.nodes.length}
                                onClick={() => {
                                    setTestModalAutoStart(false);
                                    setTestModalGoogle(false);
                                    setTestModalOpen(true);
                                }}
                            >
                                测速监控
                            </Button>
                            <Button
                                type="primary"
                                icon={<Gauge className="size-4" />}
                                disabled={loading || !state?.nodes.length || !state?.runtimeAvailable}
                                onClick={() => {
                                    setTestModalAutoStart(true);
                                    setTestModalGoogle(false);
                                    setTestModalOpen(true);
                                }}
                            >
                                一键测速
                            </Button>
                        </div>
                    }
                />
                {state?.nodes.length ? (
                    <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
                        {state.nodes.map((node) => (
                            <MagicProxyNodeCard
                                key={`${node.type}-${node.name}`}
                                node={node}
                                delayResult={delayResults[node.name]}
                                testing={testingAll || testingNode === node.name}
                                disabled={testingAll || (testingNode !== "" && testingNode !== node.name)}
                                onTest={() => void runNodeDelayTest(node.name)}
                            />
                        ))}
                    </div>
                ) : (
                    <Empty className="my-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? "正在读取节点" : "暂无代理节点"} />
                )}
            </Panel>

            <MagicProxyTestModal
                open={testModalOpen}
                onClose={() => setTestModalOpen(false)}
                nodes={state?.nodes || []}
                delayResults={delayResults}
                onDelayResultsChange={setDelayResults}
                autoStart={testModalAutoStart}
                initialTestGoogle={testModalGoogle}
            />
        </div>
    );
}

function StatusMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "success" | "warning" }) {
    const valueClass = tone === "success" ? "text-emerald-600 dark:text-emerald-400" : tone === "warning" ? "text-amber-600 dark:text-amber-400" : "text-zinc-950 dark:text-zinc-100";
    return (
        <div className="min-w-0 bg-white p-3 dark:bg-zinc-950 sm:p-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
            <div className={`mt-1 truncate text-lg font-semibold ${valueClass}`}>{value}</div>
            <div className="mt-1 truncate text-[11px] text-zinc-400 dark:text-zinc-500">{detail}</div>
        </div>
    );
}

function MagicProxyGroupCard({ group }: { group: MagicProxyGroup }) {
    return (
        <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-100" title={group.name}>
                        {group.name}
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{group.type}</div>
                </div>
                <Tag className="m-0 shrink-0">{group.all.length} 个节点</Tag>
            </div>
            <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="shrink-0">当前</span>
                <span className="min-w-0 truncate text-zinc-800 dark:text-zinc-200" title={group.now}>
                    {group.now || "未选择"}
                </span>
            </div>
        </div>
    );
}

function MagicProxyNodeCard({ node, delayResult, testing, disabled, onTest }: { node: MagicProxyNode; delayResult?: MagicProxyDelayResult; testing?: boolean; disabled?: boolean; onTest?: () => void }) {
    const alive = node.alive;
    const testedDelay = typeof delayResult?.delay === "number" ? `${delayResult.delay} ms` : "";
    const testedError = delayResult?.error || "";
    return (
        <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-100" title={node.name}>
                        {node.name}
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{node.type}</div>
                </div>
                <Tag color={alive === true ? "success" : alive === false ? "error" : "default"} className="m-0 shrink-0">
                    {alive === true ? <Wifi className="mr-1 inline size-3" /> : alive === false ? <WifiOff className="mr-1 inline size-3" /> : null}
                    {alive === true ? "存活" : alive === false ? "不可用" : "状态未知"}
                </Tag>
            </div>
            <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    延迟：
                    {testedError ? (
                        <span className="text-red-600 dark:text-red-400">{testedError}</span>
                    ) : testedDelay ? (
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">{testedDelay}</span>
                    ) : (
                        typeof node.delay === "number"
                          ? `${node.delay} ms`
                          : "未知"
                    )}
                </div>
                <Button size="small" icon={<Gauge className="size-3.5" />} loading={testing} disabled={disabled || !onTest} onClick={onTest}>
                    测速
                </Button>
            </div>
        </div>
    );
}

export function formatMagicProxyDate(value?: string) {
    if (!value) return "暂无";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}
