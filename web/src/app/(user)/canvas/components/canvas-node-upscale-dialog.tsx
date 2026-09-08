"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal, Segmented } from "antd";
import { GenerationActionButton } from "@/components/generation-action-button";
import { readImageMeta } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { getDreaminaStatus, type DreaminaStatus, type ImageUpscaleResolution } from "@/services/api/image";
import { MAX_UPSCALE_LONG_EDGE, resolveUpscaleSize, type ImageUpscaleAlgorithm, type ImageUpscaleParams } from "../utils/canvas-image-data";

export type CanvasImageUpscaleEngine = "local" | "dreamina-cli";
export type CanvasImageUpscaleParams = ImageUpscaleParams & {
    engine: CanvasImageUpscaleEngine;
    resolutionType: ImageUpscaleResolution;
};

export const DREAMINA_UPSCALE_RESOLUTION_OPTIONS: ReadonlyArray<{ label: string; value: ImageUpscaleResolution; pixels: number; vip: boolean }> = [
    { label: "2K", value: "2k", pixels: 2048, vip: false },
    { label: "4K · VIP", value: "4k", pixels: 4096, vip: true },
    { label: "8K · VIP", value: "8k", pixels: 8192, vip: true },
];

export function resolveDreaminaUpscaleSize(width: number, height: number, resolutionType: ImageUpscaleResolution) {
    const sourceLongEdge = Math.max(1, width, height);
    const targetLongEdge = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((item) => item.value === resolutionType)?.pixels || 2048;
    const scale = targetLongEdge / sourceLongEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function canUseDreaminaUpscale(status: DreaminaStatus | null, sourceLongEdge: number, resolutionType: ImageUpscaleResolution) {
    const targetLongEdge = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((item) => item.value === resolutionType)?.pixels || 0;
    return status?.enabled === true && status.authorized === true && sourceLongEdge > 0 && sourceLongEdge < targetLongEdge;
}

const algorithms: Array<{ value: ImageUpscaleAlgorithm; title: string; description: string }> = [
    { value: "high", title: "高清插值", description: "适合照片和细节图" },
    { value: "bilinear", title: "双线性", description: "平滑、速度快" },
    { value: "nearest", title: "最近邻", description: "适合像素风格" },
];

const targetOptions = [
    { label: "1K", value: 1024 },
    { label: "2K", value: 2048 },
    { label: "4K", value: MAX_UPSCALE_LONG_EDGE },
];

const defaultParams: CanvasImageUpscaleParams = {
    targetLongEdge: 2048,
    algorithm: "high",
    engine: "local",
    resolutionType: "2k",
};

export function CanvasNodeUpscaleDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageUpscaleParams) => void }) {
    const [params, setParams] = useState<CanvasImageUpscaleParams>(defaultParams);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [dreaminaStatus, setDreaminaStatus] = useState<DreaminaStatus | null>(null);
    const [dreaminaStatusLoading, setDreaminaStatusLoading] = useState(false);
    const [dreaminaStatusError, setDreaminaStatusError] = useState("");
    const sourceLongEdge = image ? Math.max(image.width, image.height) : 0;
    const targetLongEdge = params.engine === "dreamina-cli" ? DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((item) => item.value === params.resolutionType)?.pixels || 2048 : params.targetLongEdge;
    const outputSize = useMemo(
        () => (image ? (params.engine === "dreamina-cli" ? resolveDreaminaUpscaleSize(image.width, image.height, params.resolutionType) : resolveUpscaleSize(image.width, image.height, params.targetLongEdge)) : null),
        [image, params.engine, params.resolutionType, params.targetLongEdge],
    );
    const canUpscale = Boolean(image && sourceLongEdge < targetLongEdge && (params.engine === "local" ? targetLongEdge <= MAX_UPSCALE_LONG_EDGE : canUseDreaminaUpscale(dreaminaStatus, sourceLongEdge, params.resolutionType)));
    const reachedMax = Boolean(image && sourceLongEdge >= MAX_UPSCALE_LONG_EDGE);

    useEffect(() => {
        if (!open) return;
        setParams(defaultParams);
        setImage(null);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setDreaminaStatus(null);
        setDreaminaStatusError("");
        setDreaminaStatusLoading(true);
        void getDreaminaStatus(controller.signal)
            .then(setDreaminaStatus)
            .catch((error) => {
                if (!controller.signal.aborted) setDreaminaStatusError(error instanceof Error ? error.message : "即梦 CLI 状态读取失败");
            })
            .finally(() => {
                if (!controller.signal.aborted) setDreaminaStatusLoading(false);
            });
        return () => controller.abort();
    }, [open]);

    useEffect(() => {
        if (!open) return;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!image) return;
        setParams((current) => {
            if (current.engine === "dreamina-cli") {
                const nextResolution = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((option) => sourceLongEdge < option.pixels)?.value || "8k";
                const nextTarget = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((option) => option.value === nextResolution)?.pixels || 8192;
                if (current.resolutionType === nextResolution && current.targetLongEdge === nextTarget) return current;
                return { ...current, resolutionType: nextResolution, targetLongEdge: nextTarget };
            }
            const nextTarget = targetOptions.find((option) => sourceLongEdge < option.value)?.value || MAX_UPSCALE_LONG_EDGE;
            return current.targetLongEdge === nextTarget ? current : { ...current, targetLongEdge: nextTarget };
        });
    }, [image, sourceLongEdge]);

    const selectEngine = (engine: CanvasImageUpscaleEngine) => {
        setParams((current) => {
            if (engine === "local") {
                const targetLongEdge = targetOptions.find((option) => sourceLongEdge < option.value)?.value || MAX_UPSCALE_LONG_EDGE;
                return { ...current, engine, targetLongEdge };
            }
            const resolutionType = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((option) => sourceLongEdge < option.pixels)?.value || "8k";
            const targetLongEdge = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((option) => option.value === resolutionType)?.pixels || 8192;
            return { ...current, engine, resolutionType, targetLongEdge };
        });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width="min(820px, calc(100vw - 24px))" centered destroyOnHidden>
            <div className="max-h-[calc(100dvh-160px)] overflow-y-auto pr-1">
                <div className="space-y-5">
                    <div>
                        <h2 className="text-xl font-semibold">图片放大</h2>
                    </div>
                    <div className="grid gap-4 md:grid-cols-[minmax(260px,1fr)_360px] md:gap-6">
                        <div className="rounded-xl border p-4">
                            <div className="grid min-h-52 place-items-center rounded-lg bg-black/5 md:min-h-[280px]">
                                <img src={imagePreviewUrl(dataUrl, 960)} alt="" className="max-h-[320px] max-w-full rounded-lg object-contain shadow-xl" draggable={false} />
                            </div>
                            <div className="mt-3 flex items-center justify-between text-sm">
                                <span className="opacity-60">源图</span>
                                <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : "读取中"}</span>
                            </div>
                        </div>
                        <div className="space-y-4 py-2 md:space-y-6">
                            <div className="space-y-2">
                                <div className="font-medium opacity-75">处理引擎</div>
                                <div className="min-w-0">
                                    <Segmented
                                        block
                                        value={params.engine}
                                        options={[
                                            { label: "本地插值", value: "local" },
                                            { label: "即梦 CLI · 图片超清", value: "dreamina-cli" },
                                        ]}
                                        onChange={(value) => selectEngine(value as CanvasImageUpscaleEngine)}
                                    />
                                </div>
                            </div>
                            {params.engine === "local" ? (
                                <>
                                    <div className="space-y-2">
                                        <div className="font-medium opacity-75">目标像素</div>
                                        <div className="min-w-0">
                                            <Segmented
                                                block
                                                value={params.targetLongEdge}
                                                options={targetOptions.map((option) => ({ label: `${option.label} · ${option.value}px`, value: option.value, disabled: Boolean(image && sourceLongEdge >= option.value) }))}
                                                onChange={(value) => setParams((current) => ({ ...current, targetLongEdge: Number(value) }))}
                                            />
                                        </div>
                                        {image && !canUpscale ? <div className="text-xs font-medium text-[#ef4444]">{reachedMax ? "图片已达到 4K，无需放大" : "图片已达到当前目标像素，无需放大"}</div> : null}
                                    </div>
                                    <div className="space-y-2">
                                        <div className="font-medium opacity-75">放大算法</div>
                                        <div className="min-w-0">
                                            <Segmented
                                                block
                                                value={params.algorithm}
                                                options={algorithms.map((item) => ({
                                                    value: item.value,
                                                    label: (
                                                        <span className="flex min-h-12 flex-col justify-center text-left leading-5">
                                                            <span className="font-medium">{item.title}</span>
                                                            <span className="text-xs opacity-55">{item.description}</span>
                                                        </span>
                                                    ),
                                                }))}
                                                onChange={(value) => setParams((current) => ({ ...current, algorithm: value as ImageUpscaleAlgorithm }))}
                                            />
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="space-y-3">
                                    <div className="space-y-2">
                                        <div className="font-medium opacity-75">超清分辨率</div>
                                        <div className="min-w-0">
                                            <Segmented
                                                block
                                                value={params.resolutionType}
                                                options={DREAMINA_UPSCALE_RESOLUTION_OPTIONS.map((option) => ({ label: option.label, value: option.value, disabled: Boolean(image && sourceLongEdge >= option.pixels) }))}
                                                onChange={(value) => {
                                                    const resolutionType = value as ImageUpscaleResolution;
                                                    const targetLongEdge = DREAMINA_UPSCALE_RESOLUTION_OPTIONS.find((option) => option.value === resolutionType)?.pixels || 2048;
                                                    setParams((current) => ({ ...current, resolutionType, targetLongEdge }));
                                                }}
                                            />
                                        </div>
                                    </div>
                                    {dreaminaStatusLoading ? <div className="rounded-xl border px-4 py-3 text-sm opacity-70">正在读取即梦 CLI 授权状态…</div> : null}
                                    {!dreaminaStatusLoading && dreaminaStatusError ? <Alert type="warning" showIcon message="即梦 CLI 状态读取失败" description={dreaminaStatusError} /> : null}
                                    {!dreaminaStatusLoading && !dreaminaStatusError && dreaminaStatus?.enabled !== true ? <Alert type="warning" showIcon message="即梦图片超清尚未启用" description="请先由管理员在即梦 CLI 页面启用图片超清模型。" /> : null}
                                    {!dreaminaStatusLoading && !dreaminaStatusError && dreaminaStatus?.enabled === true && dreaminaStatus.authorized !== true ? (
                                        <Alert type="warning" showIcon message="即梦 CLI 尚未授权" description="请在部署服务账号执行 dreamina login 后再使用图片超清。浏览器不会直接执行 CLI。" />
                                    ) : null}
                                    {!dreaminaStatusLoading && !dreaminaStatusError && dreaminaStatus?.enabled === true && dreaminaStatus.authorized === true ? (
                                        <div className="rounded-xl border px-4 py-3 text-sm">
                                            <div className="font-medium">即梦 CLI 已连接</div>
                                            <div className="mt-1 opacity-70">会员等级：{dreaminaStatus.vipLevel || "由服务端最终校验"}</div>
                                            <div className="mt-1 text-xs opacity-60">4K / 8K 标注 VIP，会员资格与扣费以服务端和即梦 CLI 返回为准。</div>
                                        </div>
                                    ) : null}
                                    {image && !canUpscale && dreaminaStatus?.authorized === true ? <div className="text-xs font-medium text-[#ef4444]">图片已达到当前超清分辨率，无需放大</div> : null}
                                </div>
                            )}
                            <div className="rounded-xl border px-4 py-3 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className="opacity-60">输出尺寸</span>
                                    <span className="font-semibold">{outputSize ? `${outputSize.width} x ${outputSize.height} px` : "未知"}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <GenerationActionButton size="large" disabled={!canUpscale} onClick={() => onConfirm({ ...params, targetLongEdge })}>
                            生成放大图
                        </GenerationActionButton>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
