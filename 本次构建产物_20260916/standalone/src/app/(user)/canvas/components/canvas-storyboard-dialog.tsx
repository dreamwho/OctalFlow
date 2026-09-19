"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "antd";
import { Clapperboard } from "lucide-react";

import { GenerationActionButton } from "@/components/generation-action-button";
import { ModelPicker } from "@/components/model-picker";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { resolveCanvasGenerationModel } from "../utils/canvas-node-config";
import type { CanvasCharacterThreeViewParams } from "../utils/canvas-storyboard";

export function CanvasStoryboardDialog({
    dataUrl,
    open,
    config,
    initialModel,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    config: AiConfig;
    initialModel?: string;
    onClose: () => void;
    onConfirm: (params: CanvasCharacterThreeViewParams) => void;
}) {
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const defaultModel = useMemo(() => resolveCanvasGenerationModel(config, "image", initialModel), [config, initialModel]);
    const [model, setModel] = useState(defaultModel);

    useEffect(() => {
        if (open) setModel(defaultModel);
    }, [dataUrl, defaultModel, open]);

    return (
        <Modal title="分镜大师" open={open && Boolean(dataUrl)} centered footer={null} width="min(520px, calc(100vw - 32px))" destroyOnHidden onCancel={onClose}>
            <CanvasStoryboardDialogContent dataUrl={dataUrl} config={config} model={model} onModelChange={setModel} onMissingConfig={() => openConfigDialog(true)} onClose={onClose} onConfirm={() => onConfirm({ model: model || defaultModel })} />
        </Modal>
    );
}

export function CanvasStoryboardDialogContent({
    dataUrl,
    config,
    model,
    onModelChange,
    onMissingConfig,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    config: AiConfig;
    model: string;
    onModelChange: (model: string) => void;
    onMissingConfig: () => void;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <div data-canvas-storyboard-dialog className="space-y-5">
            <div className="flex min-w-0 items-center gap-3 rounded-xl border p-3">
                <span className="grid size-12 shrink-0 overflow-hidden rounded-lg bg-black/5">
                    <img src={imagePreviewUrl(dataUrl, 144)} alt="当前参考图" className="size-full object-cover" />
                </span>
                <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold">
                        <Clapperboard className="size-4" />
                        人物三视图
                    </div>
                    <p className="mt-1 text-xs leading-5 opacity-65">将当前图片作为参考，创建可继续连接和编辑的角色资产图。</p>
                </div>
            </div>

            <label className="grid gap-2">
                <span className="text-sm font-medium">图片逻辑模型</span>
                <ModelPicker config={config} value={model} onChange={onModelChange} capability="image" fullWidth placeholder="选择图片逻辑模型" onMissingConfig={onMissingConfig} />
            </label>

            <div className="flex justify-end gap-2">
                <Button onClick={onClose}>取消</Button>
                <GenerationActionButton onClick={onConfirm}>确认生成</GenerationActionButton>
            </div>
        </div>
    );
}
