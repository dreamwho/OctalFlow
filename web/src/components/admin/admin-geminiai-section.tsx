"use client";

import { LogDetailResizeHandle, useResizableDrawerWidth } from "@/hooks/use-resizable-drawer";
import { App, Alert, Button, Checkbox, Drawer, Empty, Form, Input, InputNumber, Modal, Pagination, Popconfirm, Select, Space, Tabs, Tag } from "antd";
import type { CheckboxChangeEvent } from "antd";
import { BarChart3, ChevronRight, CircleUserRound, Copy, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import {
    activateGeminiAiAccount,
    clearGeminiAiLogs,
    deleteGeminiAiAccount,
    getGeminiAiAccountLoginStatus,
    getGeminiAiAdminState,
    getGeminiAiLogs,
    getGeminiAiTestStatus,
    importGeminiAiAccount,
    startGeminiAiAccountLogin,
    syncGeminiAiModels,
    testGeminiAiModel,
    updateGeminiAiAccount,
    updateGeminiAiModels,
    updateGeminiAiRotation,
    type GeminiAiAccount,
    type GeminiAiAdminState,
    type GeminiAiCapability,
    type GeminiAiModel,
    type GeminiAiLogPage,
    type GeminiAiRequestLog,
    type GeminiAiRotation,
    type GeminiAiTestResult,
} from "@/services/api/geminiai";

import { geminiAiAccountUsage, geminiAiModelCapabilities, geminiAiModelLabel, geminiAiModelsForCapability, geminiAiSelectableModels, geminiAiSelectedModelIds, geminiAiStatusText, geminiAiTestTabs } from "./geminiai/geminiai-view-model";
import { MagicProxyBindingCard } from "./magic-proxy-binding-card";

type GeminiAiCookieImportValues = { name?: string; email?: string; cookies: string };
const GEMINIAI_IMAGE_TEST_RATIOS = ["auto", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"] as const;
const GEMINIAI_IMAGE_TEST_QUALITIES = [
    { value: "4K", label: "高（4K）" },
    { value: "2K", label: "中（2K）" },
    { value: "1K", label: "低（1K）" },
] as const;

export function AdminGeminiAiSection() {
    const { message } = App.useApp();
    const [state, setState] = useState<GeminiAiAdminState | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [syncing, setSyncing] = useState(false);
    const [accountActionId, setAccountActionId] = useState("");
    const [loginOpen, setLoginOpen] = useState(false);
    const [cookieImportOpen, setCookieImportOpen] = useState(false);
    const [renamingAccount, setRenamingAccount] = useState<GeminiAiAccount | null>(null);
    const [modelTestOpen, setModelTestOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"overview" | "logs" | "proxy">("overview");
    const [logPage, setLogPage] = useState<GeminiAiLogPage | null>(null);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logPageNumber, setLogPageNumber] = useState(1);
    const [logKeywordDraft, setLogKeywordDraft] = useState("");
    const [logKeyword, setLogKeyword] = useState("");
    const [logStatus, setLogStatus] = useState<"" | "success" | "failed">("");
    const [logCapability, setLogCapability] = useState<"" | "text" | "image" | "search">("");
    const [logModel, setLogModel] = useState<string>("");
    const [logAccountId, setLogAccountId] = useState<string>("");
    const [selectedLog, setSelectedLog] = useState<GeminiAiRequestLog | null>(null);

    const loadState = useCallback(async () => {
        setLoading(true);
        setLoadError("");
        try {
            setState(await getGeminiAiAdminState());
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "无法读取 GeminiAIStudio 配置");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadState();
    }, [loadState]);

    const loadLogs = useCallback(
        async (pageNumber = logPageNumber) => {
            setLogsLoading(true);
            try {
                setLogPage(
                    await getGeminiAiLogs({
                        page: pageNumber,
                        pageSize: 20,
                        keyword: logKeyword || undefined,
                        status: logStatus || undefined,
                        capability: logCapability || undefined,
                        model: logModel || undefined,
                        accountId: logAccountId || undefined,
                    }),
                );
            } catch (error) {
                message.error(error instanceof Error ? error.message : "无法读取 GeminiAIStudio 请求日志");
            } finally {
                setLogsLoading(false);
            }
        },
        [logCapability, logKeyword, logModel, logAccountId, logPageNumber, logStatus, message],
    );

    useEffect(() => {
        if (activeTab === "logs") void loadLogs();
    }, [activeTab, loadLogs]);

    const runAccountAction = async (accountId: string, work: () => Promise<unknown>, successMessage: string) => {
        setAccountActionId(accountId);
        try {
            await work();
            await loadState();
            message.success(successMessage);
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "账号操作失败");
            return false;
        } finally {
            setAccountActionId("");
        }
    };

    const syncModels = async () => {
        setSyncing(true);
        try {
            await syncGeminiAiModels();
            await loadState();
            message.success("GeminiAIStudio 模型目录已同步");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型目录同步失败");
        } finally {
            setSyncing(false);
        }
    };

    const saveModels = async (modelIds: string[]) => {
        try {
            await updateGeminiAiModels(modelIds);
            await loadState();
            message.success("Gemini AI Studio 渠道模型已保存");
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "Gemini AI Studio 渠道模型保存失败");
            return false;
        }
    };

    const channels = state?.channels || (state?.channel ? [state.channel] : []);

    return (
        <div className="space-y-4">
            {loadError ? (
                <Alert
                    type="error"
                    showIcon
                    message="GeminiAIStudio 配置读取失败"
                    description={loadError}
                    action={
                        <Button size="small" onClick={() => void loadState()}>
                            重试
                        </Button>
                    }
                />
            ) : null}
            <Tabs
                className="max-sm:[&_.ant-tabs-nav-list]:w-full max-sm:[&_.ant-tabs-tab]:!m-0 max-sm:[&_.ant-tabs-tab]:min-w-0 max-sm:[&_.ant-tabs-tab]:flex-1 max-sm:[&_.ant-tabs-tab]:justify-center max-sm:[&_.ant-tabs-tab]:!px-1 max-sm:[&_.ant-tabs-tab-btn]:text-xs"
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as "overview" | "logs" | "proxy")}
                items={[
                    { key: "overview", label: "账号与渠道" },
                    { key: "logs", label: "请求日志" },
                    { key: "proxy", label: "代理管理" },
                ]}
            />
            <div className={activeTab === "overview" ? "space-y-4" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="GeminiAIStudio"
                        description="使用与参考项目一致的 Camoufox Provider 授权账号，模型目录同步后再进入站内渠道路由。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadState()}>
                                    刷新状态
                                </Button>
                                <Button type="primary" icon={<Play className="size-4" />} disabled={!state?.models.length} onClick={() => setModelTestOpen(true)}>
                                    模型实测
                                </Button>
                            </Space>
                        }
                    />
                    <div className="grid gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-800">
                        <StatusMetric
                            label="服务状态"
                            value={loading && !state ? "读取中" : state?.healthy ? "正常" : state?.configured ? "不可用" : "待配置"}
                            detail={state?.healthy ? "Provider 可用，未进行自动探测。" : state?.configured ? "Provider 暂时无法连接，请检查本地服务状态。" : "请先配置 Provider 并完成至少一个账号授权。"}
                            tone={state?.healthy ? "success" : "neutral"}
                        />
                        <StatusMetric
                            label="授权账号"
                            value={state?.accountsAvailable ? String(state.accounts.length) : "—"}
                            detail={!state?.accountsAvailable ? "Provider 未连接，无法读取账号；不表示账号已删除" : state.activeAccountId ? "已有当前使用账号" : "尚未选择当前账号"}
                        />
                        <StatusMetric label="已声明模型" value={state ? String(state.models.filter((model) => model.enabled !== false).length) : "—"} detail="图片目录仅保留 gemini-3-pro-image 与 gemini-3.1-flash-image。" />
                    </div>
                    <div className="p-3 sm:p-5">
                        <Alert
                            type={state?.configured ? "info" : "warning"}
                            showIcon
                            message={state?.configured ? "Provider 已连接；Camoufox 账号需单独授权" : "尚未完成 GeminiAIStudio Provider 配置"}
                            description={
                                state?.configured
                                    ? "图片请求会在 Camoufox 的 AI Studio 页面内真实运行并读取本次新生成结果，不需要额外配置 API Key。旧 Chromium 授权不能直接沿用，需要在 Camoufox 窗口完成一次登录。"
                                    : "完成 Provider 配置后，可在这里授权 Google 账号、同步目录并选择模型进入 Gemini AI Studio 渠道。"
                            }
                        />
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader
                        title="Google 账号授权"
                        description="只展示账号名称、邮箱、状态和用量；Cookie、Token 与浏览器状态不会回显。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<ShieldCheck className="size-4" />} onClick={() => setLoginOpen(true)}>
                                    添加授权
                                </Button>
                                <Button type="default" onClick={() => setCookieImportOpen(true)}>
                                    导入 Cookie
                                </Button>
                            </Space>
                        }
                    />
                    {loading && !state ? <SectionLoading /> : null}
                    {state ? (
                        !state.accountsAvailable ? (
                            <Alert className="m-3 sm:m-4" type="warning" showIcon message="暂时无法读取授权账号" description="Provider 当前未连接，页面不会把未知状态显示成 0 个账号；这不表示已有授权已被删除。请恢复服务后刷新状态。" />
                        ) : state.accounts.length ? (
                            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                                {state.accounts.map((account) => {
                                    const active = account.id === state.activeAccountId;
                                    const actionLoading = accountActionId === account.id;
                                    return (
                                        <div key={account.id} className="flex min-w-0 flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-center lg:justify-between">
                                            <div className="flex min-w-0 items-start gap-3">
                                                <div className="grid size-9 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                                                    <CircleUserRound className="size-4" aria-hidden="true" />
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        <span className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-100">{account.name || "未命名 Google 账号"}</span>
                                                        {active ? (
                                                            <Tag color="blue" className="m-0">
                                                                当前使用
                                                            </Tag>
                                                        ) : null}
                                                        <AccountStatusTag status={account.status} />
                                                    </div>
                                                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{account.email || "授权后将显示已识别邮箱"}</div>
                                                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                                                        <span>用量：{geminiAiAccountUsage(account)}</span>
                                                        {account.lastUsedAt ? <span>最近使用：{formatDate(account.lastUsedAt)}</span> : null}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap lg:shrink-0">
                                                <Button size="small" disabled={active} loading={actionLoading && !active} onClick={() => void runAccountAction(account.id, () => activateGeminiAiAccount(account.id), "已切换当前 Google 账号")}>
                                                    {active ? "当前账号" : "设为当前"}
                                                </Button>
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setRenamingAccount(account)}>
                                                    改名
                                                </Button>
                                                <Popconfirm
                                                    title="删除这个 Google 授权？"
                                                    description="删除后此账号将无法再被 GeminiAIStudio Provider 使用。"
                                                    okText="删除"
                                                    cancelText="取消"
                                                    okButtonProps={{ danger: true, loading: actionLoading }}
                                                    onConfirm={() => runAccountAction(account.id, () => deleteGeminiAiAccount(account.id), "Google 授权已删除")}
                                                >
                                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={`删除 ${account.name || account.email || "Google 账号"}`}>
                                                        删除
                                                    </Button>
                                                </Popconfirm>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <Empty className="my-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有已授权的 Google 账号" />
                        )
                    ) : null}
                </Panel>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                    <Panel>
                        <PanelHeader title="账号轮换" description="轮换策略由 Provider 执行；保存后立即使用服务端持久化配置。" />
                        {state ? (
                            <GeminiAiRotationSettings
                                rotation={state.rotation}
                                onSave={async (rotation) => {
                                    await updateGeminiAiRotation(rotation);
                                    await loadState();
                                    message.success("账号轮换设置已保存");
                                }}
                            />
                        ) : (
                            <SectionLoading />
                        )}
                    </Panel>
                    <Panel>
                        <PanelHeader
                            title="Gemini AI Studio 渠道与模型"
                            description="模型目录需要由管理员显式同步；不会在后台自动批量探测或保存实测历史。"
                            actions={
                                <Button icon={<RefreshCw className="size-4" />} loading={syncing} disabled={!state?.configured} onClick={() => void syncModels()}>
                                    同步模型目录
                                </Button>
                            }
                        />
                        {state ? <GeminiAiModelsSummary channels={channels} models={state.models} onSave={saveModels} /> : <SectionLoading />}
                    </Panel>
                </div>
            </div>

            {activeTab === "logs" ? (
                <GeminiAiRequestLogs
                    page={logPage}
                    loading={logsLoading}
                    keyword={logKeywordDraft}
                    status={logStatus}
                    capability={logCapability}
                    model={logModel}
                    accountId={logAccountId}
                    models={state?.models || []}
                    accounts={state?.accounts || []}
                    onKeywordChange={setLogKeywordDraft}
                    onSearch={() => {
                        setLogPageNumber(1);
                        setLogKeyword(logKeywordDraft.trim());
                    }}
                    onStatusChange={(value) => {
                        setLogPageNumber(1);
                        setLogStatus(value);
                    }}
                    onCapabilityChange={(value) => {
                        setLogPageNumber(1);
                        setLogCapability(value);
                    }}
                    onModelChange={(value) => {
                        setLogPageNumber(1);
                        setLogModel(value);
                    }}
                    onAccountChange={(value) => {
                        setLogPageNumber(1);
                        setLogAccountId(value);
                    }}
                    onPageChange={setLogPageNumber}
                    onRefresh={() => void loadLogs()}
                    onClear={async () => {
                        await clearGeminiAiLogs();
                        setSelectedLog(null);
                        setLogPageNumber(1);
                        await loadLogs(1);
                        message.success("GeminiAIStudio 请求日志已清空");
                    }}
                    onSelect={setSelectedLog}
                />
            ) : null}

            <div className={activeTab === "proxy" ? "space-y-4" : "hidden"}>
                <MagicProxyBindingCard provider="geminiai" />
            </div>

            <GeminiAiAuthorizationModal
                open={loginOpen}
                onClose={() => setLoginOpen(false)}
                onCompleted={async () => {
                    await loadState();
                    message.success("Google 账号授权已完成");
                    setLoginOpen(false);
                }}
            />
            <GeminiAiCookieImportModal
                open={cookieImportOpen}
                onClose={() => setCookieImportOpen(false)}
                onCompleted={async () => {
                    await loadState();
                    message.success("Google Cookie 已安全导入");
                    setCookieImportOpen(false);
                }}
            />
            <GeminiAiRenameModal
                account={renamingAccount}
                onClose={() => setRenamingAccount(null)}
                onSave={async (name) => {
                    if (!renamingAccount) return;
                    if (await runAccountAction(renamingAccount.id, () => updateGeminiAiAccount(renamingAccount.id, { name }), "账号名称已更新")) setRenamingAccount(null);
                }}
            />
            <GeminiAiModelTestDialog state={state} open={modelTestOpen} onClose={() => setModelTestOpen(false)} />
            <GeminiAiRequestLogDrawer log={selectedLog} onClose={() => setSelectedLog(null)} />
        </div>
    );
}

function GeminiAiRequestLogs({
    page,
    loading,
    keyword,
    status,
    capability,
    model,
    accountId,
    models,
    accounts,
    onKeywordChange,
    onSearch,
    onStatusChange,
    onCapabilityChange,
    onModelChange,
    onAccountChange,
    onPageChange,
    onRefresh,
    onClear,
    onSelect,
}: {
    page: GeminiAiLogPage | null;
    loading: boolean;
    keyword: string;
    status: "" | "success" | "failed";
    capability: "" | "text" | "image" | "search";
    model: string;
    accountId: string;
    models: GeminiAiModel[];
    accounts: GeminiAiAccount[];
    onKeywordChange: (value: string) => void;
    onSearch: () => void;
    onStatusChange: (value: "" | "success" | "failed") => void;
    onCapabilityChange: (value: "" | "text" | "image" | "search") => void;
    onModelChange: (value: string) => void;
    onAccountChange: (value: string) => void;
    onPageChange: (page: number) => void;
    onRefresh: () => void;
    onClear: () => Promise<void>;
    onSelect: (log: GeminiAiRequestLog) => void;
}) {
    const stats = page?.stats || { total: 0, success: 0, failed: 0, averageDurationMs: 0 };
    const modelOptions = useMemo(() => {
        const set = new Set<string>();
        models.forEach((m) => {
            if (m.name) set.add(m.name);
        });
        page?.items.forEach((item) => {
            if (item.model) set.add(item.model);
        });
        return [{ value: "", label: "全部模型" }, ...Array.from(set).map((m) => ({ value: m, label: m }))];
    }, [models, page?.items]);

    const accountOptions = useMemo(() => {
        const set = new Map<string, string>();
        accounts.forEach((acc) => {
            set.set(acc.id, acc.email || acc.id);
        });
        page?.items.forEach((item) => {
            if (item.accountId) set.set(item.accountId, item.accountEmail || item.accountId);
        });
        return [{ value: "", label: "全部账号" }, ...Array.from(set.entries()).map(([id, label]) => ({ value: id, label }))];
    }, [accounts, page?.items]);

    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <RequestMetric label="请求总数" value={stats.total.toLocaleString()} detail="全部已持久化请求" />
                <RequestMetric label="成功请求" value={stats.success.toLocaleString()} detail={stats.total ? `${Math.round((stats.success / stats.total) * 100)}% 成功率` : "暂无请求"} tone="success" />
                <RequestMetric label="失败请求" value={stats.failed.toLocaleString()} detail="可点击记录定位上游错误" tone={stats.failed ? "danger" : "neutral"} />
                <RequestMetric label="平均耗时" value={formatDuration(stats.averageDurationMs)} detail="从提交到上游响应" />
            </div>
            <Panel>
                <PanelHeader
                    title="请求日志"
                    description="记录站内真实调用与后台模型实测；敏感授权信息和媒体二进制不会写入日志。"
                    actions={
                        <Space wrap size={6}>
                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={onRefresh}>
                                刷新
                            </Button>
                            <Popconfirm title="清空全部请求日志？" description="该操作不可撤销，但不会影响账号和渠道配置。" okText="清空" cancelText="取消" onConfirm={onClear}>
                                <Button danger icon={<Trash2 className="size-4" />} disabled={!stats.total}>
                                    清空日志
                                </Button>
                            </Popconfirm>
                        </Space>
                    }
                />
                <div className="grid gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-[minmax(0,1.2fr)_130px_130px_140px_140px_auto] sm:p-4">
                    <Input value={keyword} allowClear prefix={<Search className="size-4 text-zinc-400" />} placeholder="搜索模型、账号、路径或错误" onChange={(event) => onKeywordChange(event.target.value)} onPressEnter={onSearch} />
                    <Select
                        value={status}
                        onChange={onStatusChange}
                        options={[
                            { value: "", label: "全部状态" },
                            { value: "success", label: "成功" },
                            { value: "failed", label: "失败" },
                        ]}
                    />
                    <Select
                        value={capability}
                        onChange={onCapabilityChange}
                        options={[
                            { value: "", label: "全部能力" },
                            { value: "text", label: "文本" },
                            { value: "image", label: "图片" },
                            { value: "search", label: "Google 搜索" },
                        ]}
                    />
                    <Select
                        value={model}
                        onChange={onModelChange}
                        options={modelOptions}
                        showSearch
                        placeholder="筛选模型"
                    />
                    <Select
                        value={accountId}
                        onChange={onAccountChange}
                        options={accountOptions}
                        showSearch
                        placeholder="筛选账号"
                    />
                    <Button type="primary" onClick={onSearch}>
                        查询
                    </Button>
                </div>
                <div aria-busy={loading} className="min-h-52 divide-y divide-zinc-200 dark:divide-zinc-800">
                    {page?.items.length ? (
                        page.items.map((log) => <GeminiAiRequestLogRow key={log.id} log={log} onClick={() => onSelect(log)} />)
                    ) : (
                        <Empty className="my-10" image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? "正在读取请求日志" : "暂无符合条件的请求记录"} />
                    )}
                </div>
                {page?.total ? (
                    <div className="flex justify-end border-t border-zinc-200 p-3 dark:border-zinc-800 sm:p-4">
                        <Pagination current={page.page} pageSize={page.pageSize} total={page.total} showSizeChanger={false} showTotal={(total) => `共 ${total} 条`} onChange={onPageChange} />
                    </div>
                ) : null}
            </Panel>
        </div>
    );
}

function RequestMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "success" | "danger" }) {
    const valueColor = tone === "success" ? "text-emerald-700 dark:text-emerald-400" : tone === "danger" ? "text-red-600 dark:text-red-400" : "text-zinc-950 dark:text-zinc-100";
    return (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
            <div className={`mt-2 text-2xl font-semibold tracking-tight ${valueColor}`}>{value}</div>
            <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{detail}</div>
        </div>
    );
}

function buildCurlCommand(log: GeminiAiRequestLog): string {
    const url = log.path.startsWith("http") ? log.path : `${typeof window !== "undefined" ? window.location.origin : ""}${log.path.startsWith("/") ? "" : "/"}${log.path}`;
    const lines = [`curl -X ${log.method || "POST"} "${url}"`];
    if (log.headers) {
        for (const [k, v] of Object.entries(log.headers)) {
            if (["authorization", "cookie"].includes(k.toLowerCase())) continue;
            lines.push(`  -H "${k}: ${v.replace(/"/g, '\\"')}"`);
        }
    }
    if (!log.headers?.["content-type"] && log.requestPreview) {
        lines.push(`  -H "Content-Type: application/json"`);
    }
    if (log.requestPreview) {
        lines.push(`  --data-raw '${log.requestPreview.replace(/'/g, "'\\''")}'`);
    }
    return lines.join(" \\\n");
}

function GeminiAiRequestLogRow({ log, onClick }: { log: GeminiAiRequestLog; onClick: () => void }) {
    const phase = log.phase || (log.statusCode < 400 ? "success" : "failed");
    const pending = phase === "queued" || phase === "running";
    const success = phase === "success";
    const isLimited = log.statusCode === 429;
    return (
        <button
            type="button"
            className="grid w-full min-w-0 gap-3 px-3 py-3 text-left transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 dark:hover:bg-zinc-900/70 sm:grid-cols-[130px_minmax(0,1fr)_minmax(160px,0.55fr)_100px_24px] sm:items-center sm:px-4"
            onClick={onClick}
        >
            <div className="flex flex-wrap items-center gap-1.5">
                <Tag color={pending ? "processing" : isLimited ? "gold" : success ? "success" : "error"} className="m-0">
                    {pending ? (phase === "queued" ? "排队中" : "执行中") : isLimited ? "限流" : success ? "成功" : "失败"}
                </Tag>
                {log.proxyEgress ? (
                    <Tag color="geekblue" className="m-0 text-[11px]">
                        {log.proxyEgress.mode === "magic" ? "魔法" : "通用"}
                    </Tag>
                ) : null}
                {!pending && log.statusCode > 0 ? <span className="text-xs text-zinc-500">{log.statusCode}</span> : null}
            </div>
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {log.method || "POST"}
                    </span>
                    <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={log.model}>
                        {log.model}
                    </span>
                    {log.totalTokens ? (
                        <Tag color="blue" className="m-0 text-[11px]">
                            {log.totalTokens.toLocaleString()} Tokens
                        </Tag>
                    ) : null}
                    {log.imageRequestedCount ? (
                        <Tag color="purple" className="m-0 text-[11px]">
                            生图 {log.imageSucceededCount || 0}/{log.imageRequestedCount}
                        </Tag>
                    ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span>{capabilityLabel(log.capability)}</span>
                    <span>·</span>
                    <span>{log.source === "runtime" ? "站内调用" : "后台实测"}</span>
                    {log.proxyEgress?.address ? (
                        <>
                            <span>·</span>
                            <span className="font-mono text-zinc-400">{log.proxyEgress.address}</span>
                        </>
                    ) : null}
                </div>
            </div>
            <div className="min-w-0 text-xs text-zinc-500 dark:text-zinc-400">
                <div className="truncate" title={log.accountEmail}>
                    {log.accountEmail || "未识别实际账号"}
                </div>
                <div className="mt-0.5 truncate">{formatDate(log.createdAt)}</div>
                {log.clientIp ? <div className="mt-0.5 truncate font-mono text-zinc-400">{log.clientIp}</div> : null}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatDuration(log.durationMs)}</div>
            <ChevronRight className="hidden size-4 text-zinc-400 sm:block" aria-hidden="true" />
        </button>
    );
}

function GeminiAiRequestLogDrawer({ log, onClose }: { log: GeminiAiRequestLog | null; onClose: () => void }) {
    const { message } = App.useApp();
    const { width: drawerWidth, resizing: drawerResizing, onHandlePointerDown } = useResizableDrawerWidth({ defaultWidth: 580, minWidth: 440 });

    const copyText = (content: string | undefined, successTip: string) => {
        if (!content) return;
        void navigator.clipboard.writeText(content).then(() => {
            message.success(successTip);
        });
    };

    return (
        <Drawer title="请求详情" open={Boolean(log)} onClose={onClose} width={drawerWidth} style={{ maxWidth: "100vw" }} styles={{ body: { padding: 16, position: "relative" } }}>
            <LogDetailResizeHandle resizing={drawerResizing} onPointerDown={onHandlePointerDown} />
            {log ? (
                <div className="space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <Tag color={log.statusCode === 0 ? "processing" : log.statusCode < 400 ? "success" : "error"} className="m-0">
                                {log.statusCode === 0 ? "执行中" : log.statusCode < 400 ? "请求成功" : "请求失败"}
                            </Tag>
                            <Tag className="m-0">{capabilityLabel(log.capability)}</Tag>
                            <Tag className="m-0">{log.source === "runtime" ? "站内调用" : "后台实测"}</Tag>
                            {log.proxyEgress ? (
                                <Tag color="geekblue" className="m-0">
                                    {log.proxyEgress.mode === "magic" ? "魔法代理" : "通用代理"} · {log.proxyEgress.address || log.proxyEgress.node_name}
                                </Tag>
                            ) : null}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950">
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(buildCurlCommand(log), "cURL 命令已复制")}>
                            复制 cURL
                        </Button>
                        <Button size="small" icon={<Copy className="size-3.5" />} disabled={!log.requestPreview} onClick={() => copyText(log.requestPreview, "请求体已复制")}>
                            复制请求体
                        </Button>
                        <Button size="small" icon={<Copy className="size-3.5" />} disabled={!log.responsePreview} onClick={() => copyText(log.responsePreview, "响应体已复制")}>
                            复制响应体
                        </Button>
                        {log.error ? (
                            <Button size="small" danger icon={<Copy className="size-3.5" />} onClick={() => copyText(log.error, "错误信息已复制")}>
                                复制错误
                            </Button>
                        ) : null}
                    </div>

                    <div className="grid gap-x-4 gap-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/50 sm:grid-cols-2">
                        <DetailItem label="模型" value={log.model} />
                        <DetailItem label="实际账号" value={log.accountEmail || "未识别"} />
                        {log.proxyEgress ? (
                            <DetailItem
                                label="代理出口"
                                value={`${log.proxyEgress.mode === "magic" ? "魔法代理" : "通用代理"}${log.proxyEgress.node_name ? ` · ${log.proxyEgress.node_name}` : ""}${log.proxyEgress.address ? ` · ${log.proxyEgress.address}` : ""}`}
                            />
                        ) : null}
                        <DetailItem label="状态码" value={String(log.statusCode)} />
                        <DetailItem label="耗时" value={formatDuration(log.durationMs)} />
                        <DetailItem label="请求时间" value={formatDate(log.createdAt)} />
                        <DetailItem label="请求路径" value={`${log.method || "POST"} ${log.path}`} />
                        {log.clientIp ? <DetailItem label="客户端 IP" value={log.clientIp} /> : null}
                        {log.userAgent ? <DetailItem label="User-Agent" value={log.userAgent} /> : null}
                        {log.totalTokens ? (
                            <DetailItem
                                label="Token 消耗"
                                value={`总计 ${log.totalTokens.toLocaleString()} (输入 ${log.promptTokens || 0} / 输出 ${log.completionTokens || 0})`}
                            />
                        ) : null}
                        {log.imageRequestedCount ? (
                            <DetailItem
                                label="生图张数"
                                value={`请求 ${log.imageRequestedCount} 张 / 成功 ${log.imageSucceededCount || 0} 张 / 失败 ${log.imageFailedCount || 0} 张`}
                            />
                        ) : null}
                    </div>
                    {log.lifecycle?.length ? (
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">过程日志</div>
                            <div className="space-y-1.5">
                                {log.lifecycle.map((entry, index) => (
                                    <div key={index} className="flex items-center gap-2 text-xs">
                                        <span className={entry.phase === "queued" || entry.phase === "running" ? "text-amber-500" : entry.phase === "success" ? "text-emerald-500" : "text-red-500"}>●</span>
                                        <span className="text-zinc-400">{formatDate(entry.time)}</span>
                                        <span className="text-zinc-600 dark:text-zinc-300">{entry.message}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {log.requestPreview ? <LogPreview title="请求摘要" content={log.requestPreview} /> : null}
                    {log.responsePreview ? <LogPreview title="响应摘要" content={log.responsePreview} /> : null}
                    {log.error ? <LogPreview title="错误信息" content={log.error} danger /> : null}
                    <Alert type="info" showIcon message="日志已自动脱敏" description="授权 Cookie、Token、API Key、上传媒体和生成图片内容不会在此处保存或展示。" />
                </div>
            ) : null}
        </Drawer>
    );
}

function DetailItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
            <div className="mt-1 break-words font-medium text-zinc-900 dark:text-zinc-100">{value}</div>
        </div>
    );
}

function LogPreview({ title, content, danger = false }: { title: string; content: string; danger?: boolean }) {
    return (
        <section>
            <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h3>
            <pre
                className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-sans text-xs leading-5 ${danger ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300" : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300"}`}
            >
                {content}
            </pre>
        </section>
    );
}

function formatDuration(durationMs: number) {
    return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)} 秒` : `${Math.max(0, durationMs)} ms`;
}

function StatusMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "success" }) {
    return (
        <div className="min-w-0 bg-white p-3 dark:bg-zinc-950 sm:p-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
            <div className={`mt-1 text-xl font-semibold ${tone === "success" ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-950 dark:text-zinc-100"}`}>{value}</div>
            <div className="mt-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{detail}</div>
        </div>
    );
}

function AccountStatusTag({ status }: { status?: string }) {
    const color = status === "failed" || status === "error" ? "error" : status === "pending" ? "warning" : status === "active" || status === "ready" || status === "healthy" || status === "available" ? "success" : undefined;
    return (
        <Tag color={color} className="m-0">
            {geminiAiStatusText(status)}
        </Tag>
    );
}

function GeminiAiRotationSettings({ rotation, onSave }: { rotation?: GeminiAiRotation; onSave: (rotation: GeminiAiRotation) => Promise<void> }) {
    const [mode, setMode] = useState(rotation?.mode || "round_robin");
    const [cooldownSeconds, setCooldownSeconds] = useState<number | undefined>(rotation?.cooldownSeconds);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setMode(rotation?.mode || "round_robin");
        setCooldownSeconds(rotation?.cooldownSeconds);
    }, [rotation?.cooldownSeconds, rotation?.mode]);

    return (
        <div className="space-y-4 p-3 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
                <Tag color={rotation?.enabled === false ? "default" : "success"} className="m-0">
                    {rotation?.enabled === false ? "Provider 轮换暂停" : "Provider 轮换已启用"}
                </Tag>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">当前账号仍可在上方手动切换。</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="block min-w-0 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    轮换策略
                    <Select
                        className="mt-1.5 w-full"
                        value={mode}
                        onChange={setMode}
                        options={[
                            { value: "round_robin", label: "轮询" },
                            { value: "lru", label: "最久未使用" },
                            { value: "least_rl", label: "优先未限流" },
                        ]}
                    />
                </label>
                <label className="block min-w-0 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    冷却秒数
                    <InputNumber className="mt-1.5 w-full" min={0} value={cooldownSeconds} placeholder="使用 Provider 默认值" onChange={(value: number | null) => setCooldownSeconds(typeof value === "number" ? value : undefined)} />
                </label>
            </div>
            <Button
                type="primary"
                loading={saving}
                onClick={async () => {
                    setSaving(true);
                    try {
                        await onSave({ mode, ...(cooldownSeconds !== undefined ? { cooldownSeconds } : {}) });
                    } finally {
                        setSaving(false);
                    }
                }}
            >
                保存轮换设置
            </Button>
        </div>
    );
}

function GeminiAiModelsSummary({ channels, models, onSave }: { channels: NonNullable<GeminiAiAdminState["channels"]>; models: GeminiAiModel[]; onSave: (modelIds: string[]) => Promise<boolean> }) {
    const selectableModels = useMemo(() => geminiAiSelectableModels(models), [models]);
    const savedModelIds = useMemo(() => geminiAiSelectedModelIds(models), [models]);
    const [selectedModelIds, setSelectedModelIds] = useState(savedModelIds);
    const [saving, setSaving] = useState(false);
    const selectionChanged = selectedModelIds.length !== savedModelIds.length || selectedModelIds.some((modelId) => !savedModelIds.includes(modelId));

    useEffect(() => {
        setSelectedModelIds(savedModelIds);
    }, [savedModelIds]);

    const toggleModel = (modelId: string, checked: boolean) => {
        setSelectedModelIds((current) => (checked ? Array.from(new Set([...current, modelId])) : current.filter((id) => id !== modelId)));
    };

    const saveSelectedModels = async () => {
        setSaving(true);
        try {
            await onSave(selectedModelIds);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="p-3 sm:p-5">
            <div className="mb-4 flex flex-wrap gap-2">
                {channels.length ? (
                    channels.map((channel) => (
                        <Tag key={channel.id} color={channel.status === "failed" ? "error" : channel.status === "disabled" ? "default" : "blue"} className="m-0">
                            {channel.name || "Gemini AI Studio"} · {channel.modelCount ?? channel.models?.length ?? 0} 个模型
                        </Tag>
                    ))
                ) : (
                    <Tag className="m-0">渠道尚未创建</Tag>
                )}
            </div>
            {selectableModels.length ? (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <div className="min-w-0">
                        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">选择写入 Gemini AI Studio 渠道的模型</div>
                        <span role="status" aria-atomic="true" className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-300">
                            已选择 {selectedModelIds.length} / {selectableModels.length} 个；保存后立即刷新当前渠道配置。
                        </span>
                    </div>
                    <Button type="primary" loading={saving} disabled={!selectionChanged} onClick={() => void saveSelectedModels()}>
                        保存所选模型
                    </Button>
                </div>
            ) : models.length ? (
                <Alert className="mb-4" type="info" showIcon message="暂无可写入 Gemini AI Studio 渠道的模型" description="官方 Gemini/Veo 视频候选仅用于已保存的官方渠道测试，不会由此页面写入 GeminiAIStudio Provider。" />
            ) : null}
            {models.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                    {models.map((model) => (
                        <div key={model.id} className="min-w-0 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                            <div className="flex min-w-0 items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-zinc-950 dark:text-zinc-100">{geminiAiModelLabel(model)}</span>
                                <Tag color={model.source === "geminiai" && !savedModelIds.includes(model.id) ? "default" : model.enabled === false ? "default" : "success"} className="m-0">
                                    {model.source === "geminiai" ? (savedModelIds.includes(model.id) ? "已保存" : "未保存") : model.enabled === false ? "已停用" : "可用"}
                                </Tag>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {geminiAiModelCapabilities(model).map((capability) => (
                                    <Tag key={capability} className="m-0">
                                        {capabilityLabel(capability)}
                                    </Tag>
                                ))}
                                {model.source === "gemini" ? (
                                    <Tag color="blue" className="m-0">
                                        官方 Gemini/Veo 渠道 · 只读
                                    </Tag>
                                ) : null}
                                {!geminiAiModelCapabilities(model).length ? <span className="text-xs text-zinc-500 dark:text-zinc-400">未声明能力</span> : null}
                            </div>
                            {model.source === "geminiai" ? (
                                <Checkbox
                                    className="mt-3"
                                    checked={selectedModelIds.includes(model.id)}
                                    disabled={saving}
                                    onChange={(event: CheckboxChangeEvent) => toggleModel(model.id, event.target.checked)}
                                    aria-label={`选择 ${geminiAiModelLabel(model)} 保存到 Gemini AI Studio 渠道`}
                                >
                                    保存到 Gemini AI Studio 渠道
                                </Checkbox>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未同步 GeminiAIStudio 模型目录" />
            )}
        </div>
    );
}

function GeminiAiAuthorizationModal({ open, onClose, onCompleted }: { open: boolean; onClose: () => void; onCompleted: () => Promise<void> }) {
    const { message } = App.useApp();
    const [name, setName] = useState("");
    const [session, setSession] = useState<{ sessionId: string; status?: string; error?: string } | null>(null);
    const [starting, setStarting] = useState(false);
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        if (open) return;
        setName("");
        setSession(null);
        setStarting(false);
        setChecking(false);
    }, [open]);

    const close = () => {
        setName("");
        setSession(null);
        onClose();
    };
    const start = async () => {
        setStarting(true);
        try {
            const result = await startGeminiAiAccountLogin({ name: name.trim() || undefined, headless: false, uiLocale: "zh-CN" });
            setSession(result);
            message.success("已打开 Provider 的 Camoufox 登录窗口，请在该窗口完成 Google 授权");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法启动 Google 授权");
        } finally {
            setStarting(false);
        }
    };
    const check = async () => {
        if (!session) return;
        setChecking(true);
        try {
            const result = await getGeminiAiAccountLoginStatus(session.sessionId);
            setSession(result);
            if (result.status === "completed") await onCompleted();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法读取授权状态");
        } finally {
            setChecking(false);
        }
    };

    return (
        <Modal title="添加 Google 授权" open={open} onCancel={close} footer={null} width={640} style={{ maxWidth: "calc(100vw - 24px)" }} styles={{ body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" } }}>
            <div className="space-y-4 py-1">
                <Alert type="info" showIcon message="授权在 Provider 的 Camoufox 窗口中完成" description="Camoufox 是两个参考项目使用的请求环境；不会读取当前 Chrome Cookie。首次切换需要在该窗口登录一次，后续复用其持久授权。" />
                <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    账号备注
                    <Input className="mt-1.5" value={name} maxLength={80} placeholder="例如：运营主账号" onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} />
                </label>
                {session ? (
                    <Alert
                        type={session.status === "failed" ? "error" : session.status === "completed" ? "success" : "warning"}
                        showIcon
                        message={`授权状态：${geminiAiStatusText(session.status)}`}
                        description={session.error || (session.status === "completed" ? "授权完成，账号已加入列表。" : "请在隔离窗口完成操作后手动检查。")}
                    />
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                    {session ? (
                        <Button loading={checking} onClick={() => void check()}>
                            检查授权状态
                        </Button>
                    ) : null}
                    {!session ? (
                        <Button type="primary" icon={<Plus className="size-4" />} loading={starting} onClick={() => void start()}>
                            打开 Camoufox 授权窗口
                        </Button>
                    ) : null}
                </div>
            </div>
        </Modal>
    );
}

function GeminiAiCookieImportModal({ open, onClose, onCompleted }: { open: boolean; onClose: () => void; onCompleted: () => Promise<void> }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<GeminiAiCookieImportValues>();
    const [submitting, setSubmitting] = useState(false);
    const close = () => {
        form.resetFields();
        onClose();
    };
    return (
        <Modal
            title="导入 Google Cookie"
            open={open}
            onCancel={close}
            onOk={() => form.submit()}
            okText="安全导入"
            cancelText="取消"
            confirmLoading={submitting}
            keyboard={!submitting}
            mask={{ closable: !submitting }}
            width={680}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            styles={{ body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" } }}
        >
            <Form
                form={form}
                layout="vertical"
                requiredMark={false}
                onFinish={async (values: GeminiAiCookieImportValues) => {
                    setSubmitting(true);
                    try {
                        await importGeminiAiAccount({ cookies: values.cookies, name: values.name?.trim() || undefined, email: values.email?.trim() || undefined });
                        form.resetFields();
                        await onCompleted();
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "Cookie 导入失败");
                        form.setFieldValue("cookies", "");
                    } finally {
                        setSubmitting(false);
                    }
                }}
            >
                <Alert
                    className="mb-4"
                    type="warning"
                    showIcon
                    message="仅在无法使用 Camoufox 授权时使用"
                    description="Cookie 仅通过本次请求安全传给 GeminiAIStudio Provider，按受限权限存储；页面、审计与后续列表均不会回显，也不会写入渠道配置。提交后文本框会清空。"
                />
                <div className="grid gap-x-3 sm:grid-cols-2">
                    <Form.Item label="账号备注" name="name">
                        <Input maxLength={80} placeholder="例如：备用账号" autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="邮箱（可选）" name="email">
                        <Input type="email" maxLength={160} placeholder="授权账号邮箱" autoComplete="off" />
                    </Form.Item>
                </div>
                <Form.Item label="Cookie" name="cookies" rules={[{ required: true, message: "请粘贴待导入的 Cookie" }]}>
                    <Input.TextArea autoComplete="off" rows={8} placeholder="粘贴 Cookie 内容；不要在聊天、日志或截图中暴露。" />
                </Form.Item>
            </Form>
        </Modal>
    );
}

function GeminiAiRenameModal({ account, onClose, onSave }: { account: GeminiAiAccount | null; onClose: () => void; onSave: (name: string) => Promise<void> }) {
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    useEffect(() => setName(account?.name || ""), [account?.id, account?.name]);
    return (
        <Modal
            title="修改账号备注"
            open={Boolean(account)}
            onCancel={onClose}
            okText="保存"
            cancelText="取消"
            confirmLoading={saving}
            width={480}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            onOk={async () => {
                const nextName = name.trim();
                if (!nextName) return;
                setSaving(true);
                try {
                    await onSave(nextName);
                } finally {
                    setSaving(false);
                }
            }}
        >
            <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                账号备注
                <Input className="mt-1.5" value={name} maxLength={80} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} placeholder="例如：运营主账号" />
            </label>
        </Modal>
    );
}

function GeminiAiModelTestDialog({ state, open, onClose }: { state: GeminiAiAdminState | null; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [capability, setCapability] = useState<GeminiAiCapability>("text");
    const [modelId, setModelId] = useState("");
    const [prompt, setPrompt] = useState("");
    const [size, setSize] = useState("auto");
    const [imageQuality, setImageQuality] = useState("1K");
    const [running, setRunning] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [result, setResult] = useState<GeminiAiTestResult | null>(null);
    const [requestError, setRequestError] = useState("");
    const models = useMemo(() => geminiAiModelsForCapability(state?.models || [], capability), [capability, state?.models]);

    useEffect(() => {
        setModelId(models[0]?.id || "");
        setResult(null);
        setRequestError("");
    }, [capability, models]);
    useEffect(() => setSize(capability === "image" ? "auto" : "1:1"), [capability]);
    useEffect(() => {
        if (open) return;
        setResult(null);
        setRequestError("");
        setPrompt("");
        setRunning(false);
        setRefreshing(false);
    }, [open]);

    const submit = async () => {
        if (!modelId || !prompt.trim()) return;
        const selectedModel = models.find((model) => model.id === modelId);
        setRunning(true);
        setRequestError("");
        setResult(null);
        try {
            setResult(
                await testGeminiAiModel({
                    capability,
                    model: modelId,
                    prompt: prompt.trim(),
                    options: {
                        ...(capability === "search" ? { googleSearch: true } : {}),
                        ...(capability === "image" ? { aspectRatio: size, imageSize: imageQuality } : {}),
                        ...(capability === "video" ? { size } : {}),
                        ...(capability === "video" && selectedModel?.channelId ? { channelId: selectedModel.channelId } : {}),
                    },
                }),
            );
        } catch (error) {
            const text = error instanceof Error ? error.message : "模型实测请求失败";
            setRequestError(text);
            message.error(text);
        } finally {
            setRunning(false);
        }
    };
    const refreshVideo = async () => {
        if (!result) return;
        setRefreshing(true);
        try {
            setResult(await getGeminiAiTestStatus(result));
        } catch (error) {
            const text = error instanceof Error ? error.message : "无法刷新视频任务状态";
            setRequestError(text);
            message.error(text);
        } finally {
            setRefreshing(false);
        }
    };
    const close = () => {
        if (!running && !refreshing) onClose();
    };

    return (
        <Modal
            title="GeminiAIStudio 模型实测"
            open={open}
            onCancel={close}
            footer={null}
            closable={!running && !refreshing}
            keyboard={!running && !refreshing}
            mask={{ closable: !running && !refreshing }}
            destroyOnHidden
            centered
            width={880}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            styles={{ body: { maxHeight: "calc(100dvh - 150px)", overflowY: "auto" } }}
        >
            <div className="space-y-4 py-1">
                <Alert type="info" showIcon message="每次只发起当前选中模型的一次真实请求" description="不会批量探测、不会写入测试历史。结果仅保留在当前对话框，关闭后即清空。" />
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label="GeminiAIStudio 实测能力">
                    {geminiAiTestTabs.map((tab) => {
                        const selected = capability === tab.capability;
                        return (
                            <button
                                key={tab.capability}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`min-h-11 rounded-md border px-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${selected ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-500/15 dark:text-indigo-200" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"}`}
                                onClick={() => setCapability(tab.capability)}
                            >
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
                <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">{geminiAiTestTabs.find((tab) => tab.capability === capability)?.description}</p>
                {capability === "video" ? <Alert type="warning" showIcon message="视频测试仅调用已保存的官方 Gemini/Veo 渠道" description="Google AI Studio 账号本身不提供 Veo。没有已配置官方渠道时，服务端会返回明确的配置提示。" /> : null}
                {capability === "image" ? <Alert type="info" showIcon message="图片测试使用 AI Studio 页面原生生成" description="仅测试 gemini-3-pro-image 与 gemini-3.1-flash-image；比例和画质会同步到页面的 Aspect ratio 与 Resolution 设置。" /> : null}
                <div className={`grid gap-3 ${capability === "image" ? "sm:grid-cols-[minmax(0,1fr)_140px_140px]" : "sm:grid-cols-[minmax(0,1fr)_180px]"}`}>
                    <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        模型
                        <Select
                            className="mt-1.5 w-full"
                            value={modelId || undefined}
                            placeholder="没有已声明该能力的模型"
                            options={models.map((model) => ({ value: model.id, label: geminiAiModelLabel(model) }))}
                            onChange={setModelId}
                            disabled={!models.length || running}
                        />
                    </label>
                    {capability === "image" || capability === "video" ? (
                        <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                            画面比例
                            <Select
                                className="mt-1.5 w-full"
                                value={size}
                                onChange={setSize}
                                disabled={running}
                                options={capability === "image" ? GEMINIAI_IMAGE_TEST_RATIOS.map((value) => ({ value, label: value === "auto" ? "Auto" : value })) : ["1:1", "16:9", "9:16"].map((value) => ({ value, label: value }))}
                            />
                        </label>
                    ) : null}
                    {capability === "image" ? (
                        <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                            画质
                            <Select className="mt-1.5 w-full" value={imageQuality} onChange={setImageQuality} disabled={running} options={[...GEMINIAI_IMAGE_TEST_QUALITIES]} />
                        </label>
                    ) : null}
                </div>
                {!models.length ? (
                    <Alert
                        type="warning"
                        showIcon
                        message="没有可用于此能力的模型"
                        description={capability === "video" ? "请先在模型渠道中保存官方 Gemini/Veo 渠道并同步对应视频模型。" : "请先同步 GeminiAIStudio 模型目录，或确认服务端为模型声明了此能力。"}
                    />
                ) : null}
                <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    测试提示词
                    <Input.TextArea
                        className="mt-1.5"
                        value={prompt}
                        autoSize={{ minRows: 5, maxRows: 10 }}
                        placeholder={testPromptPlaceholder(capability)}
                        disabled={running}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)}
                    />
                </label>
                {requestError ? <Alert type="error" showIcon message="实测请求未完成" description={requestError} /> : null}
                {result ? <GeminiAiTestResultView result={result} capability={capability} refreshing={refreshing} onRefreshVideo={() => void refreshVideo()} /> : null}
                <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <Button onClick={close} disabled={running || refreshing}>
                        关闭
                    </Button>
                    <Button type="primary" icon={<Play className="size-4" />} loading={running} disabled={!modelId || !prompt.trim() || refreshing} onClick={() => void submit()}>
                        开始实测
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function GeminiAiTestResultView({ result, capability, refreshing, onRefreshVideo }: { result: GeminiAiTestResult; capability: GeminiAiCapability; refreshing: boolean; onRefreshVideo: () => void }) {
    const images = Array.from(new Set([...(result.images || []), ...(result.imageUrls || [])]));
    const text = result.text || result.content || result.output;
    const canRefreshVideo = capability === "video" && (Boolean(result.statusUrl) || Boolean(result.taskId && result.channelId)) && !result.videoUrl && result.status !== "failed";
    return (
        <section className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusTag status={result.status} />
                    <span className="text-zinc-600 dark:text-zinc-300">实际模型：{result.model || "服务未返回"}</span>
                    {result.elapsedMs !== undefined ? <span className="text-zinc-500 dark:text-zinc-400">耗时：{formatElapsed(result.elapsedMs)}</span> : null}
                </div>
                {canRefreshVideo ? (
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={refreshing} onClick={onRefreshVideo}>
                        刷新视频状态
                    </Button>
                ) : null}
            </div>
            <div className="space-y-3 p-3">
                {result.error ? <Alert type="error" showIcon message="上游未完成本次实测" description={result.error} /> : null}
                {text ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs leading-5 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">{text}</pre> : null}
                {result.citations?.length ? (
                    <div className="space-y-2">
                        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Google 搜索来源</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {result.citations.map((citation, index) => (
                                <a
                                    key={`${citation.url || citation.title || "citation"}-${index}`}
                                    href={citation.url || undefined}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="min-w-0 rounded-md border border-zinc-200 p-2 text-xs text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                                >
                                    <span className="block truncate font-medium">{citation.title || citation.source || "搜索来源"}</span>
                                    {citation.url ? <span className="mt-1 block truncate text-zinc-500 dark:text-zinc-400">{citation.url}</span> : null}
                                </a>
                            ))}
                        </div>
                    </div>
                ) : null}
                {images.length ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {images.map((url, index) => (
                            <img key={`${url}-${index}`} src={url} alt={`GeminiAIStudio 本次生成图片 ${index + 1}`} className="h-auto w-full rounded-md border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" />
                        ))}
                    </div>
                ) : null}
                {result.videoUrl ? (
                    <video className="h-auto w-full rounded-md border border-zinc-200 bg-black dark:border-zinc-800" controls preload="metadata" src={result.videoUrl}>
                        当前浏览器无法播放本次视频结果。
                    </video>
                ) : null}
                {!result.error && !text && !images.length && !result.videoUrl ? <div className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">服务端尚未返回可展示的结果内容；请查看当前状态或手动刷新视频任务。</div> : null}
            </div>
        </section>
    );
}

function StatusTag({ status }: { status?: string }) {
    const color = status === "succeeded" || status === "success" ? "success" : status === "failed" || status === "error" ? "error" : status === "needs_review" ? "warning" : "processing";
    const label =
        status === "succeeded" || status === "success" ? "已完成" : status === "failed" || status === "error" ? "失败" : status === "needs_review" ? "需要确认" : status === "running" ? "进行中" : status === "queued" ? "已排队" : status || "未知";
    return (
        <Tag color={color} className="m-0">
            {label}
        </Tag>
    );
}

function SectionLoading() {
    return <div className="flex min-h-28 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">正在读取 GeminiAIStudio 配置...</div>;
}

function capabilityLabel(capability: GeminiAiCapability) {
    return capability === "text" ? "文本" : capability === "image" ? "图片" : capability === "video" ? "视频" : "Google 搜索";
}

function testPromptPlaceholder(capability: GeminiAiCapability) {
    if (capability === "image") return "描述一张要生成的图片，例如：一只在雨夜霓虹街道漫步的橘猫";
    if (capability === "video") return "描述要生成的视频，例如：一艘飞船缓慢掠过云海";
    if (capability === "search") return "输入需要检索的问题，例如：今天上海的天气如何？";
    return "输入要发送给模型的测试问题";
}

function formatElapsed(milliseconds: number) {
    return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} 秒`;
}

function formatDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}
