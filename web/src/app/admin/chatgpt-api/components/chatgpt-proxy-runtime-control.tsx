"use client";

import { Alert, Spin, Switch, Tag } from "antd";

import { chatGptProxyRuntimeInput, chatGptProxyRuntimeStatus, type ChatGptProxyRuntimeController, type ChatGptProxyTarget } from "./use-chatgpt-proxy-runtime";

const labels: Record<ChatGptProxyTarget, string> = {
    manual: "使用代理管理",
    ipwo: "使用IPWO代理",
    magic: "使用魔法代理",
};

function selected(runtime: NonNullable<ChatGptProxyRuntimeController["runtime"]>, target: ChatGptProxyTarget) {
    return runtime.mode === (target === "magic" ? "magic" : "native") && (target === "magic" || runtime.native_source === target);
}

export function ChatGptProxyRuntimeControl({ controller, target, disabledReason }: { controller: ChatGptProxyRuntimeController; target: ChatGptProxyTarget; disabledReason?: string }) {
    const { runtime, loading, saving, error, save } = controller;
    const active = Boolean(runtime?.enabled && runtime && selected(runtime, target));
    const targetLabel = labels[target];
    const message = !runtime
        ? "正在读取全局代理状态。"
        : active
          ? chatGptProxyRuntimeStatus(runtime)
          : runtime.enabled
            ? `${chatGptProxyRuntimeStatus(runtime)} 打开此开关会切换为${targetLabel}。`
            : `${chatGptProxyRuntimeStatus(runtime)} 打开此开关会启用${targetLabel}。`;

    return (
        <div data-chatgpt-proxy-runtime-control={target} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{targetLabel}</span>
                        <Tag color={active ? "success" : "default"} className="m-0">
                            {active ? "已启用" : "未启用"}
                        </Tag>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{target === "ipwo" ? "IPWO 是代理管理的来源；不会作为第三种独立代理模式。" : message}</p>
                    {target === "ipwo" && runtime ? <p className="mt-1 text-xs leading-5 text-zinc-500">{message}</p> : null}
                </div>
                <div className="shrink-0 pt-0.5">
                    {loading && !runtime ? (
                        <Spin size="small" />
                    ) : (
                        <Switch
                            aria-label={targetLabel}
                            checked={active}
                            loading={saving}
                            disabled={loading || saving || !runtime || Boolean(disabledReason)}
                            onChange={(enabled) => void save(chatGptProxyRuntimeInput(target, enabled, runtime)).catch(() => undefined)}
                        />
                    )}
                </div>
            </div>
            {disabledReason ? <Alert type="info" showIcon title={disabledReason} /> : null}
            {error ? <Alert type="error" showIcon title={error} /> : null}
        </div>
    );
}
