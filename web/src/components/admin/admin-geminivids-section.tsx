"use client";

import { App, Alert, Button, Drawer, Empty, Form, Input, Modal, Pagination, Popconfirm, Select, Space, Switch, Tabs, Tag, Upload } from "antd";
import { BarChart3, ChevronRight, CircleUserRound, Clock, Copy, KeyRound, Network, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload as UploadIcon } from "lucide-react";
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminTrafficPanel } from "@/components/admin/admin-traffic-panel";

type GeminiVidsTab = "overview" | "statistics" | "gateway" | "logs" | "proxy";
type GeminiVidsAccount = {
    id: string;
    name: string;
    email?: string | null;
    status?: string;
    vids_doc_id?: string | null;
    created_at?: string;
    last_used?: string | null;
    last_error?: string | null;
};
type GeminiVidsKey = { id: string; name: string; prefix: string; key?: string; status: "active" | "disabled"; expiresAt?: string; allowedIps: string[]; requestCount: number; lastUsedAt?: string; createdAt: string };
type GeminiVidsRequestLog = {
    id: string;
    time: string;
    source: "runtime" | "admin-test" | "external";
    method: string;
    path: string;
    model: string;
    accountId?: string;
    accountEmail?: string;
    promptPreview?: string;
    requestPreview?: string;
    responsePreview?: string;
    statusCode?: number;
    durationMs?: number;
    error?: string;
    phase?: "queued" | "upstream" | "success" | "failed";
    clientIp?: string;
    userAgent?: string;
};
type GeminiVidsLogPage = { logs: GeminiVidsRequestLog[]; page: number; pageSize: number; total: number; stats: { total: number; success: number; failed: number; averageDurationMs: number } };
type GeminiVidsTestTask = { id: string; status: string; error?: string; width?: number; height?: number; duration?: number; video_url?: string; reference_images?: number };
type GeminiVidsKeyDraft = { name: string; expiresAt: string; allowedIps: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/admin/geminivids${path}`, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
    const payload = (await response.json().catch(() => null)) as { code?: number; data?: T; msg?: string } | null;
    if (!response.ok || !payload || typeof payload.code !== "number" || payload.code !== 0) throw new Error(payload?.msg || `请求失败（${response.status}）`);
    return payload.data as T;
}

export function AdminGeminiVidsSection() {
    const { message } = App.useApp();
    const [state, setState] = useState<{ configured: boolean; healthy: boolean; enabled: boolean; channelExists: boolean; accounts: GeminiVidsAccount[]; activeAccountId: string; models: { id: string; name: string }[]; gateway: { enabled: boolean }; apiKeys: GeminiVidsKey[]; stats: { total: number; failed: number; avgDurationMs: number }; proxyUrl?: string } | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [accountActionId, setAccountActionId] = useState("");
    const [cookieImportOpen, setCookieImportOpen] = useState(false);
    const [renamingAccount, setRenamingAccount] = useState<GeminiVidsAccount | null>(null);
    const [modelTestOpen, setModelTestOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<GeminiVidsTab>("overview");
    const [keyOpen, setKeyOpen] = useState(false);
    const [keyDraft, setKeyDraft] = useState<GeminiVidsKeyDraft>({ name: "外部调用密钥", expiresAt: "", allowedIps: "" });
    const [rawKey, setRawKey] = useState("");
    const [gatewaySaving, setGatewaySaving] = useState(false);
    const [logPage, setLogPage] = useState<GeminiVidsLogPage | null>(null);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logPageNumber, setLogPageNumber] = useState(1);
    const [logKeywordDraft, setLogKeywordDraft] = useState("");
    const [logKeyword, setLogKeyword] = useState("");
    const [logStatus, setLogStatus] = useState<"" | "success" | "failed">("");
    const [logSource, setLogSource] = useState<"" | "runtime" | "admin-test" | "external">("");
    const [logModel, setLogModel] = useState("");
    const [logAccountId, setLogAccountId] = useState("");
    const [selectedLog, setSelectedLog] = useState<GeminiVidsRequestLog | null>(null);
    const [proxyDraft, setProxyDraft] = useState("");
    const [proxySaving, setProxySaving] = useState(false);
    const [origin, setOrigin] = useState("");
    useEffect(() => {
        setOrigin(window.location.origin);
    }, []);

    const loadState = useCallback(async () => {
        setLoading(true);
        setLoadError("");
        try {
            const nextState = await api<typeof state>("/");
            setState(nextState);
            setProxyDraft(nextState?.proxyUrl || "");
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "无法读取 GeminiVids 配置");
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
                const params = new URLSearchParams({ page: String(pageNumber), pageSize: "20" });
                if (logKeyword) params.set("keyword", logKeyword);
                if (logStatus) params.set("status", logStatus);
                if (logSource) params.set("source", logSource);
                if (logModel) params.set("model", logModel);
                if (logAccountId) params.set("accountId", logAccountId);
                setLogPage(await api<GeminiVidsLogPage>(`/logs?${params.toString()}`));
            } catch (error) {
                message.error(error instanceof Error ? error.message : "无法读取 GeminiVids 请求日志");
            } finally {
                setLogsLoading(false);
            }
        },
        [logAccountId, logKeyword, logModel, logPageNumber, logSource, logStatus, message],
    );

    useEffect(() => {
        if (activeTab === "logs") void loadLogs();
    }, [activeTab, loadLogs]);

    // 视频生成请求耗时 30-120 秒：存在进行中记录时自动跟随刷新，其余情况停止轮询。
    const hasPendingLog = Boolean(logPage?.logs?.some((item) => item.phase === "queued" || item.phase === "upstream"));
    useEffect(() => {
        if (activeTab !== "logs" || !hasPendingLog) return;
        const timer = setInterval(() => void loadLogs(), 5000);
        return () => clearInterval(timer);
    }, [activeTab, hasPendingLog, loadLogs]);

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

    const saveGateway = async (enabled: boolean) => {
        setGatewaySaving(true);
        try {
            await api("/gateway", { method: "PUT", body: JSON.stringify({ enabled }) });
            await loadState();
            message.success(enabled ? "网关已启用" : "网关已停用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存网关设置失败");
        } finally {
            setGatewaySaving(false);
        }
    };

    const saveProxy = async () => {
        setProxySaving(true);
        try {
            await api("/proxy", { method: "PUT", body: JSON.stringify({ proxyUrl: proxyDraft.trim() }) });
            await loadState();
            message.success(proxyDraft.trim() ? "代理已更新" : "已切换为直连");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存代理失败");
        } finally {
            setProxySaving(false);
        }
    };

    const createKey = async () => {
        setAccountActionId("key-create");
        try {
            const data = await api<{ key: GeminiVidsKey; rawKey: string }>("/keys", {
                method: "POST",
                body: JSON.stringify({
                    name: keyDraft.name,
                    ...(keyDraft.expiresAt ? { expiresAt: new Date(keyDraft.expiresAt).toISOString() } : {}),
                    allowedIps: keyDraft.allowedIps
                        .split(/\r?\n|,/)
                        .map((value) => value.trim())
                        .filter(Boolean),
                }),
            });
            setRawKey(data.rawKey);
            setKeyOpen(false);
            await loadState();
            message.success("API 密钥已创建");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建 API 密钥失败");
        } finally {
            setAccountActionId("");
        }
    };

    const runKeyAction = async (keyId: string, work: () => Promise<unknown>, successMessage: string) => {
        setAccountActionId(keyId);
        try {
            await work();
            await loadState();
            message.success(successMessage);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "密钥操作失败");
        } finally {
            setAccountActionId("");
        }
    };

    const importFromGeminiAi = async () => {
        setAccountActionId("import-geminiai");
        try {
            const result = await api<{ imported: { account_id: string }[]; failed: { email: string; error: string }[] }>("/accounts", { method: "POST", body: JSON.stringify({ fromGeminiAi: true }) });
            await loadState();
            message.success(`已从 GeminiAIStudio 导入 ${result.imported.length} 个账号${result.failed.length ? `，失败 ${result.failed.length} 个` : ""}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入失败");
        } finally {
            setAccountActionId("");
        }
    };

    return (
        <div className="space-y-4">
            {loadError ? (
                <Alert
                    type="error"
                    showIcon
                    message="GeminiVids 配置读取失败"
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
                onChange={(key) => setActiveTab(key as GeminiVidsTab)}
                items={[
                    { key: "overview", label: <GeminiVidsTabLabel label="账号与渠道" compact="账号" /> },
                    { key: "statistics", label: <GeminiVidsTabLabel label="流量统计" compact="流量" /> },
                    { key: "gateway", label: <GeminiVidsTabLabel label="反代网关与 API 密钥" compact="网关与密钥" /> },
                    { key: "logs", label: <GeminiVidsTabLabel label="请求日志" compact="日志" /> },
                    { key: "proxy", label: <GeminiVidsTabLabel label="代理管理" compact="代理" /> },
                ]}
            />
            {activeTab === "statistics" ? <AdminTrafficPanel protocol="geminivids" title="GeminiVids 流量统计" /> : null}
            <div className={activeTab === "overview" ? "space-y-4" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="GeminiVids"
                        description="使用服务器已授权 Google 账号以纯协议调用 docs.google.com/videos 的 Omni 视频模型，无需浏览器。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadState()}>
                                    刷新状态
                                </Button>
                                <Button type="primary" icon={<Play className="size-4" />} disabled={!state?.healthy} onClick={() => setModelTestOpen(true)}>
                                    模型实测
                                </Button>
                            </Space>
                        }
                    />
                    <div className="grid gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-800">
                        <StatusMetric
                            label="服务状态"
                            value={loading && !state ? "读取中" : state?.healthy ? "正常" : state?.configured ? "不可用" : "待配置"}
                            detail={state?.healthy ? "Sidecar 在线，未进行自动探测。" : state?.configured ? "Sidecar 暂时无法连接，请检查本地服务状态。" : "请先配置 Sidecar 并导入至少一个 Google 账号。"}
                            tone={state?.healthy ? "success" : "neutral"}
                        />
                        <StatusMetric
                            label="授权账号"
                            value={state ? String(state.accounts.length) : "—"}
                            detail={state?.activeAccountId ? "已有当前使用账号" : "尚未选择当前账号"}
                        />
                        <StatusMetric label="渠道状态" value={state ? (state.channelExists ? (state.enabled ? "已启用" : "已停用") : "未初始化") : "—"} detail="渠道模型固定为 google-vids-omni；支持横竖版、720p/1080p、4-10 秒与参考图片。" />
                    </div>
                    <div className="p-3 sm:p-5">
                        <Alert
                            type={state?.configured ? "info" : "warning"}
                            showIcon
                            message={state?.configured ? "Provider 已连接；账号 Cookie 复用 GeminiAIStudio 授权" : "尚未完成 GeminiVids Provider 配置"}
                            description={
                                state?.configured
                                    ? "视频任务全部通过纯协议提交到 Google Vids，不需要浏览器；可直接从 GeminiAIStudio 一键导入已授权账号。"
                                    : "完成 Provider 配置后，可在这里导入 Google 账号 Cookie 并启用 GeminiVids 渠道。"
                            }
                        />
                        {!state?.channelExists ? (
                            <Button
                                className="mt-3"
                                type="primary"
                                loading={accountActionId === "enable"}
                                onClick={async () => {
                                    setAccountActionId("enable");
                                    try {
                                        await api("/", { method: "POST", body: JSON.stringify({ action: "enable" }) });
                                        await loadState();
                                        message.success("GeminiVids 渠道已启用");
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "启用失败");
                                    } finally {
                                        setAccountActionId("");
                                    }
                                }}
                            >
                                初始化并启用渠道
                            </Button>
                        ) : null}
                        {state?.channelExists ? (
                            <Button
                                className="mt-3"
                                type="primary"
                                ghost
                                loading={accountActionId === "toggle-channel"}
                                onClick={async () => {
                                    setAccountActionId("toggle-channel");
                                    try {
                                        await api("/", { method: "POST", body: JSON.stringify({ action: "setEnabled", enabled: !state.enabled }) });
                                        await loadState();
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "更新失败");
                                    } finally {
                                        setAccountActionId("");
                                    }
                                }}
                            >
                                {state.enabled ? "停用渠道" : "启用渠道"}
                            </Button>
                        ) : null}
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader
                        title="Google 账号授权"
                        description="只展示账号名称、邮箱、状态和 doc id；Cookie 与授权状态不会回显。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<ShieldCheck className="size-4" />} onClick={() => setCookieImportOpen(true)}>
                                    导入 Cookie
                                </Button>
                                <Button type="default" icon={<Plus className="size-4" />} loading={accountActionId === "import-geminiai"} onClick={() => void importFromGeminiAi()}>
                                    从 GeminiAIStudio 导入
                                </Button>
                            </Space>
                        }
                    />
                    {loading && !state ? <SectionLoading /> : null}
                    {state ? (
                        state.accounts.length ? (
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
                                                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{account.email || "导入 Cookie 后将显示已识别邮箱"}</div>
                                                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                                                        {account.last_used ? <span>最近使用：{formatDate(account.last_used)}</span> : null}
                                                        {account.last_error ? <span className="text-red-500">最近错误：{account.last_error}</span> : null}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap lg:shrink-0">
                                                <Button size="small" disabled={active} loading={actionLoading && !active} onClick={() => void runAccountAction(account.id, () => api(`/accounts/${account.id}/activate`, { method: "POST" }), "已切换当前 Google 账号")}>
                                                    {active ? "当前账号" : "设为当前"}
                                                </Button>
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setRenamingAccount(account)}>
                                                    改名
                                                </Button>
                                                <Popconfirm
                                                    title="删除这个 Google 授权？"
                                                    description="删除后此账号将无法再被 GeminiVids Provider 使用。"
                                                    okText="删除"
                                                    cancelText="取消"
                                                    okButtonProps={{ danger: true, loading: actionLoading }}
                                                    onConfirm={() => runAccountAction(account.id, () => api(`/accounts/${account.id}`, { method: "DELETE" }), "Google 授权已删除")}
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

                <Panel>
                    <PanelHeader title="请求概览" description="统计当前 GeminiVids 请求日志中的真实调用结果。" />
                    <div className="grid gap-3 p-3 sm:grid-cols-3 sm:p-5">
                        <RequestMetric label="请求总数" value={(state?.stats.total ?? 0).toLocaleString()} detail="全部已持久化请求" />
                        <RequestMetric label="失败请求" value={(state?.stats.failed ?? 0).toLocaleString()} detail="可点击日志页记录定位上游错误" tone={state?.stats.failed ? "danger" : "neutral"} />
                        <RequestMetric label="平均耗时" value={formatDuration(state?.stats.avgDurationMs ?? 0)} detail="从提交到上游响应" />
                    </div>
                </Panel>
            </div>

            <div data-geminivids-tab-panel="gateway" className={activeTab === "gateway" ? "grid gap-4 xl:grid-cols-2" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="反代网关"
                        description="对外提供任务式视频接口；外部调用必须使用下方创建的 API 密钥。"
                        actions={
                            <Button icon={<RefreshCw className="size-4" />} loading={loading} disabled={gatewaySaving} onClick={() => void loadState()}>
                                刷新配置
                            </Button>
                        }
                    />
                    <div className="space-y-3 p-3 sm:p-4">
                        <div className="flex items-center justify-between gap-3">
                            <span>启用网关</span>
                            <Switch aria-label="启用 GeminiVids 网关" checked={Boolean(state?.gateway?.enabled)} disabled={gatewaySaving || loading} onChange={(enabled) => void saveGateway(enabled)} />
                        </div>
                        <div className="break-all text-xs leading-6 text-zinc-500 dark:text-zinc-400">
                            Base URL：<code>{origin || "…"}/api/geminivids</code>
                            <br />
                            创建视频：POST /v1/videos
                            <br />
                            查询任务：GET /v1/videos/:task_id
                            <br />
                            成片下载：GET /v1/videos/:task_id/content
                        </div>
                    </div>
                </Panel>
                <Panel>
                    <PanelHeader
                        title="API 密钥"
                        description="外部客户端统一通过反代接口使用，密钥安全加密存储，支持随时查看明文与一键复制。"
                        actions={
                            <Button type="primary" icon={<KeyRound className="size-4" />} disabled={loading} onClick={() => setKeyOpen(true)}>
                                创建密钥
                            </Button>
                        }
                    />
                    <div className="space-y-2 p-3 sm:p-4">
                        {state?.apiKeys?.length ? (
                            state.apiKeys.map((key) => (
                                <GeminiVidsKeyRow
                                    key={key.id}
                                    apiKey={key}
                                    busy={accountActionId === key.id}
                                    onToggle={(enabled) => void runKeyAction(key.id, () => api(`/keys/${key.id}`, { method: "PATCH", body: JSON.stringify({ status: enabled ? "active" : "disabled" }) }), enabled ? "密钥已启用" : "密钥已停用")}
                                    onDelete={() => void runKeyAction(key.id, () => api(`/keys/${key.id}`, { method: "DELETE" }), "API 密钥已删除")}
                                />
                            ))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未创建 API 密钥" />
                        )}
                    </div>
                </Panel>
            </div>

            {activeTab === "logs" ? (
                <GeminiVidsRequestLogs
                    page={logPage}
                    loading={logsLoading}
                    keyword={logKeywordDraft}
                    status={logStatus}
                    source={logSource}
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
                    onSourceChange={(value) => {
                        setLogPageNumber(1);
                        setLogSource(value);
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
                        await api("/logs", { method: "DELETE" });
                        setSelectedLog(null);
                        setLogPageNumber(1);
                        await loadLogs(1);
                        message.success("GeminiVids 请求日志已清空");
                    }}
                    onSelect={setSelectedLog}
                />
            ) : null}

            <div className={activeTab === "proxy" ? "space-y-4" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="代理管理"
                        description="为 GeminiVids 的 Google 协议出口设置代理；留空保存即恢复直连。"
                        actions={
                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadState()}>
                                刷新配置
                            </Button>
                        }
                    />
                    <div className="space-y-3 p-3 sm:p-4">
                        <Alert type="info" showIcon message="代理对纯协议提交、参考图上传与成片下载同时生效" description="支持 http:// 与 socks5:// 形式；保存在 Sidecar 运行时并立即应用。" />
                        <div className="flex flex-wrap items-center gap-2">
                            <Input className="max-w-md" placeholder="http://127.0.0.1:7890 或 socks5://..." value={proxyDraft} onChange={(event: ChangeEvent<HTMLInputElement>) => setProxyDraft(event.target.value)} />
                            <Button type="primary" loading={proxySaving} onClick={() => void saveProxy()}>
                                保存并应用
                            </Button>
                        </div>
                    </div>
                </Panel>
            </div>

            <GeminiVidsCookieImportModal
                open={cookieImportOpen}
                onClose={() => setCookieImportOpen(false)}
                onCompleted={async () => {
                    await loadState();
                    message.success("Google Cookie 已安全导入");
                    setCookieImportOpen(false);
                }}
            />
            <GeminiVidsRenameModal
                account={renamingAccount}
                onClose={() => setRenamingAccount(null)}
                onSave={async (name) => {
                    if (!renamingAccount) return;
                    if (await runAccountAction(renamingAccount.id, () => api(`/accounts/${renamingAccount.id}`, { method: "PUT", body: JSON.stringify({ name }) }), "账号名称已更新")) setRenamingAccount(null);
                }}
            />
            <GeminiVidsModelTestDialog healthy={Boolean(state?.healthy)} open={modelTestOpen} onClose={() => setModelTestOpen(false)} />
            <Modal
                title="创建 GeminiVids API 密钥"
                open={keyOpen}
                centered
                okText="创建"
                cancelText="取消"
                confirmLoading={accountActionId === "key-create"}
                onCancel={() => setKeyOpen(false)}
                onOk={() => void createKey()}
                width="min(520px, calc(100vw - 32px))"
            >
                <div className="space-y-4 pt-2">
                    <Field label="密钥名称">
                        <Input value={keyDraft.name} onChange={(event: ChangeEvent<HTMLInputElement>) => setKeyDraft((current) => ({ ...current, name: event.target.value }))} />
                    </Field>
                    <Field label="过期时间（可选）">
                        <Input type="datetime-local" value={keyDraft.expiresAt} onChange={(event: ChangeEvent<HTMLInputElement>) => setKeyDraft((current) => ({ ...current, expiresAt: event.target.value }))} />
                    </Field>
                    <Field label="允许 IP / IPv4 CIDR（每行一个，可选）">
                        <Input.TextArea rows={4} placeholder={"127.0.0.1\n10.0.0.0/24"} value={keyDraft.allowedIps} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setKeyDraft((current) => ({ ...current, allowedIps: event.target.value }))} />
                    </Field>
                </div>
            </Modal>
            <Modal
                title="API 密钥已创建"
                open={Boolean(rawKey)}
                centered
                width="min(520px, calc(100vw - 32px))"
                onCancel={() => setRawKey("")}
                footer={
                    <Button type="primary" onClick={() => setRawKey("")}>
                        确定
                    </Button>
                }
            >
                <Alert type="info" showIcon message="API 密钥已创建并安全加密存储" description="你可以立即复制；后续也可以随时在下方 API 密钥列表中点击眼睛图标查看明文或一键复制。" />
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <code className="min-w-0 flex-1 break-all text-xs">{rawKey}</code>
                    <Button icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard.writeText(rawKey).then(() => message.success("密钥已复制"))}>
                        复制
                    </Button>
                </div>
            </Modal>
            <GeminiVidsRequestLogDrawer log={selectedLog} onClose={() => setSelectedLog(null)} />
        </div>
    );
}

function GeminiVidsRequestLogs({
    page,
    loading,
    keyword,
    status,
    source,
    model,
    accountId,
    models,
    accounts,
    onKeywordChange,
    onSearch,
    onStatusChange,
    onSourceChange,
    onModelChange,
    onAccountChange,
    onPageChange,
    onRefresh,
    onClear,
    onSelect,
}: {
    page: GeminiVidsLogPage | null;
    loading: boolean;
    keyword: string;
    status: "" | "success" | "failed";
    source: "" | "runtime" | "admin-test" | "external";
    model: string;
    accountId: string;
    models: { id: string; name: string }[];
    accounts: GeminiVidsAccount[];
    onKeywordChange: (value: string) => void;
    onSearch: () => void;
    onStatusChange: (value: "" | "success" | "failed") => void;
    onSourceChange: (value: "" | "runtime" | "admin-test" | "external") => void;
    onModelChange: (value: string) => void;
    onAccountChange: (value: string) => void;
    onPageChange: (page: number) => void;
    onRefresh: () => void;
    onClear: () => Promise<void>;
    onSelect: (log: GeminiVidsRequestLog) => void;
}) {
    const stats = page?.stats || { total: 0, success: 0, failed: 0, averageDurationMs: 0 };
    const modelOptions = useMemo(() => {
        const set = new Set<string>();
        models.forEach((item) => set.add(item.id));
        page?.logs.forEach((item) => {
            if (item.model) set.add(item.model);
        });
        return [{ value: "", label: "全部模型" }, ...Array.from(set).map((value) => ({ value, label: value }))];
    }, [models, page?.logs]);
    const accountOptions = useMemo(() => {
        const map = new Map<string, string>();
        accounts.forEach((account) => map.set(account.id, account.email || account.name || account.id));
        page?.logs.forEach((item) => {
            if (item.accountId) map.set(item.accountId, item.accountEmail || item.accountId);
        });
        return [{ value: "", label: "全部账号" }, ...Array.from(map.entries()).map(([value, label]) => ({ value, label }))];
    }, [accounts, page?.logs]);

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
                    description="记录站内真实调用与后台模型实测；Cookie、Token 和媒体二进制不会写入日志。"
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
                <div className="grid gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-[minmax(0,1.4fr)_120px_130px_140px_140px_auto] sm:p-4">
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
                        value={source}
                        onChange={onSourceChange}
                        options={[
                            { value: "", label: "全部来源" },
                            { value: "external", label: "外部 API" },
                            { value: "runtime", label: "站内调用" },
                            { value: "admin-test", label: "后台实测" },
                        ]}
                    />
                    <Select value={model} onChange={onModelChange} options={modelOptions} showSearch placeholder="筛选模型" />
                    <Select value={accountId} onChange={onAccountChange} options={accountOptions} showSearch placeholder="筛选账号" />
                    <Button type="primary" onClick={onSearch}>
                        查询
                    </Button>
                </div>
                <div aria-busy={loading} className="min-h-52 divide-y divide-zinc-200 dark:divide-zinc-800">
                    {page?.logs.length ? (
                        page.logs.map((log) => <GeminiVidsRequestLogRow key={log.id} log={log} onClick={() => onSelect(log)} />)
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

function buildCurlCommand(log: GeminiVidsRequestLog): string {
    const url = log.path.startsWith("http") ? log.path : `${typeof window !== "undefined" ? window.location.origin : ""}${log.path.startsWith("/") ? "" : "/"}${log.path}`;
    const lines = [`curl -X ${log.method || "POST"} "${url}"`];
    if (log.requestPreview) lines.push(`  -H "Content-Type: application/json"`, `  --data-raw '${log.requestPreview.replace(/'/g, "'\\''")}'`);
    return lines.join(" \\\n");
}

function GeminiVidsRequestLogRow({ log, onClick }: { log: GeminiVidsRequestLog; onClick: () => void }) {
    const phase = log.phase || (log.statusCode && log.statusCode < 400 ? "success" : "failed");
    const pending = phase === "queued" || phase === "upstream";
    const success = phase === "success";
    return (
        <button
            type="button"
            className="grid w-full min-w-0 gap-3 px-3 py-3 text-left transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 dark:hover:bg-zinc-900/70 sm:grid-cols-[130px_minmax(0,1fr)_minmax(160px,0.55fr)_100px_24px] sm:items-center sm:px-4"
            onClick={onClick}
        >
            <div className="flex flex-wrap items-center gap-1.5">
                <Tag color={pending ? "processing" : success ? "success" : "error"} className="m-0">
                    {pending ? (phase === "queued" ? "排队中" : "执行中") : success ? "成功" : "失败"}
                </Tag>
                <Tag color={geminiVidsSourceTagColor(log.source)} className="m-0 text-[11px]">
                    {geminiVidsSourceLabel(log.source)}
                </Tag>
                {!pending && log.statusCode ? <span className="text-xs text-zinc-500">{log.statusCode}</span> : null}
            </div>
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{log.method || "POST"}</span>
                    <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={log.model}>
                        {log.model || "google-vids-omni"}
                    </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="max-w-full truncate" title={log.promptPreview}>
                        {log.promptPreview || log.path}
                    </span>
                </div>
            </div>
            <div className="min-w-0 text-xs text-zinc-500 dark:text-zinc-400">
                <div className="truncate" title={log.accountEmail}>
                    {log.accountEmail || "未识别实际账号"}
                </div>
                <div className="mt-0.5 truncate">{formatDate(log.time)}</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatDuration(log.durationMs || 0)}</div>
            <ChevronRight className="hidden size-4 text-zinc-400 sm:block" aria-hidden="true" />
        </button>
    );
}

function GeminiVidsRequestLogDrawer({ log, onClose }: { log: GeminiVidsRequestLog | null; onClose: () => void }) {
    const { message } = App.useApp();
    const copyText = (content: string | undefined, successTip: string) => {
        if (!content) return;
        void navigator.clipboard.writeText(content).then(() => {
            message.success(successTip);
        });
    };

    return (
        <Drawer
            title="请求详情"
            open={Boolean(log)}
            onClose={onClose}
            width={640}
            style={{ maxWidth: "100vw" }}
            styles={{ body: { padding: 20 } }}
            extra={
                log ? (
                    <Space size="small">
                        <Tag className="m-0 font-mono text-xs uppercase">{log.method || "POST"}</Tag>
                        <Tag color={!log.statusCode ? "processing" : log.statusCode < 400 ? "success" : "error"}>{!log.statusCode ? "执行中" : log.statusCode < 400 ? "成功" : "失败"} · {log.statusCode || 0}</Tag>
                    </Space>
                ) : null
            }
        >
            {log ? (
                <div className="space-y-6">
                    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
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

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <Clock className="size-3.5 text-zinc-400" />
                                <span>耗时</span>
                            </div>
                            <div className="mt-1 font-mono text-base font-semibold text-zinc-900 dark:text-zinc-100">{formatDuration(log.durationMs || 0)}</div>
                        </div>
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <BarChart3 className="size-3.5 text-zinc-400" />
                                <span>状态码</span>
                            </div>
                            <div className="mt-1 font-mono text-base font-semibold text-zinc-900 dark:text-zinc-100">{log.statusCode || "—"}</div>
                        </div>
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <CircleUserRound className="size-3.5 text-zinc-400" />
                                <span>Google 账号</span>
                            </div>
                            <div className="mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100" title={log.accountEmail || "未识别"}>
                                {log.accountEmail || "未识别实际账号"}
                            </div>
                        </div>
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <Network className="size-3.5 text-zinc-400" />
                                <span>调用来源</span>
                            </div>
                            <div className="mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{geminiVidsSourceLabel(log.source)}</div>
                        </div>
                    </div>

                    <section>
                        <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">请求基本信息</h3>
                        <div className="grid gap-x-4 gap-y-3 rounded-lg border border-zinc-200 p-3.5 text-sm dark:border-zinc-800 sm:grid-cols-2">
                            <DetailItem label="模型 ID" value={log.model || "google-vids-omni"} />
                            <DetailItem label="实际账号" value={log.accountEmail || "未识别实际账号"} />
                            <DetailItem label="调用来源" value={geminiVidsSourceLabel(log.source)} />
                            <DetailItem label="耗时" value={formatDuration(log.durationMs || 0)} />
                            <DetailItem label="请求时间" value={formatDateWithMs(log.time)} />
                            <DetailItem label="请求路径" value={`${log.method || "POST"} ${log.path}`} />
                            {log.clientIp ? <DetailItem label="客户端 IP" value={log.clientIp} /> : null}
                            {log.userAgent ? <DetailItem label="User-Agent" value={log.userAgent} /> : null}
                        </div>
                    </section>

                    {log.promptPreview ? <LogPreview title="用户提示词" content={log.promptPreview} /> : null}
                    {log.requestPreview ? <LogPreview title="请求摘要" content={log.requestPreview} /> : null}
                    {log.responsePreview ? <LogPreview title="响应摘要" content={log.responsePreview} /> : null}
                    {log.error ? <LogPreview title="错误信息" content={log.error} danger /> : null}
                    <Alert type="info" showIcon message="日志已自动脱敏" description="授权 Cookie、Token、API Key、参考图与视频二进制内容不会写入请求日志。" />
                </div>
            ) : null}
        </Drawer>
    );
}

function formatDateWithMs(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const timeStr = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(date);
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${timeStr}.${ms}`;
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
    const color = status === "invalid" ? "error" : status === "active" ? "success" : undefined;
    return (
        <Tag color={color} className="m-0">
            {status === "active" ? "可用" : status === "invalid" ? "失效" : status || "未知"}
        </Tag>
    );
}

function GeminiVidsTabLabel({ label, compact }: { label: string; compact: string }) {
    return (
        <span aria-label={label} className="inline-flex min-w-0 items-center justify-center gap-1.5">
            <span className="sm:hidden">{compact}</span>
            <span className="hidden sm:inline">{label}</span>
        </span>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
            {children}
        </label>
    );
}

function geminiVidsSourceLabel(source: GeminiVidsRequestLog["source"]) {
    return source === "external" ? "外部 API" : source === "admin-test" ? "后台实测" : "站内调用";
}

function geminiVidsSourceTagColor(source: GeminiVidsRequestLog["source"]) {
    return source === "external" ? "orange" : source === "admin-test" ? "purple" : "blue";
}

function GeminiVidsKeyRow({ apiKey, busy, onToggle, onDelete }: { apiKey: GeminiVidsKey; busy: boolean; onToggle: (enabled: boolean) => void; onDelete: () => void }) {
    const { message } = App.useApp();
    const [revealed, setRevealed] = useState(false);

    const copyKey = () => {
        void navigator.clipboard.writeText(apiKey.key || apiKey.prefix).then(() => {
            message.success("API 密钥已复制");
        });
    };

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all text-sm font-medium text-zinc-950 dark:text-zinc-100">{apiKey.name}</span>
                    {revealed ? (
                        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-800 break-all dark:bg-zinc-800 dark:text-zinc-200">
                            {apiKey.key || `${apiKey.prefix}…`}
                        </code>
                    ) : (
                        <Tag className="m-0 font-mono text-[11px]">{apiKey.prefix}…</Tag>
                    )}
                    <Button
                        size="small"
                        type="text"
                        className="px-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                        icon={revealed ? <ShieldCheck className="size-3.5" /> : <KeyRound className="size-3.5" />}
                        onClick={() => setRevealed(!revealed)}
                        title={revealed ? "隐藏明文" : "查看明文"}
                    />
                    <Button size="small" type="text" className="px-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" icon={<Copy className="size-3.5" />} onClick={copyKey} title="复制密钥" />
                </div>
                <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    请求 {apiKey.requestCount} · {apiKey.expiresAt ? `到期 ${formatDate(apiKey.expiresAt)}` : "长期有效"}
                    {apiKey.allowedIps.length ? ` · ${apiKey.allowedIps.length} 条 IP 规则` : ""}
                </div>
            </div>
            <Space wrap size={6}>
                <Switch size="small" aria-label={"启用密钥 " + apiKey.name} checked={apiKey.status === "active"} loading={busy} onChange={onToggle} />
                <Popconfirm title="删除该 API 密钥？" okText="删除" cancelText="取消" onConfirm={onDelete}>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={busy}>
                        删除
                    </Button>
                </Popconfirm>
            </Space>
        </div>
    );
}

type GeminiVidsCookieImportValues = { name?: string; email?: string; cookies: string };

function GeminiVidsCookieImportModal({ open, onClose, onCompleted }: { open: boolean; onClose: () => void; onCompleted: () => Promise<void> }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<GeminiVidsCookieImportValues>();
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
                onFinish={async (values: GeminiVidsCookieImportValues) => {
                    setSubmitting(true);
                    try {
                        await api("/accounts", { method: "POST", body: JSON.stringify({ cookies: values.cookies, name: values.name?.trim() || undefined, email: values.email?.trim() || undefined }) });
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
                    message="推荐优先使用「从 GeminiAIStudio 导入」"
                    description="Cookie 仅通过本次请求安全传给 GeminiVids Provider，按受限权限存储；页面、审计与后续列表均不会回显，也不会写入渠道配置。提交后文本框会清空。"
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
                    <Input.TextArea autoComplete="off" rows={8} placeholder="粘贴 Cookie 内容（需包含 .google.com 域的 SID/SAPISID）；不要在聊天、日志或截图中暴露。" />
                </Form.Item>
            </Form>
        </Modal>
    );
}

function GeminiVidsRenameModal({ account, onClose, onSave }: { account: GeminiVidsAccount | null; onClose: () => void; onSave: (name: string) => Promise<void> }) {
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

function GeminiVidsModelTestDialog({ healthy, open, onClose }: { healthy: boolean; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [prompt, setPrompt] = useState("A cinematic drone shot flying over turquoise ocean waves at golden hour");
    const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
    const [resolution, setResolution] = useState<"720p" | "1080p">("720p");
    const [durationSeconds, setDurationSeconds] = useState(5);
    const [imageDataUrl, setImageDataUrl] = useState("");
    const [imageName, setImageName] = useState("");
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<GeminiVidsTestTask | null>(null);
    const [requestError, setRequestError] = useState("");
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (open) return;
        setResult(null);
        setRequestError("");
        setImageDataUrl("");
        setImageName("");
        setRunning(false);
    }, [open]);

    useEffect(() => {
        if (!result || (result.status !== "processing" && result.status !== "pending")) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            return;
        }
        pollRef.current = setInterval(async () => {
            try {
                const next = await api<GeminiVidsTestTask>(`/test?taskId=${encodeURIComponent(result.id)}`);
                setResult(next);
                if (next.status !== "processing" && next.status !== "pending" && pollRef.current) {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    if (next.status === "succeeded") message.success("测试视频生成成功");
                    else message.error(next.error || "测试视频生成失败");
                }
            } catch {
                /* keep polling */
            }
        }, 6000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
        };
    }, [result, message]);

    const submit = async () => {
        if (!prompt.trim()) return;
        setRunning(true);
        setRequestError("");
        setResult(null);
        try {
            const task = await api<GeminiVidsTestTask>("/test", {
                method: "POST",
                body: JSON.stringify({ prompt: prompt.trim(), aspectRatio, resolution, durationSeconds, ...(imageDataUrl ? { imageDataUrl } : {}) }),
            });
            setResult(task);
            message.info("测试任务已提交，纯协议生成约需 30-120 秒");
        } catch (error) {
            const text = error instanceof Error ? error.message : "模型实测请求失败";
            setRequestError(text);
            message.error(text);
        } finally {
            setRunning(false);
        }
    };

    return (
        <Modal
            title="GeminiVids 模型实测"
            open={open}
            onCancel={() => {
                if (!running) onClose();
            }}
            footer={null}
            closable={!running}
            keyboard={!running}
            mask={{ closable: !running }}
            destroyOnHidden
            centered
            width={760}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            styles={{ body: { maxHeight: "calc(100dvh - 150px)", overflowY: "auto" } }}
        >
            <div className="space-y-4 py-1">
                <Alert type="info" showIcon message="每次只发起一次真实纯协议请求" description="不会批量探测、不会写入测试历史。结果仅保留在当前对话框，关闭后即清空。" />
                {!healthy ? <Alert type="warning" showIcon message="Sidecar 未连接" description="请先恢复 GeminiVids Provider 再进行模型实测。" /> : null}
                <div className="grid gap-3 sm:grid-cols-[110px_110px_110px]">
                    <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        画面比例
                        <Select
                            className="mt-1.5 w-full"
                            value={aspectRatio}
                            onChange={setAspectRatio}
                            disabled={running}
                            options={[
                                { value: "16:9", label: "横屏 16:9" },
                                { value: "9:16", label: "竖屏 9:16" },
                            ]}
                        />
                    </label>
                    <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        分辨率
                        <Select
                            className="mt-1.5 w-full"
                            value={resolution}
                            onChange={setResolution}
                            disabled={running}
                            options={[
                                { value: "720p", label: "720p" },
                                { value: "1080p", label: "1080p" },
                            ]}
                        />
                    </label>
                    <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        时长
                        <Select className="mt-1.5 w-full" value={durationSeconds} onChange={setDurationSeconds} disabled={running} options={[4, 5, 6, 7, 8, 9, 10].map((value) => ({ value, label: `${value} 秒` }))} />
                    </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Upload
                        accept="image/png,image/jpeg"
                        maxCount={1}
                        showUploadList={false}
                        beforeUpload={(file) => {
                            if (file.size > 8 * 1024 * 1024) {
                                message.error("参考图不能超过 8MB");
                                return Upload.LIST_IGNORE;
                            }
                            const reader = new FileReader();
                            reader.onload = () => {
                                setImageDataUrl(String(reader.result || ""));
                                setImageName(file.name);
                            };
                            reader.readAsDataURL(file);
                            return false;
                        }}
                    >
                        <Button icon={<UploadIcon className="size-4" />} disabled={running}>
                            {imageDataUrl ? "更换参考图" : "添加参考图（可选）"}
                        </Button>
                    </Upload>
                    {imageDataUrl ? (
                        <>
                            <img src={imageDataUrl} alt="参考图预览" className="h-10 w-10 rounded border border-zinc-200 object-cover dark:border-zinc-700" />
                            <span className="max-w-40 truncate text-xs text-zinc-500 dark:text-zinc-400">{imageName}</span>
                            <Button
                                size="small"
                                type="text"
                                icon={<Trash2 className="size-3.5" />}
                                onClick={() => {
                                    setImageDataUrl("");
                                    setImageName("");
                                }}
                            />
                        </>
                    ) : null}
                </div>
                <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    测试提示词
                    <Input.TextArea
                        className="mt-1.5"
                        value={prompt}
                        autoSize={{ minRows: 4, maxRows: 8 }}
                        placeholder="描述要生成的视频，例如：a paper crane flying over tokyo skyline（英文效果最佳）"
                        disabled={running}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)}
                    />
                </label>
                {requestError ? <Alert type="error" showIcon message="实测请求未完成" description={requestError} /> : null}
                {result ? <GeminiVidsTestResultView result={result} /> : null}
                <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <Button onClick={onClose} disabled={running}>
                        关闭
                    </Button>
                    <Button type="primary" icon={<Play className="size-4" />} loading={running} disabled={!healthy || !prompt.trim()} onClick={() => void submit()}>
                        开始实测
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function GeminiVidsTestResultView({ result }: { result: GeminiVidsTestTask }) {
    const pending = result.status === "processing" || result.status === "pending";
    return (
        <section className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusTag status={result.status} />
                    {result.width ? (
                        <span className="text-zinc-600 dark:text-zinc-300">
                            {result.width}×{result.height} · {result.duration} 秒
                        </span>
                    ) : null}
                    {result.reference_images ? (
                        <Tag className="m-0" color="purple">
                            参考图 {result.reference_images} 张
                        </Tag>
                    ) : null}
                </div>
            </div>
            <div className="space-y-3 p-3">
                {result.error ? <Alert type="error" showIcon message="上游未完成本次实测" description={result.error} /> : null}
                {result.status === "succeeded" && result.video_url ? (
                    <video className="h-auto w-full rounded-md border border-zinc-200 bg-black dark:border-zinc-800" controls preload="metadata" src={`/api/admin/geminivids/test?taskId=${encodeURIComponent(result.id)}&media=1`}>
                        当前浏览器无法播放本次视频结果。
                    </video>
                ) : null}
                {pending ? <div className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">纯协议生成中，通常需要 30-120 秒；对话框会自动跟随任务状态。</div> : null}
            </div>
        </section>
    );
}

function StatusTag({ status }: { status?: string }) {
    const color = status === "succeeded" || status === "success" ? "success" : status === "failed" || status === "error" ? "error" : "processing";
    const label = status === "succeeded" || status === "success" ? "已完成" : status === "failed" || status === "error" ? "失败" : status === "processing" ? "生成中" : status || "未知";
    return (
        <Tag color={color} className="m-0">
            {label}
        </Tag>
    );
}

function SectionLoading() {
    return <div className="flex min-h-28 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">正在读取 GeminiVids 配置...</div>;
}

function formatDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}
