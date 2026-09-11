"use client";

import { Alert, App, Button, Checkbox, Drawer, Empty, Input, Pagination, Popconfirm, Select, Space, Spin, Tabs, Tag } from "antd";
import { Activity, BarChart3, Bot, Check, ChevronRight, CircleDollarSign, Film, RefreshCw, Search, Sparkles } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

import { Metric, Panel, PanelHeader } from "@/components/admin/admin-panel";
import {
    clearDreaminaLogs,
    getDreaminaLogs,
    getDreaminaOverview,
    getDreaminaStats,
    refreshDreaminaStatus,
    saveDreaminaModels,
    type DreaminaLog,
    type DreaminaModel,
    type DreaminaOverview,
    type DreaminaStats,
    type DreaminaStatsRange,
} from "@/services/api/dreamina";

type DreaminaModelGroup = "Seedream" | "Seedance" | "图片超清";

const DREAMINA_MODEL_GROUPS: DreaminaModelGroup[] = ["Seedream", "Seedance", "图片超清"];
const DREAMINA_STATS_RANGES: Array<{ value: DreaminaStatsRange; label: string }> = [
    { value: "all", label: "总计" },
    { value: "week", label: "本周" },
    { value: "month", label: "本月" },
    { value: "year", label: "本年" },
];

export function AdminDreaminaSection() {
    const { message } = App.useApp();
    const [state, setState] = useState<DreaminaOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [savingModels, setSavingModels] = useState(false);
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
    const [activeTab, setActiveTab] = useState<"overview" | "logs">("overview");
    const [logPage, setLogPage] = useState(1);
    const [logPageData, setLogPageData] = useState<{ items: DreaminaLog[]; total: number; page: number; pageSize: number } | null>(null);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logStatus, setLogStatus] = useState("");
    const [logCommand, setLogCommand] = useState("");
    const [selectedLog, setSelectedLog] = useState<DreaminaLog | null>(null);
    const [statsRange, setStatsRange] = useState<DreaminaStatsRange>("all");
    const [rangeStats, setRangeStats] = useState<DreaminaStats | null>(null);
    const [statsLoading, setStatsLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError("");
        try {
            const data = await getDreaminaOverview();
            setState(data);
            setSelectedModelIds(data.models.enabledModelIds);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "无法读取即梦 CLI 状态");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const loadLogs = useCallback(
        async (pageNumber = logPage) => {
            setLogsLoading(true);
            try {
                setLogPageData(
                    await getDreaminaLogs({
                        page: pageNumber,
                        pageSize: 20,
                        status: logStatus || undefined,
                        command: logCommand || undefined,
                    }),
                );
            } catch (error) {
                message.error(error instanceof Error ? error.message : "无法读取即梦 CLI 请求日志");
            } finally {
                setLogsLoading(false);
            }
        },
        [logCommand, logPage, logStatus, message],
    );

    useEffect(() => {
        if (activeTab === "logs") void loadLogs(logPage);
    }, [activeTab, loadLogs, logPage]);

    const saveModels = async () => {
        setSavingModels(true);
        try {
            await saveDreaminaModels(selectedModelIds);
            await load();
            message.success("即梦 CLI 模型配置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "即梦 CLI 模型配置保存失败");
        } finally {
            setSavingModels(false);
        }
    };

    const refreshStatus = async () => {
        setLoading(true);
        setLoadError("");
        try {
            await refreshDreaminaStatus();
            await load();
            message.success("即梦 CLI 状态已刷新");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "即梦 CLI 状态刷新失败";
            setLoadError(detail);
            message.error(detail);
        } finally {
            setLoading(false);
        }
    };

    const queryLogs = () => {
        setLogPage(1);
        void loadLogs(1);
    };

    const clearLogs = async () => {
        try {
            await clearDreaminaLogs();
            setLogPageData({ items: [], total: 0, page: 1, pageSize: 20 });
            setStatsRange("all");
            setRangeStats(null);
            await load();
            message.success("即梦 CLI 请求日志已清空");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "即梦 CLI 请求日志清空失败");
        }
    };

    const changeStatsRange = async (range: DreaminaStatsRange) => {
        const previousRange = statsRange;
        setStatsRange(range);
        setStatsLoading(true);
        try {
            setRangeStats(await getDreaminaStats(range));
        } catch (error) {
            setStatsRange(previousRange);
            message.error(error instanceof Error ? error.message : "无法读取即梦 CLI 积分统计");
        } finally {
            setStatsLoading(false);
        }
    };

    const models = state?.models.catalog || [];
    const groupedModels = useMemo(
        () =>
            DREAMINA_MODEL_GROUPS.map((group) => ({
                group,
                models: models.filter((model) => dreaminaModelGroup(model) === group),
            })).filter((entry) => entry.models.length),
        [models],
    );
    const runtime = state?.runtime;
    const stats = rangeStats || state?.stats;
    const statsRangeLabel = DREAMINA_STATS_RANGES.find((item) => item.value === statsRange)?.label || "总计";

    return (
        <div className="space-y-4">
            {loadError ? (
                <Alert
                    type="error"
                    showIcon
                    message="即梦 CLI 状态读取失败"
                    description={loadError}
                    action={
                        <Button size="small" onClick={() => void load()}>
                            重试
                        </Button>
                    }
                />
            ) : null}

            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as "overview" | "logs")}
                items={[
                    { key: "overview", label: "账号与模型" },
                    { key: "logs", label: "请求日志" },
                ]}
            />

            {activeTab === "overview" ? (
                <div className="space-y-4">
                    <Panel>
                        <PanelHeader
                            title="即梦 CLI"
                            description="通过当前服务可访问的即梦 CLI 使用 Seedream、Seedance 和图片超清能力；本页只展示脱敏授权状态，不提供付费实测。"
                            actions={
                                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refreshStatus()}>
                                    刷新状态
                                </Button>
                            }
                        />
                        <div className="grid gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-800">
                            <Metric
                                label="安装状态"
                                value={loading && !runtime ? "读取中" : runtime?.installed ? "已安装" : "未安装"}
                                detail={runtime?.version ? `版本 ${runtime.version}` : "检查 CLI 环境"}
                                icon={<Sparkles className="size-5" />}
                                tone={runtime?.installed ? "emerald" : "slate"}
                            />
                            <Metric
                                label="授权状态"
                                value={loading && !runtime ? "读取中" : runtime?.authorized ? "已授权" : "未授权"}
                                detail={runtime?.account?.userIdMasked || "未读取账号"}
                                icon={<Bot className="size-5" />}
                                tone={runtime?.authorized ? "emerald" : "amber"}
                            />
                            <Metric label="积分余额" value={runtime?.account ? formatCredit(runtime.account.totalCredit) : "—"} detail="来自 dreamina user_credit" icon={<CircleDollarSign className="size-5" />} tone="blue" />
                            <Metric label="会员等级" value={runtime?.account?.vipLevel || "—"} detail="当前即梦账号" icon={<Activity className="size-5" />} tone="cyan" />
                        </div>
                        {runtime && !runtime.authorized ? (
                            <div className="p-3 sm:p-5">
                                <Alert
                                    type="info"
                                    showIcon
                                    message="即梦 CLI 尚未授权"
                                    description={
                                        <span>
                                            请在部署服务账号终端执行 <code>dreamina login</code> 后点击“刷新状态”。
                                        </span>
                                    }
                                />
                            </div>
                        ) : null}
                        {runtime?.error ? (
                            <div className="p-3 sm:p-5">
                                <Alert type="warning" showIcon message="CLI 状态检查提示" description={runtime.error} />
                            </div>
                        ) : null}
                    </Panel>

                    <Panel>
                        <PanelHeader title="账号与运行环境" description="授权状态来自当前服务端的即梦 CLI 环境；用户 ID 已脱敏，CLI 凭据不会在页面回显。" />
                        {loading && !runtime ? (
                            <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-zinc-500">
                                <Spin size="small" />
                                正在读取 CLI 状态...
                            </div>
                        ) : (
                            <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
                                <InfoItem label="安装状态" value={runtime?.installed ? "已安装" : "未安装"} />
                                <InfoItem label="授权状态" value={runtime?.authorized ? "已授权" : "未授权"} />
                                <InfoItem label="脱敏用户 ID" value={runtime?.account?.userIdMasked || "—"} mono />
                                <InfoItem label="积分余额" value={runtime?.account ? formatCredit(runtime.account.totalCredit) : "—"} />
                                <InfoItem label="会员等级" value={runtime?.account?.vipLevel || "—"} />
                                <InfoItem label="CLI 版本" value={runtime?.version || "—"} mono />
                                <InfoItem label="构建提交" value={runtime?.commit || "—"} mono />
                                <InfoItem label="最近检查" value={runtime?.checkedAt ? formatDate(runtime.checkedAt) : "—"} />
                            </div>
                        )}
                    </Panel>

                    <Panel>
                        <PanelHeader
                            title="模型配置"
                            description="选择要同步到当前项目逻辑模型的即梦 CLI 能力。图片超清模型会在画布节点的分辨率放大设置中提供。"
                            actions={
                                <Button type="primary" icon={<Check className="size-4" />} loading={savingModels} disabled={!models.length || (selectedModelIds.length > 0 && runtime?.authorized !== true)} onClick={() => void saveModels()}>
                                    保存模型
                                </Button>
                            }
                        />
                        {!models.length ? (
                            <div className="p-6">
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? "正在读取模型目录" : "暂无可用模型目录"} />
                            </div>
                        ) : (
                            <div className="grid gap-4 p-3 sm:p-5 xl:grid-cols-3">
                                {groupedModels.map(({ group, models: groupModels }) => (
                                    <section key={group} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                        <div className="mb-3 flex items-center justify-between gap-2">
                                            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{group}</h3>
                                            <Tag>{groupModels.length} 个模型</Tag>
                                        </div>
                                        <div className="space-y-2">
                                            {groupModels.map((model) => {
                                                const checked = selectedModelIds.includes(model.id);
                                                return (
                                                    <label key={model.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 transition hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                                                        <Checkbox
                                                            checked={checked}
                                                            disabled={!checked && runtime?.authorized !== true}
                                                            onChange={(event) => setSelectedModelIds((current) => (event.target.checked ? (current.includes(model.id) ? current : [...current, model.id]) : current.filter((id) => id !== model.id)))}
                                                        />
                                                        <span className="min-w-0">
                                                            <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                                                <span className="truncate">{model.displayName}</span>
                                                                {model.vipOnly ? (
                                                                    <Tag color="gold" className="m-0">
                                                                        VIP
                                                                    </Tag>
                                                                ) : null}
                                                            </span>
                                                            <span className="mt-1 block truncate font-mono text-[11px] text-zinc-500" title={model.upstreamModel}>
                                                                {model.upstreamModel}
                                                            </span>
                                                            <span className="mt-1 block text-xs leading-5 text-zinc-500">{model.description}</span>
                                                            <span className="mt-1 block truncate font-mono text-[11px] text-zinc-400" title={model.command}>
                                                                {model.command}
                                                            </span>
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    </section>
                                ))}
                            </div>
                        )}
                    </Panel>

                    <Panel>
                        <PanelHeader
                            title="调用统计"
                            description={`按任务首次返回官方 credit_count 的时间统计，同一提交 ID 只计一次；当前范围：${statsRangeLabel}。`}
                            actions={<Select className="w-24" value={statsRange} loading={statsLoading} options={DREAMINA_STATS_RANGES} onChange={(value: DreaminaStatsRange) => void changeStatsRange(value)} aria-label="积分统计时间范围" />}
                        />
                        <div className="grid gap-px bg-zinc-200 sm:grid-cols-5 dark:bg-zinc-800">
                            <Metric label="请求总数" value={stats?.total.toLocaleString() || "0"} detail="已登记 CLI 请求" icon={<BarChart3 className="size-5" />} tone="slate" />
                            <Metric label="成功" value={stats?.success.toLocaleString() || "0"} detail="完成的请求" icon={<Check className="size-5" />} tone="emerald" />
                            <Metric label="失败" value={stats?.failed.toLocaleString() || "0"} detail="CLI 返回失败" icon={<Activity className="size-5" />} tone="amber" />
                            <Metric label="需要确认" value={stats?.needsReview.toLocaleString() || "0"} detail="结果状态待确认" icon={<Film className="size-5" />} tone="cyan" />
                            <Metric label="积分消耗" value={stats?.officialCredits.toLocaleString() || "0"} detail={`${statsRangeLabel}官方逐单值`} icon={<CircleDollarSign className="size-5" />} tone="blue" />
                        </div>
                    </Panel>
                </div>
            ) : (
                <Panel>
                    <PanelHeader
                        title="请求日志"
                            description="每个提交 ID 只保留一条任务生命周期日志：记录提交、最终成功或失败结果、耗时和逐单积分；轮询过程不会单独落库。"
                        actions={
                            <Space wrap size={6}>
                                <Input
                                    className="w-44"
                                    allowClear
                                    prefix={<Search className="size-3.5" />}
                                    value={logCommand}
                                    placeholder="命令 / 模型 / 提交 ID"
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setLogCommand(event.target.value)}
                                    onPressEnter={queryLogs}
                                />
                                <Select
                                    className="w-28"
                                    value={logStatus}
                                    options={[
                                        { value: "", label: "全部状态" },
                                        { value: "success", label: "成功" },
                                        { value: "failed", label: "失败" },
                                        { value: "needs_review", label: "需要确认" },
                                    ]}
                                    onChange={(value: string) => setLogStatus(value)}
                                />
                                <Button loading={logsLoading} onClick={queryLogs}>
                                    查询
                                </Button>
                                <Popconfirm title="清空全部即梦 CLI 请求日志？" description="清空后无法恢复，请确认已完成统计留档。" onConfirm={() => void clearLogs()}>
                                    <Button danger>清空</Button>
                                </Popconfirm>
                            </Space>
                        }
                    />
                    {!logPageData?.items.length ? (
                        <div className="p-6">
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={logsLoading ? "正在读取请求日志" : "暂无即梦 CLI 请求日志"} />
                        </div>
                    ) : (
                        <>
                            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                                {logPageData.items.map((log) => (
                                    <DreaminaLogRow key={log.id} log={log} onClick={() => setSelectedLog(log)} />
                                ))}
                            </div>
                            <div className="flex justify-end border-t border-zinc-200 p-3 dark:border-zinc-800">
                                <Pagination current={logPageData.page} pageSize={logPageData.pageSize} total={logPageData.total} showSizeChanger={false} hideOnSinglePage onChange={(page) => setLogPage(page)} />
                            </div>
                        </>
                    )}
                </Panel>
            )}

            <DreaminaLogDrawer log={selectedLog} onClose={() => setSelectedLog(null)} />
        </div>
    );
}

export function dreaminaModelGroup(model: Pick<DreaminaModel, "id" | "upstreamModel" | "displayName" | "command" | "capability">): DreaminaModelGroup {
    const text = [model.id, model.upstreamModel, model.displayName, model.command].join(" ").toLowerCase();
    if (model.capability === "video" || text.includes("seedance")) return "Seedance";
    if (text.includes("image_upscale") || text.includes("upscale") || text.includes("超清")) return "图片超清";
    return "Seedream";
}

function InfoItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className={`mt-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100 ${mono ? "font-mono" : ""}`} title={value}>
                {value}
            </div>
        </div>
    );
}

function DreaminaLogRow({ log, onClick }: { log: DreaminaLog; onClick: () => void }) {
    return (
        <button
            type="button"
            data-dreamina-log-id={log.id}
            aria-label={`查看即梦 CLI 请求日志：${log.model}`}
            onClick={onClick}
            className="grid w-full gap-2 p-3 text-left text-xs transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 sm:grid-cols-[126px_150px_minmax(0,1fr)_minmax(180px,1.2fr)_24px] sm:items-center sm:p-4 dark:hover:bg-zinc-900/70"
        >
            <div className="text-zinc-500">
                <div>{formatDate(log.createdAt)}</div>
                <div className="mt-0.5 text-[11px]">
                    {log.succeededAt ? `成功 ${formatDate(log.succeededAt)}` : log.failedAt ? `失败 ${formatDate(log.failedAt)}` : log.status === "success" ? "已成功（历史记录）" : log.status === "failed" ? "已失败（历史记录）" : "等待最终结果"}
                </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <DreaminaStatusTag status={log.status} />
                <span className="truncate font-mono text-zinc-500" title={log.command}>
                    {log.command}
                </span>
            </div>
            <div className="min-w-0">
                <div className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={log.model}>
                    {log.model}
                </div>
                <div className="truncate text-zinc-500" title={log.submissionId || "未返回提交 ID"}>
                    提交 ID：{log.submissionId || "—"}
                </div>
            </div>
            <div className="min-w-0 truncate text-zinc-500" title={creditSummary(log)}>
                {creditSummary(log)}
            </div>
            <ChevronRight className="hidden size-4 justify-self-end text-zinc-400 sm:block" aria-hidden="true" />
        </button>
    );
}

function DreaminaLogDrawer({ log, onClose }: { log: DreaminaLog | null; onClose: () => void }) {
    return (
        <Drawer title="请求日志详情" open={Boolean(log)} onClose={onClose} width="min(640px, 100vw)" styles={{ body: { padding: 20 } }}>
            {log ? (
                <div className="space-y-5">
                    <div className="flex flex-wrap items-center gap-2">
                        <DreaminaStatusTag status={log.status} />
                        <span className="text-xs text-zinc-500">提交于 {formatDate(log.createdAt)}</span>
                    </div>
                    <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
                        <dt className="text-zinc-500">命令</dt>
                        <dd className="break-all font-mono text-xs">{log.command}</dd>
                        <dt className="text-zinc-500">模型</dt>
                        <dd className="break-all">{log.model}</dd>
                        <dt className="text-zinc-500">提交 ID</dt>
                        <dd className="break-all font-mono text-xs">{log.submissionId || "—"}</dd>
                        <dt className="text-zinc-500">提交时间</dt>
                        <dd>{formatDate(log.createdAt)}</dd>
                        <dt className="text-zinc-500">任务成功时间</dt>
                        <dd>{formatDate(log.succeededAt)}</dd>
                        <dt className="text-zinc-500">任务失败时间</dt>
                        <dd>{formatDate(log.failedAt)}</dd>
                        <dt className="text-zinc-500">生成前积分</dt>
                        <dd>{formatCredit(log.beforeCredit)}</dd>
                        <dt className="text-zinc-500">生成后积分</dt>
                        <dd>{formatCredit(log.afterCredit)}</dd>
                        <dt className="text-zinc-500">本次任务积分</dt>
                        <dd>{log.observedCreditDelta === undefined ? "未知" : log.observedCreditDelta}</dd>
                        <dt className="text-zinc-500">积分来源</dt>
                        <dd>{creditSourceLabel(log.creditObservation)}</dd>
                        <dt className="text-zinc-500">耗时</dt>
                        <dd>{log.durationMs === undefined ? "—" : formatDuration(log.durationMs)}</dd>
                    </dl>
                    <Alert
                        type="info"
                        showIcon
                        message="积分口径"
                        description={log.creditObservation === "official" ? "该值来自 CLI 提交响应的 credit_count；账号余额在管理员显式刷新时同步。" : "当前记录没有官方逐单积分；余额差仅作为旧返回的兼容观测，不等同于官方账单。"}
                    />
                    <DreaminaLogJson title="提交返回值" value={log.submissionSummary} empty="提交结果未返回结构化内容" />
                    <DreaminaLogJson title={log.status === "success" ? "成功返回值" : log.status === "failed" || log.status === "needs_review" ? "失败返回值" : "最终返回值"} value={log.resultSummary} empty={log.status === "started" ? "任务仍在生成中，等待最终结果" : "CLI 未返回可展示的最终内容"} />
                    {log.error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{log.error}</div> : null}
                </div>
            ) : null}
        </Drawer>
    );
}

function DreaminaLogJson({ title, value, empty }: { title: string; value: Record<string, unknown>; empty: string }) {
    const content = Object.keys(value || {}).length ? JSON.stringify(value, null, 2) : "";
    return (
        <div>
            <div className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</div>
            <pre className="max-h-64 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300">{content || empty}</pre>
        </div>
    );
}

function DreaminaStatusTag({ status }: { status: string }) {
    const normalized = status.toLowerCase();
    const success = normalized === "success" || normalized === "succeeded" || normalized === "completed";
    const failed = normalized === "failed" || normalized === "error";
    const review = normalized === "needs_review" || normalized === "needs-review";
    const label = success ? "成功" : failed ? "失败" : review ? "需要确认" : normalized === "running" ? "进行中" : normalized === "queued" ? "已排队" : status || "未知";
    return (
        <Tag color={success ? "success" : failed ? "error" : review ? "warning" : "processing"} className="m-0">
            {label}
        </Tag>
    );
}

function creditSummary(log: DreaminaLog) {
    if (log.creditObservation === "official") return `官方积分 ${log.observedCreditDelta === undefined ? "未知" : log.observedCreditDelta}`;
    const hasBalance = log.beforeCredit !== undefined || log.afterCredit !== undefined;
    if (!hasBalance && log.observedCreditDelta === undefined) return "余额差未知";
    const delta = log.observedCreditDelta === undefined ? "未知" : log.observedCreditDelta;
    return `余额 ${formatCredit(log.beforeCredit)} → ${formatCredit(log.afterCredit)} · 观测差 ${delta}`;
}

function creditSourceLabel(value: DreaminaLog["creditObservation"]) {
    if (value === "official") return "CLI 官方 credit_count";
    if (value === "observed") return "账号余额差观测";
    if (value === "ambiguous") return "归属不明确";
    if (value === "inconsistent") return "余额变化不一致";
    return "未提供";
}

function formatCredit(value?: number) {
    return value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN");
}

function formatDate(value?: string) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatDuration(milliseconds: number) {
    return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} 秒`;
}
