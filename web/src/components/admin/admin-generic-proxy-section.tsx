"use client";

import { Alert, Button, Drawer, Empty, Spin, Tabs, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import type { ChatGptLogDetail, ChatGptLogPage, ChatGptLogSummary } from "@/services/api/chatgpt-api";
import { genericProxyRequest, getGenericProxyLogs } from "@/services/api/generic-proxy";

import { ChatGptProxyManager } from "@/app/admin/chatgpt-api/components/chatgpt-proxy-manager";

const PAGE_SIZE = 50;

const statusTone = (item: ChatGptLogSummary) =>
    item.outcome === "success" || item.outcome === "partial_success"
        ? "success"
        : item.outcome === "failed"
          ? "danger"
          : item.outcome === "rate_limited"
            ? "warning"
            : "default";

const statusLabel = (item: ChatGptLogSummary) => item.display_status || (item.outcome === "success" ? "成功" : item.outcome === "failed" ? "失败" : item.outcome === "rate_limited" ? "限流" : item.outcome || "未知");

function ProxyLogMeta({ proxy }: { proxy: NonNullable<ChatGptLogSummary["proxy_egress"]> }) {
    const label = proxy.mode === "magic" ? "魔法代理" : "通用代理";
    return (
        <span className="inline-flex items-center gap-1">
            <Tag color="geekblue" className="m-0">{label}</Tag>
            <span className="break-all text-xs text-zinc-500">{[proxy.node_name, proxy.address].filter(Boolean).join(" · ")}</span>
        </span>
    );
}

function ProxyRequestLogs() {
    const [page, setPage] = useState<ChatGptLogPage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [detail, setDetail] = useState<ChatGptLogDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const load = useCallback(async (offset: number) => {
        setLoading(true);
        setError("");
        try {
            const result = await getGenericProxyLogs({ limit: PAGE_SIZE, offset });
            setPage(result);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取通用代理请求日志失败");
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        void load(0);
    }, [load]);

    const openDetail = async (id: string) => {
        setDetailLoading(true);
        try {
            setDetail(await genericProxyRequest<ChatGptLogDetail>(`logs/${encodeURIComponent(id)}`));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取日志详情失败");
        } finally {
            setDetailLoading(false);
        }
    };

    const items = page?.items || [];
    return (
        <Panel>
            <PanelHeader
                title="通用代理 · 请求日志"
                description="记录每一次经代理出口提交的请求：出口方式、代理节点与地址、状态与耗时。"
                actions={
                    <Button loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void load(0)}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-3 p-3 sm:p-5">
                {error ? <Alert type="error" showIcon title={error} /> : null}
                {loading && !items.length ? (
                    <div className="flex justify-center py-8"><Spin /></div>
                ) : !items.length ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无经代理提交的请求" />
                ) : (
                    <>
                        <div className="space-y-2">
                            {items.map((item) => (
                                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                                        <Tag color={statusTone(item) === "danger" ? "red" : statusTone(item) === "success" ? "green" : statusTone(item) === "warning" ? "orange" : "default"} className="m-0">{statusLabel(item)}</Tag>
                                        {item.proxy_egress ? <ProxyLogMeta proxy={item.proxy_egress} /> : null}
                                        <span className="min-w-0 break-all text-xs text-zinc-500">{item.summary || item.endpoint || item.id}</span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                                        <span>{item.time}</span>
                                        {item.duration_ms ? <span>{item.duration_ms} ms</span> : null}
                                        <Button size="small" type="text" onClick={() => void openDetail(item.id)}>
                                            查看详情
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center justify-between text-xs text-zinc-500">
                            <span>
                                共 {page?.total ?? items.length} 条 · 本页 {items.length} 条
                            </span>
                            <div className="flex gap-2">
                                <Button size="small" disabled={loading || (page?.offset ?? 0) <= 0} onClick={() => void load(Math.max(0, (page?.offset ?? 0) - PAGE_SIZE))}>
                                    上一页
                                </Button>
                                <Button size="small" disabled={loading || !page?.has_more} onClick={() => void load((page?.offset ?? 0) + PAGE_SIZE)}>
                                    下一页
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </div>
            <Drawer
                title="通用代理请求详情"
                open={Boolean(detail) || detailLoading}
                width={Math.min(680, typeof window !== "undefined" ? window.innerWidth - 24 : 680)}
                onClose={() => setDetail(null)}
                destroyOnHidden
            >
                {detail ? (
                    <div className="space-y-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <Tag color={detail.outcome === "success" ? "green" : detail.outcome === "failed" ? "red" : "default"}>{statusLabel(detail)}</Tag>
                            {detail.proxy_egress ? <ProxyLogMeta proxy={detail.proxy_egress} /> : null}
                        </div>
                        <p className="break-all text-xs text-zinc-500">{detail.time} · {detail.duration_ms ?? 0} ms</p>
                        <div className="space-y-1 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                            <p className="break-all">出口：{detail.model || "-"} · {detail.endpoint || "-"}</p>
                            {detail.account_email ? <p className="break-all">账号：{detail.account_email}</p> : null}
                            {detail.public_error ? <p className="break-all text-red-500">错误：{detail.public_error}</p> : null}
                        </div>
                        {detail.request_text ? (
                            <div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                                <p className="mb-1 font-medium">请求摘要</p>
                                <p className="break-all whitespace-pre-wrap text-zinc-500">{detail.request_text}</p>
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <div className="flex justify-center py-8"><Spin /></div>
                )}
            </Drawer>
        </Panel>
    );
}

export function AdminGenericProxySection() {
    return (
        <div className="min-w-0 space-y-4">
            <Alert
                type="info"
                showIcon
                title="通用代理是多表面共享的代理出口池"
                description="在 GPTAPI、GeminiTools、GeminiAIStudio 的「代理管理」中选择通用代理作为出口来源；分组内节点按容量感知随机切换，请求结束前固定出口。"
            />
            <Tabs
                className="max-sm:[&_.ant-tabs-nav-list]:w-full max-sm:[&_.ant-tabs-tab]:!m-0 max-sm:[&_.ant-tabs-tab]:min-w-0 max-sm:[&_.ant-tabs-tab]:flex-1 max-sm:[&_.ant-tabs-tab]:justify-center max-sm:[&_.ant-tabs-tab]:!px-1 max-sm:[&_.ant-tabs-tab-btn]:text-xs"
                defaultActiveKey="management"
                items={[
                    { key: "management", label: "代理管理", children: <ChatGptProxyManager request={genericProxyRequest} showDefaults={true} title="通用代理" description="维护通用代理默认出口、代理分组与节点：分组内节点按容量随机切换，节点可配置图片并发上限。" /> },
                    { key: "logs", label: "请求日志", children: <ProxyRequestLogs /> },
                ]}
            />
        </div>
    );
}
