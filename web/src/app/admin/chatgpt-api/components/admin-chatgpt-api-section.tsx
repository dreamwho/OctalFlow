"use client";

import { Alert, App, Button, Checkbox, Empty, Input, Modal, Pagination, Popconfirm, Progress, Segmented, Select, Space, Spin, Switch, Tabs, Tag } from "antd";
import { KeyRound, Plus, RefreshCw, Upload } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import type { AdminDashboardController } from "@/components/admin/use-admin-dashboard-controller";
import { getAdminSettings } from "@/services/api/admin-settings";
import { chatGptApiRequest, type ChatGptAccountPage, type ChatGptGateway, type ChatGptKey, type ChatGptModelCatalog } from "@/services/api/chatgpt-api";
import { accountFilePayload, readAccountFiles, submitAccountImport, type AccountFileImport, type AccountImportPayload, type ImportProgress } from "../account-import";
import { accountOperationOutcome, type AccountOperationResult } from "../account-operation-result";
import { ChatGptMagicProxyPanel } from "./chatgpt-magic-proxy-panel";
import { ChatGptProxyManager } from "./chatgpt-proxy-manager";
import { ChatGptProxyRuntimeControl } from "./chatgpt-proxy-runtime-control";
import { ChatGptStatisticsPanel } from "./chatgpt-statistics";
import { accountOperationCompletionNotice, accountOperationProgressPercent, type AccountOperationProgress, useAccountOperationProgress } from "./use-account-operation-progress";
import { ChatGptRequestLogPanel } from "./chatgpt-request-log-panel";
import { chatGptProxyRuntimeStatus, useChatGptProxyRuntime } from "./use-chatgpt-proxy-runtime";

type ChatGptTab = "overview" | "statistics" | "gateway" | "proxy" | "logs";
type LoadTarget = "overview" | "gateway";
type AccountOperation = { label: string; progressId: string; progress?: AccountOperationProgress; followError?: string };
type CreatedKey = { item: ChatGptKey; raw_key: string };
type UpdatedKey = { item?: ChatGptKey | null };

const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });

function accountImportPayload(value: string) {
    const text = value.trim();
    if (!text) throw new Error("请填写自己的账号凭据");
    let parsed: unknown;
    try {
        parsed =
            text.startsWith("[") || text.startsWith("{")
                ? (JSON.parse(text) as unknown)
                : text
                      .split(/\r?\n/)
                      .map((item) => item.trim())
                      .filter(Boolean);
    } catch {
        throw new Error("账号凭据 JSON 格式无效");
    }
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? { tokens: parsed, sync_after_import: false as const } : { accounts: Array.isArray(parsed) ? parsed : [parsed], sync_after_import: false as const };
}

export function AdminChatGptApiSection({ controller }: { controller: AdminDashboardController }) {
    const { message } = App.useApp();
    const proxyRuntime = useChatGptProxyRuntime();
    const [tab, setTab] = useState<ChatGptTab>("overview");
    const [accounts, setAccounts] = useState<ChatGptAccountPage>({ items: [], total: 0 });
    const [catalog, setCatalog] = useState<ChatGptModelCatalog | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [gateway, setGateway] = useState<ChatGptGateway>({ enabled: false });
    const [keys, setKeys] = useState<ChatGptKey[]>([]);
    const [page, setPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState<Record<LoadTarget, boolean>>({ overview: false, gateway: false });
    const [errors, setErrors] = useState<Record<LoadTarget, string>>({ overview: "", gateway: "" });
    const [mutation, setMutation] = useState("");
    const [accountOperation, setAccountOperation] = useState<AccountOperation | null>(null);
    const accountOperationRef = useRef<AccountOperation | null>(null);
    accountOperationRef.current = accountOperation;
    const [importOpen, setImportOpen] = useState(false);
    const [credentials, setCredentials] = useState("");
    const [importMode, setImportMode] = useState("files");
    const [fileImport, setFileImport] = useState<AccountFileImport | null>(null);
    const [readingFiles, setReadingFiles] = useState(false);
    const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
    const [importError, setImportError] = useState("");
    const fileReadRevision = useRef(0);
    const fileInput = useRef<HTMLInputElement>(null);
    const clearImport = () => {
        fileReadRevision.current++;
        setCredentials("");
        setFileImport(null);
        setReadingFiles(false);
        setImportProgress(null);
        setImportError("");
        if (fileInput.current) fileInput.current.value = "";
    };
    const selectImportFiles = async (files: File[]) => {
        const revision = ++fileReadRevision.current;
        setFileImport(null);
        setImportProgress(null);
        setImportError("");
        setReadingFiles(true);
        const result = await readAccountFiles(files);
        if (revision !== fileReadRevision.current) return;
        setFileImport(result);
        setReadingFiles(false);
    };
    const [keyOpen, setKeyOpen] = useState(false);
    const [keyName, setKeyName] = useState("");
    const [rawKey, setRawKey] = useState("");
    const loadRevisions = useRef<Record<LoadTarget, number>>({ overview: 0, gateway: 0 });
    const mutationPending = useRef(false);
    const modelSelectionLoaded = useRef(false);
    const selectedDirty = useRef(false);
    const gatewayLoaded = useRef(false);

    const invalidateLoad = useCallback((target: LoadTarget) => {
        loadRevisions.current[target] += 1;
        setLoading((current) => ({ ...current, [target]: false }));
    }, []);

    const loadOverview = useCallback(async () => {
        if (mutationPending.current) return;
        const revision = ++loadRevisions.current.overview;
        const includeSelection = !modelSelectionLoaded.current && !selectedDirty.current;
        setLoading((current) => ({ ...current, overview: true }));
        setErrors((current) => ({ ...current, overview: "" }));
        try {
            const [nextAccounts, nextCatalog, nextSelection] = await Promise.all([
                chatGptApiRequest<ChatGptAccountPage>("accounts?page=" + page + "&page_size=20&keyword=" + encodeURIComponent(search)),
                chatGptApiRequest<ChatGptModelCatalog>("model-catalog"),
                includeSelection ? chatGptApiRequest<{ models: string[] }>("models") : Promise.resolve(null),
            ]);
            if (revision !== loadRevisions.current.overview) return;
            setAccounts(nextAccounts);
            setCatalog(nextCatalog);
            if (nextSelection) {
                setSelected(nextSelection.models);
                modelSelectionLoaded.current = true;
                selectedDirty.current = false;
            }
        } catch (reason) {
            if (revision === loadRevisions.current.overview) setErrors((current) => ({ ...current, overview: reason instanceof Error ? reason.message : "读取 GPTAPI 失败" }));
        } finally {
            if (revision === loadRevisions.current.overview) setLoading((current) => ({ ...current, overview: false }));
        }
    }, [page, search]);

    const loadGateway = useCallback(async () => {
        if (mutationPending.current) return;
        const revision = ++loadRevisions.current.gateway;
        setLoading((current) => ({ ...current, gateway: true }));
        setErrors((current) => ({ ...current, gateway: "" }));
        try {
            const [nextGateway, nextKeys] = await Promise.all([chatGptApiRequest<ChatGptGateway>("gateway"), chatGptApiRequest<{ items: ChatGptKey[] }>("keys")]);
            if (revision !== loadRevisions.current.gateway) return;
            setGateway(nextGateway);
            setKeys(nextKeys.items);
            gatewayLoaded.current = true;
        } catch (reason) {
            if (revision === loadRevisions.current.gateway) setErrors((current) => ({ ...current, gateway: reason instanceof Error ? reason.message : "读取网关配置失败" }));
        } finally {
            if (revision === loadRevisions.current.gateway) setLoading((current) => ({ ...current, gateway: false }));
        }
    }, []);

    useEffect(() => {
        void loadOverview();
    }, [loadOverview]);

    useEffect(() => {
        if (tab === "gateway" && !gatewayLoaded.current) void loadGateway();
    }, [loadGateway, tab]);

    useEffect(
        () => () => {
            loadRevisions.current.overview += 1;
            loadRevisions.current.gateway += 1;
        },
        [],
    );

    const startMutation = (name: string, target: LoadTarget) => {
        if (mutationPending.current) return false;
        mutationPending.current = true;
        invalidateLoad(target);
        setMutation(name);
        return true;
    };

    const finishMutation = () => {
        mutationPending.current = false;
        setMutation("");
    };

    const runMutation = async <T,>(name: string, target: LoadTarget, operation: () => Promise<T>, apply: (result: T) => void, success: string) => {
        if (!startMutation(name, target)) return;
        try {
            apply(await operation());
            message.success(success);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "操作失败");
        } finally {
            finishMutation();
        }
    };

    const runAccountOperation = async (label: string, operation: () => Promise<AccountOperationResult>, onAccepted?: () => void) => {
        if ((accountOperation && !accountOperation.progress?.done) || !startMutation("account", "overview")) return;
        let completed = false;
        try {
            const outcome = accountOperationOutcome(await operation());
            onAccepted?.();
            if (outcome.kind === "pending") {
                setAccountOperation({ label, progressId: outcome.progressId });
                message.info(label + "已提交，正在自动跟随进度");
            } else {
                completed = true;
                setAccountOperation(null);
                if (outcome.failed) message.warning(label + "部分完成：" + outcome.message);
                else message.success(label + "已完成：" + outcome.message);
            }
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "账号操作失败");
        } finally {
            finishMutation();
        }
        if (completed) await loadOverview();
    };

    const submitImportAccounts = async () => {
        let payload: AccountImportPayload;
        try {
            if (readingFiles || importError) return;
            payload = importMode === "files" ? accountFilePayload(fileImport || { accounts: [], duplicates: 0, files: 0, errors: [] }) : accountImportPayload(credentials);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "账号凭据无效");
            return;
        }
        if (!startMutation("account", "overview")) return;
        try {
            const result = await submitAccountImport(payload, (batch) => chatGptApiRequest<AccountOperationResult>("accounts", json(batch)), setImportProgress);
            clearImport();
            setImportOpen(false);
            message.success(`账号导入已完成：新增 ${result.added} 个，更新/跳过 ${result.skipped} 个，失败 0 个`);
        } catch (reason) {
            setImportError(reason instanceof Error ? reason.message : "导入中断，请核对账号列表");
        } finally {
            finishMutation();
        }
        await loadOverview();
    };

    const saveModels = async () => {
        if (!startMutation("models", "overview")) return;
        try {
            const result = await chatGptApiRequest<{ models: string[] }>("models", json({ models: selected }, "PUT"));
            setSelected(result.models);
            modelSelectionLoaded.current = true;
            selectedDirty.current = false;
            try {
                const latest = await getAdminSettings();
                controller.setSettings((current) => ({
                    ...current,
                    systemChannels: latest.systemChannels,
                    logicalModels: latest.logicalModels,
                    defaultModels: latest.defaultModels,
                }));
                message.success("已同步至模型渠道与逻辑模型");
            } catch (reason) {
                message.warning("模型已保存，但后台渠道快照刷新失败：" + (reason instanceof Error ? reason.message : "请刷新后台设置后重试"));
            }
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "保存模型失败");
        } finally {
            finishMutation();
        }
    };

    const readAccountOperationProgress = useCallback((progressId: string, signal: AbortSignal) => chatGptApiRequest<unknown>("accounts/operations/" + encodeURIComponent(progressId), { signal }), []);
    const applyAccountOperationProgress = useCallback((progressId: string, progress: AccountOperationProgress) => {
        setAccountOperation((current) => (current?.progressId === progressId ? { ...current, progress } : current));
    }, []);
    const completeAccountOperation = useCallback(
        (progressId: string, progress: AccountOperationProgress) => {
            const operation = accountOperationRef.current;
            if (!operation || operation.progressId !== progressId) return;
            setAccountOperation((current) => (current?.progressId === progressId ? { ...current, progress } : current));
            void loadOverview();
            const notice = accountOperationCompletionNotice(operation.label, progress);
            if (notice.type === "error") message.error(notice.text);
            else if (notice.type === "warning") message.warning(notice.text);
            else message.success(notice.text);
        },
        [loadOverview, message],
    );
    const failAccountOperationFollow = useCallback(
        (progressId: string, error: Error) => {
            const operation = accountOperationRef.current;
            if (!operation || operation.progressId !== progressId) return;
            setAccountOperation((current) => (current?.progressId === progressId ? { ...current, followError: error.message } : current));
            message.error(operation.label + "自动跟随失败：" + error.message);
        },
        [message],
    );
    useAccountOperationProgress({
        progressId: accountOperation?.progress?.done ? undefined : accountOperation?.progressId,
        active: Boolean(accountOperation && !accountOperation.progress?.done && !accountOperation.followError),
        readProgress: readAccountOperationProgress,
        onProgress: applyAccountOperationProgress,
        onTerminal: completeAccountOperation,
        onError: failAccountOperationFollow,
    });

    const activeLoadTarget: LoadTarget | null = tab === "overview" || tab === "gateway" ? tab : null;
    const activeError = activeLoadTarget ? errors[activeLoadTarget] : "";
    const retryActiveLoad = activeLoadTarget === "overview" ? loadOverview : activeLoadTarget === "gateway" ? loadGateway : null;
    const mutating = Boolean(mutation);
    const accountOperationPending = Boolean(accountOperation && !accountOperation.progress?.done);
    const accountOperationStatus = accountOperation?.followError ? "进度连接中断" : accountOperation?.progress?.status_label || (accountOperationPending ? "正在刷新" : "已结束");
    const accountOperationType = accountOperation?.followError
        ? "warning"
        : accountOperation?.progress?.error || accountOperation?.progress?.tone === "danger"
          ? "error"
          : accountOperation?.progress?.tone === "warning"
            ? "warning"
            : accountOperation?.progress?.tone === "success"
              ? "success"
              : "info";
    const accountOperationPercent = accountOperationProgressPercent(accountOperation?.progress);
    const proxyRuntimeStatus = proxyRuntime.runtime ? chatGptProxyRuntimeStatus(proxyRuntime.runtime) : "正在读取全局代理状态。";

    return (
        <div className="min-w-0 space-y-4">
            <Alert type="warning" showIcon title="非官方 ChatGPT 接口" description="基于 chatgpt2api2 移植，通过本人授权的 ChatGPT 账号提供兼容 API。上游变化可能导致失败或账号受限，请勿导入重要账号。" />
            <Tabs
                className="max-sm:[&_.ant-tabs-nav-list]:w-full max-sm:[&_.ant-tabs-tab]:!m-0 max-sm:[&_.ant-tabs-tab]:min-w-0 max-sm:[&_.ant-tabs-tab]:flex-1 max-sm:[&_.ant-tabs-tab]:justify-center max-sm:[&_.ant-tabs-tab]:!px-1 max-sm:[&_.ant-tabs-tab-btn]:text-xs"
                activeKey={tab}
                tabBarGutter={16}
                onChange={(key) => setTab(key as ChatGptTab)}
                items={[
                    { key: "overview", label: <ChatGptApiTabLabel label="账号与渠道" compact="账号" /> },
                    { key: "statistics", label: <ChatGptApiTabLabel label="统计报表" compact="统计" /> },
                    { key: "gateway", label: <ChatGptApiTabLabel label="反代网关与 API 密钥" compact="网关与密钥" /> },
                    { key: "proxy", label: <ChatGptApiTabLabel label="代理管理" compact="代理" /> },
                    { key: "logs", label: <ChatGptApiTabLabel label="请求日志" compact="日志" /> },
                ]}
            />
            {activeError ? <Alert type="error" showIcon title="GPTAPI 暂不可用" description={activeError} action={<Button onClick={() => void retryActiveLoad?.()}>重试</Button>} /> : null}

            <div data-chatgpt-api-tab-panel="overview" className={tab === "overview" ? "space-y-4" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="GPTAPI · 账号"
                        description="导入 Access Token / Refresh Token；凭据仅在服务端处理，不在列表展示。导入不自动调用上游。"
                        actions={
                            <Space wrap size={6}>
                                <Button
                                    icon={<RefreshCw className="size-4" />}
                                    loading={loading.overview || (accountOperationPending && !accountOperation?.followError)}
                                    disabled={mutating || accountOperationPending}
                                    onClick={() => void runAccountOperation("刷新全部额度", () => chatGptApiRequest<AccountOperationResult>("accounts/refresh", json({ selection: { mode: "all" } })))}
                                >
                                    刷新全部额度
                                </Button>
                                <Button type="primary" icon={<Plus className="size-4" />} disabled={mutating || accountOperationPending} onClick={() => setImportOpen(true)}>
                                    导入账号
                                </Button>
                            </Space>
                        }
                    />
                    <div className="space-y-3 p-3 sm:p-4">
                        {accountOperation ? (
                            <div data-chatgpt-account-operation>
                                <Alert
                                    type={accountOperationType}
                                    showIcon
                                    title={accountOperation.label + " · " + accountOperationStatus}
                                    description={
                                        <div data-chatgpt-account-operation-progress className="space-y-2" aria-live="polite">
                                            {accountOperationPending && !accountOperation.followError ? (
                                                <div className="flex items-center gap-2">
                                                    <Spin size="small" />
                                                    <span>正在处理，请稍候</span>
                                                </div>
                                            ) : null}
                                            {accountOperation.followError ? <div>{accountOperation.followError}。任务仍可能在执行，请恢复进度连接，不要重复提交。</div> : null}
                                            <div>{accountOperation.progress?.message || (accountOperationPending ? "正在等待上游返回真实进度。" : "账号操作已结束。")}</div>
                                            {accountOperation.progress ? (
                                                <div>
                                                    <div className="text-xs text-zinc-600 dark:text-zinc-300">
                                                        已处理 {accountOperation.progress.processed} / {accountOperation.progress.total}
                                                        {accountOperationPercent === undefined ? "" : "（" + accountOperationPercent + "%）"}
                                                    </div>
                                                    {accountOperationPercent === undefined ? null : (
                                                        <Progress
                                                            className="mt-1"
                                                            size="small"
                                                            percent={accountOperationPercent}
                                                            status={accountOperationPending ? "active" : accountOperationType === "error" ? "exception" : accountOperationType === "success" ? "success" : "normal"}
                                                        />
                                                    )}
                                                </div>
                                            ) : null}
                                        </div>
                                    }
                                    action={
                                        accountOperation.followError ? (
                                            <Button size="small" onClick={() => setAccountOperation((current) => current && { ...current, followError: undefined })}>
                                                恢复进度连接
                                            </Button>
                                        ) : undefined
                                    }
                                    closable={accountOperationPending ? false : { closeIcon: true, "aria-label": "关闭待确认账号操作", onClose: () => setAccountOperation(null) }}
                                />
                            </div>
                        ) : null}
                        <Input.Search
                            aria-label="搜索 ChatGPT 账号"
                            placeholder="搜索账号"
                            value={keyword}
                            onChange={(event) => setKeyword(event.target.value)}
                            onSearch={(value) => {
                                setPage(1);
                                setSearch(value);
                            }}
                        />
                        {!accounts.items.length ? (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账号" />
                        ) : (
                            accounts.items.map((account) => (
                                <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <div className="min-w-0 flex-1 max-sm:w-full max-sm:flex-none">
                                        <div className="break-all text-base font-semibold leading-6 sm:text-lg">{account.email || account.display_name}</div>
                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-zinc-500">
                                            <Tag>{account.status_label}</Tag>
                                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{account.source_plan_label}</span>
                                            <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-100">额度：{account.quota_label}</span>
                                            <span className="text-xs">
                                                成功 {account.success_count} / 失败 {account.failure_count}
                                            </span>
                                        </div>
                                        {account.status_reason && account.status_reason !== "账号已启用，当前凭据可调用" ? <div className="mt-1 break-words text-xs text-zinc-500">{account.status_reason}</div> : null}
                                    </div>
                                    <Space wrap size={6}>
                                        <Switch
                                            aria-label={"启用 " + account.display_name}
                                            checked={account.enabled}
                                            disabled={mutating || accountOperationPending}
                                            onChange={(enabled) =>
                                                void runAccountOperation("账号状态变更", () =>
                                                    chatGptApiRequest<AccountOperationResult>("accounts/batch-update", json({ account_ids: [account.id], operation: enabled ? "enable" : "disable", status: enabled ? "正常" : "禁用" })),
                                                )
                                            }
                                        />
                                        <Button
                                            disabled={mutating || accountOperationPending}
                                            onClick={() => void runAccountOperation("账号额度刷新", () => chatGptApiRequest<AccountOperationResult>("accounts/refresh", json({ account_ids: [account.id] })))}
                                        >
                                            刷新额度
                                        </Button>
                                        <Popconfirm
                                            title="删除该 ChatGPT 账号？"
                                            okText="删除"
                                            cancelText="取消"
                                            onConfirm={() => runAccountOperation("账号删除", () => chatGptApiRequest<AccountOperationResult>("accounts", json({ account_ids: [account.id] }, "DELETE")))}
                                        >
                                            <Button danger disabled={mutating || accountOperationPending}>
                                                删除
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                </div>
                            ))
                        )}
                        <Pagination current={page} pageSize={20} total={accounts.total} showSizeChanger={false} onChange={setPage} />
                    </div>
                </Panel>
                <Panel>
                    <PanelHeader
                        title="模型渠道"
                        description="勾选模型后点击“同步至渠道与逻辑模型”，即可在模型渠道及画布中使用。目录不代表账号实际调用权限。"
                        actions={
                            <Button type="primary" loading={mutation === "models"} disabled={mutating || !selected.length} onClick={() => void saveModels()}>
                                同步至渠道与逻辑模型
                            </Button>
                        }
                    />
                    <div className="space-y-4 p-3 sm:p-4">
                        <p className="text-sm text-zinc-500">
                            已选 {selected.length} 个模型{selected.length ? "；修改后需点击同步保存。" : "；尚未选择模型时不会自动创建可用渠道。"}
                        </p>
                        {catalog ? (
                            [
                                { title: "文本", values: catalog.chat_models },
                                { title: "图片", values: catalog.image_models },
                            ].map((group) => (
                                <div key={group.title}>
                                    <div className="mb-2 text-sm font-medium">{group.title}</div>
                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                        {group.values.map((model) => (
                                            <Checkbox
                                                key={model}
                                                checked={selected.includes(model)}
                                                disabled={mutating}
                                                onChange={(event) => {
                                                    selectedDirty.current = true;
                                                    setSelected((current) => (event.target.checked ? [...current, model] : current.filter((item) => item !== model)));
                                                }}
                                            >
                                                <span className="break-all">{model}</span>
                                            </Checkbox>
                                        ))}
                                    </div>
                                </div>
                            ))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="运行时就绪后读取模型目录" />
                        )}
                    </div>
                </Panel>
            </div>

            {tab === "statistics" ? (
                <div data-chatgpt-api-tab-panel="statistics" className="space-y-4">
                    <ChatGptStatisticsPanel />
                </div>
            ) : null}

            <div data-chatgpt-api-tab-panel="gateway" className={tab === "gateway" ? "grid gap-4 xl:grid-cols-2" : "hidden"}>
                <Panel>
                    <PanelHeader
                        title="反代网关"
                        description="对外提供标准 OpenAI 兼容接口；外部调用必须使用下方创建的 API 密钥。"
                        actions={
                            <Button icon={<RefreshCw className="size-4" />} loading={loading.gateway} disabled={mutating} onClick={() => void loadGateway()}>
                                刷新配置
                            </Button>
                        }
                    />
                    <div className="space-y-3 p-3 sm:p-4">
                        <div className="flex items-center justify-between gap-3">
                            <span>启用网关</span>
                            <Switch
                                aria-label="启用 ChatGPT 网关"
                                checked={gateway.enabled}
                                disabled={mutating || loading.gateway}
                                onChange={(enabled) => void runMutation("gateway", "gateway", () => chatGptApiRequest<ChatGptGateway>("gateway", json({ enabled }, "PATCH")), setGateway, enabled ? "网关已启用" : "网关已停用")}
                            />
                        </div>
                        <div className="break-all text-xs leading-6 text-zinc-500">
                            Base URL：<code>{typeof window !== "undefined" ? window.location.origin : ""}/api/chatgpt-api/v1</code>
                            <br />
                            文本：chat/completions · responses
                            <br />
                            图片：images/generations · images/edits
                            <br />
                            模型：models
                        </div>
                    </div>
                </Panel>
                <Panel>
                    <PanelHeader
                        title="API 密钥"
                        description="明文仅创建时显示一次，关闭窗口后不再回显。"
                        actions={
                            <Button type="primary" icon={<KeyRound className="size-4" />} disabled={mutating || loading.gateway} onClick={() => setKeyOpen(true)}>
                                创建密钥
                            </Button>
                        }
                    />
                    <div className="space-y-2 p-3 sm:p-4">
                        {keys.length ? (
                            keys.map((key) => (
                                <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <span className="min-w-0 break-all">{key.name || "未命名密钥"}</span>
                                    <Space wrap size={6}>
                                        <Switch
                                            aria-label={"启用密钥 " + key.name}
                                            checked={key.enabled}
                                            disabled={mutating || loading.gateway}
                                            onChange={(enabled) =>
                                                void runMutation(
                                                    "key-toggle",
                                                    "gateway",
                                                    () => chatGptApiRequest<UpdatedKey>("keys/" + encodeURIComponent(key.id), json({ enabled })),
                                                    (result) => setKeys((current) => current.map((item) => (item.id === key.id ? result.item || { ...item, enabled } : item))),
                                                    "密钥状态已保存",
                                                )
                                            }
                                        />
                                        <Popconfirm
                                            title="删除该 API 密钥？"
                                            okText="删除"
                                            cancelText="取消"
                                            onConfirm={() =>
                                                runMutation(
                                                    "key-delete",
                                                    "gateway",
                                                    () => chatGptApiRequest("keys/" + encodeURIComponent(key.id), { method: "DELETE" }),
                                                    () => setKeys((current) => current.filter((item) => item.id !== key.id)),
                                                    "密钥已删除",
                                                )
                                            }
                                        >
                                            <Button danger disabled={mutating || loading.gateway}>
                                                删除
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                </div>
                            ))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未创建 API 密钥" />
                        )}
                    </div>
                </Panel>
            </div>

            {tab === "proxy" ? (
                <div data-chatgpt-api-tab-panel="proxy" className="space-y-4">
                    <div data-chatgpt-proxy-runtime-master className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">启用代理</span>
                                <Tag color={proxyRuntime.runtime?.enabled ? "success" : "default"} className="m-0">
                                    {proxyRuntime.runtime?.enabled ? "已启用" : "已关闭"}
                                </Tag>
                            </div>
                            <p className="mt-1 text-xs leading-5 text-zinc-500">{proxyRuntimeStatus}</p>
                        </div>
                        <Switch
                            aria-label="使用代理"
                            checked={proxyRuntime.runtime?.enabled === true}
                            loading={proxyRuntime.saving}
                            disabled={proxyRuntime.loading || proxyRuntime.saving || !proxyRuntime.runtime}
                            onChange={(enabled) => {
                                const runtime = proxyRuntime.runtime;
                                if (!runtime) return;
                                void proxyRuntime.save({ enabled, mode: runtime.mode, native_source: runtime.native_source }).catch(() => undefined);
                            }}
                        />
                        {proxyRuntime.error ? <Alert className="w-full" type="error" showIcon title={proxyRuntime.error} /> : null}
                    </div>
                    {proxyRuntime.runtime ? (
                        <>
                            <Panel>
                                <PanelHeader title="代理方式" description="选择当前使用的代理来源，下方仅显示所选方式的配置内容。" />
                                <div className="p-3 sm:p-5">
                                    <Segmented
                                        aria-label="代理方式"
                                        value={proxyRuntime.runtime.mode === "magic" ? "magic" : "generic"}
                                        onChange={(value) => {
                                            const runtime = proxyRuntime.runtime;
                                            if (!runtime) return;
                                            const nextMode = value === "magic" ? "magic" : "native";
                                            void proxyRuntime.save({ enabled: true, mode: nextMode, native_source: nextMode === "magic" ? runtime.native_source || "manual" : "manual" }).catch(() => undefined);
                                        }}
                                        options={[
                                            { value: "magic", label: "魔法代理" },
                                            { value: "generic", label: "通用代理" },
                                        ]}
                                    />
                                </div>
                            </Panel>
                            {proxyRuntime.runtime.mode === "magic" ? (
                                <ChatGptMagicProxyPanel proxyRuntime={proxyRuntime} hideSourceSwitch />
                            ) : (
                                <ChatGptProxyManager proxyRuntime={proxyRuntime} showGroups={false} showSourceSwitch={false} title="通用代理出口" description="选择 GPTAPI 经通用代理提交时的默认出口与失败回退；代理分组与节点统一在「上游配置 → 通用代理」维护。" />
                            )}
                        </>
                    ) : null}
                </div>
            ) : null}

            {tab === "logs" ? <ChatGptRequestLogPanel /> : null}

            <Modal
                title="导入 ChatGPT 账号"
                open={importOpen}
                centered
                onCancel={() => {
                    if (mutation === "account") return;
                    setImportOpen(false);
                    clearImport();
                }}
                onOk={() => void submitImportAccounts()}
                confirmLoading={mutation === "account"}
                okButtonProps={{ disabled: readingFiles || Boolean(importError) || (importMode === "files" && (!fileImport?.accounts.length || Boolean(fileImport.errors.length))) }}
                cancelButtonProps={{ disabled: mutation === "account" }}
                okText="导入"
                cancelText="取消"
                width="min(640px, calc(100vw - 32px))"
            >
                <Tabs
                    activeKey={importMode}
                    onChange={(next) => {
                        if (mutation !== "account") {
                            clearImport();
                            setImportMode(next);
                        }
                    }}
                    items={[
                        { key: "files", label: "文件导入", disabled: mutation === "account" },
                        { key: "text", label: "粘贴凭据", disabled: mutation === "account" },
                    ]}
                />
                {importMode === "files" ? (
                    <div className="space-y-3">
                        <p className="text-sm text-zinc-500">推荐选择 CPA 文件夹内的 JSON 文件，可一次多选。也支持 Sub2API 账号文件；只提取账号凭据，不导入代理或计费配置。</p>
                        <input
                            ref={fileInput}
                            type="file"
                            accept=".json,application/json"
                            multiple
                            className="hidden"
                            aria-label="账号 JSON 文件"
                            onChange={(event) => {
                                void selectImportFiles(Array.from(event.target.files || []));
                                event.target.value = "";
                            }}
                        />
                        <Space wrap>
                            <Button icon={<Upload size={15} />} loading={readingFiles} disabled={mutation === "account"} onClick={() => fileInput.current?.click()}>
                                选择 JSON 文件
                            </Button>
                            {fileImport ? (
                                <Button disabled={mutation === "account"} onClick={clearImport}>
                                    清空选择
                                </Button>
                            ) : null}
                        </Space>
                        {fileImport ? (
                            <Alert
                                type={fileImport.errors.length ? "error" : "success"}
                                showIcon
                                title={`已选择 ${fileImport.files} 个文件，识别 ${fileImport.accounts.length} 个账号，去重 ${fileImport.duplicates} 个`}
                                description={
                                    fileImport.errors.length ? (
                                        <div>
                                            {fileImport.errors.map((error, index) => (
                                                <p key={index}>{error}</p>
                                            ))}
                                            <p>请重新选择有效文件，本次尚未导入任何账号。</p>
                                        </div>
                                    ) : (
                                        "确认后将按请求大小自动分批导入，无需手动拆分文件；选择文件不会自动提交或刷新账号。"
                                    )
                                }
                            />
                        ) : null}
                    </div>
                ) : (
                    <>
                        <p className="mb-3 text-sm text-zinc-500">支持每行一个 Access Token，或包含 access_token、refresh_token 的 JSON 对象/数组。仅导入本人有权使用的账号。</p>
                        <Input.TextArea
                            aria-label="账号凭据"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={mutation === "account"}
                            value={credentials}
                            onChange={(event) => setCredentials(event.target.value)}
                            rows={7}
                            placeholder={'[{"access_token":"…","refresh_token":"…"}]'}
                        />
                    </>
                )}
                {importProgress ? (
                    <div role="status" className="mt-3 text-sm">
                        已确认 {importProgress.completed}/{importProgress.total} 个 · {importProgress.batch}/{importProgress.batches} 批 · 新增 {importProgress.added} 个 · 更新/跳过 {importProgress.skipped} 个
                    </div>
                ) : null}
                {importError ? <Alert className="mt-3" type="error" showIcon title="导入已停止" description={importError} /> : null}
            </Modal>
            <Modal
                title="创建 API 密钥"
                open={keyOpen}
                centered
                onCancel={() => {
                    setKeyOpen(false);
                    setKeyName("");
                }}
                confirmLoading={mutation === "key-create"}
                okText="创建"
                cancelText="取消"
                width="min(520px, calc(100vw - 32px))"
                onOk={() =>
                    void runMutation(
                        "key-create",
                        "gateway",
                        () => chatGptApiRequest<CreatedKey>("keys", json({ name: keyName })),
                        (result) => {
                            setKeys((current) => [result.item, ...current.filter((item) => item.id !== result.item.id)]);
                            setRawKey(result.raw_key);
                            setKeyOpen(false);
                            setKeyName("");
                        },
                        "密钥已创建",
                    )
                }
            >
                <Input aria-label="密钥名称" placeholder="密钥名称" value={keyName} onChange={(event) => setKeyName(event.target.value)} />
            </Modal>
            <Modal
                title="请立即保存 API 密钥"
                open={Boolean(rawKey)}
                centered
                width="min(520px, calc(100vw - 32px))"
                onCancel={() => setRawKey("")}
                footer={
                    <Button type="primary" onClick={() => setRawKey("")}>
                        已保存，关闭
                    </Button>
                }
            >
                <Alert type="warning" title="关闭后不再显示明文" />
                <Input.TextArea aria-label="新建 API 密钥" className="mt-3" readOnly value={rawKey} autoSize />
            </Modal>
        </div>
    );
}

function ChatGptApiTabLabel({ label, compact, icon }: { label: string; compact: string; icon?: ReactNode }) {
    return (
        <span aria-label={label} className="inline-flex min-w-0 items-center justify-center gap-1.5">
            {icon}
            <span className="sm:hidden">{compact}</span>
            <span className="hidden sm:inline">{label}</span>
        </span>
    );
}
