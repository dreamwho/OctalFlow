"use client";

import { Alert, App, Button, Select, Spin, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getMagicProxy, updateMagicProxyBinding, type MagicProxyState } from "@/services/api/magic-proxy";
import { ChatGptProxyRuntimeControl } from "./chatgpt-proxy-runtime-control";
import type { ChatGptProxyRuntimeController } from "./use-chatgpt-proxy-runtime";

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

export function ChatGptMagicProxyPanel({ proxyRuntime }: { proxyRuntime: ChatGptProxyRuntimeController }) {
    const { message } = App.useApp();
    const [state, setState] = useState<MagicProxyState | null>(null);
    const [node, setNode] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const mounted = useRef(false);
    const revision = useRef(0);

    const load = useCallback(async () => {
        const currentRevision = ++revision.current;
        if (mounted.current) {
            setLoading(true);
            setError("");
        }
        try {
            const nextState = await getMagicProxy();
            if (!mounted.current || currentRevision !== revision.current) return;
            setState(nextState);
            setNode(nextState.bindings.chatgptApi?.node || "");
        } catch (reason) {
            if (mounted.current && currentRevision === revision.current) setError(errorMessage(reason, "读取魔法代理配置失败"));
        } finally {
            if (mounted.current && currentRevision === revision.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void load();
        return () => {
            mounted.current = false;
        };
    }, [load]);

    const nodeOptions = useMemo(() => {
        const options = (state?.nodes || []).map((item) => ({ value: item.name, label: `${item.name} · ${item.type}` }));
        if (node && !options.some((item) => item.value === node)) options.unshift({ value: node, label: `${node} · 当前保存节点` });
        return options;
    }, [node, state?.nodes]);
    const unavailableReason = !state?.configured ? "请先在通用魔法代理配置中导入订阅。" : !state.runtimeAvailable ? "魔法代理运行时当前不可用。" : !state.nodes.length ? "暂无可用魔法节点。" : "";
    const magicSwitchDisabledReason = state && !state.bindings.chatgptApi?.node ? "请先在下方选择并保存魔法节点，保存后即可开启使用魔法代理。" : undefined;

    const saveNode = async () => {
        if (!node.trim() || saving) return;
        setSaving(true);
        setError("");
        try {
            const nextState = await updateMagicProxyBinding({ provider: "chatgptApi", enabled: true, node: node.trim() });
            if (!mounted.current) return;
            setState(nextState);
            setNode(nextState.bindings.chatgptApi?.node || node.trim());
            try {
                await proxyRuntime.refresh();
            } catch (reason) {
                const notice = `魔法节点已保存，但总控状态刷新失败：${errorMessage(reason, "读取失败")}`;
                setError(notice);
                message.warning(notice);
                return;
            }
            message.success("魔法节点已保存");
        } catch (reason) {
            const nextError = errorMessage(reason, "保存魔法节点失败");
            if (mounted.current) {
                setError(nextError);
                message.error(nextError);
            }
        } finally {
            if (mounted.current) setSaving(false);
        }
    };

    const reload = async () => {
        await load();
        await proxyRuntime.refresh().catch(() => undefined);
    };

    return (
        <Panel>
            <PanelHeader
                title="魔法代理"
                description="保存 ChatGPT 使用的魔法节点；是否实际使用代理只由下方同一总控决定。"
                actions={
                    <Button icon={<RefreshCw className="size-4" />} loading={loading || proxyRuntime.loading} disabled={saving || proxyRuntime.saving} onClick={() => void reload()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-4 p-3 sm:p-5" data-chatgpt-magic-proxy>
                <ChatGptProxyRuntimeControl controller={proxyRuntime} target="magic" disabledReason={magicSwitchDisabledReason} />
                {error ? <Alert type="error" showIcon title={error} /> : null}
                {loading && !state ? <Spin /> : null}
                {state ? (
                    <>
                        <Alert type={unavailableReason ? "warning" : "info"} showIcon title="魔法节点配置" description={unavailableReason || "选择并保存节点不会绕过全局代理开关。"} />
                        <div className="max-w-xl space-y-2">
                            <label htmlFor="chatgpt-magic-proxy-node" className="text-sm font-medium">
                                魔法节点
                            </label>
                            <Select
                                id="chatgpt-magic-proxy-node"
                                aria-label="ChatGPT 魔法节点"
                                className="w-full"
                                value={node || undefined}
                                placeholder={unavailableReason || "选择已配置节点"}
                                options={nodeOptions}
                                disabled={loading || saving || Boolean(unavailableReason)}
                                onChange={setNode}
                            />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="primary" loading={saving} disabled={loading || saving || Boolean(unavailableReason) || !node.trim()} onClick={() => void saveNode()}>
                                保存魔法节点
                            </Button>
                            <Tag color={state.bindings.chatgptApi?.node ? "success" : "default"} className="m-0">
                                {state.bindings.chatgptApi?.node ? "已保存节点" : "尚未保存节点"}
                            </Tag>
                        </div>
                    </>
                ) : null}
            </div>
        </Panel>
    );
}
