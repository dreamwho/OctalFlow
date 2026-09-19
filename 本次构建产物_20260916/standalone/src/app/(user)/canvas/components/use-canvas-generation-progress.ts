"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { estimateCanvasProgress } from "../utils/canvas-generation-progress";
import type { CanvasNodeData } from "../types";

let clock = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function tick() {
    clock = Date.now();
    listeners.forEach((listener) => listener());
}
function visibility() {
    clearInterval(timer);
    timer = undefined;
    if (!document.hidden) {
        tick();
        timer = setInterval(tick, 1000);
    }
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        document.addEventListener("visibilitychange", visibility);
        visibility();
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            clearInterval(timer);
            timer = undefined;
            document.removeEventListener("visibilitychange", visibility);
        }
    };
}

export function useCanvasGenerationProgress(node?: CanvasNodeData, completed = false, onComplete?: () => void) {
    const now = useSyncExternalStore(
        subscribe,
        () => clock,
        () => 0,
    );
    const [mountedAt] = useState(Date.now);
    const startedAt = node?.metadata?.generationStartedAt || mountedAt;
    const estimate = estimateCanvasProgress(now ? now - startedAt : 0, node?.type, node?.metadata?.generationExpectedMs);
    const value = node?.metadata?.generationProgress;
    const real = typeof value === "number" && Number.isFinite(value) ? Math.floor(Math.max(0, Math.min(100, value))) : undefined;
    const key = `${node?.id}:${startedAt}:${node?.metadata?.generationStage || ""}`;
    const candidate = real ?? estimate.percent;
    const [previous, setPrevious] = useState({ key, percent: candidate });
    // Hold an estimate until the real value catches up; never label this held value as real.
    const carried = real === undefined ? Math.min(95, previous.percent) : previous.percent;
    const percent = completed ? previous.percent : previous.key === key ? Math.max(carried, candidate) : candidate;
    if (previous.key !== key || previous.percent !== percent) setPrevious({ key, percent });
    const [completion, setCompletion] = useState(0);
    useEffect(() => {
        if (!completed) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden) {
            onComplete?.();
            return;
        }
        const start = performance.now();
        let frame: number;
        let hold: ReturnType<typeof setTimeout>;
        const advance = (now: number) => {
            // A presentation transition after confirmed success, not a task deadline.
            const fraction = Math.min(1, (now - start) / 350);
            setCompletion(1 - (1 - fraction) ** 3);
            if (fraction < 1) frame = requestAnimationFrame(advance);
            else hold = setTimeout(() => onComplete?.(), 120);
        };
        frame = requestAnimationFrame(advance);
        return () => {
            cancelAnimationFrame(frame);
            clearTimeout(hold);
        };
    }, [completed, onComplete]);
    const displayed = completed ? Math.round(percent + (100 - percent) * completion) : percent;
    const estimated = real === undefined || percent > real;
    return {
        status: completed ? `生成完成 ${displayed}%` : `生成中 ${estimated ? "预计 " : ""}${percent}%`,
        detail: !completed && estimated && estimate.waiting ? `已等待 ${estimate.elapsed}，等待结果` : "",
        title: completed ? "已收到成功结果，正在展示完成反馈" : estimated ? "预计进度仅用于等待反馈，不代表上游实际完成比例；完成状态以服务器结果为准" : "上游实际进度",
    };
}
