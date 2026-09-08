"use client";

import { Alert, Button, Empty, Segmented, Spin, Tooltip } from "antd";
import { Activity, Check, Clock, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Metric, Panel, PanelHeader } from "@/components/admin/admin-panel";
import { chatGptApiRequest, type ChatGptStatistics } from "@/services/api/chatgpt-api";

const duration = (value: number | null) => (value == null ? "—" : `${(value / 1000).toFixed(1)} 秒`);
const percentage = (value: number | null) => (value == null ? "—" : `${value}%`);
const bytes = (value: number | null) => (value == null ? "—" : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`);
const rate = (value: number | null) => (value == null ? "—" : `${(value / 1024).toFixed(1)} KB/s`);

export function ChatGptStatisticsPanel() {
    const [range, setRange] = useState<ChatGptStatistics["time_range"]>("24h");
    const [revision, setRevision] = useState(0);
    const [data, setData] = useState<ChatGptStatistics | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError("");
        void chatGptApiRequest<ChatGptStatistics>(`statistics?time_range=${range}`, { signal: controller.signal })
            .then((value) => {
                if (!controller.signal.aborted) setData(value);
            })
            .catch((reason: unknown) => {
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取统计失败");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [range, revision]);
    const maximum = Math.max(1, ...(data?.buckets.map((bucket) => bucket.total_calls) || []));
    const runtime = data?.runtime;
    const modelCounts = Object.entries(data?.trend.model_success_requests || {}).map(([model, counts]) => ({ model, count: counts.reduce((sum, count) => sum + count, 0) }));
    const modelTotal = modelCounts.reduce((sum, item) => sum + item.count, 0);
    return (
        <Panel>
            <PanelHeader
                title="统计报表"
                description="沿用原项目的请求统计：成功、最终失败、账号切换与模型耗时。额度刷新记录单独保留在请求日志。"
                actions={
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => setRevision((value) => value + 1)}>
                        刷新报表
                    </Button>
                }
            />
            <div className="space-y-4 p-3 sm:p-5" data-chatgpt-statistics>
                <div className="min-w-0">
                    <Segmented
                        aria-label="统计时间范围"
                        value={range}
                        onChange={(value) => setRange(value as ChatGptStatistics["time_range"])}
                        options={[
                            { label: "24 小时", value: "24h" },
                            { label: "7 天", value: "7d" },
                            { label: "30 天", value: "30d" },
                        ]}
                    />
                </div>
                {error ? (
                    <Alert type="error" showIcon title={error} />
                ) : loading ? (
                    <div className="py-8 text-center">
                        <Spin aria-label="加载统计报表" />
                    </div>
                ) : data ? (
                    <>
                        <div className="grid grid-cols-2 divide-x divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 lg:grid-cols-4 dark:divide-zinc-800 dark:border-zinc-800">
                            <Metric label="请求总数" value={data.totals.total} detail="当前时间范围" icon={<Activity />} tone="blue" />
                            <Metric label="成功请求" value={data.totals.success} detail={`成功率 ${percentage(data.totals.success_rate)}`} icon={<Check />} tone="emerald" />
                            <Metric label="最终失败" value={data.totals.final_failed} detail="按最终请求结果统计" icon={<X />} tone="amber" />
                            <Metric label="平均成功耗时" value={duration(data.totals.avg_success_duration_ms)} detail="不包含失败耗时" icon={<Clock />} tone="cyan" />
                        </div>
                        <p className="text-sm text-zinc-500">
                            发生账号切换的请求 {data.switching.requests} 次 · 切换 {data.switching.count} 次 · 恢复成功 {data.switching.recovered} 次 · 恢复率 {percentage(data.switching.recovery_rate)}
                        </p>
                        <section aria-label="运行环境" className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <h3 className="text-sm font-medium">运行环境</h3>
                            <p className="text-xs text-zinc-500">GPTAPI 执行服务的资源快照；未采集到的指标显示“—”，不表示零。点击刷新报表更新。</p>
                            {runtime ? (
                                <>
                                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                                        {[
                                            { label: "应用 CPU", value: percentage(runtime.process_cpu_percent), progress: runtime.process_cpu_percent },
                                            { label: "应用内存", value: bytes(runtime.process_memory_bytes), progress: runtime.process_memory_percent },
                                            { label: runtime.memory_scope === "container" ? "容器内存" : runtime.memory_scope === "visible" ? "可见内存" : "系统内存", value: percentage(runtime.memory_percent), progress: runtime.memory_percent },
                                            { label: "数据盘", value: percentage(runtime.storage_percent), progress: runtime.storage_percent },
                                        ].map((metric) => (
                                            <div key={metric.label} className="min-w-0">
                                                <div className="flex flex-wrap justify-between gap-1 text-sm">
                                                    <span>{metric.label}</span>
                                                    <span>{metric.value}</span>
                                                </div>
                                                <div
                                                    className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
                                                    role={metric.progress == null ? undefined : "progressbar"}
                                                    aria-label={metric.label}
                                                    aria-valuenow={metric.progress ?? undefined}
                                                    aria-valuemin={0}
                                                    aria-valuemax={100}
                                                >
                                                    {metric.progress != null && <div className="h-full bg-cyan-500" style={{ width: `${metric.progress}%` }} />}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <dl className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                                        {Object.entries({
                                            运行方式: runtime.runtime_mode === "docker" ? "Docker" : "本机进程",
                                            "Python 版本": runtime.python_version,
                                            实例名称: runtime.instance_name,
                                            系统发行版: runtime.distribution,
                                            "内核 / 架构": `${runtime.kernel_version} / ${runtime.architecture}`,
                                            "CPU 容量": `${runtime.cpu_capacity} 核`,
                                            启动时间: runtime.service_started_at,
                                            已运行: `${Math.floor(runtime.service_uptime_seconds / 3600)} 小时 ${Math.floor((runtime.service_uptime_seconds % 3600) / 60)} 分钟`,
                                            "网络接收 / 发送": `${rate(runtime.network_rx_bytes_per_sec)} / ${rate(runtime.network_tx_bytes_per_sec)}`,
                                        }).map(([label, value]) => (
                                            <div key={label} className="min-w-0 border-b border-zinc-200 py-2 dark:border-zinc-800">
                                                <dt className="text-xs text-zinc-500">{label}</dt>
                                                <dd className="mt-1 break-all text-sm">{value}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                </>
                            ) : (
                                <p className="text-sm text-zinc-500">运行环境数据暂不可用</p>
                            )}
                        </section>
                        <section aria-label="模型请求分布" className="space-y-3">
                            <h3 className="text-sm font-medium">
                                模型请求分布 <span className="font-normal text-zinc-500">仅统计成功及部分成功请求</span>
                            </h3>
                            {modelTotal === 0 ? (
                                <p className="text-sm text-zinc-500">暂无成功请求</p>
                            ) : (
                                modelCounts.map(({ model, count }) => (
                                    <div key={model} className="min-w-0">
                                        <div className="flex flex-wrap justify-between gap-2 text-sm">
                                            <span className="break-all">{model}</span>
                                            <span>
                                                {count} 次 · {((count * 100) / modelTotal).toFixed(1)}%
                                            </span>
                                        </div>
                                        <div className="mt-1 h-2 rounded bg-cyan-500" style={{ width: `${(count * 100) / modelTotal}%` }} />
                                    </div>
                                ))
                            )}
                        </section>
                        <section aria-label="调用活跃度" className="space-y-3">
                            <h3 className="text-sm font-medium">调用活跃度</h3>
                            <p className="text-xs text-zinc-500">使用所选时间范围的真实请求时间桶；悬停、聚焦或点击方格查看详情。</p>
                            <div className="grid grid-cols-12 gap-1.5 sm:grid-cols-24">
                                {data.buckets.map((bucket) => (
                                    <Tooltip key={bucket.start_at} trigger={["hover", "focus", "click"]} title={`${bucket.label}：总计 ${bucket.total_calls}，成功 ${bucket.success_calls}，最终失败 ${bucket.final_failed_calls}`}>
                                        <button
                                            type="button"
                                            className="aspect-square min-w-0 cursor-pointer rounded border border-cyan-500/30 focus-visible:outline-2 focus-visible:outline-cyan-500"
                                            aria-label={`${bucket.label}：总计 ${bucket.total_calls}，成功 ${bucket.success_calls}，最终失败 ${bucket.final_failed_calls}`}
                                            style={{ backgroundColor: `rgb(6 182 212 / ${bucket.total_calls ? 0.2 + (0.8 * bucket.total_calls) / maximum : 0.06})` }}
                                        />
                                    </Tooltip>
                                ))}
                            </div>
                            <div className="flex justify-between gap-2 text-xs text-zinc-500">
                                <span>{data.buckets[0]?.label}</span>
                                <span>颜色越深，调用越多</span>
                                <span>{data.buckets.at(-1)?.label}</span>
                            </div>
                        </section>
                        <div>
                            <h3 className="mb-3 text-sm font-medium">
                                请求趋势 <span className="ml-2 font-normal text-zinc-500">成功 / 最终失败</span>
                            </h3>
                            {data.totals.total === 0 ? (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选时间内暂无生成请求" />
                            ) : (
                                <>
                                    <div className="flex h-40 items-end gap-1 border-b border-zinc-200 dark:border-zinc-800" role="img" aria-label="成功与失败请求趋势">
                                        {data.buckets.map((bucket) => (
                                            <div key={bucket.start_at} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${bucket.label}：成功 ${bucket.success_calls}，失败 ${bucket.final_failed_calls}`}>
                                                <div className="bg-amber-500" style={{ height: `${(bucket.final_failed_calls / maximum) * 100}%` }} />
                                                <div className="bg-cyan-500" style={{ height: `${(bucket.success_calls / maximum) * 100}%` }} />
                                            </div>
                                        ))}
                                    </div>
                                    <div className="mt-1 flex justify-between text-xs text-zinc-500">
                                        <span>{data.buckets[0]?.label}</span>
                                        <span>{data.buckets.at(-1)?.label}</span>
                                    </div>
                                </>
                            )}
                        </div>
                        <h3 className="text-sm font-medium">模型成功量与耗时</h3>
                        {Object.entries(data.trend.model_success_requests).map(([model, counts]) => (
                            <div key={model} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <div className="flex flex-wrap justify-between gap-2 text-sm">
                                    <span className="break-all font-medium">{model}</span>
                                    <span>成功 {counts.reduce((sum, count) => sum + count, 0)} 次</span>
                                </div>
                                <div className="mt-2 overflow-x-auto">
                                    <table className="w-full text-left text-xs">
                                        <thead>
                                            <tr>
                                                <th className="pr-4 font-normal text-zinc-500">时间</th>
                                                {data.trend.labels.map((label, index) => (
                                                    <th key={index} className="whitespace-nowrap px-2 font-normal text-zinc-500">
                                                        {label}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <th className="whitespace-nowrap pr-4 font-normal">成功量</th>
                                                {counts.map((count, index) => (
                                                    <td key={index} className="px-2 py-1">
                                                        {count}
                                                    </td>
                                                ))}
                                            </tr>
                                            <tr>
                                                <th className="whitespace-nowrap pr-4 font-normal">平均耗时</th>
                                                {(data.trend.model_avg_success_duration_ms[model] || []).map((value, index) => (
                                                    <td key={index} className="whitespace-nowrap px-2">
                                                        {duration(value)}
                                                    </td>
                                                ))}
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))}
                    </>
                ) : null}
            </div>
        </Panel>
    );
}
