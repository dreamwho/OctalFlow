"use client";

import { Alert, Badge, Button, Modal, Progress, Segmented, Space, Switch, Tag } from "antd";
import { CheckCircle2, Copy, Download, Gauge, Globe, Pause, Play, RotateCcw, Terminal, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { testMagicProxyGoogle, testMagicProxyNode, type MagicProxyDelayResult, type MagicProxyGoogleTestReport, type MagicProxyNode } from "@/services/api/magic-proxy";

export interface LogEntry {
    id: string;
    time: string;
    level: "info" | "ok" | "warn" | "error";
    nodeName?: string;
    message: string;
}

interface MagicProxyTestModalProps {
    open: boolean;
    onClose: () => void;
    nodes: MagicProxyNode[];
    delayResults: Record<string, MagicProxyDelayResult>;
    onDelayResultsChange: (updater: (prev: Record<string, MagicProxyDelayResult>) => Record<string, MagicProxyDelayResult>) => void;
    autoStart?: boolean;
    initialTestGoogle?: boolean;
}

const CONCURRENCY = 8;

export function MagicProxyTestModal({ open, onClose, nodes, delayResults, onDelayResultsChange, autoStart, initialTestGoogle = false }: MagicProxyTestModalProps) {
    const [running, setRunning] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [activeTab, setActiveTab] = useState<"logs" | "nodes">("logs");
    const [nodeFilter, setNodeFilter] = useState<"all" | "success" | "failed">("all");
    const [autoScroll, setAutoScroll] = useState(true);

    const cancelledRef = useRef(false);
    const logScrollRef = useRef<HTMLDivElement>(null);
    const hasAutoStartedRef = useRef(false);

    const appendLog = useCallback((level: LogEntry["level"], message: string, nodeName?: string) => {
        const now = new Date();
        const time = now.toTimeString().split(" ")[0] + "." + String(now.getMilliseconds()).padStart(3, "0");
        setLogs((prev) => [...prev.slice(-499), { id: Math.random().toString(36).slice(2), time, level, nodeName, message }]);
    }, []);

    // 自动滚动日志
    useEffect(() => {
        if (autoScroll && logScrollRef.current) {
            logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    // 测速核心控制函数
    const runTest = useCallback(
        async (targetNodes: MagicProxyNode[]) => {
            if (running || !targetNodes.length) return;
            setRunning(true);
            cancelledRef.current = false;

            appendLog("info", `🚀 开始节点测速任务，待测试节点数：${targetNodes.length} 个（并发通道：${CONCURRENCY}）`);

            let currentIndex = 0;
            let successCount = 0;
            let failCount = 0;

            const executeNext = async () => {
                while (currentIndex < targetNodes.length && !cancelledRef.current) {
                    const node = targetNodes[currentIndex++];
                    try {
                        const result = await testMagicProxyNode(node.name);
                        if (cancelledRef.current) break;

                        onDelayResultsChange((prev) => ({ ...prev, [node.name]: result }));

                        if (typeof result.delay === "number") {
                            successCount++;
                            appendLog("ok", `[${node.type}] 延迟 ${result.delay}ms`, node.name);
                        } else {
                            failCount++;
                            appendLog("warn", `[${node.type}] ${result.error || "测速失败或超时"}`, node.name);
                        }
                    } catch (err) {
                        if (cancelledRef.current) break;
                        failCount++;
                        const msg = err instanceof Error ? err.message : "请求异常";
                        onDelayResultsChange((prev) => ({ ...prev, [node.name]: { name: node.name, error: msg } }));
                        appendLog("error", `[${node.type}] 请求出错：${msg}`, node.name);
                    }
                }
            };

            const workers = Array.from({ length: Math.min(CONCURRENCY, targetNodes.length) }, () => executeNext());
            await Promise.all(workers);

            if (cancelledRef.current) {
                appendLog("warn", `⏹ 测速任务已由用户手动停止。当前完成：${successCount + failCount}/${targetNodes.length}`);
            } else {
                appendLog("info", `🏁 测速任务完成！可用节点：${successCount} 个，不可用/超时：${failCount} 个`);
            }

            setRunning(false);
        },
        [running, appendLog, onDelayResultsChange]
    );

    const [testingGoogle, setTestingGoogle] = useState(false);
    const [googleReport, setGoogleReport] = useState<MagicProxyGoogleTestReport | null>(null);

    const handleTestGoogle = useCallback(async () => {
        if (testingGoogle) return;
        setTestingGoogle(true);
        appendLog("info", "🌐 开始测试 Google (https://www.google.com) 真实出海连通性...");
        try {
            const report = await testMagicProxyGoogle();
            setGoogleReport(report);
            for (const item of report.items) {
                if (item.ok && typeof item.delay === "number") {
                    appendLog("ok", `[${item.serviceTitle}] 当前节点 [${item.activeNode}] -> 成功连通 Google，延迟: ${item.delay}ms`, item.group);
                } else if (!item.enabled) {
                    appendLog("warn", `[${item.serviceTitle}] 当前处于 DIRECT 直连或未开启（在国内网络下无法直连 Google）`, item.group);
                } else {
                    appendLog("error", `[${item.serviceTitle}] 当前节点 [${item.activeNode}] -> 访问 Google 失败: ${item.error || "连接超时"}`, item.group);
                }
            }
            if (report.overallOk) {
                appendLog("info", "🎉 Google 连通性测试通过！至少有一个服务通道已成功连通 Google。");
            } else {
                appendLog("error", "⚠️ Google 连通性测试未通过：当前没有任何服务通道能成功访问 Google，请确认已选择有效境外节点并点击“保存绑定”。");
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "请求失败";
            appendLog("error", `❌ Google 连通性测试失败：${msg}`);
        } finally {
            setTestingGoogle(false);
        }
    }, [testingGoogle, appendLog]);

    // 自动启动全量测速或测试 Google
    useEffect(() => {
        if (open && autoStart && !hasAutoStartedRef.current && !running && nodes.length) {
            hasAutoStartedRef.current = true;
            void runTest(nodes);
        }
        if (open && initialTestGoogle && !hasAutoStartedRef.current && !testingGoogle) {
            hasAutoStartedRef.current = true;
            void handleTestGoogle();
        }
        if (!open) {
            hasAutoStartedRef.current = false;
        }
    }, [open, autoStart, initialTestGoogle, running, testingGoogle, nodes, runTest, handleTestGoogle]);

    const handleStop = () => {
        cancelledRef.current = true;
    };

    const handleRetryAll = () => {
        void runTest(nodes);
    };

    const handleRetryFailed = () => {
        const failedNodes = nodes.filter((n) => delayResults[n.name]?.error || delayResults[n.name]?.delay === undefined);
        void runTest(failedNodes);
    };

    const handleClearLogs = () => {
        setLogs([]);
    };

    const handleCopyLogs = () => {
        const text = logs.map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.nodeName ? l.nodeName + ": " : ""}${l.message}`).join("\n");
        navigator.clipboard.writeText(text);
    };

    // 统计数据
    const totalNodes = nodes.length;
    const testedCount = useMemo(() => nodes.filter((n) => delayResults[n.name] !== undefined).length, [nodes, delayResults]);
    const successNodes = useMemo(() => nodes.filter((n) => typeof delayResults[n.name]?.delay === "number"), [nodes, delayResults]);
    const failedNodes = useMemo(() => nodes.filter((n) => delayResults[n.name]?.error), [nodes, delayResults]);

    const progressPercent = totalNodes > 0 ? Math.round((testedCount / totalNodes) * 100) : 0;

    const filteredNodes = useMemo(() => {
        if (nodeFilter === "success") return successNodes;
        if (nodeFilter === "failed") return failedNodes;
        return nodes;
    }, [nodes, successNodes, failedNodes, nodeFilter]);

    return (
        <Modal
            title={
                <div className="flex items-center gap-2 text-base font-semibold">
                    <Gauge className="size-5 text-indigo-500" />
                    <span>魔法代理测速监控与日志</span>
                    {running ? (
                        <Tag color="processing" className="ml-2 animate-pulse">
                            正在测速中 ({CONCURRENCY} 并发)
                        </Tag>
                    ) : testedCount > 0 ? (
                        <Tag color="success" className="ml-2">
                            测速就绪
                        </Tag>
                    ) : (
                        <Tag className="ml-2">未测速</Tag>
                    )}
                </div>
            }
            open={open}
            onCancel={() => {
                if (running) handleStop();
                onClose();
            }}
            width={780}
            footer={null}
            destroyOnClose={false}
            className="top-8"
        >
            <div className="space-y-4 pt-2">
                {/* 顶部进度与统计卡片 */}
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                    <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                        <span>测试总进度 ({testedCount} / {totalNodes})</span>
                        <span className="font-mono font-medium">{progressPercent}%</span>
                    </div>
                    <Progress
                        percent={progressPercent}
                        status={running ? "active" : undefined}
                        strokeColor={{ "0%": "#6366f1", "100%": "#10b981" }}
                        className="mt-1.5"
                    />

                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-4">
                        <div className="rounded border border-zinc-200/80 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
                            <div className="text-zinc-400">总节点数</div>
                            <div className="mt-0.5 text-base font-bold text-zinc-800 dark:text-zinc-200">{totalNodes}</div>
                        </div>
                        <div className="rounded border border-emerald-200/60 bg-emerald-50/50 p-2 dark:border-emerald-950 dark:bg-emerald-950/20">
                            <div className="text-emerald-600 dark:text-emerald-400">可用节点</div>
                            <div className="mt-0.5 text-base font-bold text-emerald-600 dark:text-emerald-400">{successNodes.length}</div>
                        </div>
                        <div className="rounded border border-red-200/60 bg-red-50/50 p-2 dark:border-red-950 dark:bg-red-950/20">
                            <div className="text-red-600 dark:text-red-400">超时/失败</div>
                            <div className="mt-0.5 text-base font-bold text-red-600 dark:text-red-400">{failedNodes.length}</div>
                        </div>
                        <div className="hidden rounded border border-zinc-200/80 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950 sm:block">
                            <div className="text-zinc-400">平均延迟</div>
                            <div className="mt-0.5 text-base font-bold text-indigo-600 dark:text-indigo-400">
                                {successNodes.length
                                    ? Math.round(
                                          successNodes.reduce((acc, n) => acc + (delayResults[n.name]?.delay || 0), 0) / successNodes.length
                                      ) + "ms"
                                    : "--"}
                            </div>
                        </div>
                    </div>
                </div>

                    {/* 控制操作栏 */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            {running ? (
                                <Button danger icon={<Pause className="size-4" />} onClick={handleStop}>
                                    停止测速
                                </Button>
                            ) : (
                                <Button type="primary" icon={<Play className="size-4" />} onClick={handleRetryAll}>
                                    全部重新测速
                                </Button>
                            )}
                            <Button
                                disabled={running || failedNodes.length === 0}
                                icon={<RotateCcw className="size-4" />}
                                onClick={handleRetryFailed}
                            >
                                仅测失败节点 ({failedNodes.length})
                            </Button>
                            <Button
                                icon={<Globe className="size-4 text-blue-500" />}
                                loading={testingGoogle}
                                disabled={running}
                                onClick={handleTestGoogle}
                            >
                                测试 Google 访问
                            </Button>
                        </div>

                    <div className="flex items-center gap-2">
                        <Segmented
                            value={activeTab}
                            onChange={(val) => setActiveTab(val as "logs" | "nodes")}
                            options={[
                                { label: "实时日志", value: "logs", icon: <Terminal className="size-3.5 inline mr-1" /> },
                                { label: `节点列表 (${totalNodes})`, value: "nodes", icon: <Gauge className="size-3.5 inline mr-1" /> },
                            ]}
                        />
                    </div>
                </div>

                {/* 视图区域 */}
                {activeTab === "logs" ? (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs text-zinc-500">
                            <div className="flex items-center gap-2">
                                <span>实时滚动日志 ({logs.length} 条记录)</span>
                                <Switch
                                    size="small"
                                    checked={autoScroll}
                                    onChange={setAutoScroll}
                                    checkedChildren="自滚"
                                    unCheckedChildren="停滚"
                                />
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Button size="small" type="text" icon={<Copy className="size-3" />} onClick={handleCopyLogs}>
                                    复制日志
                                </Button>
                                <Button size="small" type="text" danger icon={<Trash2 className="size-3" />} onClick={handleClearLogs}>
                                    清空
                                </Button>
                            </div>
                        </div>

                        {/* 控制台黑色日志视窗 */}
                        <div
                            ref={logScrollRef}
                            className="h-80 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300 shadow-inner"
                        >
                            {logs.length === 0 ? (
                                <div className="flex h-full items-center justify-center text-zinc-600">
                                    暂无日志，点击“全部重新测速”开始探测节点可用性
                                </div>
                            ) : (
                                logs.map((log) => {
                                    const badgeColor =
                                        log.level === "ok"
                                            ? "text-emerald-400 bg-emerald-950/40 border-emerald-800/50"
                                            : log.level === "warn"
                                            ? "text-amber-400 bg-amber-950/40 border-amber-800/50"
                                            : log.level === "error"
                                            ? "text-red-400 bg-red-950/40 border-red-800/50"
                                            : "text-blue-400 bg-blue-950/40 border-blue-800/50";

                                    return (
                                        <div key={log.id} className="py-0.5 leading-relaxed hover:bg-zinc-900/60">
                                            <span className="text-zinc-500 mr-2">[{log.time}]</span>
                                            <span className={`inline-block rounded px-1.5 py-0.2 mr-2 border text-[10px] ${badgeColor}`}>
                                                {log.level.toUpperCase()}
                                            </span>
                                            {log.nodeName ? <span className="text-indigo-300 font-semibold mr-1.5">[{log.nodeName}]</span> : null}
                                            <span
                                                className={
                                                    log.level === "ok"
                                                        ? "text-emerald-300"
                                                        : log.level === "warn"
                                                        ? "text-amber-300"
                                                        : log.level === "error"
                                                        ? "text-red-300"
                                                        : "text-zinc-200"
                                                }
                                            >
                                                {log.message}
                                            </span>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                ) : (
                    /* 节点列表筛选视图 */
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Segmented
                                size="small"
                                value={nodeFilter}
                                onChange={(val) => setNodeFilter(val as "all" | "success" | "failed")}
                                options={[
                                    { label: `全部 (${nodes.length})`, value: "all" },
                                    { label: `仅可用 (${successNodes.length})`, value: "success" },
                                    { label: `仅超时/失败 (${failedNodes.length})`, value: "failed" },
                                ]}
                            />
                        </div>

                        <div className="h-80 overflow-y-auto space-y-1.5 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                            {filteredNodes.length === 0 ? (
                                <div className="flex h-full items-center justify-center text-xs text-zinc-400">没有符合筛选的节点</div>
                            ) : (
                                filteredNodes.map((node) => {
                                    const res = delayResults[node.name];
                                    const delay = res?.delay;
                                    const error = res?.error;

                                    return (
                                        <div
                                            key={node.name}
                                            className="flex items-center justify-between rounded border border-zinc-100 bg-white px-3 py-1.5 text-xs dark:border-zinc-800/80 dark:bg-zinc-900"
                                        >
                                            <div className="min-w-0 pr-2">
                                                <div className="font-medium text-zinc-800 dark:text-zinc-200 truncate" title={node.name}>
                                                    {node.name}
                                                </div>
                                                <div className="text-[10px] text-zinc-400">{node.type}</div>
                                            </div>
                                            <div className="shrink-0 flex items-center gap-2">
                                                {typeof delay === "number" ? (
                                                    <Tag color="success" className="m-0 font-mono">
                                                        {delay} ms
                                                    </Tag>
                                                ) : error ? (
                                                    <Tag color="error" className="m-0 max-w-[200px] truncate" title={error}>
                                                        {error}
                                                    </Tag>
                                                ) : (
                                                    <Tag className="m-0">未测速</Tag>
                                                )}
                                                <Button
                                                    size="small"
                                                    disabled={running}
                                                    onClick={() => void runTest([node])}
                                                >
                                                    测速
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}
