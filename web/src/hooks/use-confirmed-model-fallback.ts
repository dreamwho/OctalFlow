"use client";

import { App } from "antd";
import { useCallback, useEffect, useRef } from "react";

import { getModelFallback, type ModelFallbackCapability } from "@/services/api/model-fallback";
import { GenerationTaskRequestError } from "@/services/api/generation-task-request-error";
import { ImageGenerationTaskTerminalError } from "@/services/api/image";
import { ClientSessionExpiredError } from "@/services/api/session-expiration";
import { VideoGenerationUpstreamError } from "@/services/api/video-types";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

function abortError() {
    return new DOMException("操作已取消", "AbortError");
}

export function isSafeModelFallbackFailure(error: unknown, capability: ModelFallbackCapability) {
    if (capability === "image") return error instanceof ImageGenerationTaskTerminalError && error.canRetry && error.fallbackEligible;
    return (error instanceof VideoGenerationUpstreamError && error.canRetry) || (error instanceof GenerationTaskRequestError && error.canRetry);
}

type ConfirmedFallbackOptions<T> = {
    config: AiConfig;
    capability: ModelFallbackCapability;
    operation: (attemptConfig: AiConfig) => Promise<T>;
    signal?: AbortSignal;
    isMounted: () => boolean;
    lookupOffer: (modelId: string, capability: ModelFallbackCapability, signal?: AbortSignal) => Promise<Awaited<ReturnType<typeof getModelFallback>>>;
    confirm: (modelName: string, fallbackName: string, signal?: AbortSignal) => Promise<boolean>;
};

export async function runWithConfirmedModelFallback<T>({ config, capability, operation, signal, isMounted, lookupOffer, confirm }: ConfirmedFallbackOptions<T>): Promise<T> {
    if (signal?.aborted || !isMounted()) throw abortError();
    try {
        return await operation(config);
    } catch (error) {
        if (signal?.aborted || !isMounted()) throw abortError();
        if (!isSafeModelFallbackFailure(error, capability)) throw error;
        const modelId = config.model?.trim();
        if (!modelId) throw error;
        let offer;
        try {
            offer = await lookupOffer(modelId, capability, signal);
        } catch (lookupError) {
            if (signal?.aborted || !isMounted() || (lookupError instanceof Error && lookupError.name === "AbortError")) throw abortError();
            if (lookupError instanceof ClientSessionExpiredError) throw lookupError;
            throw error;
        }
        if (signal?.aborted || !isMounted()) throw abortError();
        if (!offer || offer.id === modelId) throw error;
        const modelName = config.logicalModels.find((item) => item.id === modelId)?.name || modelId;
        const confirmed = await confirm(offer.sourceName || modelName, offer.name, signal);
        if (!confirmed || signal?.aborted || !isMounted()) throw abortError();
        const fallbackConfig: AiConfig = capability === "image"
            ? { ...config, model: offer.id, imageModel: offer.id }
            : { ...config, model: offer.id, videoModel: offer.id };
        return operation(fallbackConfig);
    }
}

export function useConfirmedModelFallback() {
    const { modal } = App.useApp();
    const dialogsRef = useRef(new Set<() => void>());
    const mountedRef = useRef(false);

    useEffect(() => {
        mountedRef.current = true;
        const unsubscribe = useUserStore.subscribe((state, previous) => {
            if (state.user?.id !== previous.user?.id) dialogsRef.current.forEach((cancel) => cancel());
        });
        return () => {
            mountedRef.current = false;
            unsubscribe();
            dialogsRef.current.forEach((cancel) => cancel());
            dialogsRef.current.clear();
        };
    }, []);

    const askToSwitch = useCallback((modelName: string, fallbackName: string, signal?: AbortSignal) => {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise<boolean>((resolve, reject) => {
            let settled = false;
            const dialogRef: { current?: ReturnType<typeof modal.confirm> } = {};
            const cleanup = () => {
                dialogsRef.current.delete(cancel);
                signal?.removeEventListener("abort", cancel);
            };
            const finish = (confirmed: boolean) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(confirmed);
            };
            const cancel = () => {
                if (settled) return;
                settled = true;
                cleanup();
                dialogRef.current?.destroy();
                reject(abortError());
            };
            dialogsRef.current.add(cancel);
            signal?.addEventListener("abort", cancel, { once: true });
            dialogRef.current = modal.confirm({
                title: "切换备用模型？",
                content: `「${modelName}」生成失败。是否改用「${fallbackName}」再尝试一次？`,
                okText: "切换并重试",
                cancelText: "取消",
                onOk: () => finish(true),
                onCancel: () => finish(false),
            });
        });
    }, [modal]);

    const runWithFallback = useCallback(async <T,>(
        config: AiConfig,
        capability: ModelFallbackCapability,
        operation: (attemptConfig: AiConfig) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> => {
        const ownerId = useUserStore.getState().user?.id;
        return runWithConfirmedModelFallback({ config, capability, operation, signal, isMounted: () => mountedRef.current && useUserStore.getState().user?.id === ownerId, lookupOffer: getModelFallback, confirm: askToSwitch });
    }, [askToSwitch]);

    return { runWithFallback };
}
