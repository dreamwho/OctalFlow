"use client";

import { Alert, Button, Empty, Pagination, Skeleton, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import type { AdminTrafficTaskReport, RequestTrafficSummary, TrafficFilter } from "@/lib/admin-traffic-types";
import { DEFAULT_TRAFFIC_DISPLAY_UNIT, formatTrafficBytes, type TrafficDisplayUnit } from "@/lib/traffic-format";
import { getAdminTrafficTasks } from "@/services/api/admin-traffic";

import { AdminRequestTrafficDetail, formatTrafficDate } from "./admin-request-traffic";

const PAGE_SIZE = 20;

export type AdminTaskTrafficPanelProps = {
    filter: TrafficFilter;
    displayUnit?: TrafficDisplayUnit;
    title?: string;
};

function bytes(value: number, displayUnit: TrafficDisplayUnit) {
    const formatted = formatTrafficBytes(value, displayUnit);
    return `${formatted.value} ${formatted.unit}`;
}

function groupId(item: RequestTrafficSummary) {
    return item.taskId || item.requestId || `${item.firstSeenAt}:${item.lastSeenAt}`;
}

function itemRoleLabel(role: string) {
    return (
        ({ upload: "上传", submit: "提交", query: "查询", download: "下载", browser: "浏览器", provider: "供应商请求", control: "控制与探活", account: "账号维护", account_maintenance: "账号维护", cancel: "取消任务" } as Record<string, string>)[role] ||
        role ||
        "未标记"
    );
}

function itemModeLabel(mode: string) {
    const normalized = mode?.trim().toLowerCase();
    return !normalized || normalized === "unknown" ? "未标记" : ({ direct: "直连", generic: "通用代理", magic: "魔法代理", chained: "链式代理" } as Record<string, string>)[normalized] || mode;
}

function itemModelLabel(model: string) {
    if (model === "__shared_browser__") return "共享浏览器流量";
    return model?.trim() || "未归属模型";
}

function itemEndpoint(item: RequestTrafficSummary["items"][number]) {
    return `${item.address?.trim() || "未标记地址"}:${item.port ? item.port : "直连"}`;
}

export function AdminTaskTrafficPanel({ filter, displayUnit: requestedDisplayUnit, title = "任务 / 请求流量" }: AdminTaskTrafficPanelProps) {
    const filterKey = useMemo(() => JSON.stringify(filter), [filter]);
    const [page, setPage] = useState(1);
    const [report, setReport] = useState<AdminTrafficTaskReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [refreshVersion, setRefreshVersion] = useState(0);

    useEffect(() => setPage(1), [filterKey]);

    useEffect(() => {
        const controller = new AbortController();
        setReport(null);
        setLoading(true);
        setError("");
        void getAdminTrafficTasks({ ...filter, page, pageSize: PAGE_SIZE }, controller.signal)
            .then((next) => {
                if (!controller.signal.aborted) setReport(next);
            })
            .catch((reason: unknown) => {
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取任务流量失败");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [filter, filterKey, page, refreshVersion]);

    const displayUnit = report?.displayUnit || requestedDisplayUnit || DEFAULT_TRAFFIC_DISPLAY_UNIT;
    const items = report?.items || [];

    return (
        <div data-testid="admin-task-traffic-panel">
            <Panel>
                <PanelHeader
                    title={title}
                    description="按任务 ID 分组；没有上游任务 ID 时使用请求 ID。表格直接展示每个通道的模式、端点、角色和上行/下行，展开后查看完整请求明细。"
                    actions={
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => setRefreshVersion((value) => value + 1)}>
                            刷新
                        </Button>
                    }
                />
                <div className="space-y-3 p-3 sm:p-4">
                    {error ? <Alert type="error" showIcon message="任务流量读取失败" description={error} /> : null}
                    {loading && !report ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
                    {!loading && !error && !items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务或请求流量" /> : null}
                    {items.length ? (
                        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                            <table className="min-w-[1060px] w-full text-left text-xs">
                                <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900/70 dark:text-zinc-400">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">任务 / 请求</th>
                                        <th className="px-3 py-2 font-medium">渠道 / 模型</th>
                                        <th className="px-3 py-2 font-medium">模式 / 地址：端口</th>
                                        <th className="px-3 py-2 font-medium">角色</th>
                                        <th className="px-3 py-2 text-right font-medium">上行</th>
                                        <th className="px-3 py-2 text-right font-medium">下行</th>
                                        <th className="px-3 py-2 text-right font-medium">合计</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                                    {items.map((item) => {
                                        const id = groupId(item);
                                        const expanded = expandedId === id;
                                        return (
                                            <Fragment key={id}>
                                                <tr className="bg-zinc-50/80 dark:bg-zinc-900/50" data-task-traffic-id={id}>
                                                    <td colSpan={7} className="px-3 py-2">
                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                            <div className="min-w-0">
                                                                <button type="button" className="max-w-[360px] truncate text-left font-mono text-[11px] text-blue-700 hover:underline dark:text-blue-300" onClick={() => setExpandedId(expanded ? null : id)}>
                                                                    {id}
                                                                </button>
                                                                <span className="ml-2 text-zinc-500">
                                                                    {item.taskId ? "任务" : "请求分组"} · {formatTrafficDate(item.firstSeenAt)} 至 {formatTrafficDate(item.lastSeenAt)}
                                                                </span>
                                                            </div>
                                                            <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                                                                <span>↑ {bytes(item.uploadBytes, displayUnit)}</span>
                                                                <span>↓ {bytes(item.downloadBytes, displayUnit)}</span>
                                                                <span className="font-medium">合计 {bytes(item.totalBytes, displayUnit)}</span>
                                                                <Button type="link" size="small" className="h-auto p-0" onClick={() => setExpandedId(expanded ? null : id)}>
                                                                    {expanded ? "收起完整明细" : "展开完整明细"}
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                                {item.items.map((detail, index) => (
                                                    <tr key={`${id}:item:${index}`} className="bg-white dark:bg-zinc-950">
                                                        <td className="px-3 py-2">
                                                            <span className="text-zinc-400">↳</span>
                                                            <div className="mt-0.5 max-w-[260px] truncate font-mono text-[10px] text-zinc-500" title={id}>
                                                                {id}
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <div className="font-medium text-zinc-800 dark:text-zinc-200">{detail.channelName || detail.channelId || "未归属渠道"}</div>
                                                            <div className="mt-0.5 text-zinc-500">
                                                                {itemModelLabel(detail.model)} · {detail.protocol || "未标记协议"}
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <div>{itemModeLabel(detail.connectionMode)}</div>
                                                            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{itemEndpoint(detail)}</div>
                                                        </td>
                                                        <td className="px-3 py-2">{itemRoleLabel(detail.role)}</td>
                                                        <td className="px-3 py-2 text-right tabular-nums">{bytes(detail.uploadBytes, displayUnit)}</td>
                                                        <td className="px-3 py-2 text-right tabular-nums">{bytes(detail.downloadBytes, displayUnit)}</td>
                                                        <td className="px-3 py-2 text-right font-medium tabular-nums">{bytes(detail.totalBytes, displayUnit)}</td>
                                                    </tr>
                                                ))}
                                                {expanded ? (
                                                    <tr>
                                                        <td colSpan={7} className="bg-zinc-50/60 p-3 dark:bg-zinc-900/30">
                                                            <AdminRequestTrafficDetail summary={item} displayUnit={displayUnit} />
                                                        </td>
                                                    </tr>
                                                ) : null}
                                            </Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                    {report && report.total > PAGE_SIZE ? (
                        <div className="flex justify-end">
                            <Pagination current={report.page || page} pageSize={report.pageSize || PAGE_SIZE} total={report.total} showSizeChanger={false} onChange={setPage} />
                        </div>
                    ) : null}
                    <div className="text-[11px] leading-5 text-zinc-400 dark:text-zinc-500">
                        当前筛选：{filter.start} 至 {filter.end}（结束时间不含）
                    </div>
                </div>
            </Panel>
        </div>
    );
}
