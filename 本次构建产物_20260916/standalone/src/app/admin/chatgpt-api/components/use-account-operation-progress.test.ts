import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS, accountOperationCompletionNotice, accountOperationProgressPercent, watchAccountOperationProgress } from "./use-account-operation-progress";

describe("账号操作进度自动跟随", () => {
    afterEach(() => vi.useRealTimers());

    it("按原生 processed/total 跟随到终态，且终态后不再读取", async () => {
        vi.useFakeTimers();
        const readProgress = vi
            .fn()
            .mockResolvedValueOnce({ total: 4, processed: 1, done: false, status_label: "正在刷新", message: "已完成首个账号" })
            .mockResolvedValueOnce({ total: 4, processed: 4, done: true, status_label: "已完成", tone: "success", message: "额度已刷新" });
        const progresses: Array<{ processed: number; total: number; percent: number | undefined }> = [];
        const terminal = vi.fn();

        const cancel = watchAccountOperationProgress({
            progressId: "fixture-progress",
            readProgress,
            onProgress: (_id, progress) => progresses.push({ processed: progress.processed, total: progress.total, percent: accountOperationProgressPercent(progress) }),
            onTerminal: terminal,
            onError: vi.fn(),
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(readProgress).toHaveBeenCalledTimes(1);
        expect(progresses).toEqual([{ processed: 1, total: 4, percent: 25 }]);
        await vi.advanceTimersByTimeAsync(ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS);
        expect(readProgress).toHaveBeenCalledTimes(2);
        expect(progresses).toEqual([
            { processed: 1, total: 4, percent: 25 },
            { processed: 4, total: 4, percent: 100 },
        ]);
        expect(terminal).toHaveBeenCalledWith("fixture-progress", expect.objectContaining({ done: true, processed: 4, total: 4 }));
        await vi.advanceTimersByTimeAsync(ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS * 2);
        expect(readProgress).toHaveBeenCalledTimes(2);
        cancel();
    });

    it("将 0/0 的原生准备态保持为等待，并在总数可用后展示真实进度", async () => {
        vi.useFakeTimers();
        const readProgress = vi
            .fn()
            .mockResolvedValueOnce({ total: 0, processed: 0, done: false, status_label: "正在准备账号" })
            .mockResolvedValueOnce({ total: 2, processed: 1, done: false, status_label: "正在刷新" })
            .mockResolvedValueOnce({ total: 2, processed: 2, done: true, status_label: "已完成" });
        const progresses: Array<{ processed: number; total: number; percent: number | undefined }> = [];
        const terminal = vi.fn();
        const onError = vi.fn();

        const cancel = watchAccountOperationProgress({
            progressId: "fixture-progress",
            readProgress,
            onProgress: (_id, progress) => progresses.push({ processed: progress.processed, total: progress.total, percent: accountOperationProgressPercent(progress) }),
            onTerminal: terminal,
            onError,
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(progresses).toEqual([{ processed: 0, total: 0, percent: undefined }]);
        expect(terminal).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS);
        expect(progresses).toEqual([
            { processed: 0, total: 0, percent: undefined },
            { processed: 1, total: 2, percent: 50 },
        ]);
        await vi.advanceTimersByTimeAsync(ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS);
        expect(terminal).toHaveBeenCalledWith("fixture-progress", expect.objectContaining({ done: true, processed: 2, total: 2 }));
        cancel();
    });

    it("将没有顶层错误的 danger 终态作为失败提示", () => {
        expect(accountOperationCompletionNotice("刷新全部额度", { tone: "danger", error: null, message: "1 个账号刷新失败" })).toEqual({
            type: "error",
            text: "刷新全部额度失败：1 个账号刷新失败",
        });
    });

    it("不会重叠读取，并在取消后中止当前进度读取", async () => {
        vi.useFakeTimers();
        let release: ((value: unknown) => void) | undefined;
        let signal: AbortSignal | undefined;
        const readProgress = vi.fn((_id: string, nextSignal: AbortSignal) => {
            signal = nextSignal;
            return new Promise<unknown>((resolve) => {
                release = resolve;
            });
        });
        const onProgress = vi.fn();
        const cancel = watchAccountOperationProgress({ progressId: "fixture-progress", readProgress, onProgress, onTerminal: vi.fn(), onError: vi.fn() });

        await vi.advanceTimersByTimeAsync(ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS * 3);
        expect(readProgress).toHaveBeenCalledTimes(1);
        expect(signal?.aborted).toBe(false);
        cancel();
        expect(signal?.aborted).toBe(true);
        release?.({ total: 1, processed: 1, done: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(onProgress).not.toHaveBeenCalled();
        expect(readProgress).toHaveBeenCalledTimes(1);
    });

    it("将未知异步状态作为错误停止，而不是猜测完成或重新提交", async () => {
        vi.useFakeTimers();
        const readProgress = vi.fn().mockResolvedValue({ total: 1, processed: 0 });
        const onError = vi.fn();

        watchAccountOperationProgress({ progressId: "fixture-progress", readProgress, onProgress: vi.fn(), onTerminal: vi.fn(), onError });
        await vi.advanceTimersByTimeAsync(0);

        expect(onError).toHaveBeenCalledWith("fixture-progress", expect.objectContaining({ message: "账号操作返回未知进度状态，已停止自动跟随" }));
        await vi.advanceTimersByTimeAsync(ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS * 2);
        expect(readProgress).toHaveBeenCalledTimes(1);
    });
});
