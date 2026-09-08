"use client";

import { App, Button, Empty, Form, Input, Modal, Select, Switch, Table, Tabs, Tag } from "antd";
import { Activity, CircleDollarSign, CloudCog, KeyRound, Plus, RefreshCw, RotateCw, Save, ScrollText, SquareActivity, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { imagePreviewUrl } from "@/lib/media-image-url";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { getRunningHubAdminOverview, updateRunningHubAdmin, type RunningHubAdminApp, type RunningHubAdminLog, type RunningHubAdminOverview, type RunningHubAdminTask } from "@/services/api/runninghub";

type SettingsForm = { enabled: boolean; apiBaseUrl: string; apiKey?: string; instanceType: "standard" | "plus" };
type AppForm = { id?: string; remoteId: string; kind: "ai-app" | "workflow"; name: string; description?: string; thumbnailUrl?: string; enabled: boolean; featureBindings: string[]; sortOrder?: number };

export function AdminRunningHubSection() {
    const { message, modal } = App.useApp();
    const [overview, setOverview] = useState<RunningHubAdminOverview>();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [appModalOpen, setAppModalOpen] = useState(false);
    const [editingApp, setEditingApp] = useState<RunningHubAdminApp>();
    const [settingsForm] = Form.useForm<SettingsForm>();
    const [appForm] = Form.useForm<AppForm>();

    const load = async (refreshAccount = false) => {
        setLoading(true);
        try {
            const data = await getRunningHubAdminOverview(refreshAccount);
            setOverview(data);
            settingsForm.setFieldsValue({ enabled: data.settings.enabled, apiBaseUrl: data.settings.apiBaseUrl, instanceType: data.settings.instanceType, apiKey: "" });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 RunningHub 配置失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const saveSettings = async (values: SettingsForm) => {
        setSaving(true);
        try {
            await updateRunningHubAdmin({ action: "settings", ...values, apiKey: values.apiKey?.trim() || undefined });
            message.success("RunningHub 配置已保存");
            await load(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const openAppEditor = (app?: RunningHubAdminApp) => {
        setEditingApp(app);
        appForm.setFieldsValue(
            app
                ? { id: app.id, remoteId: app.remoteId, kind: app.kind, name: app.name, description: app.description, thumbnailUrl: app.thumbnailUrl, enabled: app.enabled, featureBindings: app.featureBindings, sortOrder: app.sortOrder }
                : { kind: "ai-app", name: "", remoteId: "", description: "", thumbnailUrl: "", enabled: true, featureBindings: ["interior-design"], sortOrder: (overview?.apps.length || 0) * 10 },
        );
        setAppModalOpen(true);
    };

    const saveApp = async (values: AppForm) => {
        setSaving(true);
        try {
            await updateRunningHubAdmin({ action: "upsert-app", app: values });
            message.success(editingApp ? "应用已更新" : "应用已添加");
            setAppModalOpen(false);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存应用失败");
        } finally {
            setSaving(false);
        }
    };

    const syncApp = async (app: RunningHubAdminApp) => {
        const hide = message.loading(`正在同步 ${app.name}…`, 0);
        try {
            await updateRunningHubAdmin({ action: "sync-app", id: app.id });
            hide();
            message.success("字段同步完成");
            await load();
        } catch (error) {
            hide();
            message.error(error instanceof Error ? error.message : "字段同步失败");
        }
    };

    const removeApp = (app: RunningHubAdminApp) => {
        modal.confirm({
            title: `删除 ${app.name}？`,
            content: "删除后，该应用会立即从已绑定的画布功能中移除；历史任务记录会保留。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await updateRunningHubAdmin({ action: "delete-app", id: app.id });
                message.success("应用已删除");
                await load();
            },
        });
    };

    const tabs = [
        { key: "account", label: <RunningHubTabLabel icon={CircleDollarSign}>账户统计</RunningHubTabLabel>, children: <AccountTab overview={overview} loading={loading} settingsForm={settingsForm} saving={saving} onSave={saveSettings} onRefresh={() => void load(true)} /> },
        { key: "apps", label: <RunningHubTabLabel icon={Workflow}>应用管理</RunningHubTabLabel>, children: <AppsTab apps={overview?.apps || []} loading={loading} onAdd={() => openAppEditor()} onEdit={openAppEditor} onSync={(app) => void syncApp(app)} onDelete={removeApp} /> },
        { key: "tasks", label: <RunningHubTabLabel icon={SquareActivity}>任务监控</RunningHubTabLabel>, children: <TasksTab tasks={overview?.tasks || []} loading={loading} apps={overview?.apps || []} onRefresh={() => void load()} onCancel={async (task) => { await updateRunningHubAdmin({ action: "cancel-task", id: task.id }); message.success("任务已取消"); await load(); }} /> },
        { key: "logs", label: <RunningHubTabLabel icon={ScrollText}>请求日志</RunningHubTabLabel>, children: <LogsTab logs={overview?.logs || []} loading={loading} onRefresh={() => void load()} onClear={() => modal.confirm({ title: "清空 RunningHub 请求日志？", content: "此操作只清空接口请求日志，不会删除任务和应用。", okText: "清空", okButtonProps: { danger: true }, cancelText: "取消", onOk: async () => { await updateRunningHubAdmin({ action: "clear-logs" }); message.success("请求日志已清空"); await load(); } })} /> },
    ];

    return (
        <section className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-5" data-admin-runninghub>
            <Tabs items={tabs} />
            <Modal open={appModalOpen} title={editingApp ? "编辑 RunningHub 应用" : "添加 RunningHub 应用"} footer={null} destroyOnHidden width={620} onCancel={() => setAppModalOpen(false)}>
                <Form form={appForm} layout="vertical" className="pt-2" onFinish={(values) => void saveApp(values)}>
                    <Form.Item name="id" hidden><Input /></Form.Item>
                    <div className="grid gap-x-3 sm:grid-cols-2">
                        <Form.Item name="name" label="应用名称" rules={[{ required: true, message: "请输入应用名称" }]}><Input placeholder="例如：SU直出摄影级照片" /></Form.Item>
                        <Form.Item name="kind" label="接入类型" rules={[{ required: true }]}><Select options={[{ label: "AI 应用（WebApp）", value: "ai-app" }, { label: "ComfyUI 工作流", value: "workflow" }]} /></Form.Item>
                        <Form.Item name="remoteId" label="RunningHub ID" rules={[{ required: true, message: "请输入应用或工作流 ID" }]}><Input placeholder="RunningHub 后台中的 ID" /></Form.Item>
                        <Form.Item name="sortOrder" label="排序"><Input type="number" /></Form.Item>
                    </div>
                    <Form.Item name="thumbnailUrl" label="缩略图地址"><Input placeholder="https://..." /></Form.Item>
                    <Form.Item name="description" label="功能说明"><Input.TextArea rows={3} placeholder="向用户说明这个应用适合什么场景" /></Form.Item>
                    <Form.Item name="featureBindings" label="功能绑定"><Select mode="multiple" options={[{ label: "室内设计", value: "interior-design" }]} placeholder="选择要展示此应用的功能面板" /></Form.Item>
                    <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                    <div className="flex justify-end gap-2"><Button onClick={() => setAppModalOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={saving} icon={<Save className="size-4" />}>保存</Button></div>
                </Form>
            </Modal>
        </section>
    );
}

function RunningHubTabLabel({ icon: Icon, children }: { icon: typeof CircleDollarSign; children: string }) {
    return <span className="inline-flex items-center gap-2 whitespace-nowrap"><Icon className="size-4 shrink-0" aria-hidden="true" /><span>{children}</span></span>;
}

function AccountTab({ overview, loading, settingsForm, saving, onSave, onRefresh }: { overview?: RunningHubAdminOverview; loading: boolean; settingsForm: ReturnType<typeof Form.useForm<SettingsForm>>[0]; saving: boolean; onSave: (values: SettingsForm) => Promise<void>; onRefresh: () => void }) {
    const accountMetrics = useMemo(() => extractAccountMetrics(overview?.account), [overview?.account]);
    return (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,.8fr)]">
            <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="mb-4 flex items-center gap-2"><CloudCog className="size-5 text-cyan-500" /><div><h3 className="font-semibold text-zinc-950 dark:text-zinc-100">接口配置</h3><p className="mt-0.5 text-xs text-zinc-500">统一用于上传、任务提交、查询、取消和字段同步。</p></div></div>
                <Form form={settingsForm} layout="vertical" disabled={loading} onFinish={(values) => void onSave(values)}>
                    <div className="grid gap-x-3 sm:grid-cols-2">
                        <Form.Item name="apiBaseUrl" label="API 地址" rules={[{ required: true }]}><Input placeholder="https://www.runninghub.ai" /></Form.Item>
                        <Form.Item name="instanceType" label="算力实例"><Select options={[{ label: "标准实例", value: "standard" }, { label: "Plus 实例", value: "plus" }]} /></Form.Item>
                    </div>
                    <Form.Item name="apiKey" label={<span className="inline-flex items-center gap-1.5"><KeyRound className="size-3.5" />API Key{overview?.settings.hasApiKey ? <Tag color="green">已保存</Tag> : null}</span>}><Input.Password placeholder={overview?.settings.hasApiKey ? "留空则保持现有密钥" : "请输入 RunningHub API Key"} autoComplete="new-password" /></Form.Item>
                    <Form.Item name="enabled" label="启用 RunningHub" valuePropName="checked"><Switch /></Form.Item>
                    <div className="flex justify-end"><Button type="primary" htmlType="submit" loading={saving} icon={<Save className="size-4" />}>保存配置</Button></div>
                </Form>
            </div>
            <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-3"><div><h3 className="font-semibold text-zinc-950 dark:text-zinc-100">账户状态</h3><p className="mt-0.5 text-xs text-zinc-500">实时读取 RunningHub 官方账户接口。</p></div><Button aria-label="刷新账户状态" icon={<RefreshCw className="size-4" />} loading={loading} onClick={onRefresh} /></div>
                {overview?.accountError ? <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">{overview.accountError}</div> : null}
                <div className="mt-4 grid grid-cols-2 gap-2">
                    {accountMetrics.length ? accountMetrics.map((metric) => <div key={metric.label} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900"><div className="text-xs text-zinc-500">{metric.label}</div><div className="mt-1 truncate text-lg font-semibold text-zinc-950 dark:text-zinc-100" title={metric.value}>{metric.value}</div></div>) : <div className="col-span-2 py-8"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="保存并启用后读取账户数据" /></div>}
                </div>
            </div>
        </div>
    );
}

function AppsTab({ apps, loading, onAdd, onEdit, onSync, onDelete }: { apps: RunningHubAdminApp[]; loading: boolean; onAdd: () => void; onEdit: (app: RunningHubAdminApp) => void; onSync: (app: RunningHubAdminApp) => void; onDelete: (app: RunningHubAdminApp) => void }) {
    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-zinc-950 dark:text-zinc-100">应用与工作流</h3><p className="mt-1 text-xs text-zinc-500">绑定“室内设计”后，名称与缩略图会自动出现在画布功能弹层。</p></div><Button type="primary" icon={<Plus className="size-4" />} onClick={onAdd}>添加应用</Button></div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {apps.map((app) => (
                    <article key={app.id} className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <div className="aspect-[16/8] bg-zinc-100 dark:bg-zinc-900">{app.thumbnailUrl ? <img className="h-full w-full object-cover" src={browserReadableMediaUrl(imagePreviewUrl(app.thumbnailUrl, 640))} alt={app.name} /> : <span className="grid h-full place-items-center text-zinc-400"><Workflow className="size-8" /></span>}</div>
                        <div className="p-3.5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="truncate font-medium text-zinc-950 dark:text-zinc-100">{app.name}</h4><p className="mt-1 truncate text-xs text-zinc-500">{app.kind === "ai-app" ? "AI 应用" : "工作流"} · {app.remoteId}</p></div><Tag color={app.enabled ? "green" : "default"}>{app.enabled ? "已启用" : "已停用"}</Tag></div><p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-zinc-500">{app.description || "暂无功能说明"}</p><div className="mt-3 flex flex-wrap gap-1.5">{app.featureBindings.includes("interior-design") ? <Tag color="cyan">室内设计</Tag> : <Tag>未绑定功能</Tag>}<Tag>{app.fields.length} 个字段</Tag></div><div className="mt-4 flex justify-end gap-2"><Button size="small" icon={<RotateCw className="size-3.5" />} onClick={() => onSync(app)}>同步字段</Button><Button size="small" onClick={() => onEdit(app)}>编辑</Button><Button size="small" danger aria-label={`删除 ${app.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(app)} /></div></div>
                    </article>
                ))}
                {!apps.length && !loading ? <div className="col-span-full py-14"><Empty description="还没有 RunningHub 应用" /></div> : null}
            </div>
        </div>
    );
}

function TasksTab({ tasks, loading, apps, onRefresh, onCancel }: { tasks: RunningHubAdminTask[]; loading: boolean; apps: RunningHubAdminApp[]; onRefresh: () => void; onCancel: (task: RunningHubAdminTask) => Promise<void> }) {
    const appNames = new Map(apps.map((app) => [app.id, app.name]));
    return <><div className="mb-3 flex justify-end"><Button icon={<RefreshCw className="size-4" />} onClick={onRefresh}>刷新任务</Button></div><Table rowKey="id" loading={loading} scroll={{ x: 780 }} pagination={{ pageSize: 20 }} dataSource={tasks} columns={[
        { title: "状态", dataIndex: "status", width: 96, render: (status: RunningHubAdminTask["status"]) => <StatusTag status={status} /> },
        { title: "应用", dataIndex: "appId", width: 180, render: (value: string) => appNames.get(value) || value || "已删除应用" },
        { title: "RunningHub 任务", dataIndex: "remoteTaskId", width: 220, render: (value: string) => <span className="font-mono text-xs">{value || "等待提交"}</span> },
        { title: "开始时间", dataIndex: "createdAt", width: 170, render: formatDate },
        { title: "结果", dataIndex: "resultUrls", width: 90, render: (urls: string[]) => `${urls.length} 个` },
        { title: "错误", dataIndex: "error", ellipsis: true, render: (value: string) => value || "—" },
        { title: "操作", key: "actions", fixed: "right", width: 90, render: (_: unknown, task: RunningHubAdminTask) => ["queued", "running"].includes(task.status) ? <Button size="small" danger onClick={() => void onCancel(task)}>取消</Button> : null },
    ]} /></>;
}

function LogsTab({ logs, loading, onRefresh, onClear }: { logs: RunningHubAdminLog[]; loading: boolean; onRefresh: () => void; onClear: () => void }) {
    return <><div className="mb-3 flex justify-end gap-2"><Button icon={<RefreshCw className="size-4" />} onClick={onRefresh}>刷新日志</Button><Button danger icon={<Trash2 className="size-4" />} onClick={onClear}>清空日志</Button></div><Table rowKey="id" loading={loading} scroll={{ x: 760 }} pagination={{ pageSize: 20 }} dataSource={logs} columns={[
        { title: "阶段", dataIndex: "phase", width: 100, render: (value: RunningHubAdminLog["phase"]) => phaseLabel(value) },
        { title: "路径", dataIndex: "path", width: 270, ellipsis: true },
        { title: "HTTP", dataIndex: "statusCode", width: 82, render: (value: number) => <Tag color={value >= 200 && value < 300 ? "green" : "red"}>{value || "网络错误"}</Tag> },
        { title: "耗时", dataIndex: "durationMs", width: 100, render: (value: number) => `${value} ms` },
        { title: "时间", dataIndex: "createdAt", width: 170, render: formatDate },
        { title: "错误", dataIndex: "error", ellipsis: true, render: (value: string) => value || "—" },
    ]} /></>;
}

function StatusTag({ status }: { status: RunningHubAdminTask["status"] }) {
    const map = { queued: ["排队中", "gold"], running: ["生成中", "processing"], success: ["成功", "green"], failed: ["失败", "red"], cancelled: ["已取消", "default"] } as const;
    return <Tag color={map[status][1]}>{map[status][0]}</Tag>;
}

function extractAccountMetrics(value: unknown) {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
    const labels: Record<string, string> = { remainCoins: "剩余 RH 币", coins: "RH 币余额", balance: "账户余额", remainMoney: "剩余余额", apiKeyStatus: "密钥状态", status: "账户状态", userName: "账户名称", nickname: "账户名称", taskCount: "任务数量" };
    return Object.entries(data).filter(([key, item]) => labels[key] && ["string", "number", "boolean"].includes(typeof item)).slice(0, 6).map(([key, item]) => ({ label: labels[key], value: typeof item === "boolean" ? (item ? "正常" : "不可用") : String(item) }));
}

function phaseLabel(value: RunningHubAdminLog["phase"]) {
    return ({ account: "账户", sync: "同步", upload: "上传", submit: "提交", query: "查询", cancel: "取消" } as const)[value];
}
function formatDate(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "—";
}
