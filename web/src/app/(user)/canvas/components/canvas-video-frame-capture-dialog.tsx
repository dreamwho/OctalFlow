"use client";

import { App, Button, Modal, Slider } from "antd";
import { Camera, Check, Images, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { imagePreviewUrl } from "@/lib/media-image-url";
import type { CanvasNodeData } from "../types";
import { extractCanvasVideoFrames, type CanvasVideoFrameAsset } from "../[id]/canvas-video-frame-api";

type Props = {
    node: CanvasNodeData | null;
    storageKey?: string;
    open: boolean;
    onClose: () => void;
    onAddFrame: (frame: CanvasVideoFrameAsset) => void;
};

export function CanvasVideoFrameCaptureDialog({ node, storageKey: suppliedStorageKey, open, onClose, onAddFrame }: Props) {
    const { message } = App.useApp();
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [durationMs, setDurationMs] = useState(0);
    const [currentMs, setCurrentMs] = useState(0);
    const [frames, setFrames] = useState<CanvasVideoFrameAsset[]>([]);
    const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<"capture" | "seconds" | null>(null);
    const storageKey = suppliedStorageKey?.trim() || node?.metadata?.storageKey?.trim() || "";

    useEffect(() => {
        if (!open) return;
        setDurationMs(Math.max(0, Number(node?.metadata?.durationMs) || 0));
        setCurrentMs(0);
        setFrames([]);
        setAddedKeys(new Set());
        setBusy(null);
    }, [node?.id, node?.metadata?.durationMs, open]);

    const pendingFrames = useMemo(() => frames.filter((frame) => !addedKeys.has(frame.storageKey)), [addedKeys, frames]);

    const captureAt = async (timeMs: number) => {
        if (!storageKey) return message.error("当前视频尚未保存到服务器，无法捕捉帧");
        setBusy("capture");
        try {
            const { frame } = await extractCanvasVideoFrames({ storageKey, mode: "current", timeMs: Math.max(0, Math.min(Math.round(timeMs), Math.max(0, durationMs - 1))) });
            if (!frame) throw new Error("视频帧保存失败");
            setFrames((current) => mergeCapturedFrames(current, [frame]));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频帧捕捉失败");
        } finally {
            setBusy(null);
        }
    };

    const captureEverySecond = async () => {
        if (!storageKey) return message.error("当前视频尚未保存到服务器，无法逐秒抽帧");
        setBusy("seconds");
        try {
            const { frames: extracted } = await extractCanvasVideoFrames({ storageKey, mode: "seconds" });
            if (!extracted?.length) throw new Error("视频没有可提取的整秒画面");
            setFrames((current) => mergeCapturedFrames(current, extracted));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "逐秒抽帧失败");
        } finally {
            setBusy(null);
        }
    };

    const seek = (value: number) => {
        const next = Math.max(0, Math.min(value, durationMs));
        setCurrentMs(next);
        if (videoRef.current && Number.isFinite(next)) videoRef.current.currentTime = next / 1000;
    };

    const addFrame = (frame: CanvasVideoFrameAsset) => {
        if (addedKeys.has(frame.storageKey)) return;
        onAddFrame(frame);
        setAddedKeys((current) => new Set(current).add(frame.storageKey));
    };

    return (
        <Modal className="canvas-video-frame-capture-modal" title="捕捉帧" open={open && Boolean(node?.metadata?.content)} centered width="min(960px, calc(100vw - 24px))" footer={null} destroyOnHidden onCancel={onClose}>
            <div className="space-y-4">
                <div className="overflow-hidden rounded-2xl bg-black">
                    {node?.metadata?.content ? (
                        <video
                            ref={videoRef}
                            src={node.metadata.content}
                            controls
                            playsInline
                            className="mx-auto block max-h-[58vh] w-full object-contain"
                            aria-label={node.title || "待捕捉视频"}
                            onLoadedMetadata={(event) => {
                                const nextDuration = Number.isFinite(event.currentTarget.duration) ? Math.max(0, Math.round(event.currentTarget.duration * 1000)) : 0;
                                setDurationMs(nextDuration);
                            }}
                            onTimeUpdate={(event) => setCurrentMs(Math.max(0, Math.round(event.currentTarget.currentTime * 1000)))}
                        />
                    ) : null}
                </div>

                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs text-stone-500 dark:text-stone-400">
                    <span>{formatFrameTime(currentMs)}</span>
                    <Slider min={0} max={Math.max(1, durationMs)} step={1} value={Math.min(currentMs, Math.max(1, durationMs))} tooltip={{ formatter: (value) => formatFrameTime(Number(value) || 0) }} onChange={seek} />
                    <span>{formatFrameTime(durationMs)}</span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button icon={<SkipBack className="size-4" />} disabled={Boolean(busy)} onClick={() => void captureAt(0)}>
                        截首帧
                    </Button>
                    <Button icon={<Camera className="size-4" />} loading={busy === "capture"} disabled={busy === "seconds"} onClick={() => void captureAt(videoRef.current?.currentTime ? videoRef.current.currentTime * 1000 : currentMs)}>
                        截当前帧
                    </Button>
                    <Button icon={<Images className="size-4" />} loading={busy === "seconds"} disabled={busy === "capture"} onClick={() => void captureEverySecond()}>
                        逐秒抽帧
                    </Button>
                    <Button icon={<SkipForward className="size-4" />} disabled={Boolean(busy) || !durationMs} onClick={() => void captureAt(Math.max(0, durationMs - 1))}>
                        截尾帧
                    </Button>
                    <Button icon={<RotateCcw className="size-4" />} disabled={!frames.length || Boolean(busy)} onClick={() => setFrames([])}>
                        清除
                    </Button>
                    <Button className="sm:ml-auto" type="primary" icon={<Check className="size-4" />} disabled={!pendingFrames.length || Boolean(busy)} onClick={() => pendingFrames.forEach(addFrame)}>
                        全部添加到画布（{pendingFrames.length}）
                    </Button>
                </div>

                {frames.length ? (
                    <div className="hide-scrollbar grid max-h-56 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4" data-canvas-captured-frame-list>
                        {frames.map((frame) => {
                            const added = addedKeys.has(frame.storageKey);
                            return (
                                <button
                                    key={frame.storageKey}
                                    type="button"
                                    className="group relative aspect-video overflow-hidden rounded-xl border border-stone-200 bg-stone-100 text-left transition hover:border-violet-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 dark:border-stone-700 dark:bg-stone-900"
                                    aria-label={`${formatFrameTime(frame.atMs)} ${added ? "已添加到画布" : "添加到画布节点"}`}
                                    disabled={added}
                                    onClick={() => addFrame(frame)}
                                >
                                    <img src={imagePreviewUrl(frame.serverUrl, 480)} alt={`${formatFrameTime(frame.atMs)} 视频帧`} className="size-full object-cover" />
                                    <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] text-white">{formatFrameTime(frame.atMs)}</span>
                                    <span
                                        className={`absolute inset-0 grid place-items-center bg-black/55 px-3 text-center text-xs font-medium text-white transition ${added ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}
                                    >
                                        {added ? "已添加到画布" : "添加到画布节点"}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">播放并定位视频后截取当前帧，或点击“逐秒抽帧”。</div>
                )}
            </div>
        </Modal>
    );
}

export function mergeCapturedFrames(current: CanvasVideoFrameAsset[], incoming: CanvasVideoFrameAsset[]) {
    const byTimestamp = new Map(current.map((frame) => [frame.atMs, frame]));
    for (const frame of incoming) byTimestamp.set(frame.atMs, frame);
    return [...byTimestamp.values()].sort((left, right) => left.atMs - right.atMs);
}

export function formatFrameTime(milliseconds: number) {
    const seconds = Math.max(0, milliseconds) / 1000;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}
