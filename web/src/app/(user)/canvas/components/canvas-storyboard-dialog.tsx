"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Tag } from "antd";
import { Clapperboard } from "lucide-react";

import { GenerationActionButton } from "@/components/generation-action-button";
import { ModelPicker } from "@/components/model-picker";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { resolveCanvasGenerationModel } from "../utils/canvas-node-config";
import type { CanvasQuickActionEntry } from "../utils/canvas-quick-actions-client";

const CAPABILITY_LABELS: Record<CanvasQuickActionEntry["capability"], string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };

export function CanvasStoryboardDialog({
    dataUrl,
    open,
    config,
    initialModel,
    actions,
    preselectedActionId = "",
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    config: AiConfig;
    initialModel?: string;
    actions: CanvasQuickActionEntry[];
    preselectedActionId?: string;
    onClose: () => void;
    onConfirm: (action: CanvasQuickActionEntry, model: string) => void;
}) {
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    const [selectedId, setSelectedId] = useState(preselectedActionId || actions[0]?.id || "");
    const [model, setModel] = useState("");

    const selected = useMemo(() => actions.find((action) => action.id === selectedId) || actions[0] || null, [actions, selectedId]);
    const defaultModel = useMemo(
        () => (selected ? resolveCanvasGenerationModel(config, selected.capability, initialModel) : ""),
        [config, initialModel, selected],
    );

    useEffect(() => {
        if (!open) return;
        setSelectedId(preselectedActionId || actions[0]?.id || "");
    }, [open, preselectedActionId, actions]);

    useEffect(() => {
        if (open) setModel(defaultModel);
    }, [defaultModel, open, selected?.id]);

    return (
        <Modal title="画布功能菜单" open={open && Boolean(dataUrl)} centered footer={null} width="min(560px, calc(100vw - 32px))" destroyOnHidden onCancel={onClose}>
            <CanvasStoryboardDialogContent
                dataUrl={dataUrl}
                config={config}
                actions={actions}
                selectedId={selected?.id || ""}
                model={model || defaultModel}
                onModelChange={setModel}
                onSelect={(action) => setSelectedId(action.id)}
                onMissingConfig={() => openConfigDialog(true)}
                onClose={onClose}
                onConfirm={() => selected && onConfirm(selected, model || defaultModel)}
                confirmDisabled={!selected}
            />
        </Modal>
    );
}

export function CanvasStoryboardDialogContent({
    dataUrl,
    config,
    actions,
    selectedId,
    model,
    onModelChange,
    onSelect,
    onMissingConfig,
    onClose,
    onConfirm,
    confirmDisabled = false,
}: {
    dataUrl: string;
    config: AiConfig;
    actions: CanvasQuickActionEntry[];
    selectedId: string;
    model: string;
    onModelChange: (model: string) => void;
    onSelect: (action: CanvasQuickActionEntry) => void;
    onMissingConfig: () => void;
    onClose: () => void;
    onConfirm: () => void;
    confirmDisabled?: boolean;
}) {
    const grouped = useMemo(() => {
        const groups: Array<{ name: string; actions: CanvasQuickActionEntry[] }> = [];
        actions.forEach((action) => {
            const last = groups[groups.length - 1];
            if (last && last.name === action.groupName) last.actions.push(action);
            else groups.push({ name: action.groupName, actions: [action] });
        });
        return groups;
    }, [actions]);
    const selected = actions.find((action) => action.id === selectedId) || null;

    return (
        <div className="space-y-5">
            <div className="flex min-w-0 items-center gap-3 rounded-xl border p-3">
                <span className="grid size-12 shrink-0 overflow-hidden rounded-lg bg-black/5">
                    <img src={imagePreviewUrl(dataUrl, 144)} alt="当前参考图" className="size-full object-cover" />
                </span>
                <p className="min-w-0 text-xs leading-5 opacity-65">当前图片将作为参考素材传给所选功能，点击确认后在画布中新建节点并自动开始生成。</p>
            </div>

            <div className="max-h-[min(40dvh,320px)] space-y-3 overflow-y-auto pr-1">
                {grouped.length ? (
                    grouped.map((group) => (
                        <div key={group.name} className="space-y-2">
                            <div className="flex items-center gap-1.5 text-xs font-medium opacity-70">
                                <Clapperboard className="size-3.5" />
                                {group.name}
                            </div>
                            {group.actions.map((action) => {
                                const active = selectedId === action.id;
                                return (
                                    <button
                                        key={action.id}
                                        type="button"
                                        data-canvas-quick-action-option
                                        aria-pressed={active}
                                        onClick={() => onSelect(action)}
                                        className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${active ? "border-blue-500 bg-blue-500/5" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-500"}`}
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-2 font-semibold">
                                                {action.name}
                                                <Tag className="m-0 text-[11px]" color={active ? "blue" : "default"}>{CAPABILITY_LABELS[action.capability]}</Tag>
                                            </span>
                                            <span className="mt-1 line-clamp-2 block text-xs leading-5 opacity-65">{action.prompt}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ))
                ) : (
                    <div className="rounded-xl border border-dashed p-6 text-center text-sm opacity-65">后台暂未启用任何画布功能</div>
                )}
            </div>

            {selected ? (
                <label className="grid gap-2">
                    <span className="text-sm font-medium">{CAPABILITY_LABELS[selected.capability]}逻辑模型</span>
                    <ModelPicker
                        config={config}
                        value={model}
                        onChange={onModelChange}
                        capability={selected.capability}
                        fullWidth
                        placeholder={`选择${CAPABILITY_LABELS[selected.capability]}逻辑模型`}
                        onMissingConfig={onMissingConfig}
                    />
                </label>
            ) : null}

            <div className="flex justify-end gap-2">
                <Button onClick={onClose}>取消</Button>
                <GenerationActionButton onClick={onConfirm} disabled={confirmDisabled || !selected}>
                    确认生成
                </GenerationActionButton>
            </div>
        </div>
    );
}
