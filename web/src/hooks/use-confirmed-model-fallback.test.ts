import { describe, expect, it, vi } from "vitest";

import { GenerationTaskNeedsReviewError } from "@/services/api/generation-task-state";
import { GenerationTaskRequestError } from "@/services/api/generation-task-request-error";
import { ImageGenerationTaskTerminalError } from "@/services/api/image";
import { VideoGenerationUpstreamError } from "@/services/api/video-types";
import type { AiConfig } from "@/stores/use-config-store";

import { isSafeModelFallbackFailure, runWithConfirmedModelFallback } from "./use-confirmed-model-fallback";

const config = Object.freeze({
    model: "image-primary",
    imageModel: "image-primary",
    videoModel: "video-selected",
    logicalModels: [{ id: "image-primary", name: "图片主模型" }],
}) as AiConfig;

const offer = { id: "image-backup", name: "图片备用", sourceName: "供应商主模型" };

function runner<T>(options: {
    operation: (config: AiConfig) => Promise<T>;
    capability?: "image" | "video";
    lookupOffer?: (modelId: string, capability: "image" | "video", signal?: AbortSignal) => Promise<typeof offer | null>;
    confirm?: (modelName: string, fallbackName: string, signal?: AbortSignal) => Promise<boolean>;
    isMounted?: () => boolean;
}) {
    return runWithConfirmedModelFallback({
        config,
        capability: options.capability || "image",
        operation: options.operation,
        isMounted: options.isMounted || (() => true),
        lookupOffer: options.lookupOffer || vi.fn().mockResolvedValue(offer),
        confirm: options.confirm || vi.fn().mockResolvedValue(true),
    });
}

describe("confirmed model fallback", () => {
    it("limits eligibility to explicitly safe terminal failures", () => {
        expect(isSafeModelFallbackFailure(new ImageGenerationTaskTerminalError("upstream failed", true, true), "image")).toBe(true);
        expect(isSafeModelFallbackFailure(new ImageGenerationTaskTerminalError("result missing", true), "image")).toBe(false);
        expect(isSafeModelFallbackFailure(new ImageGenerationTaskTerminalError("not retryable", false, true), "image")).toBe(false);
        expect(isSafeModelFallbackFailure(new VideoGenerationUpstreamError("terminal", true), "video")).toBe(true);
        expect(isSafeModelFallbackFailure(new VideoGenerationUpstreamError("pending", false), "video")).toBe(false);
        expect(isSafeModelFallbackFailure(new GenerationTaskRequestError("server safe failure", 502, true), "video")).toBe(true);
        expect(isSafeModelFallbackFailure(new GenerationTaskNeedsReviewError("review"), "video")).toBe(false);
    });

    it("confirms once, retries with the selected capability only, and preserves the original snapshot", async () => {
        const failure = new ImageGenerationTaskTerminalError("upstream failed", true, true);
        const operation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce("done");
        const lookupOffer = vi.fn().mockResolvedValue(offer);
        const confirm = vi.fn().mockResolvedValue(true);

        await expect(runner({ operation, lookupOffer, confirm })).resolves.toBe("done");
        expect(confirm).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledWith("供应商主模型", "图片备用", undefined);
        expect(operation).toHaveBeenCalledTimes(2);
        expect(operation.mock.calls[0][0]).toBe(config);
        expect(operation.mock.calls[1][0]).toMatchObject({ model: "image-backup", imageModel: "image-backup", videoModel: "video-selected" });
        expect(config).toMatchObject({ model: "image-primary", imageModel: "image-primary", videoModel: "video-selected" });
    });

    it("updates only the selected video model field", async () => {
        const videoConfig = Object.freeze({ ...config, model: "video-primary", videoModel: "video-primary" }) as AiConfig;
        const operation = vi.fn().mockRejectedValueOnce(new VideoGenerationUpstreamError("failed", true)).mockResolvedValueOnce("done");
        await expect(runWithConfirmedModelFallback({
            config: videoConfig,
            capability: "video",
            operation,
            isMounted: () => true,
            lookupOffer: vi.fn().mockResolvedValue({ id: "video-backup", name: "视频备用", sourceName: "供应商视频主模型" }),
            confirm: vi.fn().mockResolvedValue(true),
        })).resolves.toBe("done");
        expect(operation.mock.calls[1][0]).toMatchObject({ model: "video-backup", videoModel: "video-backup", imageModel: "image-primary" });
    });

    it("cancels without submitting a second operation", async () => {
        const operation = vi.fn().mockRejectedValue(new ImageGenerationTaskTerminalError("failed", true, true));
        const confirm = vi.fn().mockResolvedValue(false);
        await expect(runner({ operation, confirm })).rejects.toMatchObject({ name: "AbortError" });
        expect(operation).toHaveBeenCalledOnce();
    });

    it("does not prompt or retry after a non-eligible failure or when no offer exists", async () => {
        const unsafe = new GenerationTaskNeedsReviewError("review required");
        const unsafeOperation = vi.fn().mockRejectedValue(unsafe);
        const lookupOffer = vi.fn();
        const confirm = vi.fn();
        await expect(runner({ operation: unsafeOperation, lookupOffer, confirm })).rejects.toBe(unsafe);
        expect(lookupOffer).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();

        const terminal = new ImageGenerationTaskTerminalError("failed", true, true);
        const noOfferOperation = vi.fn().mockRejectedValue(terminal);
        await expect(runner({ operation: noOfferOperation, lookupOffer: vi.fn().mockResolvedValue(null), confirm })).rejects.toBe(terminal);
        expect(noOfferOperation).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
    });

    it("never chains a second fallback when the confirmed attempt also fails", async () => {
        const firstError = new ImageGenerationTaskTerminalError("first failed", true, true);
        const secondError = new ImageGenerationTaskTerminalError("backup failed", true, true);
        const operation = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError);
        await expect(runner({ operation })).rejects.toBe(secondError);
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("does not open a late prompt after unmount during the initial request", async () => {
        let mounted = true;
        let rejectOperation!: (error: unknown) => void;
        const operation = vi.fn(() => new Promise<never>((_, reject) => { rejectOperation = reject; }));
        const lookupOffer = vi.fn();
        const confirm = vi.fn();
        const pending = runner({ operation, lookupOffer, confirm, isMounted: () => mounted });
        mounted = false;
        rejectOperation(new ImageGenerationTaskTerminalError("failed", true, true));
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(lookupOffer).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
    });

    it("does not open a late prompt after unmount during fallback lookup", async () => {
        let mounted = true;
        let resolveOffer!: (value: typeof offer) => void;
        let markLookupStarted!: () => void;
        const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
        const lookupOffer = vi.fn(() => new Promise<typeof offer>((resolve) => { resolveOffer = resolve; markLookupStarted(); }));
        const confirm = vi.fn();
        const operation = vi.fn().mockRejectedValue(new ImageGenerationTaskTerminalError("failed", true, true));
        const pending = runner({ operation, lookupOffer, confirm, isMounted: () => mounted });
        await lookupStarted;
        mounted = false;
        resolveOffer(offer);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(confirm).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledOnce();
    });
});
