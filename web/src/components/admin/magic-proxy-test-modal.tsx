"use client";

import { Alert, Badge, Button, Modal, Progress, Segmented, Space, Switch, Tag } from "antd";
import { CheckCircle2, Copy, Gauge, Globe, Pause, Play, RotateCcw, Sparkles, Terminal, Trash2, XCircle } from "lucide-react";
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
    targetSingleNode?: string | null;
    onTargetSingleNodeChange?: (node: string | null) => void;
}

const CONCURRENCY = 8;

export function MagicProxyTestModal({
    open,
    onClose,
    nodes,
    delayResults,
    onDelayResultsChange,
    autoStart,
    initialTestGoogle = false,
    targetSingleNode = null,
    onTargetSingleNodeChange,
}: MagicProxyTestModalProps) {
    const [running, setRunning] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [activeTab, setActiveTab] = useState<"logs" | "nodes">("logs");
    const [nodeFilter, setNodeFilter] = useState<"all" | "success" | "failed">("all");
    const [autoScroll, setAutoScroll] = useState(true);

    const cancelledRef = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);
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

    // 停止测速（立即取消在途网络请求并更新状态）
    const handleStop = useCallback(() => {
        cancelledRef.current = true;
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setRunning(false);
        setTestingGoogle(false);
        appendLog("warn", "⏹ 测速任务已立即手动停止，在途网络请求已取消");
    }, [appendLog]);

    // 弹窗关闭或卸载时自动取消进行中的任务
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
        };
    }, []);

    // 单节点测试
    const runSingleTest = useCallback(
        async (node: MagicProxyNode) => {
            if (running) return;
            setRunning(true);
            cancelledRef.current = false;
            abortControllerRef.current = new AbortController();
            const signal = abortControllerRef.current.signal;

            appendLog("info", `🚀 开始测试单节点：[${node.name}]（协议：${node.type}）`, node.name);
            appendLog("info", `🎯 探测目标：https://www.gstatic.com/generate_204（超时限制：4000ms）`, node.name);
            appendLog("info", `正在通过本地 Mihomo 控制器发起连通性与往返延迟探测...`, node.name);

            try {
                const result = await testMagicProxyNode(node.name, signal);
                if (signal.aborted || cancelledRef.current) return;
                onDelayResultsChange((prev) => ({ ...prev, [node.name]: result }));

                if (typeof result.delay === "number") {
                    const rating = result.delay < 100 ? "极速响应 (<100ms)" : result.delay < 300 ? "良好 (<300ms)" : "延迟偏高 (>300ms)";
                    appendLog("ok", `✅ [${node.name}] 测速成功！往返延迟: ${result.delay} ms · 链路评级: ${rating}`, node.name);
                } else {
                    appendLog("warn", `❌ [${node.name}] 测速未通过: ${result.error || "连接超时或节点不可用"}`, node.name);
                    appendLog("warn", `💡 诊断排查：请检查服务器出网链路、该节点境外服务器/端口是否可达，或订阅凭据是否已失效。`, node.name);
                }
            } catch (err) {
                if (signal.aborted || cancelledRef.current || (err instanceof Error && err.name === "AbortError")) {
                    appendLog("warn", `⏹ [${node.name}] 测速已手动中止`, node.name);
                    return;
                }
                const msg = err instanceof Error ? err.message : "请求异常";
                onDelayResultsChange((prev) => ({ ...prev, [node.name]: { name: node.name, error: msg } }));
                appendLog("error", `❌ [${node.name}] 探测请求失败：${msg}`, node.name);
            } finally {
                setRunning(false);
            }
        },
        [running, appendLog, onDelayResultsChange]
    );

    // 批量并发测速
    const runTest = useCallback(
        async (targetNodes: MagicProxyNode[]) => {
            if (running || !targetNodes.length) return;
            setRunning(true);
            cancelledRef.current = false;
            abortControllerRef.current = new AbortController();
            const signal = abortControllerRef.current.signal;

            appendLog("info", `🚀 开始批量测速任务，待测试节点数：${targetNodes.length} 个（并发通道：${Math.min(CONCURRENCY, targetNodes.length)}）`);

            let currentIndex = 0;
            let successCount = 0;
            let failCount = 0;

            const executeNext = async () => {
                while (currentIndex < targetNodes.length && !cancelledRef.current && !signal.aborted) {
                    const node = targetNodes[currentIndex++];
                    try {
                        const result = await testMagicProxyNode(node.name, signal);
                        if (cancelledRef.current || signal.aborted) break;

                        onDelayResultsChange((prev) => ({ ...prev, [node.name]: result }));

                        if (typeof result.delay === "number") {
                            successCount++;
                            appendLog("ok", `[${node.type}] 延迟 ${result.delay}ms`, node.name);
                        } else {
                            failCount++;
                            appendLog("warn", `[${node.type}] ${result.error || "测速失败或超时"}`, node.name);
                        }
                    } catch (err) {
                        if (cancelledRef.current || signal.aborted || (err instanceof Error && err.name === "AbortError")) {
                            break;
                        }
                        failCount++;
                        const msg = err instanceof Error ? err.message : "请求异常";
                        onDelayResultsChange((prev) => ({ ...prev, [node.name]: { name: node.name, error: msg } }));
                        appendLog("error", `[${node.type}] 请求出错：${msg}`, node.name);
                    }
                }
            };

            const workers = Array.from({ length: Math.min(CONCURRENCY, targetNodes.length) }, () => executeNext());
            await Promise.all(workers);

            if (cancelledRef.current || signal.aborted) {
                appendLog("warn", `⏹ 测速任务已手动停止。当前完成：${successCount + failCount}/${targetNodes.length}`);
            } else {
                appendLog("info", `🏁 批量测速完成！可用节点：${successCount} 个，不可用/超时：${failCount} 个`);
            }

            setRunning(false);
        },
        [running, appendLog, onDelayResultsChange]
    );

    const [testingGoogle, setTestingGoogle] = useState(false);
    const [, setGoogleReport] = useState<MagicProxyGoogleTestReport | null>(null);

    const handleTestGoogle = useCallback(async () => {
        if (testingGoogle) return;
        setTestingGoogle(true);
        cancelledRef.current = false;
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        if (targetSingleNode) {
            appendLog("info", `🌐 开始测试节点 [${targetSingleNode}] 的 Google (https://www.google.com) 出海连通性...`);
        } else {
            appendLog("info", "🌐 开始测试 Google (https://www.google.com) 真实出海连通性...");
        }

        try {
            const report = await testMagicProxyGoogle(targetSingleNode || undefined, signal);
            if (signal.aborted || cancelledRef.current) return;
            setGoogleReport(report);
            for (const item of report.items) {
                if (item.ok && typeof item.delay === "number") {
                    appendLog("ok", `[${item.serviceTitle}] 节点 [${item.activeNode}] -> 成功连通 Google，延迟: ${item.delay}ms`, item.group);
                } else if (!item.enabled) {
                    appendLog("warn", `[${item.serviceTitle}] 当前处于 DIRECT 直连或未开启`, item.group);
                } else {
                    appendLog("error", `[${item.serviceTitle}] 节点 [${item.activeNode}] -> 访问 Google 失败: ${item.error || "连接超时"}`, item.group);
                }
            }
            if (report.overallOk) {
                appendLog("info", "🎉 Google 连通性测试通过！出海链路顺畅。");
            } else {
                appendLog("error", "⚠️ Google 连通性测试未通过：请确认所选境外节点网络畅通并已保存绑定。");
            }
        } catch (err) {
            if (signal.aborted || cancelledRef.current || (err instanceof Error && err.name === "AbortError")) {
                appendLog("warn", "⏹ Google 连通性测试已手动中止");
                return;
            }
            const msg = err instanceof Error ? err.message : "请求失败";
            appendLog("error", `❌ Google 连通性测试失败：${msg}`);
        } finally {
            setTestingGoogle(false);
        }
    }, [testingGoogle, targetSingleNode, appendLog]);

    // 自动启动测速或测试 Google
    useEffect(() => {
        if (open && autoStart && !hasAutoStartedRef.current && !running) {
            hasAutoStartedRef.current = true;
            if (targetSingleNode) {
                const single = nodes.find((n) => n.name === targetSingleNode);
                if (single) {
                    void runSingleTest(single);
                } else if (nodes.length) {
                    void runTest(nodes);
                }
            } else if (nodes.length) {
                void runTest(nodes);
            }
        }
        if (open && initialTestGoogle && !hasAutoStartedRef.current && !testingGoogle) {
            hasAutoStartedRef.current = true;
            void handleTestGoogle();
        }
        if (!open) {
            hasAutoStartedRef.current = false;
        }
    }, [open, autoStart, initialTestGoogle, running, testingGoogle, nodes, targetSingleNode, runSingleTest, runTest, handleTestGoogle]);

    const handleRetryAll = () => {
        if (targetSingleNode) {
            const single = nodes.find((n) => n.name === targetSingleNode);
            if (single) void runSingleTest(single);
        } else {
            void runTest(nodes);
        }
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
        void navigator.clipboard.writeText(text);
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

    // 当前选中的单节点详情
    const singleNodeObj = useMemo(() => {
        if (!targetSingleNode) return null;
        return nodes.find((n) => n.name === targetSingleNode) || null;
    }, [targetSingleNode, nodes]);

    const singleResult = targetSingleNode ? delayResults[targetSingleNode] : null;

    return (
        <Modal
            title={
                <div className="flex flex-wrap items-center gap-2 text-base font-semibold">
                    <Gauge className="size-5 text-indigo-500 shrink-0" />
                    <span>{targetSingleNode ? "节点测速实时日志" : "一键测速与实时日志"}</span>
                    {targetSingleNode ? (
                        <Tag color="blue" className="font-mono text-xs">
                            {targetSingleNode}
                        </Tag>
                    ) : null}
                    {running ? (
                        <Tag color="processing" className="animate-pulse">
                            正在测速中...
                        </Tag>
                    ) : targetSingleNode ? (
                        typeof singleResult?.delay === "number" ? (
                            <Tag color="success">延迟 {singleResult.delay}ms</Tag>
                        ) : singleResult?.error ? (
                            <Tag color="error">测速未通过</Tag>
                        ) : (
                            <Tag>待测速</Tag>
                        )
                    ) : testedCount > 0 ? (
                        <Tag color="success">测速完成</Tag>
                    ) : (
                        <Tag>未测速</Tag>
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
                {/* 单节点模式：专属节点看板 */}
                {targetSingleNode && singleNodeObj ? (
                    <div className="rounded-lg border border-indigo-200/80 bg-indigo-50/40 p-3.5 dark:border-indigo-900/60 dark:bg-indigo-950/20">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                                        {singleNodeObj.name}
                                    </span>
                                    <Tag color="purple" className="text-[11px] font-mono">
                                        {singleNodeObj.type}
                                    </Tag>
                                </div>
                                <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                                    单节点独立探测 · 探测目标：https://www.gstatic.com/generate_204
                                </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-2">
                                {running ? (
                                    <div className="flex items-center gap-1.5 rounded-md bg-blue-100 px-2.5 py-1 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                                        <Gauge className="size-3.5 animate-spin" />
                                        <span>探测中...</span>
                                    </div>
                                ) : typeof singleResult?.delay === "number" ? (
                                    <div className="flex items-center gap-1.5 rounded-md bg-emerald-100 px-3 py-1 text-sm font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 font-mono">
                                        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                                        <span>{singleResult.delay} ms</span>
                                    </div>
                                ) : singleResult?.error ? (
                                    <div className="flex items-center gap-1.5 rounded-md bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                                        <XCircle className="size-3.5 text-red-600 dark:text-red-400" />
                                        <span className="max-w-[240px] truncate" title={singleResult.error}>
                                            {singleResult.error}
                                        </span>
                                    </div>
                                ) : (
                                    <Tag>点击“重新测速”开始探测</Tag>
                                )}
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-indigo-100/80 pt-2.5 dark:border-indigo-900/40">
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    size="small"
                                    type="primary"
                                    icon={<Gauge className="size-3.5" />}
                                    loading={running}
                                    disabled={testingGoogle}
                                    onClick={() => void runSingleTest(singleNodeObj)}
                                >
                                    重新测速
                                </Button>
                                <Button
                                    size="small"
                                    icon={<Globe className="size-3.5 text-emerald-500" />}
                                    loading={testingGoogle}
                                    disabled={running}
                                    onClick={handleTestGoogle}
                                >
                                    测试 Google 可达性
                                </Button>
                                {running || testingGoogle ? (
                                    <Button size="small" danger icon={<Pause className="size-3.5" />} onClick={handleStop}>
                                        停止
                                    </Button>
                                ) : null}
                            </div>
                            {onTargetSingleNodeChange ? (
                                <Button
                                    size="small"
                                    type="link"
                                    className="p-0 text-xs text-indigo-600 dark:text-indigo-400"
                                    onClick={() => {
                                        onTargetSingleNodeChange(null);
                                        void runTest(nodes);
                                    }}
                                >
                                    切换为一键测速全部节点 ({totalNodes}) →
                                </Button>
                            ) : null}
                        </div>
                    </div>
                ) : (
                    /* 批量模式：总进度与统计卡片 */
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
                                              successNodes.reduce((acc, cur) => acc + (delayResults[cur.name]?.delay || 0), 0) /
                                                  successNodes.length
                                          ) + " ms"
                                        : "--"}
                                </div>
                            </div>
                        </div>

                        {/* 操作工具栏 */}
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    size="small"
                                    type="primary"
                                    icon={<RotateCcw className="size-3.5" />}
                                    loading={running}
                                    onClick={handleRetryAll}
                                >
                                    全部重新测速
                                </Button>
                                <Button
                                    size="small"
                                    icon={<RotateCcw className="size-3.5" />}
                                    disabled={running || !failedNodes.length}
                                    onClick={handleRetryFailed}
                                >
                                    重试失败 ({failedNodes.length})
                                </Button>
                                <Button
                                    size="small"
                                    icon={<Globe className="size-3.5 text-emerald-500" />}
                                    loading={testingGoogle}
                                    disabled={running}
                                    onClick={handleTestGoogle}
                                >
                                    测试 Google 访问
                                </Button>
                                {running || testingGoogle ? (
                                    <Button size="small" danger icon={<Pause className="size-3.5" />} onClick={handleStop}>
                                        停止
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                )}

                {/* 选项卡：实时日志 vs 节点列表 */}
                <div className="flex items-center justify-between">
                    <Segmented
                        value={activeTab}
                        onChange={(val) => setActiveTab(val as "logs" | "nodes")}
                        options={[
                            { label: `实时日志 (${logs.length})`, value: "logs", icon: <Terminal className="size-3.5 inline mr-1" /> },
                            { label: `节点列表 (${totalNodes})`, value: "nodes", icon: <Gauge className="size-3.5 inline mr-1" /> },
                        ]}
                    />

                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                        <div className="flex items-center gap-1.5">
                            <span className="hidden sm:inline">自动滚动</span>
                            <Switch
                                size="small"
                                checked={autoScroll}
                                onChange={setAutoScroll}
                                checkedChildren="滚"
                                unCheckedChildren="停"
                            />
                        </div>
                        <Button size="small" type="text" icon={<Copy className="size-3" />} onClick={handleCopyLogs}>
                            复制
                        </Button>
                        <Button size="small" type="text" danger icon={<Trash2 className="size-3" />} onClick={handleClearLogs}>
                            清空
                        </Button>
                    </div>
                </div>

                {/* 视图区域 */}
                {activeTab === "logs" ? (
                    <div className="space-y-2">
                        {/* 控制台黑色日志视窗 */}
                        <div
                            ref={logScrollRef}
                            className="h-80 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300 shadow-inner select-text"
                        >
                            {logs.length === 0 ? (
                                <div className="flex h-full items-center justify-center text-zinc-600">
                                    暂无日志，点击“测速”开始探测节点可用性与实时日志
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
                                            {log.nodeName ? (
                                                <span className="text-indigo-300 font-semibold mr-1.5">
                                                    [{log.nodeName}]
                                                </span>
                                            ) : null}
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
                                                    onClick={() => {
                                                        if (onTargetSingleNodeChange) onTargetSingleNodeChange(node.name);
                                                        setActiveTab("logs");
                                                        void runSingleTest(node);
                                                    }}
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
