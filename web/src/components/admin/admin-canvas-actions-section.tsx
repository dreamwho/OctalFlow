"use client";

import { App, Button, Input, InputNumber, Modal, Select, Switch } from "antd";
import { ArrowDown, ArrowUp, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { CANVAS_QUICK_ACTION_CAPABILITIES, type CanvasQuickActionCapability, type CanvasQuickActionGroup, type CanvasQuickActionItem } from "@/lib/canvas-quick-actions";

const CAPABILITY_LABELS: Record<CanvasQuickActionCapability, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const CAPABILITY_OPTIONS = CANVAS_QUICK_ACTION_CAPABILITIES.map((value) => ({ value, label: CAPABILITY_LABELS[value] }));

type ActionDraft = Omit<CanvasQuickActionItem, "id"> & { id: string };

const emptyAction = (): ActionDraft => ({ id: "", name: "", prompt: "", capability: "image", enabled: true, defaults: { size: "", quality: "", count: "1" } });

export function AdminCanvasActionsSection() {
    const { message } = App.useApp();
    const [groups, setGroups] = useState<CanvasQuickActionGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [actionModalOpen, setActionModalOpen] = useState(false);
    const [editingGroupId, setEditingGroupId] = useState("");
    const [editingIndex, setEditingIndex] = useState(-1);
    const [draft, setDraft] = useState<ActionDraft>(emptyAction);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const response = await fetch("/api/admin/settings", { cache: "no-store" });
            const payload = (await response.json()) as { settings?: { canvasQuickActions?: CanvasQuickActionGroup[] }; error?: string };
            if (!response.ok) throw new Error(payload.error || "无法读取画布功能菜单");
            setGroups(Array.isArray(payload.settings?.canvasQuickActions) ? payload.settings.canvasQuickActions : []);
            setDirty(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法读取画布功能菜单");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void load();
    }, [load]);

    const mutate = (next: CanvasQuickActionGroup[]) => {
        setGroups(next.map((group, index) => ({ ...group, sortOrder: index })));
        setDirty(true);
    };

    const updateGroup = (id: string, patch: Partial<CanvasQuickActionGroup>) => {
        mutate(groups.map((group) => (group.id === id ? { ...group, ...patch } : group)));
    };
    const moveGroup = (id: string, direction: -1 | 1) => {
        const index = groups.findIndex((group) => group.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= groups.length) return;
        const next = [...groups];
        [next[index], next[target]] = [next[target], next[index]];
        mutate(next);
    };
    const addGroup = () => {
        mutate([...groups, { id: `group-${Date.now()}`, name: "新分组", enabled: true, sortOrder: groups.length, actions: [] }]);
    };

    const openActionModal = (groupId: string, action?: CanvasQuickActionItem, index = -1) => {
        setEditingGroupId(groupId);
        setEditingIndex(index);
        setDraft(action ? { ...action, defaults: { ...action.defaults } } : emptyAction());
        setActionModalOpen(true);
    };
    const submitAction = () => {
        if (!draft.name.trim() || !draft.prompt.trim()) {
            message.warning("请填写功能名称与提示词");
            return;
        }
        mutate(groups.map((group) => {
            if (group.id !== editingGroupId) return group;
            const actions = [...group.actions];
            const item = { ...draft, id: draft.id || `action-${Date.now()}` };
            if (editingIndex >= 0) actions[editingIndex] = item;
            else actions.push(item);
            return { ...group, actions };
        }));
        setActionModalOpen(false);
    };

    const save = async () => {
        setSaving(true);
        try {
            const response = await fetch("/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvasQuickActions: groups }) });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "保存失败");
            message.success("画布功能菜单已保存，画布端下次进入生效");
            setDirty(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Panel>
            <PanelHeader
                title="画布功能菜单"
                description="维护画布图片节点快捷菜单（右键菜单与悬浮工具栏）中的功能分组、提示词、动作类型与默认参数；启用的功能会以数据驱动方式出现在画布功能菜单中。"
                actions={
                    <>
                        <Button icon={<Plus className="size-4" />} onClick={() => addGroup()}>
                            添加分组
                        </Button>
                        <Button type="primary" icon={<Save className="size-4" />} loading={saving} disabled={loading || !dirty} onClick={() => void save()}>
                            保存
                        </Button>
                    </>
                }
            />
            {loading ? (
                <div className="py-10 text-center text-sm text-zinc-500">正在读取配置…</div>
            ) : groups.length ? (
                <div className="space-y-4">
                    {groups.map((group, groupIndex) => (
                        <div key={group.id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                            <div className="flex flex-wrap items-center gap-2">
                                <Input className="w-44" value={group.name} onChange={(event) => updateGroup(group.id, { name: event.target.value })} placeholder="分组名称" />
                                <Switch size="small" checked={group.enabled} onChange={(enabled) => updateGroup(group.id, { enabled })} />
                                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => openActionModal(group.id)}>
                                    添加功能
                                </Button>
                                <div className="ml-auto flex items-center gap-1">
                                    <Button size="small" icon={<ArrowUp className="size-3.5" />} disabled={groupIndex === 0} onClick={() => moveGroup(group.id, -1)} />
                                    <Button size="small" icon={<ArrowDown className="size-3.5" />} disabled={groupIndex === groups.length - 1} onClick={() => moveGroup(group.id, 1)} />
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => mutate(groups.filter((item) => item.id !== group.id))}>
                                        删除分组
                                    </Button>
                                </div>
                            </div>
                            <div className="mt-3 space-y-2">
                                {group.actions.length ? (
                                    group.actions.map((action, actionIndex) => (
                                        <div key={action.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-900">
                                            <span className="min-w-0 flex-1 truncate font-medium" title={action.name}>
                                                {action.name}
                                                <span className="ml-2 text-xs text-zinc-500">{CAPABILITY_LABELS[action.capability]}</span>
                                                {!action.enabled ? <span className="ml-2 text-xs text-amber-600">已停用</span> : null}
                                            </span>
                                            <span className="hidden min-w-0 flex-[2] truncate text-xs text-zinc-500 md:block" title={action.prompt}>
                                                {action.prompt}
                                            </span>
                                            <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openActionModal(group.id, action, actionIndex)}>
                                                编辑
                                            </Button>
                                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => mutate(groups.map((item) => (item.id === group.id ? { ...item, actions: item.actions.filter((item2) => item2.id !== action.id) } : item)))}>
                                                删除
                                            </Button>
                                        </div>
                                    ))
                                ) : (
                                    <div className="rounded-lg border border-dashed border-zinc-200 p-3 text-center text-xs text-zinc-500 dark:border-zinc-800">该分组暂无功能，点击「添加功能」创建</div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
                    暂无功能分组。点击「添加分组」创建第一个分组（例如：分镜大师），再在分组下添加功能条目。
                </div>
            )}
            <Modal
                title={editingIndex >= 0 ? "编辑功能" : "添加功能"}
                open={actionModalOpen}
                okText="保存功能"
                cancelText="取消"
                width={720}
                onOk={() => submitAction()}
                onCancel={() => setActionModalOpen(false)}
            >
                <div className="space-y-3 pt-2">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                        <label className="grid gap-1">
                            <span className="text-xs font-medium text-zinc-500">功能名称（画布菜单中显示）</span>
                            <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：人物三视图" />
                        </label>
                        <label className="grid gap-1">
                            <span className="text-xs font-medium text-zinc-500">动作类型</span>
                            <Select value={draft.capability} options={CAPABILITY_OPTIONS} onChange={(value: CanvasQuickActionCapability) => setDraft((current) => ({ ...current, capability: value }))} />
                        </label>
                    </div>
                    <label className="grid gap-1">
                        <span className="text-xs font-medium text-zinc-500">提示词（点击功能后作为生成提示词整段使用，当前图片自动作为参考素材）</span>
                        <Input.TextArea
                            value={draft.prompt}
                            onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                            rows={8}
                            placeholder="填写该功能的完整提示词"
                        />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className="grid gap-1">
                            <span className="text-xs font-medium text-zinc-500">默认比例</span>
                            <Input value={draft.defaults.size || ""} onChange={(event) => setDraft((current) => ({ ...current, defaults: { ...current.defaults, size: event.target.value } }))} placeholder="16:9（留空用全局默认）" />
                        </label>
                        <label className="grid gap-1">
                            <span className="text-xs font-medium text-zinc-500">{draft.capability === "video" ? "默认清晰度" : "默认画质"}</span>
                            <Input value={draft.defaults.quality || ""} onChange={(event) => setDraft((current) => ({ ...current, defaults: { ...current.defaults, quality: event.target.value } }))} placeholder={draft.capability === "video" ? "720p / 1080p" : "high / standard"} />
                        </label>
                        {draft.capability === "image" ? (
                            <label className="grid gap-1">
                                <span className="text-xs font-medium text-zinc-500">默认数量</span>
                                <Input value={draft.defaults.count || ""} onChange={(event) => setDraft((current) => ({ ...current, defaults: { ...current.defaults, count: event.target.value } }))} placeholder="1" />
                            </label>
                        ) : draft.capability === "video" ? (
                            <label className="grid gap-1">
                                <span className="text-xs font-medium text-zinc-500">默认时长（秒）</span>
                                <InputNumber className="w-full" min={1} max={60} precision={0} value={draft.defaults.videoSeconds} onChange={(value) => setDraft((current) => ({ ...current, defaults: { ...current.defaults, videoSeconds: value ?? undefined } }))} placeholder="5" />
                            </label>
                        ) : null}
                    </div>
                </div>
            </Modal>
        </Panel>
    );
}
