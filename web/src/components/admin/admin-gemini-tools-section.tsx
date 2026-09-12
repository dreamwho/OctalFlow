"use client";

import { LogDetailResizeHandle, useResizableDrawerWidth } from "@/hooks/use-resizable-drawer";
import { Alert, App, Button, Checkbox, Drawer, Empty, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Switch, Tabs, Tag } from "antd";
import type { CheckboxChangeEvent } from "antd";
import { BarChart3, Check, ChevronRight, CircleUserRound, Clock, Copy, KeyRound, Network, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getAdminSettings } from "@/services/api/admin-settings";
import {
    clearGeminiToolsLogs,
    createGeminiToolsApiKey,
    deleteGeminiToolsAccount,
    deleteGeminiToolsApiKey,
    getGeminiToolsLogs,
    getGeminiToolsOverview,
    refreshAllGeminiToolsAccounts,
    refreshGeminiToolsAccount,
    saveGeminiToolsGateway,
    saveGeminiToolsModels,
    startGeminiToolsOAuth,
    syncGeminiToolsModels,
    testGeminiToolsText,
    updateGeminiToolsAccount,
    updateGeminiToolsApiKey,
    type GeminiToolsAccount,
    type GeminiToolsApiKey,
    type GeminiToolsGateway,
    type GeminiToolsLog,
    type GeminiToolsOverview,
    type GeminiToolsQuota,
} from "@/services/api/gemini-tools";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { MagicProxyBindingCard } from "./magic-proxy-binding-card";

type KeyDraft = { name: string; expiresAt: string; allowedIps: string };
type AccountDraft = { name: string; note: string; priority: number };
type GeminiToolsTab = "overview" | "gateway" | "magic-proxy" | "logs";

export function AdminGeminiToolsSection({ controller }: { controller: AdminDashboardController }) {
    const { message } = App.useApp();
    const [state, setState] = useState<GeminiToolsOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [action, setAction] = useState("");
    const [selectedModels, setSelectedModels] = useState<string[]>([]);
    const [gateway, setGateway] = useState<GeminiToolsGateway>({ enabled: true, strategy: "round_robin", sessionStickiness: false });
    const [testOpen, setTestOpen] = useState(false);
    const [testModel, setTestModel] = useState("");
    const [testPrompt, setTestPrompt] = useState("请用一句中文说明当前模型已通过 GeminiTools 真实调用。");
    const [testResult, setTestResult] = useState("");
    const [keyOpen, setKeyOpen] = useState(false);
    const [keyDraft, setKeyDraft] = useState<KeyDraft>({ name: "外部调用密钥", expiresAt: "", allowedIps: "" });
    const [rawKey, setRawKey] = useState("");
    const [editingAccount, setEditingAccount] = useState<GeminiToolsAccount | null>(null);
    const [accountDraft, setAccountDraft] = useState<AccountDraft>({ name: "", note: "", priority: 0 });
    const [activeTab, setActiveTab] = useState<GeminiToolsTab>("overview");
    const [logs, setLogs] = useState<GeminiToolsLog[]>([]);
    const [logKeyword, setLogKeyword] = useState("");
    const [logStatus, setLogStatus] = useState<"" | "success" | "failed">("");
    const [logProtocol, setLogProtocol] = useState<"" | "openai" | "gemini" | "anthropic">("");
    const [logModel, setLogModel] = useState<string>("");
    const [logAccountId, setLogAccountId] = useState<string>("");
    const [selectedLog, setSelectedLog] = useState<GeminiToolsLog | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const data = await getGeminiToolsOverview();
            setState(data);
            setSelectedModels(data.models.filter((model) => model.enabled).map((model) => model.id));
            setGateway(data.gateway);
            const availableModels = data.models.filter((model) => model.available);
            setTestModel((current) => (availableModels.some((model) => model.id === current) ? current : availableModels.find((model) => model.enabled)?.id || availableModels[0]?.id || ""));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "读取 GeminiTools 状态失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        const onOAuth = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.data?.type !== "octalflow-gemini-tools-oauth") return;
            if (event.data.ok) {
                message.success(event.data.message || "Google 账号授权成功");
                void load();
            } else message.error(event.data.message || "Google 账号授权失败");
        };
        window.addEventListener("message", onOAuth);
        return () => window.removeEventListener("message", onOAuth);
    }, [load, message]);

    const run = async (name: string, work: () => Promise<unknown>, success: string, reload = true) => {
        setAction(name);
        try {
            await work();
            if (reload) await load();
            message.success(success);
        } catch (runError) {
            message.error(runError instanceof Error ? runError.message : "操作失败");
        } finally {
            setAction("");
        }
    };

    const openOAuth = async () => {
        setAction("oauth");
        try {
            const { authUrl } = await startGeminiToolsOAuth();
            const width = 560;
            const height = 720;
            const popup = window.open(
                authUrl,
                `octalflow-gemini-tools-${Date.now()}`,
                `popup=yes,width=${width},height=${height},left=${Math.max(0, window.screenX + (window.outerWidth - width) / 2)},top=${Math.max(0, window.screenY + (window.outerHeight - height) / 2)}`,
            );
            if (!popup) throw new Error("浏览器拦截了 Google 授权窗口，请允许本站弹出窗口后重试");
            popup.focus();
        } catch (oauthError) {
            message.error(oauthError instanceof Error ? oauthError.message : "发起 Google 授权失败");
        } finally {
            setAction("");
        }
    };

    const loadLogs = async () => {
        setAction("logs");
        try {
            const data = await getGeminiToolsLogs({
                keyword: logKeyword,
                status: logStatus || undefined,
                protocol: logProtocol || undefined,
                model: logModel || undefined,
                accountId: logAccountId || undefined,
                pageSize: 50,
            });
            setLogs(data.items);
        } catch (logError) {
            message.error(logError instanceof Error ? logError.message : "读取请求日志失败");
        } finally {
            setAction("");
        }
    };

    const saveModels = async () => {
        await saveGeminiToolsModels(selectedModels);
        const latest = await getAdminSettings();
        controller.setSettings((current) => ({
            ...current,
            systemChannels: latest.systemChannels,
            logicalModels: latest.logicalModels,
            defaultModels: latest.defaultModels,
        }));
    };

    const syncLatestModels = async (enableNewModels: boolean) => {
        setAction("sync-models");
        try {
            const data = await syncGeminiToolsModels({ enableNewModels });
            if (data.enabledNewModelIds.length) {
                const latest = await getAdminSettings();
                controller.setSettings((current) => ({
                    ...current,
                    systemChannels: latest.systemChannels,
                    logicalModels: latest.logicalModels,
                    defaultModels: latest.defaultModels,
                }));
            }
            await load();
            message.success(`模型目录已获取：${data.discoveredModels.length} 个可用模型，本次发现 ${data.newModels.length} 个${data.enabledNewModelIds.length ? `，已启用 ${data.enabledNewModelIds.length} 个新模型` : "，当前渠道选择未改动"}`);
            const failed = data.accountResults.filter((item) => !item.ok).length;
            if (failed) message.warning(`${failed} 个账号刷新失败，已保留原有渠道选择和可用目录。`);
        } catch (syncError) {
            message.error(syncError instanceof Error ? syncError.message : "获取 GeminiTools 最新模型失败");
        } finally {
            setAction("");
        }
    };

    const enabledAccounts = state?.accounts.filter((account) => account.status === "active" && account.proxyEnabled).length || 0;
    const availableModels = useMemo(() => (state?.models || []).filter((model) => model.available), [state?.models]);
    const modelOptions = useMemo(() => availableModels.map((model) => ({ label: model.name || model.id, value: model.id })), [availableModels]);
    const accountOptions = useMemo(() => {
        return (state?.accounts || []).map((account) => ({
            label: account.email ? `${account.name} (${account.email})` : account.name,
            value: account.id,
        }));
    }, [state?.accounts]);

    return (
        <div className="space-y-4">
            {error ? (
                <Alert
                    type="error"
                    showIcon
                    message="GeminiTools 配置读取失败"
                    description={error}
                    action={
                        <Button size="small" onClick={() => void load()}>
                            重试
                        </Button>
                    }
                />
            ) : null}

            <Tabs
                className="max-sm:[&_.ant-tabs-nav-list]:w-full max-sm:[&_.ant-tabs-tab]:!m-0 max-sm:[&_.ant-tabs-tab]:min-w-0 max-sm:[&_.ant-tabs-tab]:flex-1 max-sm:[&_.ant-tabs-tab]:justify-center max-sm:[&_.ant-tabs-tab]:!px-1 max-sm:[&_.ant-tabs-tab-btn]:text-xs"
                activeKey={activeTab}
                tabBarGutter={16}
                onChange={(key) => {
                    const next = key as GeminiToolsTab;
                    setActiveTab(next);
                    if (next === "logs") void loadLogs();
                }}
                items={[
                    { key: "overview", label: <GeminiToolsTabLabel label="账号与渠道" compact="账号" /> },
                    { key: "gateway", label: <GeminiToolsTabLabel label="反代网关与 API 密钥" compact="网关与密钥" /> },
                    { key: "magic-proxy", label: <GeminiToolsTabLabel label="代理管理" compact="代理" /> },
                    {
                        key: "logs",
                        label: <GeminiToolsTabLabel label="请求日志" compact="日志" />,
                    },
                ]}
            />

            <div data-gemini-tools-tab-panel="overview" className={activeTab === "overview" ? "space-y-4" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="GeminiTools"
                        description="使用当前浏览器的 Google 登录会话完成标准 OAuth；账号、额度与模型渠道均由当前项目管理，不依赖独立 Provider。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                                    刷新状态
                                </Button>
                                <Button type="primary" icon={<Play className="size-4" />} disabled={!availableModels.length} onClick={() => setTestOpen(true)}>
                                    文本实测
                                </Button>
                            </Space>
                        }
                    />
                    <div className="grid gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-800">
                        <Metric label="服务状态" value={state?.healthy ? "正常" : "待授权"} detail="已内置 Antigravity OAuth 客户端" ok={Boolean(state?.healthy)} />
                        <Metric label="可用账号" value={String(enabledAccounts)} detail={`共 ${state?.accounts.length || 0} 个授权账号`} />
                        <Metric label="文本模型" value={String(availableModels.length)} detail="仅建立文本能力渠道" />
                    </div>
                    <div className="p-3 sm:p-5">
                        <Alert
                            type="info"
                            showIcon
                            message="授权会在当前浏览器普通 Google 弹窗中完成"
                            description="已使用参考项目内置的 Antigravity Enterprise OAuth 客户端；不会打开隔离浏览器，也不会读取 Chrome Cookie。每次添加账号都会创建新的授权状态并显示 Google 账号选择。"
                        />
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader
                        title="账号管理与额度"
                        description="Token 加密保存且不回显；每个账号只展示最近活跃的 3 个模型额度。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<RefreshCw className="size-4" />} loading={action === "refresh-all"} disabled={!state?.accounts.length} onClick={() => void run("refresh-all", refreshAllGeminiToolsAccounts, "全部账号额度已刷新")}>
                                    刷新全部额度
                                </Button>
                                <Button type="primary" icon={<ShieldCheck className="size-4" />} loading={action === "oauth"} onClick={() => void openOAuth()}>
                                    添加授权
                                </Button>
                            </Space>
                        }
                    />
                    {!state?.accounts.length ? (
                        <div className="p-6">
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未授权 Google 账号" />
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                            {state.accounts.map((account) => (
                                <AccountRow
                                    key={account.id}
                                    account={account}
                                    activeModelIds={(state.logs.items || []).filter((log) => log.accountId === account.id || (log.accountEmail && log.accountEmail === account.email)).map((log) => log.model)}
                                    busy={action === account.id}
                                    onRefresh={() => void run(account.id, () => refreshGeminiToolsAccount(account.id), "账号额度已刷新")}
                                    onToggle={(checked: boolean) => void run(account.id, () => updateGeminiToolsAccount(account.id, { proxyEnabled: checked, status: checked ? "active" : "disabled" }), checked ? "账号已启用" : "账号已停用")}
                                    onEdit={() => {
                                        setEditingAccount(account);
                                        setAccountDraft({ name: account.name, note: account.note || "", priority: account.priority });
                                    }}
                                    onDelete={() => void run(account.id, () => deleteGeminiToolsAccount(account.id), "Google 账号已删除")}
                                />
                            ))}
                        </div>
                    )}
                </Panel>

                <Panel>
                    <PanelHeader
                        title="Gemini Antigravity Tools 模型渠道"
                        description="模型目录从已授权账号实时汇总；获取最新模型默认不改动渠道，只有明确选择时才会启用本次新发现的真实模型。"
                        actions={
                            <Space wrap size={6}>
                                <Button icon={<RefreshCw className="size-4" />} loading={action === "sync-models"} disabled={!state?.accounts.length} onClick={() => void syncLatestModels(false)}>
                                    获取最新模型
                                </Button>
                                <Popconfirm title="获取并启用本次新发现的模型？" description="只会追加上游本次真实返回、此前目录中没有的模型，不会移除当前选择。" okText="获取并启用" cancelText="取消" onConfirm={() => void syncLatestModels(true)}>
                                    <Button loading={action === "sync-models"} disabled={!state?.accounts.length}>
                                        获取并启用新模型
                                    </Button>
                                </Popconfirm>
                                <Button type="primary" icon={<Check className="size-4" />} loading={action === "models"} disabled={!state?.models.length} onClick={() => void run("models", saveModels, "模型渠道已保存并同步到模型渠道与逻辑模型")}>
                                    保存模型
                                </Button>
                            </Space>
                        }
                    />
                    <div className="max-h-[430px] space-y-2 overflow-y-auto p-3 sm:p-4">
                        {state?.models.length ? (
                            state.models.map((model) => (
                                <label key={model.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                                    <Checkbox
                                        checked={selectedModels.includes(model.id)}
                                        onChange={(event: CheckboxChangeEvent) => setSelectedModels((current) => (event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id)))}
                                    />
                                    <span className="min-w-0">
                                        <span className="flex min-w-0 items-center gap-1.5">
                                            <span className="min-w-0 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{model.name}</span>
                                            {!model.available ? <Tag color="gold">上游当前未返回</Tag> : null}
                                        </span>
                                        <span className="block truncate font-mono text-xs text-zinc-500">{model.id}</span>
                                    </span>
                                </label>
                            ))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="授权并刷新账号后读取真实模型目录" />
                        )}
                    </div>
                </Panel>
            </div>

            <div data-gemini-tools-tab-panel="gateway" className={activeTab === "gateway" ? "grid gap-4 xl:grid-cols-2" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="反代与网关"
                        description="站内渠道由逻辑模型路由；外部兼容 OpenAI Chat 和 Anthropic Messages。"
                        actions={
                            <Button type="primary" loading={action === "gateway"} onClick={() => void run("gateway", () => saveGeminiToolsGateway(gateway), "网关设置已保存")}>
                                保存网关
                            </Button>
                        }
                    />
                    <div className="space-y-4 p-3 sm:p-4">
                        <SettingRow label="启用网关" description="关闭后站内渠道和外部 API 均停止转发">
                            <Switch checked={gateway.enabled} onChange={(checked: boolean) => setGateway((current) => ({ ...current, enabled: checked }))} />
                        </SettingRow>
                        <SettingRow label="账号调度" description="轮询优先使用最久未调用账号；优先级模式按账号优先级选择">
                            <Select
                                className="w-36"
                                value={gateway.strategy}
                                options={[
                                    { value: "round_robin", label: "轮询" },
                                    { value: "priority", label: "优先级" },
                                ]}
                                onChange={(value: "round_robin" | "priority") => setGateway((current) => ({ ...current, strategy: value }))}
                            />
                        </SettingRow>
                        <SettingRow label="会话粘性" description="预留网关会话策略；关闭时每次按当前调度规则选择">
                            <Switch checked={gateway.sessionStickiness} onChange={(checked: boolean) => setGateway((current) => ({ ...current, sessionStickiness: checked }))} />
                        </SettingRow>
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-6 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                            <div>
                                <strong>OpenAI：</strong>
                                <code>/api/gemini-tools/v1/chat/completions</code>
                            </div>
                            <div>
                                <strong>Anthropic：</strong>
                                <code>/api/gemini-tools/v1/messages</code>
                            </div>
                            <div>
                                <strong>模型目录：</strong>
                                <code>/api/gemini-tools/v1/models</code>
                            </div>
                        </div>
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader
                        title="API 密钥"
                        description="密钥以哈希保存，可限制过期时间和调用 IP；明文只显示一次。"
                        actions={
                            <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setKeyOpen(true)}>
                                创建密钥
                            </Button>
                        }
                    />
                    {!state?.apiKeys.length ? (
                        <div className="p-6">
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未创建 API 密钥" />
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                            {state.apiKeys.map((key) => (
                                <KeyRow
                                    key={key.id}
                                    apiKey={key}
                                    busy={action === key.id}
                                    onToggle={(checked: boolean) => void run(key.id, () => updateGeminiToolsApiKey(key.id, { status: checked ? "active" : "disabled" }), checked ? "密钥已启用" : "密钥已停用")}
                                    onDelete={() => void run(key.id, () => deleteGeminiToolsApiKey(key.id), "API 密钥已删除")}
                                />
                            ))}
                        </div>
                    )}
                </Panel>
            </div>

            <div data-gemini-tools-tab-panel="magic-proxy" className={activeTab === "magic-proxy" ? "space-y-4" : "hidden"}>
                <MagicProxyBindingCard provider="geminiTools" />
            </div>

            <div data-gemini-tools-tab-panel="logs" className={activeTab === "logs" ? "space-y-4" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="请求日志"
                        description="记录渠道协议、模型、实际账号、状态、耗时与 Token，不记录完整敏感载荷。"
                        actions={
                            <Space wrap size={6}>
                                <Input
                                    className="w-40"
                                    allowClear
                                    prefix={<Search className="size-3.5 text-zinc-400" />}
                                    value={logKeyword}
                                    placeholder="模型 / 账号 / 错误"
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setLogKeyword(event.target.value)}
                                    onPressEnter={() => void loadLogs()}
                                />
                                <Select
                                    className="w-28"
                                    value={logStatus}
                                    options={[
                                        { value: "", label: "全部状态" },
                                        { value: "success", label: "成功" },
                                        { value: "failed", label: "失败" },
                                    ]}
                                    onChange={(value: "" | "success" | "failed") => setLogStatus(value)}
                                />
                                <Select
                                    className="w-28"
                                    value={logProtocol}
                                    options={[
                                        { value: "", label: "全部协议" },
                                        { value: "openai", label: "OpenAI" },
                                        { value: "gemini", label: "Gemini" },
                                        { value: "anthropic", label: "Anthropic" },
                                    ]}
                                    onChange={(value: "" | "openai" | "gemini" | "anthropic") => setLogProtocol(value)}
                                />
                                <Select
                                    className="w-36"
                                    value={logModel}
                                    allowClear
                                    showSearch
                                    placeholder="全部模型"
                                    options={[{ value: "", label: "全部模型" }, ...modelOptions]}
                                    onChange={(value: string) => setLogModel(value || "")}
                                />
                                <Select
                                    className="w-36"
                                    value={logAccountId}
                                    allowClear
                                    showSearch
                                    placeholder="全部账号"
                                    options={[{ value: "", label: "全部账号" }, ...accountOptions]}
                                    onChange={(value: string) => setLogAccountId(value || "")}
                                />
                                <Button loading={action === "logs"} onClick={() => void loadLogs()}>
                                    查询
                                </Button>
                                <Popconfirm
                                    title="清空全部 GeminiTools 请求日志？"
                                    description="该操作不可撤销，但不会影响账号和渠道配置。"
                                    okText="清空"
                                    cancelText="取消"
                                    onConfirm={() =>
                                        void run(
                                            "clear-logs",
                                            async () => {
                                                await clearGeminiToolsLogs();
                                                setLogs([]);
                                            },
                                            "请求日志已清空",
                                        )
                                    }
                                >
                                    <Button danger icon={<Trash2 className="size-4" />} disabled={!logs.length}>
                                        清空
                                    </Button>
                                </Popconfirm>
                            </Space>
                        }
                    />
                    {!logs.length ? (
                        <div className="p-6">
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无请求日志" />
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                            {logs.map((log) => (
                                <LogRow key={log.id} log={log} onClick={() => setSelectedLog(log)} />
                            ))}
                        </div>
                    )}
                </Panel>
            </div>

            <Modal
                title="编辑 Google 账号"
                open={Boolean(editingAccount)}
                okText="保存"
                cancelText="取消"
                confirmLoading={action === "account-edit"}
                onCancel={() => setEditingAccount(null)}
                onOk={() => editingAccount && void run("account-edit", () => updateGeminiToolsAccount(editingAccount.id, accountDraft), "账号设置已保存").then(() => setEditingAccount(null))}
            >
                <div className="space-y-4 pt-2">
                    <Field label="显示名称">
                        <Input value={accountDraft.name} onChange={(event: ChangeEvent<HTMLInputElement>) => setAccountDraft((current) => ({ ...current, name: event.target.value }))} />
                    </Field>
                    <Field label="优先级">
                        <InputNumber className="w-full" min={0} max={10000} value={accountDraft.priority} onChange={(value: number | null) => setAccountDraft((current) => ({ ...current, priority: value || 0 }))} />
                    </Field>
                    <Field label="备注">
                        <Input.TextArea rows={3} value={accountDraft.note} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setAccountDraft((current) => ({ ...current, note: event.target.value }))} />
                    </Field>
                </div>
            </Modal>

            <Modal title="创建 GeminiTools API 密钥" open={keyOpen} okText="创建" cancelText="取消" confirmLoading={action === "key-create"} onCancel={() => setKeyOpen(false)} onOk={() => void createKey()}>
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
                footer={
                    <Button type="primary" onClick={() => setRawKey("")}>
                        我已安全保存
                    </Button>
                }
                closable={false}
                mask={{ closable: false }}
            >
                <Alert type="warning" showIcon message="明文只显示本次" description="关闭后无法再次查看，只能删除并创建新密钥。" />
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <code className="min-w-0 flex-1 break-all text-xs">{rawKey}</code>
                    <Button icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard.writeText(rawKey).then(() => message.success("密钥已复制"))}>
                        复制
                    </Button>
                </div>
            </Modal>

            <Modal title="GeminiTools 文本模型实测" open={testOpen} okText="真实调用" cancelText="关闭" confirmLoading={action === "test"} onCancel={() => setTestOpen(false)} onOk={() => void runTest()}>
                <div className="space-y-4 pt-2">
                    <Field label="模型">
                        <Select className="w-full" showSearch optionFilterProp="label" value={testModel || undefined} options={modelOptions} onChange={(value: string) => setTestModel(value)} />
                    </Field>
                    <Field label="测试输入">
                        <Input.TextArea rows={4} value={testPrompt} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTestPrompt(event.target.value)} />
                    </Field>
                    {testResult ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">{testResult}</div> : null}
                </div>
            </Modal>

            <GeminiToolsRequestLogDrawer log={selectedLog} onClose={() => setSelectedLog(null)} />
        </div>
    );

    async function createKey() {
        setAction("key-create");
        try {
            const data = await createGeminiToolsApiKey({
                name: keyDraft.name,
                ...(keyDraft.expiresAt ? { expiresAt: new Date(keyDraft.expiresAt).toISOString() } : {}),
                allowedIps: keyDraft.allowedIps
                    .split(/\r?\n|,/)
                    .map((value) => value.trim())
                    .filter(Boolean),
            });
            setRawKey(data.rawKey);
            setKeyOpen(false);
            await load();
        } catch (keyError) {
            message.error(keyError instanceof Error ? keyError.message : "创建 API 密钥失败");
        } finally {
            setAction("");
        }
    }

    async function runTest() {
        setAction("test");
        setTestResult("");
        try {
            const data = await testGeminiToolsText({ model: testModel, prompt: testPrompt });
            setTestResult(data.text);
            await load();
            message.success("真实模型调用成功");
        } catch (testError) {
            message.error(testError instanceof Error ? testError.message : "模型调用失败");
        } finally {
            setAction("");
        }
    }
}

function GeminiToolsTabLabel({ label, compact, icon }: { label: string; compact: string; icon?: ReactNode }) {
    return (
        <span aria-label={label} className="inline-flex min-w-0 items-center justify-center gap-1.5">
            {icon}
            <span className="sm:hidden">{compact}</span>
            <span className="hidden sm:inline">{label}</span>
        </span>
    );
}

function Metric({ label, value, detail, ok }: { label: string; value: string; detail: string; ok?: boolean }) {
    return (
        <div className="bg-white p-4 dark:bg-zinc-950">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className={`mt-1 text-xl font-semibold ${ok ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-950 dark:text-zinc-100"}`}>{value}</div>
            <div className="mt-1 text-xs text-zinc-400">{detail}</div>
        </div>
    );
}

function AccountRow({
    account,
    activeModelIds,
    busy,
    onRefresh,
    onToggle,
    onEdit,
    onDelete,
}: {
    account: GeminiToolsAccount;
    activeModelIds: string[];
    busy: boolean;
    onRefresh: () => void;
    onToggle: (checked: boolean) => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const visibleQuotas = visibleGeminiToolsQuotas(account.quotas, activeModelIds);
    return (
        <div className="p-3 sm:p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
                        {account.picture ? <img src={account.picture} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <CircleUserRound className="size-5" />}
                    </span>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">{account.name}</span>
                            <Tag color={account.status === "active" && account.proxyEnabled ? "green" : "default"}>{account.status === "active" && account.proxyEnabled ? "可用" : "停用"}</Tag>
                            {account.planType ? <Tag>{account.planType}</Tag> : null}
                        </div>
                        <div className="truncate text-xs text-zinc-500">
                            {account.email} · 请求 {account.requestCount} · Token {account.totalTokens.toLocaleString()} · 错误 {account.errorCount}
                        </div>
                    </div>
                </div>
                <Space wrap size={6}>
                    <Switch size="small" checked={account.status === "active" && account.proxyEnabled} loading={busy} onChange={onToggle} />
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={onRefresh}>
                        额度
                    </Button>
                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
                        编辑
                    </Button>
                    <Popconfirm title="删除此 Google 授权账号？" description="加密 Token 与账号配置会一并删除。" onConfirm={onDelete}>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                            删除
                        </Button>
                    </Popconfirm>
                </Space>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {visibleQuotas.length ? (
                    visibleQuotas.map((quota) => (
                        <div key={quota.model} className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                            <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-200" title={quota.model}>
                                    {quota.displayName || quota.model}
                                </span>
                                <span className="shrink-0 text-zinc-500">{quota.remainingPercent === undefined ? "未知" : `${quota.remainingPercent}%`}</span>
                            </div>
                            <Progress className="!mb-0" percent={quota.remainingPercent || 0} size="small" showInfo={false} status={quota.remainingPercent !== undefined && quota.remainingPercent < 10 ? "exception" : "normal"} />
                            <div className="mt-1 truncate text-[11px] text-zinc-400">{quota.resetTime ? `重置 ${formatTime(quota.resetTime)}` : quota.model}</div>
                        </div>
                    ))
                ) : (
                    <div className="text-xs text-zinc-400">暂无额度目录，请刷新账号。</div>
                )}
            </div>
        </div>
    );
}

export function visibleGeminiToolsQuotas(quotas: GeminiToolsQuota[], activeModelIds: string[]) {
    const activity = new Map<string, number>();
    activeModelIds.forEach((model, index) => {
        if (!activity.has(model)) activity.set(model, index);
    });
    return [...quotas]
        .sort((left, right) => {
            const leftActivity = activity.get(left.model);
            const rightActivity = activity.get(right.model);
            if (leftActivity !== undefined || rightActivity !== undefined) return (leftActivity ?? Number.MAX_SAFE_INTEGER) - (rightActivity ?? Number.MAX_SAFE_INTEGER);
            return (right.remainingPercent ?? -1) - (left.remainingPercent ?? -1);
        })
        .slice(0, 3);
}

function KeyRow({ apiKey, busy, onToggle, onDelete }: { apiKey: GeminiToolsApiKey; busy: boolean; onToggle: (checked: boolean) => void; onDelete: () => void }) {
    return (
        <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
                    <KeyRound className="size-4" />
                </span>
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{apiKey.name}</span>
                        <Tag>{apiKey.prefix}…</Tag>
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                        请求 {apiKey.requestCount} · Token {apiKey.totalTokens.toLocaleString()} · {apiKey.expiresAt ? `到期 ${formatTime(apiKey.expiresAt)}` : "长期有效"}
                        {apiKey.allowedIps.length ? ` · ${apiKey.allowedIps.length} 条 IP 规则` : ""}
                    </div>
                </div>
            </div>
            <Space size={6}>
                <Switch size="small" checked={apiKey.status === "active"} loading={busy} onChange={onToggle} />
                <Popconfirm title="删除此 API 密钥？" onConfirm={onDelete}>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                        删除
                    </Button>
                </Popconfirm>
            </Space>
        </div>
    );
}

function buildToolsCurlCommand(log: GeminiToolsLog): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const url = log.path.startsWith("http") ? log.path : `${origin}${log.path.startsWith("/") ? "" : "/"}${log.path}`;
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

function LogRow({ log, onClick }: { log: GeminiToolsLog; onClick: () => void }) {
    const phase = log.phase || (log.statusCode < 400 ? "success" : "failed");
    const pending = phase === "queued" || phase === "running";
    const success = phase === "success";
    const method = log.method || "POST";
    const hasImages = (log.imageRequestedCount || 0) > 0 || (log.imageSucceededCount || 0) > 0;

    return (
        <button
            type="button"
            data-gemini-tools-log-id={log.id}
            aria-label={`查看请求日志：${log.model}`}
            onClick={onClick}
            className="grid w-full gap-2 p-3 text-left text-xs transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 sm:grid-cols-[140px_160px_minmax(0,1fr)_140px_24px] sm:items-center sm:p-4 dark:hover:bg-zinc-900/70"
        >
            <div className="text-zinc-500">{formatTime(log.createdAt)}</div>
            <div className="flex flex-wrap items-center gap-1.5">
                <Tag className="m-0 font-mono text-[10px] uppercase">{method}</Tag>
                <Tag color={pending ? "processing" : success ? "green" : "red"} className="m-0">
                    {pending ? (phase === "queued" ? "排队中" : "执行中") : log.statusCode}
                </Tag>
                {log.proxyEgress ? (
                    <Tag color="geekblue" className="m-0 font-medium">
                        {log.proxyEgress.mode === "magic"
                            ? `魔法·${log.proxyEgress.node_name || "订阅"}`
                            : log.proxyEgress.mode === "chained"
                            ? `链式·${log.proxyEgress.node_name || "节点"}`
                            : `通用·${log.proxyEgress.node_name || "直出"}`}
                    </Tag>
                ) : (
                    <Tag className="m-0 text-zinc-400">直连</Tag>
                )}
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={log.model}>{log.model}</span>
                    <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">{log.protocol}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-zinc-500 dark:text-zinc-400">
                    <span className="truncate">{log.accountEmail || "未分配账号"}</span>
                    {log.proxyEgress?.address ? <span>· 出口: {log.proxyEgress.address}</span> : null}
                    {log.error ? <span className="text-red-500">· {log.error}</span> : null}
                </div>
            </div>
            <div className="text-zinc-500 dark:text-zinc-400">
                <div>{log.durationMs} ms</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                    {hasImages ? (
                        <Tag color="cyan" className="m-0 text-[10px]">
                            {log.imageSucceededCount || 0} 张生图
                        </Tag>
                    ) : log.totalTokens ? (
                        <Tag color="blue" className="m-0 text-[10px]">
                            {log.totalTokens} Tokens
                        </Tag>
                    ) : null}
                </div>
            </div>
            <ChevronRight className="hidden size-4 justify-self-end text-zinc-400 sm:block" aria-hidden="true" />
        </button>
    );
}

function GeminiToolsRequestLogDrawer({ log, onClose }: { log: GeminiToolsLog | null; onClose: () => void }) {
    const { width: drawerWidth, resizing: drawerResizing, onHandlePointerDown } = useResizableDrawerWidth({ defaultWidth: 640, minWidth: 420 });
    const { message: messageApi } = App.useApp();
    const success = log ? log.statusCode < 400 && !log.error : false;
    const pending = log ? log.phase === "queued" || log.phase === "running" : false;

    const copyToClipboard = (text: string | undefined, title: string) => {
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            messageApi.success(`${title}已复制到剪贴板`);
        }).catch(() => {
            messageApi.error("复制失败");
        });
    };

    return (
        <Drawer
            title="请求日志详情"
            open={Boolean(log)}
            onClose={onClose}
            width={drawerWidth}
            styles={{ body: { padding: 20, position: "relative" } }}
            extra={
                log ? (
                    <Space size="small">
                        <Tag className="m-0 font-mono text-xs uppercase">{log.method || "POST"}</Tag>
                        <Tag color={pending ? "processing" : success ? "green" : "red"}>
                            {pending ? (log.phase === "queued" ? "排队中" : "执行中") : success ? "成功" : "失败"} · {log.statusCode || 0}
                        </Tag>
                    </Space>
                ) : null
            }
        >
            <LogDetailResizeHandle resizing={drawerResizing} onPointerDown={onHandlePointerDown} />
            {log ? (
                <div className="space-y-6">
                    {/* Action buttons toolbar */}
                    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
                        <Button
                            size="small"
                            icon={<Copy className="size-3.5" />}
                            onClick={() => copyToClipboard(buildToolsCurlCommand(log), "cURL 命令")}
                        >
                            复制 cURL
                        </Button>
                        {log.requestPreview ? (
                            <Button
                                size="small"
                                icon={<Copy className="size-3.5" />}
                                onClick={() => copyToClipboard(log.requestPreview, "请求体")}
                            >
                                复制请求体
                            </Button>
                        ) : null}
                        {log.responsePreview ? (
                            <Button
                                size="small"
                                icon={<Copy className="size-3.5" />}
                                onClick={() => copyToClipboard(log.responsePreview, "响应体")}
                            >
                                复制响应体
                            </Button>
                        ) : null}
                        {log.error ? (
                            <Button
                                size="small"
                                danger
                                icon={<Copy className="size-3.5" />}
                                onClick={() => copyToClipboard(log.error, "错误信息")}
                            >
                                复制错误
                            </Button>
                        ) : null}
                    </div>

                    {/* Quick Highlights Summary Cards */}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <Clock className="size-3.5 text-zinc-400" />
                                <span>耗时</span>
                            </div>
                            <div className="mt-1 font-mono text-base font-semibold text-zinc-900 dark:text-zinc-100">
                                {log.durationMs} <span className="text-xs font-normal text-zinc-500">ms</span>
                            </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <BarChart3 className="size-3.5 text-zinc-400" />
                                <span>Token 消耗</span>
                            </div>
                            <div className="mt-1 font-mono text-base font-semibold text-zinc-900 dark:text-zinc-100">
                                {log.totalTokens?.toLocaleString() || 0}
                            </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <CircleUserRound className="size-3.5 text-zinc-400" />
                                <span>Google 账号</span>
                            </div>
                            <div className="mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100" title={log.accountEmail || "未分配"}>
                                {log.accountEmail || "未分配账号"}
                            </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <Network className="size-3.5 text-zinc-400" />
                                <span>代理出口</span>
                            </div>
                            <div className="mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100" title={log.proxyEgress?.node_name || log.proxyEgress?.address || "直连"}>
                                {log.proxyEgress
                                    ? `${log.proxyEgress.mode === "magic" ? "魔法" : log.proxyEgress.mode === "chained" ? "链式" : "通用"}: ${log.proxyEgress.node_name || log.proxyEgress.address || "已配置"}`
                                    : "直接连接"}
                            </div>
                        </div>
                    </div>

                    {/* Metadata Overview Fields */}
                    <section>
                        <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">请求基本信息</h3>
                        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2.5 rounded-lg border border-zinc-200 p-3.5 text-sm dark:border-zinc-800">
                            <dt className="text-zinc-500">模型 ID</dt>
                            <dd className="break-all font-mono font-medium text-zinc-900 dark:text-zinc-100">{log.model}</dd>

                            <dt className="text-zinc-500">协议类型</dt>
                            <dd>
                                <Tag color="geekblue" className="font-mono text-xs uppercase">{log.protocol}</Tag>
                            </dd>

                            <dt className="text-zinc-500">请求路径</dt>
                            <dd className="break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">{log.path}</dd>

                            {log.clientIp ? (
                                <>
                                    <dt className="text-zinc-500">客户端 IP</dt>
                                    <dd className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{log.clientIp}</dd>
                                </>
                            ) : null}

                            {log.userAgent ? (
                                <>
                                    <dt className="text-zinc-500">User Agent</dt>
                                    <dd className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{log.userAgent}</dd>
                                </>
                            ) : null}

                            <dt className="text-zinc-500">API 凭据</dt>
                            <dd className="text-xs text-zinc-700 dark:text-zinc-300">{log.keyPrefix ? `前缀 [${log.keyPrefix}...]` : "站内系统默认权限"}</dd>

                            <dt className="text-zinc-500">Token 细节</dt>
                            <dd className="text-xs text-zinc-600 dark:text-zinc-400">
                                提示词 (Prompt): <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">{log.promptTokens || 0}</span> · 生成 (Completion): <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">{log.completionTokens || 0}</span> · 总计: <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">{log.totalTokens || 0}</span>
                            </dd>

                            {(log.imageRequestedCount || 0) > 0 || (log.imageSucceededCount || 0) > 0 ? (
                                <>
                                    <dt className="text-zinc-500">生图任务</dt>
                                    <dd className="text-xs text-zinc-600 dark:text-zinc-400">
                                        请求: {log.imageRequestedCount || 0} 张 · 成功: {log.imageSucceededCount || 0} 张 · 失败: {log.imageFailedCount || 0} 张
                                    </dd>
                                </>
                            ) : null}

                            <dt className="text-zinc-500">发起时间</dt>
                            <dd className="text-xs text-zinc-600 dark:text-zinc-400">{formatTimeWithMs(log.createdAt)}</dd>
                        </dl>
                    </section>

                    {/* Rich Chronological Lifecycle Process Log Timeline */}
                    <section>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">过程日志与时序</h3>
                            <span className="text-xs text-zinc-500">
                                共 {log.lifecycle?.length || 1} 个执行阶段 · 总历时 {log.durationMs}ms
                            </span>
                        </div>
                        {log.lifecycle?.length ? (
                            <div className="space-y-2 rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800">
                                {log.lifecycle.map((entry, index) => {
                                    const isPhaseSuccess = entry.phase === "success";
                                    const isPhaseFailed = entry.phase === "failed";
                                    const isPhaseProgress = entry.phase === "queued" || entry.phase === "running" || entry.phase === "upstream" || entry.phase === "routing" || entry.phase === "auth";
                                    return (
                                        <div key={index} className="flex items-start gap-3 text-xs">
                                            <span className={`mt-0.5 shrink-0 text-sm ${isPhaseSuccess ? "text-emerald-500" : isPhaseFailed ? "text-rose-500" : isPhaseProgress ? "text-blue-500" : "text-amber-500"}`}>
                                                {isPhaseSuccess ? "✓" : isPhaseFailed ? "✕" : "●"}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-mono text-zinc-400 dark:text-zinc-500">{formatTimeWithMs(entry.time)}</span>
                                                    {entry.durationMs !== undefined ? (
                                                        <Tag className="m-0 border-0 bg-zinc-100 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                                            +{entry.durationMs}ms
                                                        </Tag>
                                                    ) : null}
                                                    <Tag color={phaseTagColor(entry.phase)} className="m-0 text-[10px] uppercase">
                                                        {phaseLabel(entry.phase)}
                                                    </Tag>
                                                    <span className="font-medium text-zinc-800 dark:text-zinc-200">{entry.message}</span>
                                                </div>
                                                {entry.detail ? (
                                                    <div className="mt-1 break-all rounded bg-zinc-50 p-2 font-mono text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-400">
                                                        {entry.detail}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="rounded-lg border border-dashed border-zinc-200 p-4 text-center text-xs text-zinc-500 dark:border-zinc-800">
                                未记录详细阶段日志
                            </div>
                        )}
                    </section>

                    {log.error ? <LogPreview title="错误信息" value={log.error} tone="error" /> : null}
                    {log.requestPreview ? <LogPreview title="请求内容" value={log.requestPreview} /> : null}
                    {log.responsePreview ? <LogPreview title="响应内容" value={log.responsePreview} /> : null}
                </div>
            ) : null}
        </Drawer>
    );
}

function phaseTagColor(phase: string) {
    switch (phase) {
        case "queued": return "default";
        case "routing": return "purple";
        case "auth": return "cyan";
        case "upstream": return "geekblue";
        case "response": return "blue";
        case "running": return "processing";
        case "success": return "success";
        case "failed": return "error";
        default: return "default";
    }
}

function phaseLabel(phase: string) {
    switch (phase) {
        case "queued": return "排队";
        case "routing": return "路由";
        case "auth": return "认证";
        case "upstream": return "上游";
        case "response": return "响应";
        case "running": return "执行";
        case "success": return "完成";
        case "failed": return "异常";
        default: return phase;
    }
}

function formatTimeWithMs(value: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    const timeStr = date.toLocaleString("zh-CN", { hour12: false });
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${timeStr}.${ms}`;
}

function LogPreview({ title, value, tone }: { title: string; value: string; tone?: "error" }) {
    return (
        <section>
            <h3 className={`mb-2 text-sm font-medium ${tone === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-800 dark:text-zinc-200"}`}>{title}</h3>
            <pre
                className={`max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-xs leading-5 ${tone === "error" ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200" : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"}`}
            >
                {value}
            </pre>
        </section>
    );
}
function SettingRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{description}</div>
            </div>
            {children}
        </div>
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
function formatTime(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}
