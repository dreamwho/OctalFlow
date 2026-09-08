"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getChatGptProxyRuntime, updateChatGptProxyRuntime, type ChatGptProxyNativeSource, type ChatGptProxyRuntime, type ChatGptProxyRuntimeMode, type ChatGptProxyRuntimePatch } from "@/services/api/chatgpt-api";

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

function isAbortError(reason: unknown) {
    return reason instanceof DOMException && reason.name === "AbortError";
}

export type ChatGptProxyTarget = "manual" | "ipwo" | "magic";

export const chatGptProxyModeOptions: Array<{ value: ChatGptProxyRuntimeMode; label: string }> = [
    { value: "native", label: "代理管理" },
    { value: "magic", label: "魔法代理" },
];

export function chatGptProxyModeLabel(mode: ChatGptProxyRuntimeMode) {
    return chatGptProxyModeOptions.find((item) => item.value === mode)?.label || "代理管理";
}

export function chatGptProxyNativeSourceLabel(source: ChatGptProxyNativeSource) {
    return source === "ipwo" ? "IPWO" : "手动配置";
}

export function chatGptProxyRuntimeStatus(runtime: ChatGptProxyRuntime) {
    if (!runtime.enabled) return "全局代理已关闭：所有请求均不使用代理。";
    if (runtime.mode === "magic") return runtime.magicConfigured ? "当前使用魔法代理。" : "当前已选择魔法代理，但当前配置不可用；运行时会拒绝请求。";
    if (runtime.native_source === "ipwo") return runtime.ipwoConfigured ? "当前使用代理管理中的 IPWO 来源。" : "当前已选择代理管理中的 IPWO 来源，但当前配置不可用；运行时会拒绝请求。";
    return "当前使用代理管理中的手动配置。";
}

export function chatGptProxyRuntimeInput(target: ChatGptProxyTarget, enabled: boolean, runtime: ChatGptProxyRuntime | null): ChatGptProxyRuntimePatch {
    return {
        enabled,
        mode: target === "magic" ? "magic" : "native",
        native_source: target === "magic" ? runtime?.native_source || "manual" : target,
    };
}

export type ChatGptProxyRuntimeController = {
    runtime: ChatGptProxyRuntime | null;
    loading: boolean;
    saving: boolean;
    error: string;
    refresh: () => Promise<ChatGptProxyRuntime>;
    save: (input: ChatGptProxyRuntimePatch) => Promise<ChatGptProxyRuntime>;
};

export function useChatGptProxyRuntime(): ChatGptProxyRuntimeController {
    const [runtime, setRuntime] = useState<ChatGptProxyRuntime | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const mounted = useRef(false);
    const revision = useRef(0);
    const savingRef = useRef(false);
    const request = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const currentRevision = ++revision.current;
        if (mounted.current) {
            setLoading(true);
            setError("");
        }
        try {
            const nextRuntime = await getChatGptProxyRuntime({ signal: controller.signal });
            if (!controller.signal.aborted && mounted.current && currentRevision === revision.current) setRuntime(nextRuntime);
            return nextRuntime;
        } catch (reason) {
            if (isAbortError(reason)) throw reason;
            const nextError = errorMessage(reason, "读取代理状态失败");
            if (mounted.current && currentRevision === revision.current) setError(nextError);
            throw new Error(nextError);
        } finally {
            if (request.current === controller) request.current = null;
            if (mounted.current && currentRevision === revision.current) setLoading(false);
        }
    }, []);

    const save = useCallback(async (input: ChatGptProxyRuntimePatch) => {
        if (savingRef.current) throw new Error("代理设置正在保存，请稍候");
        savingRef.current = true;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const currentRevision = ++revision.current;
        if (mounted.current) {
            setSaving(true);
            setError("");
        }
        try {
            const nextRuntime = await updateChatGptProxyRuntime(input, { signal: controller.signal });
            if (!controller.signal.aborted && mounted.current && currentRevision === revision.current) setRuntime(nextRuntime);
            return nextRuntime;
        } catch (reason) {
            if (isAbortError(reason)) throw reason;
            const nextError = errorMessage(reason, "保存代理状态失败");
            if (mounted.current && currentRevision === revision.current) setError(nextError);
            throw new Error(nextError);
        } finally {
            savingRef.current = false;
            if (request.current === controller) request.current = null;
            if (mounted.current) setSaving(false);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void refresh().catch(() => undefined);
        return () => {
            mounted.current = false;
            request.current?.abort();
        };
    }, [refresh]);

    return { runtime, loading, saving, error, refresh, save };
}
