"use client";

import { Alert, App, Button, Checkbox, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Tag } from "antd";
import { Music2, Pencil, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { TOKENHUB_MUSIC_MODELS } from "@/lib/minimax-audio";
import type { SystemModelChannel } from "@/lib/auth/store";
import { synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import type { MiniMaxMusicRecord } from "@/lib/server/minimax-audio-store";

type TokenHubLog = {
    id: string;
    createdAt: string;
    model: string;
    path: string;
    phase: string;
    statusCode: number;
    durationMs: number;
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
    lifecycle: Array<{ at: string; phase: string; message: string }>;
};

type TokenHubState = {
    channels: Array<Partial<SystemModelChannel> & { hasApiKey?: boolean }>;
    logs: { items: TokenHubLog[]; total: number; page: number; pageSize: number };
    music: MiniMaxMusicRecord[];
};

export function AdminTencentTokenHubMusicSection({ controller }: { controller: AdminDashboardController }) {
    const { message } = App.useApp();
    const { settings, setSettings, saveSettings, settingsLoading } = controller;
    const [state, setState] = useState<TokenHubState | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedLog, setSelectedLog] = useState<TokenHubLog | null>(null);
    const [tab, setTab] = useState<"music" | "logs">("music");
    const channel = useMemo(() => settings.systemChannels.find((item) => item.id === "tencent-tokenhub-music" || item.advancedConfig?.protocol === "tencent-tokenhub-music") || createTokenHubChannel(), [settings.systemChannels]);

    const load = useCallback(async (page = 1) => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`/api/admin/tencent-music?page=${page}`, { cache: "no-store" });
            const payload = (await response.json()) as TokenHubState & { error?: string };
            if (!response.ok) throw new Error(payload.error || "读取腾讯云 TokenHub 控制台失败");
            setState(payload);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取腾讯云 TokenHub 控制台失败");
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => void load(), [load]);

    const updateChannel = (patch: Partial<SystemModelChannel>) => {
        setSettings((current) => {
            const nextChannel = applyChannelProtocol({ ...channel, ...patch }, "tencent-tokenhub-music");
            const exists = current.systemChannels.some((item) => item.id === channel.id);
            const channels = exists ? current.systemChannels.map((item) => (item.id === channel.id ? nextChannel : item)) : [...current.systemChannels, nextChannel];
            return { ...current, systemChannels: channels, logicalModels: synchronizeLogicalModelsWithChannels(current.logicalModels, channels) };
        });
    };

    const save = async () => {
        const systemChannels = settings.systemChannels.some((item) => item.id === channel.id) ? settings.systemChannels.map((item) => (item.id === channel.id ? channel : item)) : [...settings.systemChannels, channel];
        const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, systemChannels);
        if (await saveSettings({ systemChannels, logicalModels }, "腾讯云 TokenHub 音乐渠道已保存")) await load(state?.logs.page || 1);
    };

    return <div className="space-y-4">
        {error ? <Alert type="error" showIcon message="TokenHub 控制台读取失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
        <Panel>
            <PanelHeader title="TokenHub" description="管理 TokenHub 音频/音乐模型、生成记录和调用日志。API Key 仅通过渠道安全保存。" actions={<Space wrap><Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<Save className="size-4" />} loading={settingsLoading} onClick={() => void save()}>保存配置</Button></Space>} />
            <div className="space-y-4 p-4 sm:p-5">
                <div className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1.5 text-sm"><span>渠道名称</span><Input value={channel.name} onChange={(event) => updateChannel({ name: event.target.value })} /></label>
                    <label className="space-y-1.5 text-sm"><span>Base URL</span><Input value={channel.baseUrl} onChange={(event) => updateChannel({ baseUrl: event.target.value })} /></label>
                    <label className="space-y-1.5 text-sm"><span>API Key {channel.hasApiKey ? <Tag color="green">已配置</Tag> : null}</span><Input.Password value={channel.apiKey} placeholder={channel.hasApiKey ? "留空保持已保存密钥" : "请输入腾讯云 TokenHub API Key"} onChange={(event) => updateChannel({ apiKey: event.target.value, enabled: true })} /></label>
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"><Switch checked={channel.enabled} onChange={(enabled) => updateChannel({ enabled })} /><span>启用 TokenHub 音乐渠道</span><Tag color={channel.enabled ? "green" : "default"}>{channel.enabled ? "已启用" : "已停用"}</Tag></div>
                <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="mb-2 flex items-center gap-2 text-sm font-medium"><Music2 className="size-4" />音乐模型</div><div className="flex flex-wrap gap-x-4 gap-y-2">{TOKENHUB_MUSIC_MODELS.map((model) => <Checkbox key={model} checked={channel.models.includes(model)} onChange={(event) => updateChannel({ models: event.target.checked ? Array.from(new Set([...channel.models, model])) : channel.models.filter((item) => item !== model) })}>{model}</Checkbox>)}</div></div>
                <Tabs activeKey={tab} onChange={(key) => setTab(key as "music" | "logs")} items={[{ key: "music", label: "音乐管理" }, { key: "logs", label: "请求日志" }]} />
                {tab === "music" ? <TokenHubMusicManagement records={state?.music || []} onRefresh={() => void load(state?.logs.page || 1)} onError={(text) => message.error(text)} /> : <div className="space-y-2"><div className="flex items-center justify-between border-b border-zinc-200 pb-2 text-sm dark:border-zinc-800"><span className="font-medium">请求日志</span><Button size="small" onClick={() => void load(state?.logs.page || 1)}>刷新日志</Button></div><Table rowKey="id" size="small" loading={loading} dataSource={state?.logs.items || []} pagination={{ current: state?.logs.page || 1, pageSize: state?.logs.pageSize || 20, total: state?.logs.total || 0, showSizeChanger: false, onChange: (page) => void load(page) }} onRow={(log) => ({ onClick: () => setSelectedLog(log), className: "cursor-pointer" })} columns={[{ title: "时间", dataIndex: "createdAt", render: (value) => new Date(value).toLocaleString() }, { title: "模型", dataIndex: "model" }, { title: "路径", dataIndex: "path" }, { title: "状态", dataIndex: "phase" }, { title: "HTTP", dataIndex: "statusCode" }, { title: "耗时", dataIndex: "durationMs", render: (value) => `${value} ms` }]} locale={{ emptyText: "暂无 TokenHub 请求日志" }} /></div>}
            </div>
        </Panel>
        <Modal open={Boolean(selectedLog)} title="TokenHub 音乐请求详情" footer={null} onCancel={() => setSelectedLog(null)} width={780}>
            {selectedLog ? <div className="space-y-4 text-sm"><div className="grid gap-3 sm:grid-cols-3"><div><div className="text-stone-500">状态</div><div>{selectedLog.phase} · HTTP {selectedLog.statusCode || "-"}</div></div><div><div className="text-stone-500">模型</div><div>{selectedLog.model}</div></div><div><div className="text-stone-500">路径</div><div className="break-all">POST {selectedLog.path}</div></div></div><div><div className="mb-1 text-stone-500">生命周期</div><div className="max-h-60 overflow-y-auto rounded-lg bg-stone-50 p-3 dark:bg-zinc-900">{selectedLog.lifecycle.map((item, index) => <div key={`${item.at}-${index}`} className="border-b border-stone-200 py-2 last:border-0 dark:border-zinc-800"><span className="mr-2 text-stone-500">{new Date(item.at).toLocaleString()}</span>{item.message}</div>)}</div></div><div className="grid gap-3 md:grid-cols-2"><LogPayload title="请求摘要" value={selectedLog.requestPreview} /><LogPayload title="响应/错误" value={selectedLog.responsePreview || selectedLog.error} /></div></div> : null}
        </Modal>
        {state?.channels.length === 0 ? <div className="text-xs text-stone-500">保存后才会创建 TokenHub 渠道并同步到模型路由。</div> : null}
    </div>;
}

function TokenHubMusicManagement({ records, onRefresh, onError }: { records: MiniMaxMusicRecord[]; onRefresh: () => void; onError: (text: string) => void }) {
    const [editing, setEditing] = useState<MiniMaxMusicRecord | null>(null);
    const [name, setName] = useState("");
    const updateName = async () => {
        if (!editing || !name.trim()) return;
        const response = await fetch(`/api/admin/tencent-music/${encodeURIComponent(editing.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
        if (!response.ok) return onError("TokenHub 音乐名称保存失败");
        setEditing(null);
        onRefresh();
    };
    const remove = async (record: MiniMaxMusicRecord) => {
        const response = await fetch(`/api/admin/tencent-music/${encodeURIComponent(record.id)}`, { method: "DELETE" });
        if (!response.ok) return onError("TokenHub 音乐记录删除失败");
        onRefresh();
    };
    return <div className="space-y-2"><div className="flex items-center justify-between border-b border-zinc-200 pb-2 text-sm dark:border-zinc-800"><span className="font-medium">音乐管理</span><span className="text-xs text-stone-500">仅显示 TokenHub 生成记录</span></div><Table rowKey="id" size="small" pagination={false} dataSource={records} columns={[{ title: "名称", dataIndex: "name" }, { title: "模型", dataIndex: "model" }, { title: "提示", dataIndex: "prompt", render: (value) => <span className="line-clamp-2 max-w-md">{value || "-"}</span> }, { title: "状态", dataIndex: "status" }, { title: "试听", dataIndex: "resultUrl", render: (value) => value ? <audio controls preload="none" src={value} className="h-8 w-52" /> : "-" }, { title: "操作", render: (_, record) => <Space><Button type="text" icon={<Pencil className="size-4" />} onClick={() => { setEditing(record); setName(record.name); }} aria-label="编辑 TokenHub 音乐名称" /><Popconfirm title="确认删除该 TokenHub 音乐记录？" onConfirm={() => void remove(record)}><Button type="text" danger icon={<Trash2 className="size-4" />} aria-label="删除 TokenHub 音乐记录" /></Popconfirm></Space> }]} locale={{ emptyText: "暂无 TokenHub 音乐记录" }} /><Modal open={Boolean(editing)} title="编辑 TokenHub 音乐名称" okText="保存" cancelText="取消" onCancel={() => setEditing(null)} onOk={() => void updateName()}><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Modal></div>;
}

function LogPayload({ title, value }: { title: string; value?: string }) {
    return <div><div className="mb-1 text-stone-500">{title}</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-50 p-3 text-xs dark:bg-zinc-900">{value || "-"}</pre></div>;
}

function createTokenHubChannel(): SystemModelChannel {
    return applyChannelProtocol({ id: "tencent-tokenhub-music", name: "腾讯云 TokenHub 音乐", baseUrl: "https://tokenhub.tencentmaas.com", apiKey: "", apiFormat: "openai", models: [...TOKENHUB_MUSIC_MODELS], enabled: true }, "tencent-tokenhub-music");
}
