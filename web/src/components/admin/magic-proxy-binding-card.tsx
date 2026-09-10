"use client";

import { Alert, App, Button, Select, Segmented, Switch, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getMagicProxy, updateMagicProxyBinding, type MagicProxyNode, type MagicProxyProvider, type MagicProxyState } from "@/services/api/magic-proxy";
import { genericProxyRequest, getGenericProxyBindings, saveGenericProxyBinding, type ChatGptProxyView, type GenericProxyBindings } from "@/services/api/generic-proxy";

const providerLabels: Record<MagicProxyProvider, string> = {
    geminiai: "GeminiAIStudio",
    geminiTools: "GeminiTools",
    chatgptApi: "GPTAPI",
};

export function magicProxyBindingValidationMessage(enabled: boolean, node?: string) {
    return enabled && !node?.trim() ? "启用魔法代理前请选择代理节点" : "";
}

type ProxySource = "magic" | "generic";

export function MagicProxyBindingCard({ provider }: { provider: MagicProxyProvider }) {
    const { message } = App.useApp();
    const [state, setState] = useState<MagicProxyState | null>(null);
    const [genericBindings, setGenericBindings] = useState<GenericProxyBindings | null>(null);
    const [genericView, setGenericView] = useState<ChatGptProxyView | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [source, setSource] = useState<ProxySource>("magic");
    const [node, setNode] = useState("");
    const [target, setTarget] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [nextState, nextGeneric, nextGenericView] = await Promise.all([
                getMagicProxy(),
                getGenericProxyBindings().catch(() => null),
                genericProxyRequest<ChatGptProxyView>("proxies").catch(() => null),
            ]);
            setState(nextState);
            setGenericBindings(nextGeneric);
            setGenericView(nextGenericView);
            const magicBinding = nextState.bindings?.[provider];
            const genericBinding = nextGeneric?.bindings?.[provider];
            setEnabled(magicBinding?.enabled === true || genericBinding?.enabled === true);
            setSource(genericBinding?.enabled === true ? "generic" : "magic");
            setNode(magicBinding?.node || "");
            setTarget(genericBinding?.target || "");
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "读取代理绑定失败");
        } finally {
            setLoading(false);
        }
    }, [provider]);

    useEffect(() => {
        void load();
    }, [load]);

    const genericOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const group of genericView?.groups || []) {
            if (provider !== "geminiai") options.push({ value: `group:${group.id}`, label: `整组 · ${group.name}（${group.nodes.length} 个节点自动切换）` });
            for (const node of group.nodes) {
                options.push({ value: `node:${node.id}`, label: `节点 · ${node.name || node.id}（${group.name}）` });
            }
        }
        if (target && !options.some((option) => option.value === target)) options.unshift({ value: target, label: `${target} · 当前绑定` });
        return options;
    }, [genericView, provider, target]);

    const persistSourceSwitch = (nextSource: ProxySource) => {
        // Switching the viewed source is a local choice; the source is activated
        // when its node/target is selected or the master switch is turned on.
        setSource(nextSource);
    };

    const persist = async (nextEnabled: boolean, nextSource: ProxySource, overrides: { node?: string; target?: string } = {}) => {
        const effectiveNode = overrides.node ?? node;
        const effectiveTarget = overrides.target ?? target;
        const validationMessage = magicProxyBindingValidationMessage(nextEnabled && nextSource === "magic", effectiveNode);
        if (validationMessage) {
            message.error(validationMessage);
            return;
        }
        if (nextEnabled && nextSource === "generic" && !effectiveTarget) {
            message.error("启用通用代理前请先选择代理节点或整组，选择后自动生效");
            return;
        }

        const previous = { enabled, source };
        setEnabled(nextEnabled);
        setSaving(true);
        setError("");
        try {
            if (!nextEnabled) {
                await updateMagicProxyBinding({ provider, enabled: false }).catch(() => undefined);
                await saveGenericProxyBinding({ provider, enabled: false }).catch(() => undefined);
            } else if (nextSource === "magic") {
                await updateMagicProxyBinding({ provider, enabled: true, node: effectiveNode });
                await saveGenericProxyBinding({ provider, enabled: false });
            } else {
                await updateMagicProxyBinding({ provider, enabled: false }).catch(() => undefined);
                await saveGenericProxyBinding({ provider, enabled: true, target: effectiveTarget });
            }
            await load();
            message.success(`${providerLabels[provider]} 代理设置已保存`);
        } catch (saveError) {
            setEnabled(previous.enabled);
            setSource(previous.source);
            const nextError = saveError instanceof Error ? saveError.message : "保存代理设置失败";
            setError(nextError);
            message.error(nextError);
        } finally {
            setSaving(false);
        }
    };

    const nodes = state?.nodes || [];
    const nodeOptions = useMemo(() => {
        const options = nodes.map((item: MagicProxyNode) => ({ value: item.name, label: `${item.name} · ${item.type}` }));
        if (node && !options.some((option) => option.value === node)) options.unshift({ value: node, label: `${node} · 当前绑定` });
        return options;
    }, [node, nodes]);
    const configured = state?.configured === true;
    const runtimeAvailable = state?.runtimeAvailable === true;
    const magicUnavailableReason = !configured ? "请先在魔法代理页面导入订阅" : !runtimeAvailable ? "魔法代理运行时当前不可用" : !nodes.length ? "暂无可用代理节点" : "";
    const genericUnavailableReason = !(genericView?.groups || []).length ? "请先在通用代理页面添加分组或节点" : "";
    const description = provider === "geminiTools" ? "仅控制当前 Provider 是否使用代理及其出口来源；GeminiTools 账号列表中的账号启用开关仍保持原有含义。" : "仅控制当前 Provider 是否使用代理及其出口来源。";

    const magicActive = enabled && source === "magic";

    return (
        <Panel>
            <PanelHeader
                title={`${providerLabels[provider]} · 代理管理`}
                description={description}
                actions={
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-4 p-3 sm:p-4">
                {error ? <Alert type="error" showIcon message="代理绑定读取或保存失败" description={error} /> : null}
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-zinc-950 dark:text-zinc-100">启用代理</span>
                            <Tag color={enabled ? "success" : "default"} className="m-0">
                                {enabled ? "已启用" : "未启用"}
                            </Tag>
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">选择代理方式后仅显示所选方式的配置内容；选择节点或整组即启用该方式。</p>
                    </div>
                    <div className="shrink-0 pt-0.5">
                        <Switch
                            aria-label="启用代理"
                            checked={enabled}
                            disabled={loading || saving}
                            loading={saving}
                            onChange={(checked) => {
                                if (checked) {
                                    if (source === "magic" ? node : target) {
                                        void persist(true, source, source === "magic" ? { node } : { target });
                                        return;
                                    }
                                    setEnabled(true);
                                    message.info("请选择代理方式与出口，选择后自动启用");
                                    return;
                                }
                                void persist(false, source);
                            }}
                        />
                    </div>
                </div>
                {(
                    <>
                        <div className="min-w-0">
                            <label htmlFor={`proxy-source-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                代理方式
                            </label>
                            <Segmented
                                id={`proxy-source-${provider}`}
                                aria-label="代理方式"
                                value={source}
                                disabled={saving}
                                onChange={(value) => persistSourceSwitch(value as ProxySource)}
                                options={[
                                    { value: "magic", label: "魔法代理" },
                                    { value: "generic", label: "通用代理" },
                                ]}
                            />
                        </div>
                        {source === "magic" ? (
                            <div className="min-w-0">
                                <label htmlFor={`magic-proxy-node-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                    魔法节点
                                </label>
                                <div className="min-w-0 sm:max-w-sm">
                                    <Select
                                        id={`magic-proxy-node-${provider}`}
                                        aria-label="魔法节点"
                                        className="w-full"
                                        value={node || undefined}
                                        placeholder={magicUnavailableReason || "请选择魔法节点"}
                                        options={nodeOptions}
                                        disabled={loading || saving || !configured || !runtimeAvailable || !nodes.length}
                                        onChange={(value: string) => {
                                            setNode(value);
                                            void persist(true, "magic", { node: value });
                                        }}
                                    />
                                </div>
                                {magicActive && node ? <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">当前节点已保存，立即生效。</div> : null}
                            </div>
                        ) : (
                            <div className="min-w-0">
                                <label htmlFor={`generic-proxy-target-${provider}`} className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                    通用代理出口（节点或整组）
                                </label>
                                <div className="min-w-0 sm:max-w-md">
                                    <Select
                                        id={`generic-proxy-target-${provider}`}
                                        aria-label="通用代理出口"
                                        className="w-full"
                                        value={target || undefined}
                                        placeholder={genericUnavailableReason || "选择节点或整组"}
                                        options={genericOptions}
                                        disabled={loading || saving || Boolean(genericUnavailableReason)}
                                        onChange={(value: string) => {
                                            setTarget(value);
                                            void persist(true, "generic", { target: value });
                                        }}
                                    />
                                </div>
                                {enabled && source === "generic" && target ? (
                                    <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">当前出口已保存，立即生效；整组选择时每次请求按容量随机切换节点，单节点固定出口。</div>
                                ) : source === "generic" ? (
                                    <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">选择节点或整组后自动启用通用代理{provider === "geminiai" ? "；GeminiAIStudio 浏览器会话将随出口切换自动重启" : ""}。</div>
                                ) : null}
                            </div>
                        )}
                    </>
                )}
            </div>
        </Panel>
    );
}

export function magicProxyNodeOption(node: MagicProxyNode) {
    return { value: node.name, label: `${node.name} · ${node.type}` };
}
