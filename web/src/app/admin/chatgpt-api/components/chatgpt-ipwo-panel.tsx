"use client";

import { Alert, App, Button, Input, InputNumber, Modal, Select, Spin } from "antd";
import { FlaskConical, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getIpwoSettings, saveIpwoSettings, testIpwoConnection, type IpwoSettings, type IpwoTestEvent } from "@/services/api/chatgpt-ipwo";

const stageLabels: Record<string, string> = { configuration: "配置校验", ipwo_api: "API 提取", proxy_egress: "出口连通性", ipinfo: "出口 IP 信息" };

export function ChatGptIpwoPanel({ controls, onSaved }: { controls: ReactNode; onSaved: () => Promise<unknown> }) {
    const { message } = App.useApp();
    const [settings, setSettings] = useState<IpwoSettings | null>(null);
    const [apiUrl, setApiUrl] = useState("");
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [open, setOpen] = useState(false);
    const [testing, setTesting] = useState(false);
    const [events, setEvents] = useState<IpwoTestEvent[]>([]);
    const [testError, setTestError] = useState("");
    const request = useRef<AbortController | null>(null);
    const pending = useRef(false);
    const mounted = useRef(true);
    const logEnd = useRef<HTMLDivElement | null>(null);
    const load = async (signal?: AbortSignal) => {
        setBusy(true);
        setError("");
        try {
            const result = await getIpwoSettings(signal);
            if (!mounted.current || signal?.aborted) return;
            setSettings(result);
            setApiUrl("");
            setDirty(false);
        } catch (reason) {
            if (mounted.current && !signal?.aborted) setError(reason instanceof Error ? reason.message : "读取 IPWO 设置失败");
        } finally {
            if (mounted.current && !signal?.aborted) setBusy(false);
        }
    };
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        void load(controller.signal);
        return () => {
            mounted.current = false;
            controller.abort();
            request.current?.abort();
        };
    }, []);
    useEffect(() => {
        logEnd.current?.scrollIntoView({ block: "nearest" });
    }, [events]);
    const save = async () => {
        if (!settings || pending.current) return;
        pending.current = true;
        setBusy(true);
        setError("");
        try {
            const saved = await saveIpwoSettings({ protocol: settings.protocol, regions: settings.regions, timeout_seconds: settings.timeout_seconds, ...(apiUrl.trim() ? { api_url: apiUrl.trim() } : {}) });
            if (!mounted.current) return;
            setSettings(saved);
            setApiUrl("");
            setDirty(false);
            try {
                await onSaved();
            } catch {
                setError("IPWO 配置已保存，但代理状态刷新失败；请刷新页面确认当前状态。");
                return;
            }
            void message.success("IPWO 设置已保存");
        } catch (reason) {
            if (mounted.current) setError(reason instanceof Error ? reason.message : "保存 IPWO 设置失败");
        } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
        }
    };
    const test = async () => {
        if (pending.current) return;
        pending.current = true;
        const controller = new AbortController();
        request.current = controller;
        setEvents([]);
        setTestError("");
        setOpen(true);
        setTesting(true);
        try {
            await testIpwoConnection((event) => {
                if (mounted.current && !controller.signal.aborted) setEvents((current) => [...current, event]);
            }, controller.signal);
        } catch (reason) {
            if (mounted.current && !controller.signal.aborted) setTestError(reason instanceof Error ? reason.message : "测试失败");
        } finally {
            pending.current = false;
            if (mounted.current) setTesting(false);
        }
    };
    const close = () => {
        request.current?.abort();
        setOpen(false);
    };
    const update = (patch: Partial<IpwoSettings>) => {
        setSettings((current) => current && { ...current, ...patch });
        setDirty(true);
    };
    return (
        <Panel>
            <PanelHeader
                title="IPWO 代理"
                description="自动提取代理 IP，无需逐个添加节点；使用前请在供应商控制台配置服务器公网 IP 白名单。"
                actions={
                    <Button aria-label="刷新 IPWO 配置" icon={<RefreshCw className="size-4" />} disabled={busy || testing || dirty} onClick={() => void load()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-4 p-3 sm:p-5" data-chatgpt-ipwo>
                {controls}
                {error ? <Alert showIcon type="error" title={error} /> : null}
                {!settings && busy ? (
                    <Spin />
                ) : settings ? (
                    <>
                        <Alert showIcon type="info" title="使用 API 提取链接，不使用网站登录密码" description="请从 IPWO 控制台复制 HTTPS API 提取链接。链接加密保存、不回显；留空保留已保存值。保存配置不会启用代理。" />
                        <div className="space-y-2">
                            <label htmlFor="ipwo-api-url">API 提取链接</label>
                            <Input.Password
                                id="ipwo-api-url"
                                aria-label="IPWO API 提取链接"
                                autoComplete="off"
                                placeholder={settings.has_api_url ? "已保存；留空保留，填写可替换" : "粘贴 IPWO 控制台生成的 HTTPS 链接"}
                                value={apiUrl}
                                disabled={busy || testing}
                                onChange={(event) => {
                                    setApiUrl(event.target.value);
                                    setDirty(true);
                                }}
                            />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-3">
                            <div className="min-w-0 space-y-2">
                                <label htmlFor="ipwo-protocol">代理协议</label>
                                <Select
                                    id="ipwo-protocol"
                                    aria-label="IPWO 代理协议"
                                    className="w-full"
                                    value={settings.protocol}
                                    options={[
                                        { value: "http", label: "HTTP / HTTPS" },
                                        { value: "socks5", label: "SOCKS5" },
                                    ]}
                                    disabled={busy || testing}
                                    onChange={(protocol) => update({ protocol })}
                                />
                            </div>
                            <div className="min-w-0 space-y-2">
                                <label htmlFor="ipwo-regions">国家 / 地区</label>
                                <Input id="ipwo-regions" aria-label="IPWO 国家地区" placeholder="如 US,JP；留空不限定" value={settings.regions} disabled={busy || testing} onChange={(event) => update({ regions: event.target.value })} />
                            </div>
                            <div className="min-w-0 space-y-2">
                                <label htmlFor="ipwo-timeout">请求超时（秒）</label>
                                <InputNumber
                                    id="ipwo-timeout"
                                    aria-label="IPWO 请求超时"
                                    className="w-full"
                                    value={settings.timeout_seconds}
                                    min={1}
                                    disabled={busy || testing}
                                    onChange={(value) => {
                                        if (value !== null) update({ timeout_seconds: value });
                                    }}
                                />
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button type="primary" loading={busy} disabled={testing || (!settings.has_api_url && !apiUrl.trim())} onClick={() => void save()}>
                                保存 IPWO 配置
                            </Button>
                            <Button icon={<FlaskConical className="size-4" />} loading={testing} disabled={busy || dirty || !settings.configured} onClick={() => void test()}>
                                测试 IPWO 连接
                            </Button>
                        </div>
                        <p className="text-xs text-zinc-500">测试使用已保存配置，会临时提取 IP 并访问出口检测服务，可能消耗供应商流量；不会切换业务代理或调用 ChatGPT。{dirty ? "请先保存修改再测试。" : ""}</p>
                    </>
                ) : null}
            </div>
            <Modal title="IPWO 连接测试 · 过程日志" open={open} onCancel={close} width="min(720px, calc(100vw - 24px))" footer={<Button onClick={close}>{testing ? "取消等待并关闭" : "关闭"}</Button>}>
                <div className="space-y-3">
                    {testing ? (
                        <div className="flex items-center gap-3">
                            <Spin size="small" />
                            <span>测试进行中，等待实际网络结果…</span>
                        </div>
                    ) : null}
                    {testError ? <Alert type="error" showIcon title={testError} /> : null}
                    <div role="log" aria-label="IPWO 测试日志" aria-live="polite" className="max-h-[55vh] overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                        {events.map((event, index) => (
                            <div key={index} className="mb-3 break-words text-sm last:mb-0">
                                <div className="text-xs text-zinc-500">
                                    {(event.elapsed_ms / 1000).toFixed(2)}s · {stageLabels[event.stage] || event.stage} · {event.status === "running" ? "进行中" : event.status === "success" ? "成功" : "失败"}
                                </div>
                                <div>{event.message}</div>
                                {event.exit_ip ? <div>出口 IP：{event.exit_ip}</div> : null}
                            </div>
                        ))}
                        <div ref={logEnd} />
                    </div>
                </div>
            </Modal>
        </Panel>
    );
}
