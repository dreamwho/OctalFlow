"use client";

import { Alert, App, Button, Select, Switch, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getMagicProxy, updateMagicProxyBinding, type MagicProxyNode, type MagicProxyProvider, type MagicProxyState } from "@/services/api/magic-proxy";

const providerLabels: Record<MagicProxyProvider, string> = {
    geminiai: "GeminiAIStudio",
    geminiTools: "GeminiTools",
    chatgptApi: "GPTAPI",
};

export function magicProxyBindingValidationMessage(enabled: boolean, node?: string) {
    return enabled && !node?.trim() ? "启用魔法代理前请选择代理节点" : "";
}

export function MagicProxyBindingCard({ provider }: { provider: MagicProxyProvider }) {
    const { message } = App.useApp();
    const [state, setState] = useState<MagicProxyState | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [node, setNode] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const nextState = await getMagicProxy();
            setState(nextState);
            const binding = nextState.bindings?.[provider];
            setEnabled(binding?.enabled === true);
            setNode(binding?.node || "");
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "读取魔法代理绑定失败");
        } finally {
            setLoading(false);
        }
    }, [provider]);

    useEffect(() => {
        void load();
    }, [load]);

    const persist = async (nextEnabled: boolean, nextNode: string) => {
        const validationMessage = magicProxyBindingValidationMessage(nextEnabled, nextNode);
        if (validationMessage) {
            message.error(validationMessage);
            return;
        }

        const previous = { enabled, node };
        setEnabled(nextEnabled);
        setNode(nextNode);
        setSaving(true);
        setError("");
        try {
            const response = await updateMagicProxyBinding({ provider, enabled: nextEnabled, ...(nextNode ? { node: nextNode } : {}) });
            setState(response);
            const binding = response.bindings[provider] || { enabled: nextEnabled, node: nextNode };
            setEnabled(binding.enabled === true);
            setNode(binding.node || "");
            message.success(`${providerLabels[provider]} 魔法代理设置已保存`);
        } catch (saveError) {
            setEnabled(previous.enabled);
            setNode(previous.node);
            const nextError = saveError instanceof Error ? saveError.message : "保存魔法代理设置失败";
            setError(nextError);
            message.error(nextError);
        } finally {
            setSaving(false);
        }
    };

    const nodes = state?.nodes || [];
    const nodeOptions = useMemo(() => {
        const options = nodes.map((item) => ({ value: item.name, label: `${item.name} · ${item.type}` }));
        if (node && !options.some((option) => option.value === node)) options.unshift({ value: node, label: `${node} · 当前绑定` });
        return options;
    }, [node, nodes]);
    const configured = state?.configured === true;
    const runtimeAvailable = state?.runtimeAvailable === true;
    const disabledReason = !configured ? "请先在魔法代理页面导入订阅" : !runtimeAvailable ? "魔法代理运行时当前不可用" : !nodes.length ? "暂无可用代理节点" : "";
    const description = provider === "geminiTools" ? "仅控制当前 Provider 是否使用魔法代理及其节点；GeminiTools 账号列表中的账号启用开关仍保持原有含义。" : "仅控制当前 Provider 是否使用魔法代理及其节点。";

    return (
        <Panel>
            <PanelHeader
                title={`${providerLabels[provider]} · 魔法代理`}
                description={description}
                actions={
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-4 p-3 sm:p-4">
                {error ? <Alert type="error" showIcon message="魔法代理绑定读取或保存失败" description={error} /> : null}
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-zinc-950 dark:text-zinc-100">使用魔法代理</span>
                            <Tag color={enabled ? "success" : "default"} className="m-0">
                                {enabled ? "已启用" : "未启用"}
                            </Tag>
                            <Tag color={configured && runtimeAvailable ? "success" : "default"} className="m-0">
                                {configured ? (runtimeAvailable ? "运行时可用" : "运行时不可用") : "未配置"}
                            </Tag>
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{disabledReason || "启用后会立即保存当前节点绑定。"}</p>
                    </div>
                    <div className="shrink-0 pt-0.5">
                        <Switch aria-label="使用魔法代理" checked={enabled} disabled={loading || saving || Boolean(disabledReason)} loading={saving} onChange={(checked) => void persist(checked, node)} />
                    </div>
                </div>
                <div className="min-w-0">
                    <label htmlFor={`magic-proxy-node-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                        代理节点
                    </label>
                    <div className="min-w-0 sm:max-w-sm">
                        <Select
                            id={`magic-proxy-node-${provider}`}
                            aria-label="代理节点"
                            className="w-full"
                            value={node || undefined}
                            placeholder={disabledReason || "请选择代理节点"}
                            options={nodeOptions}
                            disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length}
                            onChange={(value: string) => void persist(enabled, value)}
                        />
                    </div>
                    {!enabled && node ? <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">当前节点已保存，启用开关后立即生效。</div> : null}
                </div>
            </div>
        </Panel>
    );
}

export function magicProxyNodeOption(node: MagicProxyNode) {
    return { value: node.name, label: `${node.name} · ${node.type}` };
}
