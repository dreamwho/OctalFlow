"use client";

import { App, Button, Checkbox, Drawer, Empty, Input, InputNumber, Popconfirm, Select, Space, Switch, Tag } from "antd";
import type { CheckboxChangeEvent } from "antd";
import { AlertTriangle, GitBranch, Pencil, Plus, RefreshCw, Route, Search, Trash2 } from "lucide-react";
import { type ChangeEvent, useDeferredValue, useMemo, useState } from "react";

import { LabeledControl, SectionTitle } from "@/components/admin/admin-settings-controls";
import type { LogicalModel, LogicalModelBinding, LogicalModelCapability, LogicalModelCapabilityProfile, SystemDefaultModels, SystemModelChannel } from "@/lib/auth/store";
import { capabilityLabel, isLogicalModelResolvable, normalizeDefaultModelsConfig, resolveLogicalModelConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";

type Props = {
    channels: SystemModelChannel[];
    logicalModels: LogicalModel[];
    defaultModels: SystemDefaultModels;
    onChange: (value: { logicalModels: LogicalModel[]; defaultModels: SystemDefaultModels }) => void;
};

const capabilityOptions: Array<{ label: string; value: LogicalModelCapability }> = [
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const defaultFields: Array<{ capability: LogicalModelCapability; key: keyof SystemDefaultModels; label: string }> = [
    { capability: "text", key: "textModel", label: "默认文本模型" },
    { capability: "image", key: "imageModel", label: "默认图片模型" },
    { capability: "video", key: "videoModel", label: "默认视频模型" },
    { capability: "audio", key: "audioModel", label: "默认音频模型" },
];

export function AdminLogicalModelManager({ channels, logicalModels, defaultModels, onChange }: Props) {
    const { message } = App.useApp();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingId, setEditingId] = useState("");
    const [draft, setDraft] = useState<LogicalModel | null>(null);
    const [query, setQuery] = useState("");
    const [capabilityFilter, setCapabilityFilter] = useState<LogicalModelCapability | "all">("all");
    const deferredQuery = useDeferredValue(query.trim().toLowerCase());
    const visibleModels = useMemo(
        () =>
            logicalModels.filter(
                (model) => (capabilityFilter === "all" || model.capability === capabilityFilter) && (!deferredQuery || `${model.id} ${model.name} ${model.bindings.map((binding) => binding.upstreamModel).join(" ")}`.toLowerCase().includes(deferredQuery)),
            ),
        [capabilityFilter, deferredQuery, logicalModels],
    );
    const availableDefaultFields = defaultFields.filter(({ capability }) => logicalModels.some((model) => model.capability === capability && isLogicalModelResolvable(logicalModels, channels, capability, model.id)));
    const readyCount = availableDefaultFields.filter(({ capability, key }) => isLogicalModelResolvable(logicalModels, channels, capability, defaultModels[key])).length;

    const openEdit = (model: LogicalModel) => {
        setEditingId(model.id);
        setDraft(cloneLogicalModel(model));
        setDrawerOpen(true);
    };

    const openCreate = () => {
        const channel = channels.find((item) => item.models.length);
        const upstreamModel = channel?.models[0] || "";
        const id = uniqueDraftId("custom-model", logicalModels);
        setEditingId("");
        setDraft({
            id,
            name: "自定义模型",
            capability: "text",
            enabled: true,
            bindings: channel && upstreamModel ? [{ id: `${channel.id}:${upstreamModel}:${Date.now()}`, channelId: channel.id, upstreamModel, enabled: true, priority: 1 }] : [],
        });
        setDrawerOpen(true);
    };

    const saveDraft = () => {
        if (!draft) return;
        const id = draft.id.trim();
        const name = draft.name.trim();
        if (!id || !/^[a-zA-Z0-9._/-]+$/.test(id)) {
            message.error("逻辑模型 ID 只能包含字母、数字、点、下划线、斜杠和短横线");
            return;
        }
        if (!name) return void message.error("请填写前端展示昵称");
        if (!draft.bindings.length) return void message.error("请至少添加一个渠道绑定");
        if (logicalModels.some((model) => model.id.toLowerCase() === id.toLowerCase() && model.id !== editingId)) return void message.error("逻辑模型 ID 已存在");
        const bindingKeys = draft.bindings.map((binding) => `${binding.channelId}:${binding.upstreamModel.trim().toLowerCase()}`);
        if (new Set(bindingKeys).size !== bindingKeys.length) return void message.error("同一逻辑模型中不能重复绑定相同的渠道模型");
        const saved = cloneLogicalModel({ ...draft, id, name });
        const nextModels = editingId ? logicalModels.map((model) => (model.id === editingId ? saved : model)) : [...logicalModels, saved];
        const renamedDefaults = Object.fromEntries(Object.entries(defaultModels).map(([key, value]) => [key, editingId && value === editingId ? id : value])) as SystemDefaultModels;
        onChange({ logicalModels: nextModels, defaultModels: normalizeDefaultModelsConfig(renamedDefaults, nextModels, channels) });
        setDrawerOpen(false);
        message.success(editingId ? "逻辑模型已更新，请保存渠道配置" : "逻辑模型已创建，请保存渠道配置");
    };

    const deleteModel = (modelId: string) => {
        const nextModels = logicalModels.filter((model) => model.id !== modelId);
        onChange({ logicalModels: nextModels, defaultModels: normalizeDefaultModelsConfig(defaultModels, nextModels, channels) });
        message.success("逻辑模型已删除，请保存渠道配置");
    };

    const syncChannelModels = () => {
        const nextModels = synchronizeLogicalModelsWithChannels(logicalModels, channels);
        if (JSON.stringify(nextModels) === JSON.stringify(logicalModels)) {
            message.info("逻辑模型已与渠道目录同步");
            return;
        }
        onChange({ logicalModels: nextModels, defaultModels: normalizeDefaultModelsConfig(defaultModels, nextModels, channels) });
        message.success(`已同步 ${nextModels.length} 个逻辑模型；同名上游路径保持按渠道独立`);
    };

    const updateDefault = (key: keyof SystemDefaultModels, modelId: string) => onChange({ logicalModels, defaultModels: { ...defaultModels, [key]: modelId } });

    return (
        <section className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <SectionTitle icon={<Route className="size-4" />} title="逻辑模型路由" />
                        <Tag color={availableDefaultFields.length && readyCount === availableDefaultFields.length ? "green" : "orange"} className="m-0">
                            默认能力 {readyCount}/{availableDefaultFields.length} 可用
                        </Tag>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">逻辑模型拥有独立的前端 ID 与昵称，并明确绑定渠道和上游模型。相同上游模型可以创建多个前端模型，分别固定到不同渠道。</p>
                </div>
                <Space wrap size={6}>
                    <Button icon={<RefreshCw className="size-4" />} onClick={syncChannelModels}>
                        同步未绑定模型
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} disabled={!channels.some((channel) => channel.models.length)} onClick={openCreate}>
                        新建逻辑模型
                    </Button>
                </Space>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0">
                    <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                        <Input allowClear value={query} prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索模型昵称、ID 或上游模型" onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} />
                        <Select value={capabilityFilter} options={[{ label: "全部能力", value: "all" }, ...capabilityOptions]} onChange={(value: LogicalModelCapability | "all") => setCapabilityFilter(value)} />
                    </div>
                    <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1">
                        {visibleModels.map((model) => {
                            const resolved = resolveLogicalModelConfig(logicalModels, channels, model.capability, model.id);
                            const isDefault = Object.values(defaultModels).some((value) => value.toLowerCase() === model.id.toLowerCase());
                            return (
                                <div key={model.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between dark:border-stone-800 dark:bg-stone-950">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{model.name}</span>
                                            <Tag className="m-0">{capabilityLabel(model.capability)}</Tag>
                                            <Tag color={model.enabled ? "green" : "default"} className="m-0">
                                                {model.enabled ? "启用" : "停用"}
                                            </Tag>
                                            {isDefault ? (
                                                <Tag color="blue" className="m-0">
                                                    默认
                                                </Tag>
                                            ) : null}
                                        </div>
                                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                                            <span>ID：{model.id}</span>
                                            <span>{model.bindings.length} 个渠道绑定</span>
                                            <span className={resolved ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>{resolved ? `${resolved.channel.name} / ${resolved.binding.upstreamModel}` : "当前无可用渠道"}</span>
                                        </div>
                                    </div>
                                    <Space size={4} className="shrink-0">
                                        <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(model)}>
                                            编辑
                                        </Button>
                                        <Popconfirm
                                            title="删除逻辑模型"
                                            description={`删除后前端将不再显示「${model.name}」，对应默认模型会自动清理。`}
                                            okText="删除"
                                            cancelText="取消"
                                            okButtonProps={{ danger: true }}
                                            onConfirm={() => deleteModel(model.id)}
                                        >
                                            <Button danger size="small" icon={<Trash2 className="size-3.5" />}>
                                                删除
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                </div>
                            );
                        })}
                        {!visibleModels.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={logicalModels.length ? "没有匹配的逻辑模型" : "渠道尚未同步到模型目录"} /> : null}
                    </div>
                </div>

                <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                    <SectionTitle icon={<GitBranch className="size-4" />} title="默认模型" />
                    <div className="mt-4 space-y-4">
                        {availableDefaultFields.map(({ capability, key, label }) => {
                            const options = logicalModels.filter((model) => model.capability === capability && isLogicalModelResolvable(logicalModels, channels, capability, model.id)).map((model) => ({ label: model.name, value: model.id }));
                            const selected = logicalModels.find((model) => model.id === defaultModels[key]);
                            const resolved = selected ? resolveLogicalModelConfig(logicalModels, channels, capability, selected.id) : null;
                            return (
                                <LabeledControl key={key} label={label}>
                                    <Select
                                        className="w-full"
                                        allowClear
                                        showSearch
                                        optionFilterProp="label"
                                        value={defaultModels[key] || undefined}
                                        placeholder={`选择可用${capabilityLabel(capability)}模型`}
                                        options={options}
                                        status={defaultModels[key] && !resolved ? "error" : undefined}
                                        onChange={(value: string | undefined) => updateDefault(key, value || "")}
                                    />
                                    <div className={`mt-1 flex items-center gap-1 text-xs ${resolved ? "text-stone-500 dark:text-stone-400" : "text-amber-600 dark:text-amber-400"}`}>
                                        {!resolved ? <AlertTriangle className="size-3.5 shrink-0" /> : null}
                                        <span>{resolved ? `实际路由：${resolved.channel.name} / ${resolved.binding.upstreamModel}` : defaultModels[key] ? "当前默认模型不可解析" : "尚未设置默认模型"}</span>
                                    </div>
                                </LabeledControl>
                            );
                        })}
                    </div>
                </div>
            </div>

            <Drawer
                title={editingId ? "编辑逻辑模型" : "新建逻辑模型"}
                width="min(760px, 100vw)"
                open={drawerOpen}
                destroyOnHidden
                onClose={() => setDrawerOpen(false)}
                extra={
                    <Space>
                        <Button onClick={() => setDrawerOpen(false)}>取消</Button>
                        <Button type="primary" disabled={!draft?.name.trim()} onClick={saveDraft}>
                            应用修改
                        </Button>
                    </Space>
                }
            >
                {draft ? (
                    <>
                        <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/40">
                            <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,180px)_140px_96px]">
                                <LabeledControl label="逻辑模型 ID">
                                    <Input
                                        className="!w-full"
                                        aria-label="逻辑模型 ID"
                                        maxLength={120}
                                        value={draft.id}
                                        placeholder="image-pro"
                                        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft((current) => (current ? { ...current, id: event.target.value } : current))}
                                    />
                                </LabeledControl>
                                <LabeledControl label="前端昵称">
                                    <Input
                                        className="!w-full"
                                        aria-label="前端展示昵称"
                                        maxLength={120}
                                        value={draft.name}
                                        placeholder={draft.bindings[0]?.upstreamModel || draft.id}
                                        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft((current) => (current ? { ...current, name: event.target.value } : current))}
                                    />
                                </LabeledControl>
                                <LabeledControl label="能力类型">
                                    <Select className="w-full" value={draft.capability} options={capabilityOptions} onChange={(capability: LogicalModelCapability) => setDraft((current) => (current ? { ...current, capability } : current))} />
                                </LabeledControl>
                                <LabeledControl label="模型状态">
                                    <div className="flex h-8 items-center">
                                        <Switch checkedChildren="启用" unCheckedChildren="停用" checked={draft.enabled} onChange={(enabled: boolean) => setDraft((current) => (current ? { ...current, enabled } : current))} />
                                    </div>
                                </LabeledControl>
                            </div>
                        </div>
                        <div className="mt-5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <h3 className="text-sm font-semibold text-stone-950 dark:text-stone-100">渠道绑定</h3>
                                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">每个绑定明确选择渠道与上游模型；多个绑定只用于当前逻辑模型内部的优先级和故障切换。</p>
                                </div>
                                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => setDraft((current) => (current ? addDraftBinding(current, channels) : current))}>
                                    添加绑定
                                </Button>
                            </div>
                            <div className="mt-3 space-y-3">
                                {draft.bindings.map((binding) => (
                                    <BindingEditor
                                        key={binding.id}
                                        binding={binding}
                                        capability={draft.capability}
                                        channels={channels}
                                        onChange={(patch) => setDraft((current) => (current ? { ...current, bindings: current.bindings.map((item) => (item.id === binding.id ? { ...item, ...patch } : item)) } : current))}
                                        onRemove={() => setDraft((current) => (current ? { ...current, bindings: current.bindings.filter((item) => item.id !== binding.id) } : current))}
                                    />
                                ))}
                            </div>
                        </div>
                    </>
                ) : null}
            </Drawer>
        </section>
    );
}

function BindingEditor({
    binding,
    capability,
    channels,
    onChange,
    onRemove,
}: {
    binding: LogicalModelBinding;
    capability: LogicalModelCapability;
    channels: SystemModelChannel[];
    onChange: (patch: Partial<LogicalModelBinding>) => void;
    onRemove: () => void;
}) {
    const channel = channels.find((item) => item.id === binding.channelId);
    const profile = binding.capabilityProfile || {};
    const effectiveAsync = profile.supportsAsync ?? (capability === "image" || capability === "video");
    const timeoutSeconds = profile.timeoutMs ? Math.round(profile.timeoutMs / 1000) : undefined;
    const defaultTimeoutSeconds = capability === "image" ? 600 : capability === "text" ? 180 : 1800;
    const updateProfile = (patch: Partial<LogicalModelCapabilityProfile>) => onChange({ capabilityProfile: { ...profile, ...patch } });
    const updateList = (value: string) =>
        updateProfile({
            aspectRatios: value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
        });
    return (
        <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/40">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_90px_90px_auto_auto] sm:items-end">
                <LabeledControl label="渠道">
                    <Select
                        className="w-full"
                        value={binding.channelId}
                        options={channels.filter((item) => item.models.length).map((item) => ({ value: item.id, label: item.name }))}
                        onChange={(channelId: string) => {
                            const next = channels.find((item) => item.id === channelId);
                            onChange({ channelId, upstreamModel: next?.models[0] || "" });
                        }}
                    />
                </LabeledControl>
                <LabeledControl label="上游模型">
                    <Select
                        className="w-full"
                        showSearch
                        optionFilterProp="label"
                        value={binding.upstreamModel || undefined}
                        options={(channel?.models || []).map((model) => ({ value: model, label: model }))}
                        onChange={(upstreamModel: string) => onChange({ upstreamModel })}
                    />
                </LabeledControl>
                <LabeledControl label="优先级">
                    <InputNumber className="w-full" min={1} max={10000} precision={0} value={binding.priority} onChange={(priority: number | null) => onChange({ priority: Number(priority) || 1 })} />
                </LabeledControl>
                <LabeledControl label="权重">
                    <InputNumber className="w-full" min={1} max={10000} precision={0} value={binding.weight || 100} onChange={(weight: number | null) => onChange({ weight: Number(weight) || 100 })} />
                </LabeledControl>
                <div className="flex h-8 items-center">
                    <Switch size="small" checked={binding.enabled} aria-label={`${channel?.name || "渠道"}绑定启用状态`} onChange={(enabled: boolean) => onChange({ enabled })} />
                </div>
                <Button danger type="text" aria-label="删除渠道绑定" icon={<Trash2 className="size-4" />} onClick={onRemove} />
            </div>
            <div className="mt-3 rounded-md border border-stone-200/80 bg-white/70 p-3 dark:border-stone-800 dark:bg-stone-950/40">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <div className="text-xs font-semibold text-stone-700 dark:text-stone-200">能力档案</div>
                        <div className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">控制参考素材、任务能力和资源限制。</div>
                    </div>
                    <Tag className="m-0">{capabilityLabel(capability)}</Tag>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600 dark:text-stone-300 sm:col-span-2 lg:col-span-4">
                        <Checkbox checked={profile.supportsReferenceImage === true} onChange={(event: CheckboxChangeEvent) => updateProfile({ supportsReferenceImage: event.target.checked })}>
                            参考图片
                        </Checkbox>
                        <Checkbox checked={profile.supportsReferenceVideo === true} onChange={(event: CheckboxChangeEvent) => updateProfile({ supportsReferenceVideo: event.target.checked })}>
                            参考视频
                        </Checkbox>
                        <Checkbox checked={profile.supportsReferenceAudio === true} onChange={(event: CheckboxChangeEvent) => updateProfile({ supportsReferenceAudio: event.target.checked })}>
                            参考音频
                        </Checkbox>
                        <Checkbox checked={effectiveAsync} onChange={(event: CheckboxChangeEvent) => updateProfile({ supportsAsync: event.target.checked })}>
                            异步查询
                        </Checkbox>
                        <Checkbox checked={profile.supportsCancel === true} onChange={(event: CheckboxChangeEvent) => updateProfile({ supportsCancel: event.target.checked })}>
                            上游取消
                        </Checkbox>
                        <Checkbox checked={profile.supportsWebhook === true} onChange={(event: CheckboxChangeEvent) => updateProfile({ supportsWebhook: event.target.checked })}>
                            Webhook
                        </Checkbox>
                    </div>
                    <LabeledControl label="最大参考图数量">
                        <InputNumber className="w-full" min={0} max={16} precision={0} value={profile.maxReferenceImages} onChange={(value: number | null) => updateProfile({ maxReferenceImages: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="最大批量数量">
                        <InputNumber className="w-full" min={1} max={100} precision={0} value={profile.maxBatchSize} onChange={(value: number | null) => updateProfile({ maxBatchSize: Number(value) || 1 })} />
                    </LabeledControl>
                    <LabeledControl label="最短时长（秒）">
                        <InputNumber className="w-full" min={0} max={3600} precision={0} value={profile.minDurationSeconds} onChange={(value: number | null) => updateProfile({ minDurationSeconds: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="最长时长（秒）">
                        <InputNumber className="w-full" min={0} max={3600} precision={0} value={profile.maxDurationSeconds} onChange={(value: number | null) => updateProfile({ maxDurationSeconds: Number(value) || 0 })} />
                    </LabeledControl>
                    {capability === "video" ? (
                        <LabeledControl label="时长档位/范围">
                            <Input value={profile.durationRange || ""} placeholder="4-15 秒 或 4、6、8 秒" onChange={(event: ChangeEvent<HTMLInputElement>) => updateProfile({ durationRange: event.target.value.trim() || undefined })} />
                        </LabeledControl>
                    ) : null}
                    <LabeledControl label="支持比例（逗号分隔）">
                        <Input value={profile.aspectRatios?.join(", ") || ""} placeholder="1:1, 16:9, 9:16" onChange={(event: ChangeEvent<HTMLInputElement>) => updateList(event.target.value)} />
                    </LabeledControl>
                    {capability === "video" ? (
                        <LabeledControl label="支持清晰度（逗号分隔）">
                            <Input
                                value={profile.qualityOptions?.join(", ") || ""}
                                placeholder="480p, 720p, 1080p"
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                    updateProfile({
                                        qualityOptions: Array.from(new Set(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))),
                                    })
                                }
                            />
                        </LabeledControl>
                    ) : null}
                    <LabeledControl label="请求超时（秒）">
                        <InputNumber
                            className="w-full"
                            min={5}
                            max={1800}
                            precision={0}
                            value={timeoutSeconds}
                            placeholder={`默认 ${defaultTimeoutSeconds} 秒`}
                            onChange={(value: number | null) => updateProfile({ timeoutMs: value ? Number(value) * 1000 : undefined })}
                        />
                    </LabeledControl>
                    <LabeledControl label="并发上限">
                        <InputNumber className="w-full" min={1} max={1000} precision={0} value={profile.concurrencyLimit} onChange={(value: number | null) => updateProfile({ concurrencyLimit: Number(value) || 1 })} />
                    </LabeledControl>
                    <LabeledControl label="单次成本">
                        <InputNumber className="w-full" min={0} precision={4} value={profile.unitCost} onChange={(value: number | null) => updateProfile({ unitCost: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="成本货币">
                        <Input value={profile.unitCostCurrency || ""} maxLength={12} placeholder="USD / CNY" onChange={(event: ChangeEvent<HTMLInputElement>) => updateProfile({ unitCostCurrency: event.target.value.trim().toUpperCase() })} />
                    </LabeledControl>
                </div>
            </div>
        </div>
    );
}

function cloneLogicalModel(model: LogicalModel): LogicalModel {
    return { ...model, bindings: model.bindings.map((binding) => ({ ...binding, capabilityProfile: binding.capabilityProfile ? { ...binding.capabilityProfile } : undefined })) };
}

function addDraftBinding(model: LogicalModel, channels: SystemModelChannel[]) {
    const channel = channels.find((item) => item.models.length && !model.bindings.some((binding) => binding.channelId === item.id && binding.upstreamModel === item.models[0])) || channels.find((item) => item.models.length);
    if (!channel) return model;
    const upstreamModel = channel.models.find((item) => !model.bindings.some((binding) => binding.channelId === channel.id && binding.upstreamModel === item)) || channel.models[0];
    return { ...model, bindings: [...model.bindings, { id: `${channel.id}:${upstreamModel}:${Date.now()}`, channelId: channel.id, upstreamModel, enabled: true, priority: model.bindings.length + 1 }] };
}

function uniqueDraftId(base: string, models: LogicalModel[]) {
    const ids = new Set(models.map((model) => model.id.toLowerCase()));
    let candidate = base;
    let suffix = 2;
    while (ids.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
    return candidate;
}
