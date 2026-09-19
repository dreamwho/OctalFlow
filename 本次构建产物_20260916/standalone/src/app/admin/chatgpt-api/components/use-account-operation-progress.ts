"use client";

import { useEffect, useRef } from "react";

export type AccountOperationProgress = {
    total: number;
    processed: number;
    done: boolean;
    status_label?: string;
    tone?: "info" | "success" | "warning" | "danger";
    message?: string;
    error?: string | null;
};

type ProgressReader = (progressId: string, signal: AbortSignal) => Promise<unknown>;
type ProgressListener = (progressId: string, progress: AccountOperationProgress) => void;
type ProgressErrorListener = (progressId: string, error: Error) => void;

// Keeps the original account-operation polling cadence for
// `accounts/operations/{progressId}`; this is not the dashboard refresh cadence.
export const ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS = 1_500;

function accountOperationProgressError() {
    return new Error("账号操作返回未知进度状态，已停止自动跟随");
}

function asError(reason: unknown) {
    return reason instanceof Error ? reason : new Error("读取账号操作进度失败");
}

export function normalizeAccountOperationProgress(value: unknown): AccountOperationProgress {
    if (!value || typeof value !== "object") throw accountOperationProgressError();
    const progress = value as Record<string, unknown>;
    const total = progress.total;
    const processed = progress.processed;
    if (typeof progress.done !== "boolean" || typeof total !== "number" || typeof processed !== "number" || !Number.isSafeInteger(total) || !Number.isSafeInteger(processed) || total < 0 || processed < 0 || processed > total) {
        throw accountOperationProgressError();
    }
    // Native `init_refresh_progress()` creates `{ total, processed: 0, done: false }`
    // without requiring a positive total. Zero therefore means preparation has not
    // published a computable denominator yet: keep polling with the pending spinner.
    return {
        total,
        processed,
        done: progress.done,
        ...(typeof progress.status_label === "string" ? { status_label: progress.status_label } : {}),
        ...(progress.tone === "info" || progress.tone === "success" || progress.tone === "warning" || progress.tone === "danger" ? { tone: progress.tone } : {}),
        ...(typeof progress.message === "string" ? { message: progress.message } : {}),
        ...(typeof progress.error === "string" || progress.error === null ? { error: progress.error } : {}),
    };
}

export function accountOperationProgressPercent(progress?: AccountOperationProgress) {
    if (!progress?.total) return undefined;
    return Math.floor((progress.processed / progress.total) * 100);
}

export function accountOperationCompletionNotice(label: string, progress: Pick<AccountOperationProgress, "error" | "tone" | "message" | "status_label">) {
    // The native operation presentation may use danger for a terminal failure
    // without a top-level runtime error, so both fields determine the toast.
    if (progress.error || progress.tone === "danger") {
        return { type: "error" as const, text: label + "失败：" + (progress.error || progress.message || progress.status_label || "账号操作失败") };
    }
    if (progress.tone === "warning") {
        return { type: "warning" as const, text: label + "已结束：" + (progress.message || progress.status_label || "部分完成") };
    }
    return { type: "success" as const, text: label + "已完成：" + (progress.message || progress.status_label || "已完成") };
}

export function watchAccountOperationProgress({
    progressId,
    readProgress,
    onProgress,
    onTerminal,
    onError,
    intervalMs = ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS,
}: {
    progressId: string;
    readProgress: ProgressReader;
    onProgress: ProgressListener;
    onTerminal: ProgressListener;
    onError: ProgressErrorListener;
    intervalMs?: number;
}) {
    const controller = new AbortController();
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
        stopped = true;
        if (timer !== undefined) globalThis.clearTimeout(timer);
        timer = undefined;
        controller.abort();
    };
    const schedule = () => {
        if (!stopped) timer = globalThis.setTimeout(read, intervalMs);
    };
    const read = () => {
        if (stopped || reading || controller.signal.aborted) return;
        reading = true;
        void readProgress(progressId, controller.signal)
            .then((value) => {
                if (stopped || controller.signal.aborted) return;
                const progress = normalizeAccountOperationProgress(value);
                onProgress(progressId, progress);
                if (progress.done) {
                    stop();
                    onTerminal(progressId, progress);
                } else {
                    schedule();
                }
            })
            .catch((reason) => {
                if (stopped || controller.signal.aborted) return;
                stop();
                onError(progressId, asError(reason));
            })
            .finally(() => {
                reading = false;
            });
    };

    read();
    return stop;
}

export function useAccountOperationProgress({
    progressId,
    active,
    readProgress,
    onProgress,
    onTerminal,
    onError,
}: {
    progressId?: string;
    active: boolean;
    readProgress: ProgressReader;
    onProgress: ProgressListener;
    onTerminal: ProgressListener;
    onError: ProgressErrorListener;
}) {
    const listeners = useRef({ readProgress, onProgress, onTerminal, onError });
    listeners.current = { readProgress, onProgress, onTerminal, onError };

    useEffect(() => {
        if (!active || !progressId) return;
        let cancel: () => void = () => undefined;
        const start = () => {
            if (document.hidden) return;
            cancel = watchAccountOperationProgress({
                progressId,
                readProgress: (id, signal) => listeners.current.readProgress(id, signal),
                onProgress: (id, progress) => listeners.current.onProgress(id, progress),
                onTerminal: (id, progress) => listeners.current.onTerminal(id, progress),
                onError: (id, error) => listeners.current.onError(id, error),
            });
        };
        const handleVisibilityChange = () => {
            cancel();
            if (!document.hidden) start();
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        start();
        return () => {
            cancel();
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [active, progressId]);
}
