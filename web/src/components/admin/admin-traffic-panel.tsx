"use client";

import { Alert, Button, DatePicker, InputNumber, Select, Table, Tag, type TableProps } from "antd";
import { RefreshCw } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import type { AdminTrafficSummary, TrafficFilter, TrafficItem } from "@/lib/admin-traffic-types";
import { DEFAULT_TRAFFIC_DISPLAY_UNIT, formatTrafficBytes } from "@/lib/traffic-format";
import { getAdminTraffic } from "@/services/api/admin-traffic";

import { AdminTaskTrafficPanel } from "./admin-task-traffic-panel";

export type AdminTrafficPanelProps = {
    channelId?: string;
    protocol?: string;
    title?: string;
};

export type TrafficDateRange = [Dayjs, Dayjs];

const numberFormatter = new Intl.NumberFormat("zh-CN");

function defaultDateRange(): TrafficDateRange {
    const today = dayjs().startOf("day");
    return [today, dayjs()];
}

function formatExactBytes(value: number) {
    return `${numberFormatter.format(Math.max(0, value))} B`;
}

function formatBytes(value: number, displayUnit: AdminTrafficSummary["displayUnit"]) {
    const formatted = formatTrafficBytes(value, displayUnit);
    return (
        <span className="tabular-nums" title={formatExactBytes(value)}>
            {formatted.value} {formatted.unit}
        </span>
    );
}

function formatRole(role: string) {
    if (role === "upload") return "上传";
    if (role === "download") return "下载";
    if (role === "submit") return "提交";
    if (role === "query") return "查询";
    if (role === "browser") return "浏览器";
    if (role === "provider") return "供应商请求";
    if (role === "control") return "控制与探活";
    if (role === "account_maintenance" || role === "account") return "账号维护";
    if (role === "sync") return "同步配置";
    if (role === "catalog") return "模型目录";
    if (role === "cancel") return "取消任务";
    return role || "未标记";
}

export function trafficModelLabel(value: string) {
    if (value === "__shared_browser__") return "共享浏览器流量";
    if (value === "__account_probe__") return "账号检测与维护";
    if (value === "__unattributed__") return "未归属模型";
    return value.trim() || "未归属模型";
}

function itemModel(item: TrafficItem) {
    return trafficModelLabel(item.model);
}

export function trafficConnectionModeLabel(value: string) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "unknown") return "未标记";
    if (normalized === "direct") return "直连";
    if (normalized === "generic") return "通用代理";
    if (normalized === "magic") return "魔法代理";
    if (normalized === "chained") return "链式代理";
    return "未标记";
}

function itemConnectionMode(item: TrafficItem) {
    if (item.model === "__shared_browser__" && item.connectionMode === "unknown") return "共享代理（按端口）";
    return item.connectionMode.trim() ? trafficConnectionModeLabel(item.connectionMode) : item.model.trim() ? "未标记" : "共享连接";
}

function channelLabel(item: TrafficItem) {
    return item.channelName.trim() || item.channelId || "未归属渠道";
}

export function trafficCoverageLabel(item: NonNullable<AdminTrafficSummary["coverage"]>[number]) {
    if (item.message.trim()) return item.message;
    if (item.status === "unknown") return "未知";
    if (item.status === "missing" || item.status === "unavailable") return "未接入";
    if (item.status === "error" || item.status === "failed") return "读取失败";
    if (item.status === "ok" || item.status === "available" || item.status === "complete") return "已覆盖";
    return "状态未说明";
}

function StatCard({ label, value, displayUnit }: { label: string; value?: number; displayUnit: AdminTrafficSummary["displayUnit"] }) {
    return (
        <div className="min-w-0 rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
            {value === undefined ? (
                <div className="mt-1 text-base font-semibold text-zinc-400 dark:text-zinc-500">—</div>
            ) : (
                <div className="mt-1 flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-sm font-semibold text-zinc-950 dark:text-zinc-100">
                    <span className="min-w-0 truncate">{formatBytes(value, displayUnit)}</span>
                </div>
            )}
        </div>
    );
}

export function buildTrafficFilter(range: TrafficDateRange, channelId?: string, protocol?: string, model?: string, connectionMode?: string, port?: number): TrafficFilter {
    const [start, end] = range;
    return {
        start: start.toISOString(),
        end: end.toISOString(),
        ...(channelId ? { channelId } : {}),
        ...(protocol ? { protocol } : {}),
        ...(model ? { model } : {}),
        ...(connectionMode ? { connectionMode } : {}),
        ...(port === undefined ? {} : { port }),
    };
}

export function AdminTrafficPanel({ channelId, protocol, title = "全局流量统计" }: AdminTrafficPanelProps) {
    const [range, setRange] = useState<TrafficDateRange>(defaultDateRange);
    const [selectedChannelId, setSelectedChannelId] = useState<string>();
    const [model, setModel] = useState<string>();
    const [connectionMode, setConnectionMode] = useState<string>();
    const [port, setPort] = useState<number>();
    const [summary, setSummary] = useState<AdminTrafficSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const serial = useRef(0);

    const effectiveChannelId = channelId || selectedChannelId;
    const displayUnit = summary?.displayUnit ?? DEFAULT_TRAFFIC_DISPLAY_UNIT;
    const filter = useMemo(() => buildTrafficFilter(range, effectiveChannelId, protocol, model, connectionMode, port), [effectiveChannelId, connectionMode, model, port, protocol, range]);

    const load = useCallback(async () => {
        const version = ++serial.current;
        setLoading(true);
        setError("");
        setSummary(null);
        try {
            const result = await getAdminTraffic(filter);
            if (serial.current !== version) return;
            setSummary(result);
        } catch (reason) {
            if (serial.current === version) setError(reason instanceof Error ? reason.message : "读取流量统计失败");
        } finally {
            if (serial.current === version) setLoading(false);
        }
    }, [filter]);

    useEffect(() => {
        void load();
        return () => {
            serial.current += 1;
        };
    }, [load]);

    const modelOptions = useMemo(() => (summary?.options.models || []).filter(Boolean).map((value) => ({ value, label: trafficModelLabel(value) })), [summary?.options.models]);
    const connectionModeOptions = useMemo(() => (summary?.options.connectionModes || []).filter(Boolean).map((value) => ({ value, label: trafficConnectionModeLabel(value) })), [summary?.options.connectionModes]);
    const channelOptions = useMemo(() => (summary?.options.channels || []).map((item) => ({ value: item.id, label: item.name || item.id })), [summary?.options.channels]);

    const columns = useMemo<TableProps<TrafficItem>["columns"]>(
        () => [
            { title: "来源渠道", key: "channel", fixed: "left", width: 150, render: (_, item) => <span className="font-medium">{channelLabel(item)}</span> },
            { title: "模型", dataIndex: "model", width: 150, render: (_, item) => itemModel(item) },
            { title: "协议", dataIndex: "protocol", width: 120, render: (value: string) => value || "未标记" },
            { title: "连接模式", dataIndex: "connectionMode", width: 120, render: (_, item) => itemConnectionMode(item) },
            { title: "角色", dataIndex: "role", width: 90, render: (value: string) => formatRole(value) },
            { title: "地址", dataIndex: "address", width: 190, render: (value: string) => value || "未标记" },
            { title: "端口", dataIndex: "port", width: 80, align: "right", render: (value: number) => (value ? String(value) : "直连") },
            { title: "上行", dataIndex: "uploadBytes", width: 125, align: "right", render: (value: number) => formatBytes(value, displayUnit) },
            { title: "下行", dataIndex: "downloadBytes", width: 125, align: "right", render: (value: number) => formatBytes(value, displayUnit) },
            { title: "合计", dataIndex: "totalBytes", width: 125, align: "right", render: (value: number) => formatBytes(value, displayUnit) },
        ],
        [displayUnit],
    );

    const coverageIncomplete = summary !== null && (!summary.coverage?.length || summary.coverage.some((item) => !["ok", "available", "complete"].includes(item.status)));
    const hasObservedTraffic = summary !== null && (summary.items.length > 0 || summary.totalBytes > 0);
    const hasData = summary !== null && (!coverageIncomplete || hasObservedTraffic);
    const resetRange = (days: number) => {
        const end = dayjs().startOf("day");
        const now = dayjs();
        setRange([days === 1 ? now.startOf("day") : end.subtract(days, "day"), now]);
    };

    return (
        <>
        <Panel>
            <PanelHeader
                title={title}
                description="按有效时间范围统计上行、下行和来源明细；开始时间包含，结束时间不包含。"
                actions={
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-3 p-3 sm:p-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="min-w-0 w-full sm:w-auto sm:max-w-full">
                        <DatePicker.RangePicker
                            className="w-full sm:w-[320px]"
                            allowClear={false}
                            showTime
                            value={range}
                            format="YYYY-MM-DD HH:mm"
                            onChange={(value) => {
                                if (value?.[0] && value[1]) setRange([value[0], value[1]]);
                            }}
                        />
                    </div>
                    {!channelId ? <Select className="min-w-28 max-w-full" allowClear placeholder="全部渠道" value={selectedChannelId} options={channelOptions} onChange={setSelectedChannelId} /> : null}
                    <Select className="min-w-28 max-w-full" allowClear placeholder="全部模型" value={model} options={modelOptions} onChange={setModel} />
                    <Select className="min-w-28 max-w-full" allowClear placeholder="全部模式" value={connectionMode} options={connectionModeOptions} onChange={setConnectionMode} />
                    <InputNumber className="w-28" min={0} max={65535} precision={0} placeholder="全部端口" value={port} onChange={(value) => setPort(value === null ? undefined : value)} />
                    <Button size="small" onClick={() => resetRange(1)}>
                        今天
                    </Button>
                    <Button size="small" onClick={() => resetRange(7)}>
                        近 7 天
                    </Button>
                </div>
                {error ? <Alert type="error" showIcon message="流量统计读取失败" description={error} /> : null}
                {summary?.boundary ? <Alert type="info" showIcon message="统计边界" description={summary.boundary} /> : null}
                {summary?.coverage?.length ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                        <span>数据来源：</span>
                        {summary.coverage.map((item) => (
                            <Tag
                                key={`${item.source}-${item.status}`}
                                color={item.status === "ok" || item.status === "available" || item.status === "complete" ? "green" : item.status === "error" || item.status === "failed" ? "red" : "gold"}
                                className="m-0"
                            >
                                {item.source} · {trafficCoverageLabel(item)}
                            </Tag>
                        ))}
                    </div>
                ) : summary ? (
                    <Alert type="warning" showIcon message="覆盖来源未返回" description="未报告的来源（包括 CLI）不会被按 0 计算，请以来源状态恢复后再判断完整流量。" />
                ) : null}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <StatCard label="上行" value={hasData ? summary.uploadBytes : undefined} displayUnit={displayUnit} />
                    <StatCard label="下行" value={hasData ? summary.downloadBytes : undefined} displayUnit={displayUnit} />
                    <StatCard label="合计" value={hasData ? summary.totalBytes : undefined} displayUnit={displayUnit} />
                </div>
                <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <Table<TrafficItem>
                        size="small"
                        rowKey={(item) => `${item.channelId}:${item.model}:${item.protocol}:${item.connectionMode}:${item.role}:${item.address}:${item.port}`}
                        loading={loading}
                        columns={columns}
                        dataSource={summary?.items || []}
                        pagination={false}
                        scroll={{ x: 1290 }}
                        locale={{ emptyText: error ? "统计读取失败，未显示明细" : loading ? "正在读取流量统计" : "暂无符合条件的流量" }}
                    />
                </div>
                <div className="text-[11px] leading-5 text-zinc-400 dark:text-zinc-500">
                    当前筛选：{filter.start} 至 {filter.end}（结束时间不含）
                </div>
            </div>
        </Panel>
        <AdminTaskTrafficPanel filter={filter} displayUnit={displayUnit} />
        </>
    );
}
