"use client";

import { Alert, Button, Empty, Input, Pagination, Select, Space, Tag } from "antd";
import { ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getChatGptLogs, type ChatGptLogStatus, type ChatGptLogSummary } from "@/services/api/chatgpt-api";

import { ChatGptLogDetail } from "./chatgpt-log-detail";
import { ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS } from "./use-account-operation-progress";

export function ChatGptRequestLogPanel() {
    const [logs, setLogs] = useState<{ items: ChatGptLogSummary[]; total: number }>({ items: [], total: 0 });
    const [logPage, setLogPage] = useState(1);
    const [logKeyword, setLogKeyword] = useState("");
    const [logStatus, setLogStatus] = useState<ChatGptLogStatus>("");
    const [logDetailId, setLogDetailId] = useState<string | null>(null);
    const [loadingLogs, setLoadingLogs] = useState(false);
    const [logError, setLogError] = useState("");
    const loadRevisions = useRef({ logs: 0 });

    const loadLogs = useCallback(
        async (silent = false, pageOverride = logPage) => {
            const revision = ++loadRevisions.current.logs;
            if (!silent) setLoadingLogs(true);
            setLogError("");
            try {
                const nextLogs = await getChatGptLogs({ limit: 50, offset: (pageOverride - 1) * 50, search: logKeyword, status: logStatus || undefined });
                if (revision === loadRevisions.current.logs) setLogs(nextLogs);
            } catch (reason) {
                if (revision === loadRevisions.current.logs) setLogError(reason instanceof Error ? reason.message : "读取请求日志失败");
            } finally {
                if (revision === loadRevisions.current.logs) setLoadingLogs(false);
            }
        },
        [logKeyword, logPage, logStatus],
    );

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const follow = async (silent = false) => {
            if (!document.hidden) await loadLogs(silent);
            if (!stopped) timer = setTimeout(() => void follow(true), ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS);
        };
        void follow();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            loadRevisions.current.logs += 1;
        };
    }, [loadLogs]);

    useEffect(() => () => setLogDetailId(null), []);

    return (
        <Panel>
            <PanelHeader
                title="请求日志"
                description="记录时间、接口、模型、账号、状态与耗时；点击整行查看完整请求详情和过程日志。"
                actions={
                    <Space wrap size={6}>
                        <Input
                            className="w-48"
                            allowClear
                            prefix={<Search className="size-3.5" />}
                            value={logKeyword}
                            placeholder="模型 / 账号 / 接口 / 错误"
                            onChange={(event) => setLogKeyword(event.target.value)}
                            onPressEnter={() => {
                                setLogPage(1);
                                void loadLogs(false, 1);
                            }}
                        />
                        <Select
                            className="w-28"
                            value={logStatus}
                            options={[
                                { value: "", label: "全部状态" },
                                { value: "success", label: "成功" },
                                { value: "failed", label: "失败" },
                                { value: "limited", label: "限流" },
                            ]}
                            onChange={(value: ChatGptLogStatus) => setLogStatus(value)}
                        />
                        <Button
                            loading={loadingLogs}
                            onClick={() => {
                                setLogPage(1);
                                void loadLogs(false, 1);
                            }}
                        >
                            查询
                        </Button>
                    </Space>
                }
            />
            <div className="p-0">
                {logError ? (
                    <div className="p-3 sm:p-4">
                        <Alert type="error" showIcon title={logError} />
                    </div>
                ) : null}
                {logs.items.length ? (
                    <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {logs.items.map((log) => (
                            <ChatGptLogRow key={log.id} log={log} onClick={() => setLogDetailId(log.id)} />
                        ))}
                    </div>
                ) : (
                    <div className="p-6">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loadingLogs ? "正在读取请求日志" : "暂无请求日志"} />
                    </div>
                )}
                <div className="p-3 sm:p-4">
                    <Pagination current={logPage} pageSize={50} total={logs.total} showSizeChanger={false} onChange={setLogPage} />
                </div>
            </div>
            <ChatGptLogDetail id={logDetailId} onClose={() => setLogDetailId(null)} />
        </Panel>
    );
}

export function ChatGptLogRow({ log, onClick }: { log: ChatGptLogSummary; onClick: () => void }) {
    const status = chatGptLogStatus(log);
    const duration = log.presentation?.duration?.text || formatChatGptDuration(log.duration_ms);
    const attempts = log.attempt_count && log.attempt_count > 1 ? `${log.attempt_count} 次尝试` : "";
    const switches = log.switch_count ? `${log.switch_count} 次切换` : "";
    return (
        <button
            type="button"
            data-chatgpt-log-id={log.id}
            aria-label={`查看请求日志：${log.model || "未命名模型"}`}
            onClick={onClick}
            className="grid w-full gap-2 p-3 text-left text-xs transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 sm:grid-cols-[160px_122px_minmax(0,1fr)_150px_24px] sm:items-center sm:p-4 dark:hover:bg-zinc-900/70"
        >
            <div className="text-zinc-500">{formatChatGptTime(log.started_at || log.time)}</div>
            <div>
                <Tag color={status.color}>{log.status_code ? `${status.label} · ${log.status_code}` : status.label}</Tag>
                {log.proxy_egress ? (
                    <Tag color="geekblue" className="m-0" aria-label={`经${log.proxy_egress.mode === "magic" ? "魔法代理" : "通用代理"}提交`}>
                        {log.proxy_egress.mode === "magic" ? "魔法" : "通用"}
                    </Tag>
                ) : null}
                <span className="uppercase text-zinc-500">OPENAI</span>
                {log.proxy_egress?.address ? <span className="mt-0.5 block break-all text-[11px] leading-4 text-zinc-400">{log.proxy_egress.address}</span> : log.proxy_egress?.node_name ? <span className="mt-0.5 block break-all text-[11px] leading-4 text-zinc-400">{log.proxy_egress.node_name}</span> : null}
            </div>
            <div className="min-w-0">
                <div className="truncate font-medium text-zinc-800 dark:text-zinc-200">{log.model || "未记录模型"}</div>
                <div className="truncate text-zinc-500">
                    {log.account_email || log.key_name || "站内调用"} · {log.endpoint || chatGptLogTypeLabel(log.type || log.business)}
                    {log.public_error || log.summary ? ` · ${log.public_error || log.summary}` : ""}
                </div>
            </div>
            <div className="text-zinc-500">
                {duration}
                {attempts ? ` · ${attempts}` : ""}
                {switches ? ` · ${switches}` : ""}
            </div>
            <ChevronRight className="hidden size-4 justify-self-end text-zinc-400 sm:block" aria-hidden="true" />
        </button>
    );
}

function chatGptLogStatus(log: ChatGptLogSummary) {
    const outcome = log.outcome || log.display_status || "";
    if (log.presentation?.status?.label) return { label: log.presentation.status.label, color: chatGptStatusColor(log.presentation.status.tone, outcome) };
    if (["queued", "running"].includes(outcome)) return { label: outcome === "queued" ? "排队中" : "运行中", color: "processing" as const };
    if (outcome === "success" || ((log.status_code || 0) < 400 && !log.public_error)) return { label: "成功", color: "green" as const };
    if (["rate_limited", "limited"].includes(outcome)) return { label: "限流", color: "gold" as const };
    return { label: "失败", color: "red" as const };
}

function chatGptStatusColor(tone: string | undefined, outcome: string) {
    if (tone === "success" || outcome === "success") return "green" as const;
    if (tone === "warning" || ["rate_limited", "limited", "text_review", "partial_success"].includes(outcome)) return "gold" as const;
    if (tone === "danger" || ["failed", "error", "fail"].includes(outcome)) return "red" as const;
    if (tone === "info" || ["queued", "running"].includes(outcome)) return "processing" as const;
    return "default" as const;
}

function chatGptLogTypeLabel(value?: string) {
    const labels: Record<string, string> = { chat: "文本", responses: "Responses", messages: "Messages", image_generation: "图片生成", image_edit: "图片编辑", image_chat: "图片对话", search: "搜索", file: "文件" };
    return labels[value || ""] || value || "API";
}

function formatChatGptDuration(value?: number) {
    const milliseconds = Math.max(0, Number(value || 0));
    if (milliseconds < 1000) return `${milliseconds}ms`;
    if (milliseconds < 10000) return `${(milliseconds / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`;
    if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1).replace(/\.0$/, "")}s`;
    return `${(milliseconds / 60000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatChatGptTime(value?: string) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}
