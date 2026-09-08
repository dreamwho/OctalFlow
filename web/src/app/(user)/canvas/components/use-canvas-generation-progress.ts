"use client";

import { useState, useSyncExternalStore } from "react";
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

export function useCanvasGenerationProgress(node?: CanvasNodeData) {
    const now = useSyncExternalStore(
        subscribe,
        () => clock,
        () => 0,
    );
    const [mountedAt] = useState(Date.now);
    const startedAt = node?.metadata?.generationStartedAt || mountedAt;
    const estimate = estimateCanvasProgress(now ? now - startedAt : 0, node?.type);
    const value = node?.metadata?.generationProgress;
    const real = typeof value === "number" && Number.isFinite(value) ? Math.floor(Math.max(0, Math.min(100, value))) : undefined;
    const key = `${node?.id}:${startedAt}:${node?.metadata?.generationStage || ""}`;
    const candidate = real ?? estimate.percent;
    const [previous, setPrevious] = useState({ key, percent: candidate });
    // Hold an estimate until the real value catches up; never label this held value as real.
    const carried = real === undefined ? Math.min(95, previous.percent) : previous.percent;
    const percent = previous.key === key ? Math.max(carried, candidate) : candidate;
    if (previous.key !== key || previous.percent !== percent) setPrevious({ key, percent });
    const estimated = real === undefined || percent > real;
    return {
        status: `生成中 ${estimated ? "预计 " : ""}${percent}%`,
        detail: estimated && estimate.waiting ? `已等待 ${estimate.elapsed}，等待结果` : "",
        title: estimated ? "预计进度仅用于等待反馈，不代表上游实际完成比例；完成状态以服务器结果为准" : "上游实际进度",
    };
}
