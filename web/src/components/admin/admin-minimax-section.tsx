"use client";

import { Alert, App, Button, Checkbox, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import { Music2, Pencil, RefreshCw, Save, Trash2, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { MINIMAX_MUSIC_MODELS, MINIMAX_SPEECH_MODELS, MINIMAX_VOICE_CATEGORIES, normalizeMiniMaxBaseUrl } from "@/lib/minimax-audio";
import { synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { getMiniMaxAdminState, syncMiniMaxVoices, type MiniMaxAdminState } from "@/services/api/minimax";

type MiniMaxTab = "voices" | "music" | "logs";
type MiniMaxVoiceGroup = "system" | "personal";

export function AdminMiniMaxSection({ controller }: { controller: AdminDashboardController }) {
    const { message } = App.useApp();
    const { settings, setSettings, saveSettings, settingsLoading } = controller;
    const [tab, setTab] = useState<MiniMaxTab>("voices");
    const [state, setState] = useState<MiniMaxAdminState | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedLog, setSelectedLog] = useState<MiniMaxAdminState["logs"]["items"][number] | null>(null);
    const channel = useMemo(() => {
        const current = settings.systemChannels.find((item) => item.id === "minimax-audio" || item.advancedConfig?.protocol === "minimax-audio");
        return current ? { ...current, baseUrl: normalizeMiniMaxBaseUrl(current.baseUrl) } : createMiniMaxChannel();
    }, [settings.systemChannels]);

    const load = useCallback(async (page = 1) => {
        setLoading(true);
        setError("");
        try {
            setState(await getMiniMaxAdminState(page));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取 MiniMax 控制台失败");
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => void load(), [load]);

    const updateChannel = (patch: Partial<SystemModelChannel>) => {
        setSettings((current) => {
            const exists = current.systemChannels.some((item) => item.id === channel.id);
            const nextChannel = applyChannelProtocol({ ...channel, ...patch }, "minimax-audio");
            const channels = exists ? current.systemChannels.map((item) => (item.id === channel.id ? nextChannel : item)) : [...current.systemChannels, nextChannel];
            const logicalModels = synchronizeLogicalModelsWithChannels(current.logicalModels, channels);
            return { ...current, systemChannels: channels, logicalModels };
        });
    };

    const updateVoiceFeature = (key: "minimaxVoiceCloneEnabled" | "minimaxVoiceDesignEnabled" | "minimaxMusicEnabled", enabled: boolean) => {
        if (!channel.advancedConfig) return;
        updateChannel({ advancedConfig: { ...channel.advancedConfig, [key]: enabled } });
    };

    const save = async () => {
        const savedChannel = applyChannelProtocol(channel, "minimax-audio");
        const exists = settings.systemChannels.some((item) => item.id === savedChannel.id);
        const systemChannels = exists ? settings.systemChannels.map((item) => (item.id === savedChannel.id ? savedChannel : item)) : [...settings.systemChannels, savedChannel];
        const synchronizedModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, systemChannels);
        const { logicalModels, aliases } = promoteMiniMaxLogicalModels(synchronizedModels, savedChannel);
        const defaultModels = aliases[settings.defaultModels.audioModel] ? { ...settings.defaultModels, audioModel: aliases[settings.defaultModels.audioModel] } : settings.defaultModels;
        const ok = await saveSettings({ systemChannels, logicalModels, defaultModels }, "MiniMax 音频渠道已保存");
        if (ok) await load();
    };

    const syncVoices = async () => {
        try {
            const voices = await syncMiniMaxVoices();
            setState((current) => (current ? { ...current, voices } : current));
            await load(state?.logs.page || 1);
            message.success(`已同步 ${voices.length} 个 MiniMax 音色`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "同步音色失败");
        }
    };

    return (
        <div className="space-y-4">
            {error ? <Alert type="error" showIcon message="MiniMax 控制台读取失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
            <Panel>
                <PanelHeader
                    title="MiniMax 音频控制台"
                    description="配置官方语音与音乐模型，并管理音色目录、音乐记录和调用过程日志。API Key 仅通过渠道安全保存。"
                    actions={<Space wrap><Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<Save className="size-4" />} loading={settingsLoading} onClick={() => void save()}>保存配置</Button></Space>}
                />
                <div className="space-y-4 p-4 sm:p-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className="space-y-1.5 text-sm"><span>渠道名称</span><Input value={channel.name} onChange={(event) => updateChannel({ name: event.target.value })} /></label>
                        <label className="space-y-1.5 text-sm"><span>Base URL</span><Input value={channel.baseUrl} onChange={(event) => updateChannel({ baseUrl: event.target.value })} /></label>
                        <label className="space-y-1.5 text-sm"><span>API Key {channel.hasApiKey ? <Tag color="green">已配置</Tag> : null}</span><Input.Password placeholder={channel.hasApiKey ? "留空保持已保存密钥" : "请输入 MiniMax API Key"} value={channel.apiKey} onChange={(event) => updateChannel({ apiKey: event.target.value, enabled: true })} /></label>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                        <Switch checked={channel.enabled} onChange={(enabled) => updateChannel({ enabled })} />
                        <span>启用 MiniMax 音频渠道</span>
                        <Tag color={channel.enabled ? "green" : "default"}>{channel.enabled ? "已启用" : "已停用"}</Tag>
                        {!channel.enabled ? <span className="text-stone-500">同步音色、语音和音乐请求前必须启用渠道。</span> : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 text-sm dark:border-zinc-800"><div><div className="font-medium">允许音色复刻</div><div className="text-xs text-stone-500">关闭后 MiniMax 不会提交复刻请求，改用阿里云百炼或其他已启用模型。</div></div><Switch checked={channel.advancedConfig?.minimaxVoiceCloneEnabled !== false} onChange={(enabled) => updateVoiceFeature("minimaxVoiceCloneEnabled", enabled)} /></div>
                        <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 text-sm dark:border-zinc-800"><div><div className="font-medium">允许音色设计</div><div className="text-xs text-stone-500">关闭后 MiniMax 不会提交设计请求，避免产生一次性音色费用。</div></div><Switch checked={channel.advancedConfig?.minimaxVoiceDesignEnabled !== false} onChange={(enabled) => updateVoiceFeature("minimaxVoiceDesignEnabled", enabled)} /></div>
                        <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 text-sm dark:border-zinc-800"><div><div className="font-medium">允许音乐设计</div><div className="text-xs text-stone-500">关闭后前端不显示 MiniMax 音乐设计模型，不会提交音乐生成请求。</div></div><Switch checked={channel.advancedConfig?.minimaxMusicEnabled !== false} onChange={(enabled) => updateVoiceFeature("minimaxMusicEnabled", enabled)} /></div>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        <ModelPicker label="语音模型" icon={<Volume2 className="size-4" />} values={channel.models.filter((model) => MINIMAX_SPEECH_MODELS.includes(model as (typeof MINIMAX_SPEECH_MODELS)[number]))} options={[...MINIMAX_SPEECH_MODELS]} onChange={(models) => updateChannel({ models: [...models, ...channel.models.filter((model) => MINIMAX_MUSIC_MODELS.includes(model as (typeof MINIMAX_MUSIC_MODELS)[number]))] })} />
                        <ModelPicker label="音乐模型" icon={<Music2 className="size-4" />} values={channel.models.filter((model) => MINIMAX_MUSIC_MODELS.includes(model as (typeof MINIMAX_MUSIC_MODELS)[number]))} options={[...MINIMAX_MUSIC_MODELS]} onChange={(models) => updateChannel({ models: [...channel.models.filter((model) => MINIMAX_SPEECH_MODELS.includes(model as (typeof MINIMAX_SPEECH_MODELS)[number])), ...models] })} />
                    </div>
                    <Tabs activeKey={tab} onChange={(key) => setTab(key as MiniMaxTab)} items={[{ key: "voices", label: "音色管理" }, { key: "music", label: "音乐管理" }, { key: "logs", label: "请求日志" }]} />
                    {tab === "voices" ? <VoiceManagement state={state} onSync={() => void syncVoices()} /> : null}
                    {tab === "music" ? <MusicManagement state={state} onRefresh={() => void load()} /> : null}
                    {tab === "logs" ? <RequestLogs state={state} onSelect={setSelectedLog} onPageChange={(page) => void load(page)} /> : null}
                </div>
            </Panel>
            <Modal open={Boolean(selectedLog)} title="MiniMax 请求详情" footer={null} onCancel={() => setSelectedLog(null)} width={760}>
                {selectedLog ? <div className="space-y-4 text-sm"><div className="grid gap-3 sm:grid-cols-3"><div><div className="text-stone-500">状态</div><div>{selectedLog.phase} · HTTP {selectedLog.statusCode || "-"}</div></div><div><div className="text-stone-500">模型</div><div>{selectedLog.model}</div></div><div><div className="text-stone-500">路径</div><div className="break-all">{selectedLog.method} {selectedLog.path}</div></div></div><div><div className="mb-1 text-stone-500">生命周期</div><div className="max-h-52 overflow-y-auto rounded-lg bg-stone-50 p-3 dark:bg-zinc-900">{selectedLog.lifecycle.map((item, index) => <div key={`${item.at}-${index}`} className="border-b border-stone-200 py-2 last:border-0 dark:border-zinc-800"><span className="mr-2 text-stone-500">{new Date(item.at).toLocaleString()}</span>{item.message}</div>)}</div></div><div className="grid gap-3 md:grid-cols-2"><LogPayload title="请求" value={selectedLog.requestPreview} /><LogPayload title="响应" value={selectedLog.responsePreview || selectedLog.error} /></div></div> : null}
            </Modal>
        </div>
    );
}

function ModelPicker({ label, icon, values, options, onChange }: { label: string; icon: React.ReactNode; values: string[]; options: string[]; onChange: (values: string[]) => void }) {
    return <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="mb-2 flex items-center gap-2 text-sm font-medium">{icon}{label}</div><div className="flex flex-wrap gap-x-4 gap-y-2">{options.map((value) => <Checkbox key={value} checked={values.includes(value)} onChange={(event) => onChange(event.target.checked ? Array.from(new Set([...values, value])) : values.filter((item) => item !== value))}>{value}</Checkbox>)}</div></div>;
}

function VoiceManagement({ state, onSync }: { state: MiniMaxAdminState | null; onSync: () => void }) {
    const { message } = App.useApp();
    const voices = state?.voices || [];
    const [group, setGroup] = useState<MiniMaxVoiceGroup>("system");
    const [editing, setEditing] = useState<(typeof voices)[number] | null>(null);
    const [name, setName] = useState("");
    const [category, setCategory] = useState("");
    const systemVoices = voices.filter((voice) => voice.voiceType === "system");
    const personalVoices = voices.filter((voice) => voice.voiceType !== "system");
    const visibleVoices = group === "system" ? systemVoices : personalVoices;
    const updateVisibility = async (voice: (typeof voices)[number], visible: boolean) => {
        await fetch(`/api/admin/minimax/voices/${encodeURIComponent(voice.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visible }) });
        onSync();
    };
    const removeVoice = async (voice: (typeof voices)[number]) => {
        await fetch(`/api/admin/minimax/voices/${encodeURIComponent(voice.id)}`, { method: "DELETE" });
        onSync();
    };
    const updateName = async () => {
        if (!editing || !name.trim()) return;
        const response = await fetch(`/api/admin/minimax/voices/${encodeURIComponent(editing.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), category }) });
        if (!response.ok) return message.error("音色名称保存失败");
        setEditing(null);
        onSync();
    };
    return <>
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm text-stone-500">系统音色与用户创建音色分组管理；用户端个人音色按用户隔离。</div><Button onClick={onSync}>获取全部音色</Button></div>
            <Tabs activeKey={group} onChange={(key) => setGroup(key as MiniMaxVoiceGroup)} items={[{ key: "system", label: `系统音色（${systemVoices.length}）` }, { key: "personal", label: `用户创建（${personalVoices.length}）` }]} />
            <Table
                rowKey="id"
                size="small"
                pagination={{ pageSize: 25, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
                dataSource={visibleVoices}
                columns={[
                    { title: "音色名称", dataIndex: "voiceName", render: (value, voice) => <div><div className="font-medium">{value || voice.name}</div><div className="text-xs text-stone-500">前端显示：{voice.name}</div></div> },
                    { title: "音色介绍", dataIndex: "description", render: (value) => <span className="line-clamp-2 max-w-sm text-xs text-stone-600 dark:text-stone-300">{value || "暂无介绍"}</span> },
                    { title: "创建时间", dataIndex: "providerCreatedTime", render: (value) => value ? new Date(value).toLocaleString() : "-" },
                    { title: "分类", dataIndex: "category" },
                    { title: "远端 ID", dataIndex: "remoteVoiceId", render: (value) => <span className="break-all text-xs">{value}</span> },
                    { title: "类型", render: (_, voice) => voice.voiceType === "system" ? "系统音色" : voice.voiceType === "voice_generation" ? "音色设计" : "音色复刻" },
                    { title: "前端显示", render: (_, voice) => <Switch size="small" checked={voice.visible} onChange={(checked) => void updateVisibility(voice, checked)} /> },
                    { title: "操作", render: (_, voice) => <Space><Button type="text" icon={<Pencil className="size-4" />} onClick={() => { setEditing(voice); setName(voice.name); setCategory(voice.category); }} aria-label="编辑音色名称和分类" /><Popconfirm title="确认删除该音色？" onConfirm={() => void removeVoice(voice)}><Button type="text" danger icon={<Trash2 className="size-4" />} aria-label="删除音色" /></Popconfirm></Space> },
                ]}
                locale={{ emptyText: group === "system" ? "暂无系统音色，请先获取全部音色" : "暂无用户创建音色" }}
            />
        </div>
        <Modal open={Boolean(editing)} title="编辑音色名称和分类" okText="保存" cancelText="取消" onCancel={() => setEditing(null)} onOk={() => void updateName()}><div className="space-y-3"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /><Select className="w-full" value={category} options={MINIMAX_VOICE_CATEGORIES.map((item) => ({ value: item, label: item }))} onChange={setCategory} /></div></Modal>
    </>;
}

function MusicManagement({ state, onRefresh }: { state: MiniMaxAdminState | null; onRefresh: () => void }) {
    const { message } = App.useApp();
    const [editing, setEditing] = useState<MiniMaxAdminState["music"][number] | null>(null);
    const [name, setName] = useState("");
    const updateName = async () => {
        if (!editing || !name.trim()) return;
        const response = await fetch(`/api/admin/minimax/music/${encodeURIComponent(editing.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
        if (!response.ok) return message.error("音乐名称保存失败");
        setEditing(null);
        onRefresh();
    };
    const remove = async (record: MiniMaxAdminState["music"][number]) => {
        const response = await fetch(`/api/admin/minimax/music/${encodeURIComponent(record.id)}`, { method: "DELETE" });
        if (!response.ok) return message.error("音乐记录删除失败");
        onRefresh();
    };
    return <><Table rowKey="id" size="small" pagination={false} dataSource={state?.music || []} columns={[{ title: "名称", dataIndex: "name" }, { title: "模型", dataIndex: "model" }, { title: "风格/提示", dataIndex: "prompt", render: (value) => <span className="line-clamp-2 max-w-md">{value || "-"}</span> }, { title: "歌词", dataIndex: "lyrics", render: (value) => <span className="line-clamp-2 max-w-md">{value || "器乐"}</span> }, { title: "状态", dataIndex: "status" }, { title: "结果", dataIndex: "resultUrl", render: (value) => value ? <a href={value} target="_blank" rel="noreferrer">试听</a> : "-" }, { title: "操作", render: (_, record) => <Space><Button type="text" icon={<Pencil className="size-4" />} onClick={() => { setEditing(record); setName(record.name); }} aria-label="编辑音乐名称" /><Popconfirm title="确认删除该音乐记录？" onConfirm={() => void remove(record)}><Button type="text" danger icon={<Trash2 className="size-4" />} aria-label="删除音乐记录" /></Popconfirm></Space> }]} locale={{ emptyText: "暂无 MiniMax 音乐记录，完成一次音乐生成后会自动出现" }} /><Modal open={Boolean(editing)} title="编辑音乐名称" okText="保存" cancelText="取消" onCancel={() => setEditing(null)} onOk={() => void updateName()}><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Modal></>;
}

function RequestLogs({ state, onSelect, onPageChange }: { state: MiniMaxAdminState | null; onSelect: (log: MiniMaxAdminState["logs"]["items"][number]) => void; onPageChange: (page: number) => void }) {
    const logs = state?.logs.items || [];
    return <Table rowKey="id" size="small" pagination={{ current: state?.logs.page || 1, pageSize: state?.logs.pageSize || 20, total: state?.logs.total || 0, showSizeChanger: false, onChange: onPageChange }} dataSource={logs} onRow={(log) => ({ onClick: () => onSelect(log), className: "cursor-pointer" })} columns={[{ title: "时间", dataIndex: "createdAt", render: (value) => new Date(value).toLocaleString() }, { title: "能力", dataIndex: "capability" }, { title: "模型", dataIndex: "model" }, { title: "路径", dataIndex: "path" }, { title: "状态", dataIndex: "phase" }, { title: "耗时", dataIndex: "durationMs", render: (value) => `${value} ms` }, { title: "结果", dataIndex: "statusCode" }]} locale={{ emptyText: "暂无 MiniMax 请求日志" }} />;
}

function LogPayload({ title, value }: { title: string; value?: string }) {
    return <div><div className="mb-1 text-stone-500">{title}</div><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-50 p-3 text-xs dark:bg-zinc-900">{value || "-"}</pre></div>;
}

function createMiniMaxChannel(): SystemModelChannel {
    return applyChannelProtocol({ id: "minimax-audio", name: "MiniMax 音频", baseUrl: normalizeMiniMaxBaseUrl(""), apiKey: "", apiFormat: "openai", models: [...MINIMAX_SPEECH_MODELS, ...MINIMAX_MUSIC_MODELS], enabled: true }, "minimax-audio");
}

function promoteMiniMaxLogicalModels(models: LogicalModel[], channel: SystemModelChannel) {
    const miniMaxModels = new Set(channel.models.map((model) => model.trim().toLowerCase()));
    const aliases: Record<string, string> = {};
    const result: LogicalModel[] = [];
    const handled = new Set<string>();
    for (const model of models) {
        if (model.capability !== "audio") {
            result.push(model);
            continue;
        }
        const upstream = model.bindings.find((binding) => miniMaxModels.has(binding.upstreamModel.trim().toLowerCase()))?.upstreamModel.trim().toLowerCase();
        if (!upstream || handled.has(upstream)) {
            if (!upstream) result.push(model);
            continue;
        }
        const matching = models.filter((candidate) => candidate.capability === "audio" && candidate.bindings.some((binding) => binding.upstreamModel.trim().toLowerCase() === upstream));
        const primary = matching.find((candidate) => candidate.id.trim().toLowerCase() === upstream) || matching[0] || model;
        const bindings = new Map<string, LogicalModel["bindings"][number]>();
        matching.flatMap((candidate) => candidate.bindings).forEach((binding) => bindings.set(`${binding.channelId}:${binding.upstreamModel.trim().toLowerCase()}`, binding));
        const miniMaxBinding = { id: `${channel.id}:${upstream}`, channelId: channel.id, upstreamModel: primary.bindings.find((binding) => binding.upstreamModel.trim().toLowerCase() === upstream)?.upstreamModel || upstream, enabled: true, priority: 0 };
        bindings.set(`${channel.id}:${upstream}`, miniMaxBinding);
        matching.forEach((candidate) => {
            if (candidate.id !== primary.id) aliases[candidate.id] = primary.id;
        });
        result.push({ ...primary, bindings: Array.from(bindings.values()).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)) });
        handled.add(upstream);
    }
    return { logicalModels: result, aliases };
}
