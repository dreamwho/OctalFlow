"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Input, InputNumber, Modal, Popconfirm, Switch, Tag } from "antd";
import { Plus, Trash2 } from "lucide-react";

import type { LogicalModelCapability, UserRoleDefinition } from "@/lib/auth/store";
import { DEFAULT_USER_ROLE, USER_ROLE_CAPABILITIES, userRoleAllowsModel } from "@/lib/user-roles";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

const capabilityLabels: Record<LogicalModelCapability, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };

export function AdminUserRolesModal({ controller, open, onClose }: { controller: AdminDashboardController; open: boolean; onClose: () => void }) {
    const [roles, setRoles] = useState<UserRoleDefinition[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [draft, setDraft] = useState<UserRoleDefinition | null>(null);
    const [saving, setSaving] = useState(false);
    const models = useMemo(() => controller.settings.logicalModels.filter((model) => model.enabled), [controller.settings.logicalModels]);

    useEffect(() => {
        if (!open) {
            setRoles([]);
            setSelectedId("");
            setDraft(null);
            return;
        }
        if (roles.length) return;
        const current = structuredClone(controller.settings.userRoles);
        setRoles(current);
        setSelectedId(current[0]?.id || "user");
        setDraft(structuredClone(current[0] || DEFAULT_USER_ROLE));
    }, [controller.settings.userRoles, open, roles.length]);

    const selectRole = (id: string) => {
        const role = roles.find((item) => item.id === id);
        if (!role) return;
        setSelectedId(id);
        setDraft(structuredClone(role));
    };

    const startNewRole = () => {
        const id = `role-${Math.random().toString(36).slice(2, 8)}`;
        const role: UserRoleDefinition = { ...structuredClone(DEFAULT_USER_ROLE), id, name: "新角色" };
        setSelectedId(id);
        setDraft(role);
    };

    const saveRoles = async (nextRoles: UserRoleDefinition[], successText: string) => {
        setSaving(true);
        try {
            const response = await fetch("/api/admin/user-roles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles: nextRoles }) });
            const payload = (await response.json().catch(() => ({}))) as { roles?: UserRoleDefinition[]; error?: string };
            if (!response.ok || !payload.roles) throw new Error(payload.error || "保存角色失败");
            setRoles(payload.roles);
            controller.setSettings((current) => ({ ...current, userRoles: payload.roles! }));
            if (payload.roles.some((role) => role.id === selectedId)) {
                const selected = payload.roles.find((role) => role.id === selectedId)!;
                setDraft(structuredClone(selected));
            } else {
                setSelectedId("user");
                setDraft(structuredClone(payload.roles.find((role) => role.id === "user") || DEFAULT_USER_ROLE));
            }
            controller.message.success(successText);
            return true;
        } catch (error) {
            controller.message.error(error instanceof Error ? error.message : "保存角色失败");
            return false;
        } finally {
            setSaving(false);
        }
    };

    const saveDraft = async () => {
        if (!draft) return;
        const next = roles.some((role) => role.id === draft.id) ? roles.map((role) => role.id === draft.id ? draft : role) : [...roles, draft];
        await saveRoles(next, "角色权限已保存");
    };

    const deleteRole = async (id: string) => {
        if (id === "user") return;
        const next = roles.filter((role) => role.id !== id);
        await saveRoles(next, "角色已删除");
    };

    const updateRole = (patch: Partial<UserRoleDefinition>) => {
        setDraft((current) => current ? { ...current, ...patch } : current);
        if (typeof patch.id === "string") setSelectedId(patch.id);
    };
    const updateAccess = (patch: Partial<UserRoleDefinition["modelAccess"]>) => setDraft((current) => current ? { ...current, modelAccess: { ...current.modelAccess, ...patch } } : current);

    const toggleCapability = (capability: LogicalModelCapability, checked: boolean) => {
        if (!draft) return;
        const access = draft.modelAccess;
        const capabilities = new Set(access.all ? USER_ROLE_CAPABILITIES : access.capabilities);
        if (checked) capabilities.add(capability);
        else capabilities.delete(capability);
        const categoryModelIds = models.filter((model) => model.capability === capability).map((model) => model.id.toLowerCase());
        updateAccess({ all: false, capabilities: USER_ROLE_CAPABILITIES.filter((item) => capabilities.has(item)), excludedModelIds: checked ? access.excludedModelIds.filter((id) => !categoryModelIds.includes(id.toLowerCase())) : access.excludedModelIds });
    };

    const toggleModel = (modelId: string, capability: LogicalModelCapability, checked: boolean) => {
        if (!draft) return;
        const access = draft.modelAccess;
        const normalized = modelId.toLowerCase();
        let next = { ...access, modelIds: [...access.modelIds], excludedModelIds: [...access.excludedModelIds] };
        const remove = (items: string[]) => items.filter((id) => id.toLowerCase() !== normalized);
        if (next.all) {
            if (checked) next.excludedModelIds = remove(next.excludedModelIds);
            else next = { all: false, capabilities: [...USER_ROLE_CAPABILITIES], modelIds: [], excludedModelIds: [modelId] };
        } else if (checked) {
            next.excludedModelIds = remove(next.excludedModelIds);
            if (!next.capabilities.includes(capability) && !next.modelIds.some((id) => id.toLowerCase() === normalized)) next.modelIds.push(modelId);
        } else if (next.capabilities.includes(capability)) {
            if (!next.excludedModelIds.some((id) => id.toLowerCase() === normalized)) next.excludedModelIds.push(modelId);
        } else {
            next.modelIds = remove(next.modelIds);
        }
        updateAccess(next);
    };

    const toggleAll = (checked: boolean) => updateAccess(checked
        ? { all: true, capabilities: [...USER_ROLE_CAPABILITIES], modelIds: [], excludedModelIds: [] }
        : { all: false, capabilities: [], modelIds: [], excludedModelIds: [] });

    const roleExists = roles.some((role) => role.id === draft?.id);
    const categoryModels = (capability: LogicalModelCapability) => models.filter((model) => model.capability === capability);

    return (
        <Modal
            title="用户角色与权限"
            open={open}
            onCancel={onClose}
            footer={null}
            width="min(1080px, calc(100vw - 24px))"
            centered
            styles={{ container: { display: "flex", maxHeight: "calc(100dvh - 24px)", flexDirection: "column" }, body: { minHeight: 0, overflowY: "auto", paddingTop: 12 } }}
        >
            <div className="grid min-h-[520px] gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
                <aside className="min-w-0 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">角色列表</span>
                        <Button size="small" icon={<Plus className="size-3.5" />} onClick={startNewRole}>新增</Button>
                    </div>
                    <div className="space-y-1">
                        {roles.map((role) => (
                            <button key={role.id} type="button" onClick={() => selectRole(role.id)} className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${selectedId === role.id ? "bg-violet-100 text-violet-950 dark:bg-violet-950/60 dark:text-violet-100" : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900"}`}>
                                <span className="min-w-0 truncate">{role.name}</span>
                                {role.id === "user" ? <Tag className="!mr-0">默认</Tag> : null}
                            </button>
                        ))}
                    </div>
                    <p className="mt-4 text-xs leading-5 text-stone-500 dark:text-stone-400">管理员使用独立的职责权限，不在此处配置。普通用户角色可调整策略，不能删除。</p>
                </aside>

                {draft ? (
                    <section className="min-w-0 space-y-5 rounded-lg border border-stone-200 p-4 dark:border-stone-800 sm:p-5">
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.7fr)]">
                            <label className="min-w-0 space-y-1.5 text-sm">
                                <span>角色名称</span>
                                <Input value={draft.name} maxLength={40} onChange={(event) => updateRole({ name: event.target.value })} />
                            </label>
                            <label className="min-w-0 space-y-1.5 text-sm">
                                <span>角色 ID</span>
                                <Input value={draft.id} disabled={roleExists || draft.id === "user"} maxLength={32} onChange={(event) => updateRole({ id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
                            </label>
                        </div>

                        <section className="rounded-md border border-stone-200 p-4 dark:border-stone-800">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-sm font-semibold">积分消耗</h3>
                                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">按模型原始消耗乘以角色比例；记录模式保留消费流水但不扣积分，仍遵循套餐次数限制。</p>
                                </div>
                                <label className="flex items-center gap-2 text-sm"><Switch checked={draft.recordOnly} onChange={(recordOnly) => updateRole({ recordOnly })} /><span>只记录，不扣积分</span></label>
                            </div>
                            <label className="flex max-w-sm items-center gap-3 text-sm">
                                <span className="shrink-0">消耗比例</span>
                                <InputNumber className="!w-36" min={0} max={100} step={0.1} precision={4} value={draft.pointsMultiplier} disabled={draft.recordOnly} onChange={(pointsMultiplier) => updateRole({ pointsMultiplier: Number(pointsMultiplier ?? 1) })} />
                                <span className="text-stone-500 dark:text-stone-400">倍（默认 1:1）</span>
                            </label>
                        </section>

                        <section className="space-y-3 rounded-md border border-stone-200 p-4 dark:border-stone-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <h3 className="text-sm font-semibold">模型使用权限</h3>
                                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">可按图片、视频、文本、音频分类授权，也可在分类下单独选择模型。</p>
                                </div>
                                <Checkbox checked={draft.modelAccess.all} onChange={(event) => toggleAll(event.target.checked)}>全部模型</Checkbox>
                            </div>
                            {USER_ROLE_CAPABILITIES.map((capability) => {
                                const checked = draft.modelAccess.all || draft.modelAccess.capabilities.includes(capability);
                                const items = categoryModels(capability);
                                return (
                                    <div key={capability} className="rounded-md border border-stone-200 dark:border-stone-800">
                                        <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-800 dark:bg-stone-900/60">
                                            <Checkbox checked={checked} onChange={(event) => toggleCapability(capability, event.target.checked)}>{capabilityLabels[capability]}模型</Checkbox>
                                            <span className="text-xs text-stone-500 dark:text-stone-400">{items.length} 个</span>
                                        </div>
                                        {items.length ? <div className="grid gap-x-4 gap-y-2 p-3 sm:grid-cols-2">
                                            {items.map((model) => (
                                                <Checkbox key={model.id} checked={userRoleAllowsModel(draft, model.id, capability)} onChange={(event) => toggleModel(model.id, capability, event.target.checked)}>
                                                    <span className="break-all text-xs">{model.name || model.id}</span>
                                                </Checkbox>
                                            ))}
                                        </div> : <p className="px-3 py-2 text-xs text-stone-500 dark:text-stone-400">当前没有已配置的{capabilityLabels[capability]}模型</p>}
                                    </div>
                                );
                            })}
                        </section>

                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-4 dark:border-stone-800">
                            {draft.id !== "user" && roleExists ? <Popconfirm title="删除此角色？" description="已分配给用户的角色不能删除。" okText="删除" cancelText="取消" onConfirm={() => void deleteRole(draft.id)}><Button danger icon={<Trash2 className="size-4" />} disabled={saving}>删除角色</Button></Popconfirm> : <span />}
                            <div className="ml-auto flex gap-2">
                                <Button onClick={onClose}>取消</Button>
                                <Button type="primary" loading={saving} onClick={() => void saveDraft()}>保存角色</Button>
                            </div>
                        </div>
                    </section>
                ) : <div className="grid min-h-64 place-items-center text-sm text-stone-500">选择一个角色开始配置</div>}
            </div>
        </Modal>
    );
}
