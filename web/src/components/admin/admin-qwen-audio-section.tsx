"use client";

import { Alert, Button, Checkbox, Input, App, Modal, Select, Switch, Tabs, Table, Tag, type TableProps } from "antd";
import { Pencil, RefreshCw, Save, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { MINIMAX_VOICE_CATEGORIES } from "@/lib/minimax-audio";
import { QWEN_AUDIO_MODELS } from "@/lib/qwen-audio";
import { synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

type QwenVoice = { id: string; model?: string; name: string; voiceName: string; description: string; remoteVoiceId: string; voiceType: string; category?: string; scene?: string; voiceParam?: string; feature?: string; age?: string; gender?: string; language?: string; previewUrl?: string; providerCreatedTime?: string; createdAt: string };
type QwenAudioRecord = { id: string; taskId: string; userId: string; username: string; displayName: string; accountId: string; model: string; audioMode: string; prompt: string; textContent: string; voice?: string; format?: string; sampleRate?: string; resultUrl?: string; mimeType?: string; status: "pending" | "success" | "failed"; error?: string; createdAt: string; updatedAt: string };
type QwenState = { channels: Array<Partial<SystemModelChannel> & { hasApiKey?: boolean }>; system: QwenVoice[]; voices: QwenVoice[]; audio: { items: QwenAudioRecord[]; total: number; page: number; pageSize: number }; logs: { items: Array<{ id: string; createdAt: string; model: string; path: string; phase: string; statusCode: number; durationMs: number; error?: string; lifecycle: Array<{ at: string; message: string }> }>; total: number; page: number; pageSize: number } };

export function AdminQwenAudioSection({ controller }: { controller: AdminDashboardController }) {
    const { message } = App.useApp();
    const { settings, setSettings, saveSettings, settingsLoading } = controller;
    const [state, setState] = useState<QwenState | null>(null);
    const [tab, setTab] = useState("voices");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedLog, setSelectedLog] = useState<QwenState["logs"]["items"][number] | null>(null);
    const [editingVoice, setEditingVoice] = useState<QwenVoice | null>(null);
    const [voiceCategory, setVoiceCategory] = useState("");
    const channel = useMemo(() => {
        const current = settings.systemChannels.find((item) => item.id === "aliyun-bailian-audio" || item.advancedConfig?.protocol === "aliyun-bailian-audio");
        return current || createQwenChannel();
    }, [settings.systemChannels]);
    const load = useCallback(async (page = 1) => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`/api/admin/qwen-audio?page=${page}`, { cache: "no-store" });
            const payload = (await response.json()) as QwenState & { error?: string };
            if (!response.ok) throw new Error(payload.error || "读取阿里云百炼控制台失败");
            setState(payload);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取阿里云百炼控制台失败");
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => void load(), [load]);
    const updateChannel = (patch: Partial<SystemModelChannel>) => {
        setSettings((current) => {
            const next = applyChannelProtocol({ ...channel, ...patch }, "aliyun-bailian-audio");
            const exists = current.systemChannels.some((item) => item.id === channel.id);
            const channels = exists ? current.systemChannels.map((item) => (item.id === channel.id ? next : item)) : [...current.systemChannels, next];
            return { ...current, systemChannels: channels, logicalModels: synchronizeLogicalModelsWithChannels(current.logicalModels, channels) };
        });
    };
    const save = async () => {
        const exists = settings.systemChannels.some((item) => item.id === channel.id);
        const systemChannels = exists ? settings.systemChannels.map((item) => (item.id === channel.id ? channel : item)) : [...settings.systemChannels, channel];
        const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, systemChannels);
        if (await saveSettings({ systemChannels, logicalModels }, "阿里云百炼语音渠道已保存")) await load();
    };
    const saveVoiceCategory = async () => {
        if (!editingVoice) return;
        const response = await fetch(`/api/admin/qwen-audio/voices/${encodeURIComponent(editingVoice.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: voiceCategory }) });
        if (!response.ok) return message.error("音色分类保存失败");
        setEditingVoice(null);
        await load(state?.logs.page || 1);
    };
    return <div className="space-y-4">
        {error ? <Alert type="error" showIcon message="阿里云百炼控制台读取失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
        <Panel>
            <PanelHeader title="阿里云百炼语音控制台" description="管理 Qwen-Audio-TTS、CosyVoice、Qwen-TTS 的音色复刻、音色设计、模型启用状态和请求日志。" actions={<div className="flex gap-2"><Button onClick={() => { void load(); message.success("已获取百炼官方音色目录"); }}>获取全部音色</Button><Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<Save className="size-4" />} loading={settingsLoading} onClick={() => void save()}>保存配置</Button></div>} />
            <div className="space-y-4 p-4 sm:p-5">
                <div className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1.5 text-sm"><span>渠道名称</span><Input value={channel.name} onChange={(event) => updateChannel({ name: event.target.value })} /></label>
                    <label className="space-y-1.5 text-sm"><span>Base URL</span><Input value={channel.baseUrl} onChange={(event) => updateChannel({ baseUrl: event.target.value })} /></label>
                    <label className="space-y-1.5 text-sm"><span>API Key {channel.hasApiKey ? <Tag color="green">已配置</Tag> : null}</span><Input.Password value={channel.apiKey} placeholder={channel.hasApiKey ? "留空保持已保存密钥" : "请输入百炼 API Key"} onChange={(event) => updateChannel({ apiKey: event.target.value, enabled: true })} /></label>
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"><Switch checked={channel.enabled} onChange={(enabled) => updateChannel({ enabled })} /><span>启用阿里云百炼语音渠道</span><Tag color={channel.enabled ? "green" : "default"}>{channel.enabled ? "已启用" : "已停用"}</Tag></div>
                <div className="grid gap-3">
                    <ModelPicker label="音频模型可用性" values={channel.models.filter((model) => QWEN_AUDIO_MODELS.includes(model as never))} options={[...QWEN_AUDIO_MODELS]} onChange={(models) => updateChannel({ models })} />
                    <div className="text-xs text-stone-500">每个模型只显示一次，勾选状态同时控制该模型在文转语音、音色复刻和音色设计中的可用性；取消最后一个模型也会保留为空。</div>
                </div>
                <Tabs activeKey={tab} onChange={setTab} items={[{ key: "system", label: `系统音色（${state?.system.length || 0}）` }, { key: "voices", label: `个人创建（${state?.voices.length || 0}）` }, { key: "audio", label: `音频管理（${state?.audio?.total || 0}）` }, { key: "logs", label: "请求日志" }]} />
                {tab === "system" ? <QwenVoiceTable voices={state?.system || []} emptyText="暂无官方音色目录" /> : tab === "voices" ? <QwenVoiceTable voices={state?.voices || []} emptyText="暂无阿里云百炼个人音色" onEdit={(voice) => { setEditingVoice(voice); setVoiceCategory(voice.category || voice.feature || "其他"); }} /> : tab === "audio" ? <AudioManagement state={state} onPageChange={(page) => void load(page)} /> : <Table rowKey="id" size="small" dataSource={state?.logs.items || []} pagination={{ current: state?.logs.page, pageSize: state?.logs.pageSize, total: state?.logs.total, showSizeChanger: false, onChange: (page) => void load(page) }} onRow={(log) => ({ onClick: () => setSelectedLog(log), className: "cursor-pointer" })} columns={[{ title: "时间", dataIndex: "createdAt", render: (value) => new Date(value).toLocaleString() }, { title: "模型", dataIndex: "model" }, { title: "路径", dataIndex: "path" }, { title: "状态", dataIndex: "phase" }, { title: "HTTP", dataIndex: "statusCode" }, { title: "耗时", dataIndex: "durationMs", render: (value) => `${value} ms` }]} locale={{ emptyText: "暂无阿里云百炼请求日志" }} />}
            </div>
        </Panel>
        <ModalLog log={selectedLog} onClose={() => setSelectedLog(null)} />
        <Modal open={Boolean(editingVoice)} title="编辑百炼音色分类" okText="保存" cancelText="取消" onCancel={() => setEditingVoice(null)} onOk={() => void saveVoiceCategory()}><Select className="w-full" value={voiceCategory} options={MINIMAX_VOICE_CATEGORIES.map((item) => ({ value: item, label: item }))} onChange={setVoiceCategory} /></Modal>
    </div>;
}

function ModelPicker({ label, values, options, onChange }: { label: string; values: string[]; options: string[]; onChange: (values: string[]) => void }) {
    return <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="mb-2 flex items-center gap-2 text-sm font-medium"><Volume2 className="size-4" />{label}</div><div className="flex flex-wrap gap-x-4 gap-y-2">{options.map((value) => <Checkbox key={value} checked={values.includes(value)} onChange={(event) => onChange(event.target.checked ? Array.from(new Set([...values, value])) : values.filter((item) => item !== value))}>{value}</Checkbox>)}</div></div>;
}

function QwenVoiceTable({ voices, emptyText, onEdit }: { voices: QwenVoice[]; emptyText: string; onEdit?: (voice: QwenVoice) => void }) {
    const columns: TableProps<QwenVoice>["columns"] = [
        { title: "场景", dataIndex: "scene", width: 180, render: (value) => value || "-" },
        { title: "音色名称", dataIndex: "voiceName", width: 140 },
        { title: "音色参数", dataIndex: "voiceParam", width: 180, render: (value, voice) => value || voice.remoteVoiceId },
        { title: "特征", dataIndex: "feature", width: 140, render: (value, voice) => value || voice.description || "-" },
        { title: "年龄", dataIndex: "age", width: 80 },
        { title: "性别", dataIndex: "gender", width: 80 },
        { title: "语言", dataIndex: "language", width: 160 },
        { title: "模型", dataIndex: "model", width: 190 },
        { title: "试听", dataIndex: "previewUrl", width: 150, render: (value) => value ? <audio controls preload="none" src={value} className="h-8 w-36" /> : "暂无试听" },
        { title: "创建时间", dataIndex: "providerCreatedTime", width: 170, render: (value) => value ? new Date(value).toLocaleString() : "-" },
        ...(onEdit ? [{ title: "操作", width: 80, render: (_value: unknown, voice: QwenVoice) => <Button type="text" icon={<Pencil className="size-4" />} onClick={() => onEdit(voice)} aria-label="编辑音色分类" /> }] : []),
    ];
    return <Table rowKey="id" size="small" scroll={{ x: onEdit ? 1160 : 1080 }} dataSource={voices} pagination={{ pageSize: 25, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} columns={columns} locale={{ emptyText }} />;
}

function AudioManagement({ state, onPageChange }: { state: QwenState | null; onPageChange: (page: number) => void }) {
    const records = state?.audio?.items || [];
    return <Table
        rowKey="id"
        size="small"
        scroll={{ x: 1420 }}
        dataSource={records}
        pagination={{ current: state?.audio?.page || 1, pageSize: state?.audio?.pageSize || 25, total: state?.audio?.total || 0, showSizeChanger: false, showTotal: (total) => `共 ${total} 条`, onChange: onPageChange }}
        columns={[
            { title: "生成时间", dataIndex: "createdAt", width: 170, render: (value) => new Date(value).toLocaleString() },
            { title: "提交用户", dataIndex: "displayName", width: 170, render: (value, record) => <div><div>{value || record.username || "已删除用户"}</div><div className="text-xs text-stone-500">{record.username || "-"}{record.accountId ? ` · ID：${record.accountId}` : ""}</div></div> },
            { title: "模型", dataIndex: "model", width: 190 },
            { title: "类型", dataIndex: "audioMode", width: 100, render: (value) => value === "tts" ? "文转语音" : value === "voice-clone" ? "音色复刻" : value === "voice-design" ? "音色设计" : value },
            { title: "提示词", dataIndex: "prompt", width: 260, render: (value) => <span className="line-clamp-2 max-w-xs whitespace-pre-wrap">{value || "-"}</span> },
            { title: "文本内容", dataIndex: "textContent", width: 300, render: (value) => <span className="line-clamp-2 max-w-sm whitespace-pre-wrap">{value || "-"}</span> },
            { title: "音色", dataIndex: "voice", width: 160, render: (value) => value || "-" },
            { title: "状态", dataIndex: "status", width: 90, render: (value, record) => <Tag color={value === "success" ? "green" : value === "failed" ? "red" : "gold"}>{value === "success" ? "成功" : value === "failed" ? record.error || "失败" : "生成中"}</Tag> },
            { title: "试听", dataIndex: "resultUrl", width: 220, render: (value) => value ? <audio controls preload="none" src={value} className="h-8 w-52" /> : "暂无结果" },
        ]}
        locale={{ emptyText: "暂无百炼语音生成记录" }}
    />;
}

function ModalLog({ log, onClose }: { log: QwenState["logs"]["items"][number] | null; onClose: () => void }) {
    return <div>{log ? <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4" onClick={onClose}><div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 dark:bg-zinc-900" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-center justify-between text-lg font-semibold"><span>阿里云百炼请求详情</span><Button type="text" onClick={onClose}>关闭</Button></div><div className="grid gap-3 text-sm sm:grid-cols-3"><div>状态：{log.phase}</div><div>HTTP：{log.statusCode || "-"}</div><div>耗时：{log.durationMs} ms</div></div><div className="mt-4 space-y-2 text-sm">{log.lifecycle.map((item, index) => <div key={`${item.at}-${index}`} className="border-b border-zinc-200 py-2 dark:border-zinc-800"><span className="mr-2 text-zinc-500">{new Date(item.at).toLocaleString()}</span>{item.message}</div>)}</div>{log.error ? <pre className="mt-4 whitespace-pre-wrap break-all rounded-lg bg-red-50 p-3 text-xs text-red-700">{log.error}</pre> : null}</div></div> : null}</div>;
}

function createQwenChannel(): SystemModelChannel {
    return applyChannelProtocol({ id: "aliyun-bailian-audio", name: "阿里云百炼语音", baseUrl: "https://dashscope.aliyuncs.com/api/v1", apiKey: "", apiFormat: "openai", models: [...QWEN_AUDIO_MODELS], enabled: true }, "aliyun-bailian-audio");
}
