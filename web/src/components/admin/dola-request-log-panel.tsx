"use client";

import { LogDetailResizeHandle, useResizableDrawerWidth } from "@/hooks/use-resizable-drawer";
import { Alert, App, Button, Card, Drawer, Empty, Image, Input, Pagination, Popconfirm, Select, Space, Switch, Tag } from "antd";
import { BarChart3, Camera, ChevronRight, CircleUserRound, Clock, Copy, Download, Eye, Network, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { cancelDolaLogTask, clearDolaLogs, getDolaLogs, retrieveDolaUnwatermarkedUrl, type DolaAccount, type DolaLogPage, type DolaModel, type DolaRequestLog, type DolaRequestLogPhase, type DolaRequestLogStatus } from "@/services/api/dola";
import { dolaErrorHint } from "@/lib/dola-errors";
import { DolaVerificationDialog } from "@/app/(user)/canvas/components/dola-verification-dialog";

type Props = {
    active: boolean;
    models: DolaModel[];
    accounts: DolaAccount[];
    captureVerificationScreenshot?: boolean;
    onToggleCaptureVerificationScreenshot?: (enabled: boolean) => Promise<void>;
    onLaunchHeadedTest?: (accountId: string, model?: string) => void;
};
type StatusFilter = "" | DolaRequestLogStatus;
type SourceFilter = "" | "runtime" | "admin-test" | "external";
type ProxyFilter = "" | "direct" | "magic" | "generic" | "chained";
type PhaseFilter = "" | DolaRequestLogPhase;

export function DolaRequestLogPanel({ active, models, accounts, captureVerificationScreenshot, onToggleCaptureVerificationScreenshot, onLaunchHeadedTest }: Props) {
    const { message } = App.useApp();
    const [page, setPage] = useState<DolaLogPage | null>(null);
    const [loading, setLoading] = useState(false);
    const [pageNumber, setPageNumber] = useState(1);
    const [keywordDraft, setKeywordDraft] = useState("");
    const [keyword, setKeyword] = useState("");
    const [status, setStatus] = useState<StatusFilter>("");
    const [phase, setPhase] = useState<PhaseFilter>("");
    const [source, setSource] = useState<SourceFilter>("");
    const [model, setModel] = useState("");
    const [accountId, setAccountId] = useState("");
    const [proxyMode, setProxyMode] = useState<ProxyFilter>("");
    const [selectedLog, setSelectedLog] = useState<DolaRequestLog | null>(null);
    const [verificationTarget, setVerificationTarget] = useState<{ taskId: string; verificationId: string } | null>(null);

    const handleOpenVerification = (verificationId: string, taskId?: string) => {
        setVerificationTarget({ verificationId, taskId: taskId || "" });
    };

    const load = useCallback(async (nextPage = pageNumber) => {
        setLoading(true);
        try {
            setPage(await getDolaLogs({ page: nextPage, pageSize: 20, keyword: keyword || undefined, status: status || undefined, phase: phase || undefined, source: source || undefined, model: model || undefined, accountId: accountId || undefined, proxyMode: proxyMode || undefined }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法读取 Dola 请求日志");
        } finally {
            setLoading(false);
        }
    }, [accountId, keyword, message, model, pageNumber, phase, proxyMode, source, status]);

    useEffect(() => {
        if (active) void load();
    }, [active, load]);

    const modelOptions = useMemo(() => {
        const values = new Set(models.map((item) => item.id));
        page?.items.forEach((item) => item.model && values.add(item.model));
        return [{ value: "", label: "全部模型" }, ...Array.from(values).map((value) => ({ value, label: value }))];
    }, [models, page?.items]);
    const accountOptions = useMemo(() => {
        const values = new Map<string, string>();
        accounts.forEach((item) => values.set(item.id, item.name || item.email || item.id));
        page?.items.forEach((item) => item.accountId && values.set(item.accountId, item.accountName || values.get(item.accountId) || item.accountId));
        return [{ value: "", label: "全部账号" }, ...Array.from(values.entries()).map(([value, label]) => ({ value, label }))];
    }, [accounts, page?.items]);

    const clear = async () => {
        try {
            await clearDolaLogs();
            setSelectedLog(null);
            setPageNumber(1);
            await load(1);
            message.success("Dola 请求日志已清空");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清空 Dola 请求日志失败");
        }
    };
    const resetPage = () => setPageNumber(1);
    const stats = page?.stats || { total: 0, success: 0, failed: 0, needsReview: 0, pending: 0, averageDurationMs: 0 };

    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <RequestMetric label="请求总数" value={stats.total.toLocaleString()} detail="全部已持久化请求" />
                <RequestMetric label="成功请求" value={stats.success.toLocaleString()} detail={stats.total ? `${Math.round((stats.success / stats.total) * 100)}% 成功率` : "暂无请求"} tone="success" />
                <RequestMetric label="失败请求" value={stats.failed.toLocaleString()} detail="可点击记录定位上游错误" tone={stats.failed ? "danger" : "neutral"} />
                <RequestMetric label="待人工确认" value={stats.needsReview.toLocaleString()} detail="验证或提交状态待确认" tone={stats.needsReview ? "warning" : "neutral"} />
                <RequestMetric label="平均耗时" value={formatDuration(stats.averageDurationMs)} detail={stats.pending ? `${stats.pending} 条仍在执行` : "从提交到上游响应"} />
            </div>
            <Card
                title="请求日志"
                extra={
                    <Space wrap size={8}>
                        {onToggleCaptureVerificationScreenshot ? (
                            <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                                <span>异常截图</span>
                                <Switch
                                    size="small"
                                    checked={captureVerificationScreenshot ?? true}
                                    onChange={(checked) => void onToggleCaptureVerificationScreenshot(checked)}
                                />
                            </div>
                        ) : null}
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                            刷新
                        </Button>
                        <Popconfirm title="清空全部 Dola 请求日志？" description="该操作不可撤销，但不会影响账号、代理和网关配置。" okText="清空" cancelText="取消" onConfirm={() => void clear()}>
                            <Button danger icon={<Trash2 className="size-4" />} disabled={!stats.total}>
                                清空日志
                            </Button>
                        </Popconfirm>
                    </Space>
                }
            >
                <div className="mb-3 rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-xs leading-relaxed text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                    记录 Dola API 的站内调用、后台实测和外部网关请求，包括账号轮换、魔法/通用/链式代理、模型参数、上游响应、额度观察、验证状态和完整执行时序。Cookie、API Key、Token、参考图和视频二进制不会写入日志。
                </div>
                <div className="grid gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800 sm:grid-cols-[minmax(0,1.2fr)_120px_130px_130px_130px_140px_120px_auto]">
                    <Input value={keywordDraft} allowClear prefix={<Search className="size-4 text-zinc-400" />} placeholder="搜索模型、账号、路径、任务或错误" onChange={(event) => setKeywordDraft(event.target.value)} onPressEnter={() => { resetPage(); setKeyword(keywordDraft.trim()); }} />
                    <Select value={status} onChange={(value: StatusFilter) => { resetPage(); setStatus(value); }} options={[{ value: "", label: "全部状态" }, { value: "success", label: "生成完成" }, { value: "failed", label: "生成失败" }, { value: "needs_review", label: "待人工确认" }, { value: "pending", label: "进行中" }]} />
                    <Select value={phase} onChange={(value: PhaseFilter) => { resetPage(); setPhase(value); }} options={[{ value: "", label: "全部阶段" }, ...phaseOptions]} />
                    <Select value={source} onChange={(value: SourceFilter) => { resetPage(); setSource(value); }} options={[{ value: "", label: "全部来源" }, { value: "runtime", label: "站内调用" }, { value: "admin-test", label: "后台实测" }, { value: "external", label: "外部 API" }]} />
                    <Select value={proxyMode} onChange={(value: ProxyFilter) => { resetPage(); setProxyMode(value); }} options={[{ value: "", label: "全部代理" }, { value: "direct", label: "直连" }, { value: "magic", label: "魔法代理" }, { value: "generic", label: "通用代理" }, { value: "chained", label: "链式代理" }]} />
                    <Select value={model} onChange={(value) => { resetPage(); setModel(value); }} options={modelOptions} showSearch placeholder="筛选模型" />
                    <Select value={accountId} onChange={(value) => { resetPage(); setAccountId(value); }} options={accountOptions} showSearch placeholder="筛选账号" />
                    <Button type="primary" onClick={() => { resetPage(); setKeyword(keywordDraft.trim()); }}>
                        查询
                    </Button>
                </div>
                <div aria-busy={loading} className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-800">
                    {page?.items.length ? page.items.map((log) => <DolaRequestLogRow key={log.id} log={log} onClick={() => setSelectedLog(log)} onOpenVerification={handleOpenVerification} onLaunchHeadedTest={onLaunchHeadedTest} />) : <Empty className="my-10" image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? "正在读取请求日志" : "暂无符合条件的请求记录"} />}
                </div>
                {page?.total ? <div className="flex justify-end border-t border-zinc-200 pt-3 dark:border-zinc-800"><Pagination current={page.page} pageSize={page.pageSize} total={page.total} showSizeChanger={false} showTotal={(total) => `共 ${total} 条`} onChange={setPageNumber} /></div> : null}
            </Card>
            <DolaRequestLogDrawer log={selectedLog} onClose={() => setSelectedLog(null)} onTaskCancelled={() => void load()} onOpenVerification={handleOpenVerification} onLaunchHeadedTest={onLaunchHeadedTest} />
            <DolaVerificationDialog
                request={verificationTarget}
                admin
                onClose={() => setVerificationTarget(null)}
                onResolved={() => {
                    setVerificationTarget(null);
                    message.success("页面验证已完成");
                    void load();
                }}
            />
        </div>
    );
}

const phaseOptions: Array<{ value: DolaRequestLogPhase; label: string }> = [
    { value: "queued", label: "排队中" },
    { value: "routing", label: "代理路由" },
    { value: "auth", label: "账号鉴权" },
    { value: "upstream", label: "上游请求" },
    { value: "response", label: "读取响应" },
    { value: "running", label: "执行中" },
    { value: "submitted", label: "已提交" },
    { value: "generating", label: "生成中" },
    { value: "success", label: "生成完成" },
    { value: "failed", label: "生成失败" },
    { value: "needs_review", label: "待人工确认" },
];

function DolaRequestLogRow({ log, onClick, onOpenVerification, onLaunchHeadedTest }: { log: DolaRequestLog; onClick: () => void; onOpenVerification?: (verificationId: string, taskId?: string) => void; onLaunchHeadedTest?: (accountId: string, model?: string) => void }) {
    const pending = ["queued", "routing", "auth", "upstream", "response", "running", "submitted", "generating"].includes(log.phase);
    const needsReview = log.phase === "needs_review";
    const success = log.phase === "success";
    return (
        <button type="button" className="grid w-full min-w-0 gap-3 px-2 py-3 text-left transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-zinc-900/70 sm:grid-cols-[150px_minmax(0,1fr)_minmax(150px,0.6fr)_120px_24px] sm:items-center sm:px-1" onClick={onClick}>
            <div className="flex flex-wrap items-center gap-1.5">
                <Tag color={pending ? "processing" : needsReview ? "gold" : success ? "success" : "error"} className="m-0">{pending ? phaseLabel(log.phase) : needsReview ? "待确认" : success ? "生成完成" : "生成失败"}</Tag>
                <Tag color={sourceTagColor(log.source)} className="m-0 text-[11px]">{sourceLabel(log.source)}</Tag>
                <Tag color="geekblue" className="m-0 text-[11px]">{proxyLabel(log.proxyEgress)}</Tag>
                {!pending && log.statusCode > 0 ? <span className="text-xs text-zinc-500">{log.statusCode}</span> : null}
            </div>
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{log.method || "POST"}</span>
                    <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={log.model}>{log.model || "未声明模型"}</span>
                    {log.requestedDuration ? <Tag color="blue" className="m-0 text-[11px]">{log.requestedDuration}s · {log.ratio || "默认比例"}</Tag> : null}
                    {log.verificationId ? <Tag color="gold" className="m-0 text-[11px]">需页面验证</Tag> : null}
                    {log.screenshotBase64 ? <Tag color="cyan" className="m-0 text-[11px]"><Camera className="mr-0.5 inline size-3" />截图</Tag> : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="truncate" title={log.path}>{log.path}</span>
                    <span>·</span>
                    <span>{phaseLabel(log.phase)}</span>
                    {log.proxyEgress && log.proxyEgress.mode !== "direct" ? (
                        <>
                            <span>·</span>
                            <span className="max-w-[160px] truncate text-blue-600 dark:text-blue-400" title={`代理节点: ${log.proxyEgress.nodeName || log.proxyEgress.address}`}>
                                节点: {log.proxyEgress.nodeName || log.proxyEgress.address}
                            </span>
                        </>
                    ) : null}
                    {log.taskId ? <><span>·</span><span className="max-w-[180px] truncate font-mono">任务 {log.taskId}</span></> : null}
                </div>
            </div>
            <div className="min-w-0 text-xs text-zinc-500 dark:text-zinc-400"><div className="truncate" title={log.accountName || log.accountId}>{log.accountName || log.accountId || "未识别账号"}</div><div className="mt-0.5 truncate">{formatDate(log.createdAt)}</div>{log.quotaRemaining !== undefined ? <div className="mt-0.5 truncate">额度：{quotaLabel(log)}</div> : null}</div>
            <div className="flex flex-col items-end gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <div>{formatDuration(log.durationMs)}</div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                    {log.accountId ? (
                        <Button
                            size="small"
                            className="px-1.5 text-[11px]"
                            onClick={(event) => {
                                event.stopPropagation();
                                onLaunchHeadedTest?.(log.accountId!, log.model);
                            }}
                        >
                            有头测试
                        </Button>
                    ) : null}
                    {log.verificationId ? (
                        <Button
                            size="small"
                            type="primary"
                            className="text-xs"
                            onClick={(event) => {
                                event.stopPropagation();
                                onOpenVerification?.(log.verificationId!, log.taskId);
                            }}
                        >
                            页面验证
                        </Button>
                    ) : null}
                </div>
            </div>
            <ChevronRight className="hidden size-4 text-zinc-400 sm:block" aria-hidden="true" />
        </button>
    );
}

function DolaRequestLogDrawer({ log, onClose, onTaskCancelled, onOpenVerification, onLaunchHeadedTest }: { log: DolaRequestLog | null; onClose: () => void; onTaskCancelled?: () => void; onOpenVerification?: (verificationId: string, taskId?: string) => void; onLaunchHeadedTest?: (accountId: string, model?: string) => void }) {
    const { message } = App.useApp();
    const { width, resizing, onHandlePointerDown } = useResizableDrawerWidth({ defaultWidth: 660, minWidth: 440 });
    const [salvaging, setSalvaging] = useState(false);
    const [salvageUrl, setSalvageUrl] = useState("");
    const [cancelling, setCancelling] = useState(false);
    const copy = (value: string | undefined, tip: string) => { if (!value) return; void navigator.clipboard.writeText(value).then(() => message.success(tip)); };
    const errorHint = log?.error ? dolaErrorHint(log.error) : null;
    const canSalvage = Boolean(log?.phase === "success" && log.taskId);
    const pendingTask = Boolean(log && ["queued", "routing", "auth", "upstream", "response", "running", "submitted", "generating"].includes(log.phase) && log.taskId);
    const cancelTask = async () => {
        if (!log?.taskId) return;
        setCancelling(true);
        try {
            const result = await cancelDolaLogTask(log.taskId);
            if (result.alreadyCancelled) message.info("该任务此前已被取消");
            else message.success("任务已取消");
            onTaskCancelled?.();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "取消任务失败");
        } finally {
            setCancelling(false);
        }
    };
    const retrieveUnwatermarked = async () => {
        if (!log?.taskId) return;
        setSalvaging(true);
        try {
            const result = await retrieveDolaUnwatermarkedUrl(log.taskId);
            setSalvageUrl(result.downloadUrl);
            void navigator.clipboard.writeText(result.downloadUrl).then(() => message.success("无水印视频地址已取回并复制"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "取回无水印视频失败");
        } finally {
            setSalvaging(false);
        }
    };
    return <Drawer title="Dola 请求详情" open={Boolean(log)} onClose={() => { setSalvageUrl(""); onClose(); }} width={width} style={{ maxWidth: "100vw" }} styles={{ body: { padding: 20, position: "relative" } }} extra={log ? <Space size="small"><Tag className="m-0 font-mono text-xs">{log.method}</Tag><Tag color={log.phase === "success" ? "success" : log.phase === "needs_review" ? "gold" : log.phase === "failed" ? "error" : "processing"}>{phaseLabel(log.phase)} · {log.statusCode || "—"}</Tag></Space> : null}>
        <LogDetailResizeHandle resizing={resizing} onPointerDown={onHandlePointerDown} />
        {log ? <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copy(buildCurlCommand(log), "cURL 命令已复制")}>复制 cURL</Button>
                <Button size="small" icon={<Copy className="size-3.5" />} disabled={!log.requestPreview} onClick={() => copy(log.requestPreview, "请求摘要已复制")}>复制请求摘要</Button>
                <Button size="small" icon={<Copy className="size-3.5" />} disabled={!log.responsePreview} onClick={() => copy(log.responsePreview, "响应摘要已复制")}>复制响应摘要</Button>
                {log.error ? <Button size="small" danger icon={<Copy className="size-3.5" />} onClick={() => copy(log.error, "错误信息已复制")}>复制错误</Button> : null}
                {log.accountId ? (
                    <Button
                        size="small"
                        icon={<Eye className="size-3.5" />}
                        onClick={() => onLaunchHeadedTest?.(log.accountId!, log.model)}
                    >
                        以此账号发起有头测试
                    </Button>
                ) : null}
                {log.verificationId ? <Button size="small" type="primary" icon={<ShieldCheck className="size-3.5" />} onClick={() => onOpenVerification?.(log.verificationId!, log.taskId)}>处理页面验证</Button> : null}
                {canSalvage ? <Button size="small" type="primary" ghost icon={<Download className="size-3.5" />} loading={salvaging} onClick={() => void retrieveUnwatermarked()}>取回无水印视频</Button> : null}
                {pendingTask ? <Popconfirm title="取消该生成任务？" description="将停止轮询并取消该任务，已消耗的积分按取消流程处理。" okText="取消任务" cancelText="再等等" onConfirm={() => void cancelTask()}><Button size="small" danger loading={cancelling}>取消任务</Button></Popconfirm> : null}
            </div>
            {salvageUrl ? <section><h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">无水印视频地址</h3><div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/20"><span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">{salvageUrl}</span><Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copy(salvageUrl, "无水印视频地址已复制")}>复制</Button></div><div className="mt-1 text-xs text-zinc-500">地址由上游签发、有时效；请尽快下载保存。</div></section> : null}
            {log.screenshotBase64 ? (
                <section>
                    <div className="mb-2 flex items-center justify-between">
                        <h3 className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            <Camera className="size-4 text-blue-500" />
                            <span>协议异常后的浏览器页面快照</span>
                        </h3>
                        <span className="text-xs text-zinc-500">点击放大查看真实页面</span>
                    </div>
                    <div className="flex justify-center overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <Image
                            src={log.screenshotBase64.startsWith("data:") ? log.screenshotBase64 : `data:image/png;base64,${log.screenshotBase64}`}
                            alt="协议异常后的浏览器页面快照"
                            className="max-h-72 w-auto rounded object-contain"
                            preview={{ mask: "点击放大查看" }}
                        />
                    </div>
                </section>
            ) : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Highlight icon={<Clock className="size-3.5" />} label="耗时" value={formatDuration(log.durationMs)} /><Highlight icon={<BarChart3 className="size-3.5" />} label="响应" value={formatBytes(log.responseBytes)} /><Highlight icon={<CircleUserRound className="size-3.5" />} label="账号" value={log.accountName || log.accountId || "未识别"} /><Highlight icon={<Network className="size-3.5" />} label="代理" value={proxyLabel(log.proxyEgress)} /></div>
            <section><h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">请求基本信息</h3><div className="grid gap-x-4 gap-y-3 rounded-lg border border-zinc-200 p-3.5 text-sm dark:border-zinc-800 sm:grid-cols-2"><Detail label="模型 ID" value={log.model || "未声明"} /><Detail label="能力类型" value={log.capability === "image" ? "图片" : "视频"} /><Detail label="调用来源" value={sourceLabel(log.source)} /><Detail label="请求路径" value={`${log.method} ${log.path}`} /><Detail label="状态码" value={String(log.statusCode || "执行中")} /><Detail label="阶段" value={phaseLabel(log.phase)} /><Detail label="请求时间" value={formatDateWithMs(log.createdAt)} /><Detail label="耗时" value={formatDuration(log.durationMs)} />{log.accountId ? <Detail label="账号 ID" value={log.accountId} /> : null}{log.proxyEgress && log.proxyEgress.mode !== "direct" ? <Detail label="代理节点名称" value={log.proxyEgress.nodeName || log.proxyEgress.address || "已配置节点"} /> : null}{log.proxyEgress?.address && log.proxyEgress.address !== log.proxyEgress.nodeName ? <Detail label="代理出口地址" value={log.proxyEgress.address} /> : null}{log.taskId ? <Detail label="上游任务 ID" value={log.taskId} /> : null}{log.verificationId ? <Detail label="验证会话 ID" value={log.verificationId} /> : null}{log.requestedDuration ? <Detail label="视频参数" value={`${log.requestedDuration} 秒 · ${log.ratio || "默认比例"}`} /> : null}{log.contentType ? <Detail label="响应类型" value={log.contentType} /> : null}{log.clientIp ? <Detail label="客户端 IP" value={log.clientIp} /> : null}</div></section>
            {log.quotaRemaining !== undefined ? <section><h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">额度观察</h3><div className="rounded-lg border border-zinc-200 p-3.5 text-sm dark:border-zinc-800"><div className="font-medium">{quotaLabel(log)}</div><div className="mt-1 text-xs text-zinc-500">仅记录 Provider 返回或账号快照中的额度，不把额度推断成成功结果。</div></div></section> : null}
            <section><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">过程日志与时序</h3><span className="text-xs text-zinc-500">共 {log.lifecycle?.length || 1} 个执行阶段 · 总历时 {formatDuration(log.durationMs)}</span></div>{log.lifecycle?.length ? <div className="space-y-2 rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800">{log.lifecycle.map((entry, index) => <div key={`${entry.time}-${index}`} className="flex items-start gap-3 text-xs"><span className={`mt-0.5 shrink-0 text-sm ${entry.phase === "success" ? "text-emerald-500" : entry.phase === "failed" ? "text-rose-500" : entry.phase === "needs_review" ? "text-amber-500" : "text-blue-500"}`}>{entry.phase === "success" ? "✓" : entry.phase === "failed" ? "✕" : "●"}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-zinc-400 dark:text-zinc-500">{formatDateWithMs(entry.time)}</span>{entry.durationMs !== undefined ? <Tag className="m-0 border-0 bg-zinc-100 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">+{entry.durationMs}ms</Tag> : null}<Tag color={entry.phase === "success" ? "success" : entry.phase === "failed" ? "error" : entry.phase === "needs_review" ? "gold" : "processing"} className="m-0 text-[10px]">{phaseLabel(entry.phase)}</Tag><span className="font-medium text-zinc-800 dark:text-zinc-200">{entry.message}</span></div>{entry.detail ? <div className="mt-1 break-all rounded bg-zinc-50 p-2 font-mono text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-400">{entry.detail}</div> : null}</div></div>)}</div> : <div className="rounded-lg border border-dashed border-zinc-200 p-4 text-center text-xs text-zinc-500 dark:border-zinc-800">未记录详细阶段日志</div>}</section>
            {log.requestPreview ? <LogPreview title="请求摘要" value={log.requestPreview} /> : null}{log.responsePreview ? <LogPreview title="响应摘要" value={log.responsePreview} /> : null}{errorHint && !log.error?.includes(errorHint) ? <Alert type="warning" showIcon message="错误分类" description={errorHint} /> : null}{log.error ? <LogPreview title="错误信息" value={log.error} danger /> : null}
            <Alert type="info" showIcon message="日志已自动脱敏" description="授权 Cookie、Token、API Key、上传参考图和生成视频二进制不会在此处保存或展示。" />
        </div> : null}
    </Drawer>;
}

function Highlight({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="min-w-0 rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50"><div className="flex items-center gap-1.5 text-xs text-zinc-500">{icon}<span>{label}</span></div><div className="mt-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={value}>{value}</div></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><div className="text-xs text-zinc-500">{label}</div><div className="mt-0.5 break-all text-sm text-zinc-900 dark:text-zinc-100">{value}</div></div>; }
function LogPreview({ title, value, danger = false }: { title: string; value: string; danger?: boolean }) { return <section><h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h3><pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-3 font-mono text-xs leading-relaxed ${danger ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-200" : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"}`}>{value}</pre></section>; }
function RequestMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "success" | "danger" | "warning" }) { const color = tone === "success" ? "text-emerald-700 dark:text-emerald-400" : tone === "danger" ? "text-red-600 dark:text-red-400" : tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-zinc-950 dark:text-zinc-100"; return <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"><div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div><div className={`mt-2 text-2xl font-semibold tracking-tight ${color}`}>{value}</div><div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{detail}</div></div>; }
function buildCurlCommand(log: DolaRequestLog) { const url = log.path.startsWith("http") ? log.path : `${typeof window !== "undefined" ? window.location.origin : ""}${log.path.startsWith("/") ? "" : "/"}${log.path}`; const lines = [`curl -X ${log.method || "POST"} "${url}"`]; for (const [key, value] of Object.entries(log.headers || {})) lines.push(`  -H "${key}: ${value.replace(/"/g, '\\"')}"`); if (log.requestPreview) lines.push(`  --data-raw '${log.requestPreview.replace(/'/g, "'\\''")}'`); return lines.join(" \\\n"); }
function sourceLabel(value: DolaRequestLog["source"]) { return value === "admin-test" ? "后台实测" : value === "external" ? "外部 API" : "站内调用"; }
function sourceTagColor(value: DolaRequestLog["source"]) { return value === "admin-test" ? "purple" : value === "external" ? "cyan" : "blue"; }
function proxyLabel(value: DolaRequestLog["proxyEgress"]) { if (!value || value.mode === "direct") return "直连"; const label = value.mode === "magic" ? "魔法" : value.mode === "chained" ? "链式" : "通用"; return `${label}·${value.nodeName || value.address || "已配置"}`; }
function phaseLabel(value: DolaRequestLogPhase) { return phaseOptions.find((item) => item.value === value)?.label || value; }
function quotaLabel(log: DolaRequestLog) { return `${formatQuota(log.quotaRemaining)} / ${formatQuota(log.quotaLimit)}`; }
function formatQuota(value: number | null | undefined) { return value === null || value === undefined ? "未知" : Number.isInteger(value) ? String(value) : value.toFixed(2); }
function formatBytes(value: number | undefined) { if (!value) return "未知"; if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`; if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`; return `${value} B`; }
function formatDuration(value: number) { return value < 1_000 ? `${Math.max(0, value)} ms` : `${(value / 1_000).toFixed(1)} s`; }
function formatDate(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value; }
function formatDateWithMs(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? `${date.toLocaleString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}` : value; }
