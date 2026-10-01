"use client";

import { Alert, Skeleton, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";

import type { AdminRequestTrafficReport, RequestTrafficSummary, TrafficItem } from "@/lib/admin-traffic-types";
import { DEFAULT_TRAFFIC_DISPLAY_UNIT, formatTrafficBytes, type TrafficDisplayUnit } from "@/lib/traffic-format";
import { getAdminRequestTraffic } from "@/services/api/admin-traffic";

export type RequestTrafficValue = unknown;

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Extract the persisted request identity without assuming a provider-specific log shape. */
export function trafficRequestId(value: RequestTrafficValue) {
    const record = recordValue(value);
    if (!record) return "";
    return stringValue(record.requestId) || stringValue(record.request_id) || stringValue(record.id);
}

/** Extract an upstream task identity when a provider exposes one. */
export function trafficTaskId(value: RequestTrafficValue) {
    const record = recordValue(value);
    if (!record) return "";
    return (
        stringValue(record.serverTaskId) ||
        stringValue(record.server_task_id) ||
        stringValue(record.generationTaskId) ||
        stringValue(record.generation_task_id) ||
        stringValue(record.taskId) ||
        stringValue(record.task_id) ||
        stringValue(record.submissionId) ||
        stringValue(record.submission_id)
    );
}

export function collectRequestIds(values: RequestTrafficValue[]) {
    return Array.from(new Set(values.map((value) => trafficRequestId(value)).filter(Boolean)));
}

export function collectTaskIds(values: RequestTrafficValue[]) {
    return Array.from(new Set(values.map((value) => trafficTaskId(value)).filter(Boolean)));
}

export function getRequestTrafficSummary(items: RequestTrafficSummary[], id: string | undefined) {
    const normalized = id?.trim();
    if (!normalized) return undefined;
    return items.find((item) => item.requestId === normalized || item.taskId === normalized);
}

/** Prefer an exact task group before falling back to a request group. */
export function getTaskTrafficSummary(items: RequestTrafficSummary[], id: string | undefined) {
    const normalized = id?.trim();
    if (!normalized) return undefined;
    return items.find((item) => item.taskId === normalized);
}

export function selectRequestTaskTrafficSummary({ requestId, taskId, requestItems, taskItems = [] }: { requestId?: string; taskId?: string; requestItems: RequestTrafficSummary[]; taskItems?: RequestTrafficSummary[] }) {
    const normalizedTaskId = taskId?.trim();
    const normalizedRequestId = requestId?.trim();
    if (normalizedTaskId) {
        const exactTask = getTaskTrafficSummary(taskItems, normalizedTaskId) || getTaskTrafficSummary(requestItems, normalizedTaskId);
        if (exactTask) return exactTask;
    }
    if (normalizedRequestId) {
        return requestItems.find((item) => item.requestId === normalizedRequestId) || taskItems.find((item) => item.requestId === normalizedRequestId);
    }
    return undefined;
}

export function dedupeTrafficSummarySelections(selections: Array<{ summary?: RequestTrafficSummary; requestId?: string; taskId?: string }>) {
    const groups = new Map<string, RequestTrafficSummary>();
    for (const { summary, requestId, taskId } of selections) {
        const key = summary?.taskId ? `task:${summary.taskId}` : summary?.requestId ? `request:${summary.requestId}` : taskId ? `task:${taskId}` : requestId ? `request:${requestId}` : "";
        if (key && summary) groups.set(key, summary);
    }
    return Array.from(groups.values());
}

export function useAdminRequestTraffic(requestIds: string[], taskIds: string[] = [], refreshKey = "") {
    const requestKey = useMemo(
        () =>
            `r:${Array.from(new Set(requestIds.map((value) => value.trim()).filter(Boolean)))
                .sort()
                .join("\u0000")}|t:${Array.from(new Set(taskIds.map((value) => value.trim()).filter(Boolean)))
                .sort()
                .join("\u0000")}|v:${refreshKey}`,
        [requestIds, taskIds, refreshKey],
    );
    const ids = useMemo(() => {
        const [requestPart, taskPart] = requestKey.split("|t:");
        return { requestIds: requestPart.replace(/^r:/, "").split("\u0000").filter(Boolean), taskIds: taskPart.split("|v:")[0].split("\u0000").filter(Boolean) };
    }, [requestKey]);
    const [report, setReport] = useState<AdminRequestTrafficReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        if (!ids.requestIds.length && !ids.taskIds.length) {
            setReport({ displayUnit: DEFAULT_TRAFFIC_DISPLAY_UNIT, items: [] });
            setLoading(false);
            setError("");
            return () => controller.abort();
        }
        setReport(null);
        setLoading(true);
        setError("");
        void getAdminRequestTraffic(ids, controller.signal)
            .then((next) => {
                if (!controller.signal.aborted) setReport(next);
            })
            .catch((reason: unknown) => {
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取请求流量失败");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [ids]);

    const byRequestId = useMemo(() => {
        const map = new Map<string, RequestTrafficSummary>();
        for (const item of [...(report?.items || []), ...(report?.tasks || [])]) {
            if (item.requestId) map.set(item.requestId, item);
            if (item.taskId) map.set(item.taskId, item);
        }
        return map;
    }, [report?.items, report?.tasks]);

    return { report, byRequestId, loading, error };
}

export function formatTrafficDate(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value || "—";
}

function trafficValue(bytes: number, unit: TrafficDisplayUnit) {
    const formatted = formatTrafficBytes(bytes, unit);
    return `${formatted.value} ${formatted.unit}`;
}

function sharedBrowserItem(item: TrafficItem) {
    return item.attributionScope === "shared_browser" || item.model === "__shared_browser__";
}

function hasSharedBrowserTraffic(summary?: RequestTrafficSummary) {
    return Boolean(summary?.items.some(sharedBrowserItem));
}

export function trafficRoleLabel(role: string) {
    const labels: Record<string, string> = {
        upload: "上传",
        submit: "提交",
        query: "查询",
        download: "下载",
        browser: "浏览器",
        provider: "供应商请求",
        control: "控制与探活",
        account: "账号维护",
        account_maintenance: "账号维护",
        cancel: "取消任务",
        sync: "同步配置",
        catalog: "模型目录",
    };
    return labels[role] || role || "未标记";
}

export function trafficConnectionModeLabel(mode: string) {
    const labels: Record<string, string> = { direct: "直连", generic: "通用代理", magic: "魔法代理", chained: "链式代理" };
    const normalized = mode?.trim().toLowerCase();
    return !normalized || normalized === "unknown" ? "未标记" : labels[normalized] || mode;
}

export function trafficEndpointLabel(item: TrafficItem) {
    const address = item.address?.trim() || "未标记地址";
    return `${address}:${item.port ? item.port : "直连"}`;
}

function itemChannelLabel(item: TrafficItem) {
    return item.channelName?.trim() || item.channelId || "未归属渠道";
}

function itemModelLabel(item: TrafficItem) {
    if (item.model === "__shared_browser__") return "共享浏览器流量";
    if (item.model === "__account_probe__") return "账号检测与维护";
    return item.model?.trim() || "未归属模型";
}

export function AdminRequestTrafficSummary({ summary, displayUnit, loading = false, className = "" }: { summary?: RequestTrafficSummary; displayUnit: TrafficDisplayUnit; loading?: boolean; className?: string }) {
    if (loading && !summary)
        return (
            <div className={`min-w-[190px] ${className}`}>
                <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
        );
    if (!summary) return <span className={`text-xs text-zinc-400 ${className}`}>未采集</span>;
    return (
        <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 ${className}`} data-testid="request-traffic-summary">
            <span>↑ {trafficValue(summary.uploadBytes, displayUnit)}</span>
            <span>↓ {trafficValue(summary.downloadBytes, displayUnit)}</span>
            <span className="font-medium text-zinc-700 dark:text-zinc-200">合计 {trafficValue(summary.totalBytes, displayUnit)}</span>
            {hasSharedBrowserTraffic(summary) ? (
                <Tag className="m-0 text-[10px]" color="gold">
                    共享浏览器不可归属单模型
                </Tag>
            ) : null}
        </div>
    );
}

export function AdminRequestTrafficDetail({ summary, displayUnit, loading = false, error = "" }: { summary?: RequestTrafficSummary; displayUnit: TrafficDisplayUnit; loading?: boolean; error?: string }) {
    if (loading && !summary) return <Skeleton active paragraph={{ rows: 3 }} />;
    if (error) return <Alert type="warning" showIcon message="请求流量读取失败" description={error} />;
    if (!summary) return <div className="rounded-lg border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">该请求暂无可用的中心流量记录。</div>;
    const shared = hasSharedBrowserTraffic(summary);
    return (
        <section className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/40 p-3 dark:border-zinc-800 dark:bg-zinc-900/30" data-testid="request-traffic-detail">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {summary.requestId ? (
                        <div>
                            请求 ID：<code className="break-all text-zinc-700 dark:text-zinc-200">{summary.requestId}</code>
                        </div>
                    ) : null}
                    {summary.taskId ? (
                        <div>
                            任务 ID：<code className="break-all text-zinc-700 dark:text-zinc-200">{summary.taskId}</code>
                        </div>
                    ) : null}
                    <div>
                        时间：{formatTrafficDate(summary.firstSeenAt)} 至 {formatTrafficDate(summary.lastSeenAt)}
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    <span>↑ {trafficValue(summary.uploadBytes, displayUnit)}</span>
                    <span>↓ {trafficValue(summary.downloadBytes, displayUnit)}</span>
                    <span>合计 {trafficValue(summary.totalBytes, displayUnit)}</span>
                </div>
            </div>
            {shared ? <Alert type="warning" showIcon message="共享浏览器流量不可归属于单个模型" description="以下明细保留真实的共享浏览器通道、连接模式和端点；系统不会把它伪装成某个模型的 0 流量。" /> : null}
            <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                <table className="min-w-[920px] w-full text-left text-xs">
                    <thead className="bg-white text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
                        <tr>
                            <th className="px-2.5 py-2 font-medium">渠道 / 模型</th>
                            <th className="px-2.5 py-2 font-medium">连接模式</th>
                            <th className="px-2.5 py-2 font-medium">地址：端口</th>
                            <th className="px-2.5 py-2 font-medium">角色</th>
                            <th className="px-2.5 py-2 text-right font-medium">上行</th>
                            <th className="px-2.5 py-2 text-right font-medium">下行</th>
                            <th className="px-2.5 py-2 text-right font-medium">合计</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {summary.items.length ? (
                            summary.items.map((item, index) => (
                                <tr key={`${item.channelId}:${item.model}:${item.role}:${item.address}:${item.port}:${index}`} className="bg-white dark:bg-zinc-950">
                                    <td className="px-2.5 py-2">
                                        <div className="font-medium text-zinc-800 dark:text-zinc-200">{itemChannelLabel(item)}</div>
                                        <div className="mt-0.5 text-zinc-500">
                                            {itemModelLabel(item)} · {item.protocol || "未标记协议"}
                                        </div>
                                    </td>
                                    <td className="px-2.5 py-2">{trafficConnectionModeLabel(item.connectionMode)}</td>
                                    <td className="px-2.5 py-2 font-mono text-[11px]">{trafficEndpointLabel(item)}</td>
                                    <td className="px-2.5 py-2">{trafficRoleLabel(item.role)}</td>
                                    <td className="px-2.5 py-2 text-right tabular-nums">{trafficValue(item.uploadBytes, displayUnit)}</td>
                                    <td className="px-2.5 py-2 text-right tabular-nums">{trafficValue(item.downloadBytes, displayUnit)}</td>
                                    <td className="px-2.5 py-2 text-right font-medium tabular-nums">{trafficValue(item.totalBytes, displayUnit)}</td>
                                </tr>
                            ))
                        ) : (
                            <tr>
                                <td colSpan={7} className="px-3 py-4 text-center text-zinc-500">
                                    该请求没有通道明细。
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

export function AdminRequestTraffic({
    requestIds = [],
    taskIds = [],
    selectedRequestId,
    selectedTaskId,
    refreshKey = "",
    className = "",
}: {
    requestIds?: string[];
    taskIds?: string[];
    selectedRequestId?: string;
    selectedTaskId?: string;
    refreshKey?: string;
    className?: string;
}) {
    const traffic = useAdminRequestTraffic(requestIds, taskIds, refreshKey);
    const summary = selectRequestTaskTrafficSummary({
        requestId: selectedRequestId || requestIds[0],
        taskId: selectedTaskId || (selectedRequestId ? undefined : taskIds[0]),
        requestItems: traffic.report?.items || [],
        taskItems: traffic.report?.tasks || [],
    });
    return (
        <div className={className}>
            <AdminRequestTrafficDetail summary={summary} displayUnit={traffic.report?.displayUnit || DEFAULT_TRAFFIC_DISPLAY_UNIT} loading={traffic.loading} error={traffic.error} />
        </div>
    );
}
