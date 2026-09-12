"use client";

import { Alert, App, Button, Collapse, Empty, Input, InputNumber, Modal, Popconfirm, Select, Switch, Tag, Tooltip } from "antd";
import { Activity, AlertCircle, CheckCircle2, ChevronRight, Copy, Globe, Info, Network, Plus, RefreshCw, Server, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { chatGptApiRequest, type ChatGptProxyDiagnostics, type ChatGptProxyGroup, type ChatGptProxyNode, type ChatGptProxyProbe, type ChatGptProxyReference, type ChatGptProxyView } from "@/services/api/chatgpt-api";
import { ChatGptProxyRuntimeControl } from "./chatgpt-proxy-runtime-control";
import type { ChatGptProxyRuntimeController } from "./use-chatgpt-proxy-runtime";

const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });
const strategies = [
    { value: "request_random", label: "每次请求随机" },
    { value: "round_robin", label: "轮询" },
    { value: "time_window", label: "按时间轮换" },
];
const newNode = (): ChatGptProxyNode => ({ id: "", name: "", url: "", enabled: true, image_concurrency_limit: 30, notes: "" });
const newGroup = (): ChatGptProxyGroup => ({ id: "", name: "", enabled: true, strategy: "request_random", rotation_interval_minutes: 5, notes: "", nodes: [], can_delete: true, references: [] });

type ProxyProtocol = "http://" | "socks5://";

const protocolOptions: Array<{ value: ProxyProtocol; label: string }> = [
    { value: "http://", label: "HTTP/HTTPS" },
    { value: "socks5://", label: "SOCKS5" },
];

function extractProxyProtocol(rawUrl: string): { protocol: ProxyProtocol; rest: string } {
    const trimmed = (rawUrl || "").trim();
    if (/^socks5h?:\/\//i.test(trimmed)) {
        return { protocol: "socks5://", rest: trimmed.replace(/^socks5h?:\/\//i, "") };
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return { protocol: "http://", rest: trimmed.replace(/^https?:\/\//i, "") };
    }
    return { protocol: "http://", rest: trimmed };
}

function assembleProxyUrl(protocol: ProxyProtocol, rest: string): string {
    const trimmed = (rest || "").trim();
    if (!trimmed) return "";
    const parts = trimmed.split(":");
    if (parts.length === 4) {
        if (/^\d+$/.test(parts[1])) {
            const [host, port, user, pass] = parts;
            return `${protocol}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
        }
        if (/^\d+$/.test(parts[3])) {
            const [user, pass, host, port] = parts;
            return `${protocol}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
        }
    }
    if (/^socks5h?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    return `${protocol}${trimmed}`;
}

function getProxyProtocolTag(rawUrl: string): { label: string; color: string } {
    const trimmed = (rawUrl || "").trim().toLowerCase();
    if (trimmed.startsWith("socks5")) {
        return { label: "SOCKS5", color: "cyan" };
    }
    return { label: "HTTP/HTTPS", color: "blue" };
}

function formatProxyDisplayUrl(rawUrl: string): string {
    if (!rawUrl) return "";
    if (rawUrl.includes("__OCTAL_PROXY_AUTH_REDACTED__")) {
        return rawUrl.replace("__OCTAL_PROXY_AUTH_REDACTED__@", "******@");
    }
    return rawUrl;
}

function ReferenceEditor({ label, value, groups, onChange, optional = false }: { label: string; value: ChatGptProxyReference | null; groups: ChatGptProxyGroup[]; onChange: (value: ChatGptProxyReference | null) => void; optional?: boolean }) {
    const nodeOptions = groups.flatMap((group) => group.nodes.filter((node) => node.enabled).map((node) => ({ value: node.id, label: `${node.name || node.id}（${group.name}）` })));
    return (
        <div className="space-y-2">
            <label className="text-sm font-medium">{label}</label>
            <Select
                className="w-full"
                aria-label={label}
                value={value?.mode || "disabled"}
                onChange={(mode) => onChange(mode === "disabled" ? null : mode === "group" ? { mode, group_id: "" } : mode === "node" ? { mode, node_id: nodeOptions[0]?.value || "" } : mode === "custom" ? { mode, url: "" } : { mode: "direct" })}
                options={[...(optional ? [{ value: "disabled", label: "关闭回退" }] : []), { value: "direct", label: "直接连接" }, { value: "node", label: "代理节点" }, { value: "group", label: "已保存代理组" }, { value: "custom", label: "自定义出口" }]}
            />
            {value?.mode === "node" ? (
                <Select
                    className="w-full"
                    aria-label={`${label}节点`}
                    placeholder={nodeOptions.length ? "选择代理节点" : "暂无可用节点，请在通用代理页面添加"}
                    value={value.node_id || undefined}
                    options={nodeOptions}
                    onChange={(node_id) => onChange({ mode: "node", node_id })}
                />
            ) : value?.mode === "group" ? (
                <Select
                    className="w-full"
                    aria-label={`${label}代理组`}
                    placeholder="选择代理组"
                    value={value.group_id || undefined}
                    options={groups.map((group) => ({ value: group.id, label: group.name }))}
                    onChange={(group_id) => onChange({ mode: "group", group_id })}
                />
            ) : value?.mode === "custom" ? (
                (() => {
                    const { protocol, rest } = extractProxyProtocol(value.url || "");
                    return (
                        <Input
                            aria-label={`${label}代理地址`}
                            autoComplete="off"
                            addonBefore={
                                <Select
                                    value={protocol}
                                    onChange={(newProto: ProxyProtocol) => {
                                        onChange({ mode: "custom", url: assembleProxyUrl(newProto, rest) });
                                    }}
                                    options={protocolOptions}
                                    style={{ width: 125 }}
                                />
                            }
                            placeholder="用户名:密码@主机:端口 或 主机:端口"
                            value={rest}
                            onChange={(event) => {
                                const inputVal = event.target.value.trim();
                                if (/^socks5h?:\/\//i.test(inputVal) || /^https?:\/\//i.test(inputVal)) {
                                    onChange({ mode: "custom", url: inputVal });
                                } else {
                                    onChange({ mode: "custom", url: assembleProxyUrl(protocol, inputVal) });
                                }
                            }}
                        />
                    );
                })()
            ) : null}
        </div>
    );
}

export type ProxyManagerRequest = <T,>(path: string, init?: RequestInit) => Promise<T>;

function ChatGptProxyDiagnosticModal({
    node,
    onClose,
}: {
    node: { name: string; url: string; health: NonNullable<ChatGptProxyNode["health"]> } | null;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    if (!node) return null;
    const diag = node.health.diagnostics;
    const isHealthy = node.health.state === "healthy" && !node.health.error;
    const analysis = diag?.analysis;

    const copyReport = () => {
        const lines: string[] = [];
        lines.push(`## 代理节点测试诊断报告`);
        lines.push(`- **节点名称**: ${node.name || "未命名节点"}`);
        lines.push(`- **代理协议/地址**: ${formatProxyDisplayUrl(node.url)}`);
        lines.push(`- **测试状态**: ${isHealthy ? "可用 (Healthy)" : "异常 (Unhealthy)"}`);
        lines.push(`- **总耗时**: ${node.health.latency_ms != null ? `${node.health.latency_ms} ms` : "未知"}`);
        if (node.health.error) lines.push(`- **错误信息**: ${node.health.error}`);
        if (diag?.server_context?.server_public_ip) lines.push(`- **当前服务器公网出口 IP**: ${diag.server_context.server_public_ip}`);
        if (diag?.server_context?.server_os) lines.push(`- **服务器系统环境**: ${diag.server_context.server_os}`);
        lines.push(``);
        if (analysis?.title || analysis?.summary) {
            lines.push(`### 智能诊断结论`);
            if (analysis.title) lines.push(`- **诊断项**: ${analysis.title}`);
            if (analysis.summary) lines.push(`- **概要**: ${analysis.summary}`);
            if (analysis.suggestions?.length) {
                lines.push(`- **排查建议**:`);
                analysis.suggestions.forEach((s) => lines.push(`  * ${s}`));
            }
            lines.push(``);
        }
        if (diag?.dns) {
            lines.push(`### 1. DNS 域名解析`);
            lines.push(`- 状态: ${diag.dns.ok ? "成功" : "失败"} (${diag.dns.latency_ms} ms)`);
            if (diag.dns.resolved_ips?.length) lines.push(`- 解析 IP: ${diag.dns.resolved_ips.join(", ")}`);
            if (diag.dns.error) lines.push(`- 错误: ${diag.dns.error}`);
            lines.push(``);
        }
        if (diag?.tcp) {
            lines.push(`### 2. TCP 端口握手`);
            lines.push(`- 状态: ${diag.tcp.ok ? "成功 (端口可达)" : "失败"} (${diag.tcp.latency_ms} ms)`);
            if (diag.tcp.error) lines.push(`- 错误: ${diag.tcp.error}`);
            lines.push(``);
        }
        if (diag?.probes?.length) {
            lines.push(`### 3. 端点探针测试明细`);
            diag.probes.forEach((p, idx) => {
                lines.push(`#### 探针 ${idx + 1}: ${p.name}`);
                lines.push(`- URL: ${p.url}`);
                lines.push(`- 状态: ${p.ok ? "通过" : "失败"} (${p.latency_ms} ms, HTTP ${p.status_code || 0})`);
                if (p.egress_ip) lines.push(`- 代理出口 IP: ${p.egress_ip}${p.loc ? ` (地区: ${p.loc})` : ""}`);
                if (p.error) lines.push(`- 错误: ${p.error}`);
            });
            lines.push(``);
        }
        navigator.clipboard.writeText(lines.join("\n"));
        message.success("诊断报告已复制到剪贴板");
    };

    return (
        <Modal
            title={
                <div className="flex items-center gap-2">
                    <Activity className="size-4 text-sky-500" />
                    <span>代理测试详细诊断日志 · {node.name || "未命名节点"}</span>
                </div>
            }
            open={Boolean(node)}
            width={760}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            footer={
                <div className="flex items-center justify-between">
                    <Button icon={<Copy className="size-3.5" />} onClick={copyReport}>
                        复制诊断报告
                    </Button>
                    <Button type="primary" onClick={onClose}>
                        关闭
                    </Button>
                </div>
            }
            onCancel={onClose}
        >
            <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1 py-1">
                {/* 节点概览条 */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3 dark:border-zinc-800/80 dark:bg-zinc-900/40">
                    <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{node.name || "未命名节点"}</span>
                            <Tag color={isHealthy ? "success" : "error"}>{isHealthy ? "可用" : "异常"}</Tag>
                            {node.health.latency_ms != null ? (
                                <span className="font-mono text-xs text-zinc-500">{node.health.latency_ms} ms</span>
                            ) : null}
                        </div>
                        <div className="font-mono text-xs text-zinc-500 break-all select-all">
                            {formatProxyDisplayUrl(node.url)}
                        </div>
                    </div>
                </div>

                {/* 服务器公网 IP 突出展示 (针对 IPWO 白名单问题) */}
                {diag?.server_context?.server_public_ip ? (
                    <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <Server className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
                                <span className="font-medium">当前运行本服务的服务器公网出口 IP：</span>
                                <code className="rounded bg-amber-100 dark:bg-amber-900/60 px-2 py-0.5 font-mono text-xs font-bold text-amber-900 dark:text-amber-100">
                                    {diag.server_context.server_public_ip}
                                </code>
                            </div>
                            <Button
                                size="small"
                                icon={<Copy className="size-3" />}
                                onClick={() => {
                                    navigator.clipboard.writeText(diag.server_context?.server_public_ip || "");
                                    message.success("服务器公网 IP 已复制");
                                }}
                            >
                                复制 IP
                            </Button>
                        </div>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-700/90 dark:text-amber-300/80">
                            提示：若代理服务商（如 IPWO、芝麻、BrightData 等）开启了「IP 白名单限制」，代理网关会直接返回连接重置 (curl 56 Connection reset by peer)。请登录代理平台后台，将此 IP 添加至白名单。
                        </p>
                    </div>
                ) : null}

                {/* 智能诊断与排查建议 */}
                {analysis ? (
                    <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/80 p-3.5 text-xs dark:border-zinc-800/80 dark:bg-zinc-900/60 space-y-2">
                        <div className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
                            <ShieldAlert className="size-4 text-sky-500 shrink-0" />
                            <span>{analysis.title || "智能分析结论"}</span>
                        </div>
                        {analysis.summary ? (
                            <p className="text-zinc-600 dark:text-zinc-300 leading-relaxed">{analysis.summary}</p>
                        ) : null}
                        {analysis.suggestions?.length ? (
                            <div className="pt-1 space-y-1.5">
                                <div className="font-medium text-zinc-800 dark:text-zinc-200">排查建议：</div>
                                <ul className="list-disc pl-4 space-y-1 text-zinc-600 dark:text-zinc-400">
                                    {analysis.suggestions.map((s, idx) => (
                                        <li key={idx} className="leading-relaxed">{s}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {/* 连接阶段耗时卡片 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* DNS 解析 */}
                    <div className="rounded-lg border border-zinc-200/80 bg-white p-3 text-xs dark:border-zinc-800/80 dark:bg-zinc-900 space-y-1">
                        <div className="flex items-center justify-between">
                            <span className="font-medium flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                                <Globe className="size-3.5 text-sky-500" />
                                域名解析 (DNS)
                            </span>
                            <Tag color={diag?.dns?.ok ? "success" : "error"}>
                                {diag?.dns?.ok ? `成功 (${diag.dns.latency_ms} ms)` : "解析失败"}
                            </Tag>
                        </div>
                        {diag?.dns?.resolved_ips?.length ? (
                            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono">
                                解析目标: {diag.dns.resolved_ips.join(", ")}
                            </div>
                        ) : null}
                        {diag?.dns?.error ? (
                            <div className="text-[11px] text-red-500">{diag.dns.error}</div>
                        ) : null}
                    </div>

                    {/* TCP 端口握手 */}
                    <div className="rounded-lg border border-zinc-200/80 bg-white p-3 text-xs dark:border-zinc-800/80 dark:bg-zinc-900 space-y-1">
                        <div className="flex items-center justify-between">
                            <span className="font-medium flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                                <Network className="size-3.5 text-indigo-500" />
                                TCP 端口握手
                            </span>
                            <Tag color={diag?.tcp?.ok ? "success" : "error"}>
                                {diag?.tcp?.ok ? `端口可达 (${diag.tcp.latency_ms} ms)` : "连接失败"}
                            </Tag>
                        </div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono">
                            直连目标: {diag?.proxy?.host}:{diag?.proxy?.port}
                        </div>
                        {diag?.tcp?.error ? (
                            <div className="text-[11px] text-red-500">{diag.tcp.error}</div>
                        ) : null}
                    </div>
                </div>

                {/* 端点探针执行明细 */}
                {diag?.probes?.length ? (
                    <div className="rounded-lg border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-900 overflow-hidden">
                        <div className="border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center justify-between">
                            <span>端点探针执行明细</span>
                            <span className="text-[11px] text-zinc-400">共执行 {diag.probes.length} 个端点探针</span>
                        </div>
                        <div className="divide-y divide-zinc-100 dark:divide-zinc-800 text-xs">
                            {diag.probes.map((probe) => (
                                <div key={probe.id} className="p-3 space-y-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {probe.ok ? (
                                                <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
                                            ) : (
                                                <XCircle className="size-3.5 text-red-500 shrink-0" />
                                            )}
                                            <span className="font-medium text-zinc-800 dark:text-zinc-200">{probe.name}</span>
                                            <code className="text-[11px] text-zinc-400 font-mono truncate max-w-[280px]">
                                                {probe.url}
                                            </code>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {probe.status_code > 0 ? (
                                                <Tag color={probe.ok ? "success" : "warning"} className="m-0 text-[11px]">
                                                    HTTP {probe.status_code}
                                                </Tag>
                                            ) : null}
                                            <span className="font-mono text-zinc-500 text-[11px]">{probe.latency_ms} ms</span>
                                        </div>
                                    </div>
                                    {probe.egress_ip ? (
                                        <div className="text-[11px] text-emerald-600 dark:text-emerald-400 pl-5.5">
                                            代理出口 IP：<strong className="font-mono">{probe.egress_ip}</strong>
                                            {probe.loc ? ` (国家/地区: ${probe.loc})` : ""}
                                        </div>
                                    ) : null}
                                    {probe.error ? (
                                        <div className="text-[11px] text-red-500 dark:text-red-400 pl-5.5 break-all">
                                            {probe.error}
                                        </div>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                {/* 原始诊断 JSON (可折叠) */}
                <Collapse
                    size="small"
                    items={[
                        {
                            key: "raw_json",
                            label: <span className="text-xs text-zinc-500">查看原始诊断遥测 JSON</span>,
                            children: (
                                <pre className="max-h-48 overflow-y-auto rounded bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-300 select-all whitespace-pre-wrap break-all">
                                    {JSON.stringify(diag || { error: node.health.error, state: node.health.state }, null, 2)}
                                </pre>
                            ),
                        },
                    ]}
                />
            </div>
        </Modal>
    );
}

export function ChatGptProxyManager({ proxyRuntime, request = chatGptApiRequest, showDefaults = true, showGroups = true, showSourceSwitch = true, title = "代理管理", description = "维护代理管理的已存出口与回退配置。它们不是额外代理模式：全局仅会使用代理管理或魔法代理。" }: {
    proxyRuntime?: ChatGptProxyRuntimeController;
    request?: ProxyManagerRequest;
    showDefaults?: boolean;
    showGroups?: boolean;
    showSourceSwitch?: boolean;
    title?: string;
    description?: string;
}) {
    const { message } = App.useApp();
    const [view, setView] = useState<ChatGptProxyView | null>(null);
    const [defaults, setDefaults] = useState<{ default_reference: ChatGptProxyReference; fallback_reference: ChatGptProxyReference | null }>({ default_reference: { mode: "direct" }, fallback_reference: null });
    const [draft, setDraft] = useState<ChatGptProxyGroup | null>(null);
    const [importText, setImportText] = useState("");
    const [importProtocol, setImportProtocol] = useState<ProxyProtocol>("http://");
    const [importOpen, setImportOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [nodeTests, setNodeTests] = useState<Record<string, NonNullable<ChatGptProxyNode["health"]>>>({});
    const [diagnosticNode, setDiagnosticNode] = useState<{ name: string; url: string; health: NonNullable<ChatGptProxyNode["health"]> } | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const pending = useRef(false);
    const mounted = useRef(true);
    const loadRevision = useRef(0);
    const load = useCallback(async () => {
        const revision = ++loadRevision.current;
        const result = await request<ChatGptProxyView>("proxies");
        if (!mounted.current || revision !== loadRevision.current) return;
        setView(result);
        setDefaults({ default_reference: result.default_reference, fallback_reference: result.fallback_reference });
    }, []);
    useEffect(() => {
        mounted.current = true;
        setBusy("load");
        void load()
            .catch((reason: unknown) => {
                if (mounted.current) setError(reason instanceof Error ? reason.message : "读取代理失败");
            })
            .finally(() => {
                if (mounted.current) setBusy("");
            });
        return () => {
            mounted.current = false;
        };
    }, [load]);
    const act = async <T,>(label: string, work: () => Promise<T>, reload = true) => {
        if (pending.current) return { ok: false as const };
        pending.current = true;
        setBusy(label);
        setError("");
        try {
            const result = await work();
            if (reload) await load();
            return { ok: true as const, result };
        } catch (reason) {
            if (mounted.current) setError(reason instanceof Error ? reason.message : "代理操作失败");
            return { ok: false as const };
        } finally {
            pending.current = false;
            if (mounted.current) setBusy("");
        }
    };
    const updateNode = (index: number, patch: Partial<ChatGptProxyNode>) => setDraft((current) => current && { ...current, nodes: current.nodes.map((node, cursor) => (cursor === index ? { ...node, ...patch } : node)) });
    const testGroup = (id: string, nodeId?: string) =>
        request<{ summary: { message: string }; results: Array<{ node_id: string; result: { ok: boolean; latency_ms: number; error?: string | null; target_warning?: string | null; diagnostics?: ChatGptProxyDiagnostics | null } }> }>("proxies/groups/test", json({ id, ...(nodeId ? { node_id: nodeId } : {}) }));
    const applyGroupTest = async (id: string, nodeId?: string) => {
        const outcome = await act(`test-${nodeId || id}`, () => testGroup(id, nodeId), false);
        if (!outcome.ok) return;
        const result = outcome.result;
        setNodeTests((current) => ({
            ...current,
            ...Object.fromEntries(
                result.results.map(({ node_id, result: test }) => [
                    node_id,
                    {
                        state: test.ok ? "healthy" : "unhealthy",
                        latency_ms: test.latency_ms,
                        error: test.error,
                        diagnostics: test.diagnostics,
                    },
                ])
            ),
        }));
        void message.info(result.summary.message);
    };
    const saveDraft = async () => {
        if (!draft) return;
        const group = draft;
        const outcome = await act("save", () =>
            request(
                "proxies/groups",
                json({
                    id: group.id,
                    create_only: !group.id,
                    name: group.name,
                    enabled: group.enabled,
                    strategy: group.strategy,
                    rotation_interval_minutes: group.rotation_interval_minutes,
                    notes: group.notes,
                    nodes: group.nodes.map(({ id, name, url, enabled, image_concurrency_limit, notes }) => ({ id, name, url, enabled, image_concurrency_limit, notes })),
                }),
            ),
        );
        if (outcome.ok && mounted.current) {
            setDraft(null);
            message.success("代理组已保存");
        }
    };
    const importNodes = async () => {
        const textWithProtocol = importText
            .split("\n")
            .map((line) => {
                const trimmed = line.trim();
                if (!trimmed) return "";
                const parts = trimmed.split(/\s+/);
                const urlPart = parts[0];
                if (!/^https?:\/\//i.test(urlPart) && !/^socks5h?:\/\//i.test(urlPart)) {
                    parts[0] = `${importProtocol}${urlPart}`;
                }
                return parts.join(" ");
            })
            .join("\n");
        const outcome = await act(
            "import",
            async () => {
                const result = await request<{ nodes: Array<{ url: string; image_concurrency_limit: number }>; invalid_count: number; duplicate_count: number }>("proxies/nodes/import", json({ text: textWithProtocol }));
                if (result.invalid_count) throw new Error(`有 ${result.invalid_count} 行无效，请检查代理地址；未添加节点`);
                return result;
            },
            false,
        );
        if (!outcome.ok || !mounted.current) return;
        const result = outcome.result;
        setDraft((current) => current && { ...current, nodes: [...current.nodes, ...result.nodes.map((node) => ({ ...newNode(), ...node }))] });
        setImportOpen(false);
        setImportText("");
        message.success(`已添加 ${result.nodes.length} 个节点，跳过重复 ${result.duplicate_count} 个`);
    };
    return (
        <Panel>
            <PanelHeader
                title={title}
                description={description}
                actions={
                    <>
                        <Button loading={busy === "load"} disabled={Boolean(busy)} icon={<RefreshCw className="size-4" />} onClick={() => void act("load", load, false)}>
                            刷新代理
                        </Button>
                        {showGroups ? (
                            <Button type="primary" disabled={Boolean(busy)} icon={<Plus className="size-4" />} onClick={() => setDraft(newGroup())}>
                                新建代理组
                            </Button>
                        ) : null}
                    </>
                }
            />
            <div className="space-y-4 p-3 sm:p-5" data-chatgpt-proxy-manager>
                {showDefaults && showSourceSwitch && proxyRuntime ? <ChatGptProxyRuntimeControl controller={proxyRuntime} target="manual" /> : null}
                {error ? <Alert type="error" showIcon title={error} /> : null}
                {view ? (
                    <>
                        {showDefaults ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                            <ReferenceEditor label="默认出口" value={defaults.default_reference} groups={view.groups} onChange={(value) => setDefaults((current) => ({ ...current, default_reference: value || { mode: "direct" } }))} />
                            <ReferenceEditor label="失败回退" optional value={defaults.fallback_reference} groups={view.groups} onChange={(value) => setDefaults((current) => ({ ...current, fallback_reference: value }))} />
                        </div>
                        ) : null}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <span className="text-xs text-zinc-500">
                                当前默认：{view.effective_default.label} · 回退：{view.effective_fallback.label}
                            </span>
                            {showDefaults ? (
                                <div className="flex items-center gap-2">
                                    {proxyRuntime && (proxyRuntime.runtime?.mode !== "native" || !proxyRuntime.runtime?.enabled) ? (
                                        <Button
                                            loading={busy === "defaults" || proxyRuntime.saving}
                                            disabled={Boolean(busy) || proxyRuntime.saving}
                                            onClick={() =>
                                                void act("defaults", async () => {
                                                    await proxyRuntime.save({ enabled: true, mode: "native", native_source: "manual" });
                                                }).then(() => {
                                                    message.success("已切换并启用通用代理");
                                                })
                                            }
                                        >
                                            启用通用代理
                                        </Button>
                                    ) : null}
                                    <Button
                                        type="primary"
                                        loading={busy === "defaults" || proxyRuntime?.saving}
                                        disabled={Boolean(busy) || proxyRuntime?.saving}
                                        onClick={() =>
                                            void act("defaults", async () => {
                                                const outcome = await request("proxies/defaults", json(defaults));
                                                if (proxyRuntime && (proxyRuntime.runtime?.mode !== "native" || !proxyRuntime.runtime?.enabled)) {
                                                    await proxyRuntime.save({ enabled: true, mode: "native", native_source: "manual" });
                                                }
                                                return outcome;
                                            }).then((outcome) => {
                                                if (outcome?.ok) message.success("代理出口已保存并启用通用代理");
                                            })
                                        }
                                    >
                                        保存出口
                                    </Button>
                                    {proxyRuntime?.runtime?.mode === "native" && proxyRuntime?.runtime?.enabled ? (
                                        <Tag color="processing" className="m-0">当前已生效</Tag>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                        {showGroups ? (
                        <>
                        <Input.Search aria-label="搜索代理组" placeholder="搜索代理组" value={search} onChange={(event) => setSearch(event.target.value)} />
                        {!view.groups.length ? (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无代理组" />
                        ) : (
                            view.groups
                                .filter((group) => group.name.toLowerCase().includes(search.toLowerCase()))
                                .map((group) => (
                                    <div key={group.id} className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="min-w-0">
                                                <h3 className="break-all text-base font-medium">{group.name}</h3>
                                                <p className="mt-1 text-xs text-zinc-500">
                                                    {strategies.find((item) => item.value === group.strategy)?.label} · {group.nodes.length} 个节点
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Switch
                                                    aria-label={`启用代理组 ${group.name}`}
                                                    checked={group.enabled}
                                                    disabled={Boolean(busy)}
                                                    onChange={(enabled) => void act("group", () => request("proxies/groups", json({ id: group.id, enabled })))}
                                                />
                                                <Button disabled={Boolean(busy)} onClick={() => setDraft({ ...group, nodes: group.nodes.map((node) => ({ ...node, url: node.url || "" })) })}>
                                                    编辑
                                                </Button>
                                                <Button disabled={Boolean(busy)} loading={busy === `test-${group.id}`} onClick={() => void applyGroupTest(group.id)}>
                                                    测试代理组
                                                </Button>
                                                <Popconfirm title="删除这个代理组？" okText="删除" cancelText="取消" onConfirm={() => act("delete", () => request(`proxies/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" }))}>
                                                    <Button danger disabled={Boolean(busy) || !group.can_delete}>
                                                        删除
                                                    </Button>
                                                </Popconfirm>
                                            </div>
                                        </div>
                                        {group.references.length ? <p className="break-all text-xs text-zinc-500">引用：{group.references.join("、")}</p> : null}
                                        {group.nodes.map((storedNode) => {
                                            const node = { ...storedNode, health: nodeTests[storedNode.id] || storedNode.health };
                                            const protoTag = getProxyProtocolTag(node.url);
                                            return (
                                                <div key={node.id} className="flex flex-wrap items-center justify-between gap-2 text-sm border-b border-zinc-100 dark:border-zinc-800/60 pb-2 last:border-b-0 last:pb-0">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5 font-medium text-zinc-800 dark:text-zinc-200 break-all">
                                                            <Tag color={protoTag.color} className="m-0 text-[11px] leading-tight px-1 py-0">{protoTag.label}</Tag>
                                                            <span>{node.name || "未命名节点"}</span>
                                                        </div>
                                                        {node.url ? (
                                                            <div className="mt-0.5 font-mono text-xs text-zinc-500 break-all select-all">
                                                                {formatProxyDisplayUrl(node.url)}
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                    <span className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
                                                        <Tag color={node.health?.state === "healthy" ? "success" : node.health?.state === "unhealthy" ? "error" : "default"}>
                                                            {node.health?.state === "healthy" ? "可用" : node.health?.state === "unhealthy" ? "异常" : "未检测"}
                                                        </Tag>
                                                        {node.health?.latency_ms != null ? `${node.health.latency_ms} ms` : null} · 图片并发 {node.image_concurrency_limit || "不限"}
                                                        <Button size="small" disabled={Boolean(busy)} loading={busy === `test-${node.id}`} onClick={() => void applyGroupTest(group.id, node.id)}>
                                                            测试节点
                                                        </Button>
                                                    </span>
                                                    {node.health?.error ? (
                                                        <div className="w-full mt-2 rounded-md border border-red-200/80 bg-red-50/70 p-2.5 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 space-y-1">
                                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                                <span className="font-semibold flex items-center gap-1.5">
                                                                    <AlertCircle className="size-3.5 shrink-0 text-red-500" />
                                                                    <span>{node.health.diagnostics?.analysis?.title || "节点连接异常"}</span>
                                                                </span>
                                                                <Button
                                                                    size="small"
                                                                    type="link"
                                                                    className="h-auto p-0 text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 shrink-0"
                                                                    onClick={() => setDiagnosticNode({ name: node.name, url: node.url, health: node.health! })}
                                                                >
                                                                    查看详细诊断与排查建议 ➔
                                                                </Button>
                                                            </div>
                                                            <p className="break-all opacity-90">{node.health.error}</p>
                                                            {node.health.diagnostics?.server_context?.server_public_ip ? (
                                                                <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                                                    <span>当前服务器公网 IP：<code className="font-mono font-bold text-zinc-800 dark:text-zinc-200 bg-zinc-200/60 dark:bg-zinc-800/80 px-1 rounded">{node.health.diagnostics.server_context.server_public_ip}</code></span>
                                                                    <span className="text-zinc-400">|</span>
                                                                    <span className="text-amber-600 dark:text-amber-400 font-medium">请确认已将此 IP 添加至代理平台后台白名单</span>
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    ) : node.health?.diagnostics ? (
                                                        <div className="w-full mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
                                                            <span className="flex items-center gap-1.5 min-w-0">
                                                                <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
                                                                <span>{node.health.diagnostics.analysis?.title || "探针测试通过"}</span>
                                                                {node.health.diagnostics.probes?.find((p) => p.egress_ip)?.egress_ip ? (
                                                                    <span className="font-mono text-zinc-600 dark:text-zinc-400">
                                                                        (代理出口 IP: {node.health.diagnostics.probes.find((p) => p.egress_ip)?.egress_ip}{node.health.diagnostics.probes.find((p) => p.loc)?.loc ? ` · ${node.health.diagnostics.probes.find((p) => p.loc)?.loc}` : ""})
                                                                    </span>
                                                                ) : null}
                                                            </span>
                                                            <Button
                                                                size="small"
                                                                type="link"
                                                                className="h-auto p-0 text-[11px] text-sky-600 hover:text-sky-700 dark:text-sky-400 shrink-0"
                                                                onClick={() => setDiagnosticNode({ name: node.name, url: node.url, health: node.health! })}
                                                            >
                                                                查看连接诊断日志 ➔
                                                            </Button>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ))
                        )}
                        </>
                        ) : null}
                    </>
                ) : null}
            </div>
            <Modal
                title={draft?.id ? "编辑代理组" : "新建代理组"}
                open={Boolean(draft)}
                width={720}
                style={{ maxWidth: "calc(100vw - 24px)" }}
                okText="保存"
                cancelText="取消"
                confirmLoading={busy === "save"}
                cancelButtonProps={{ disabled: Boolean(busy) }}
                closable={!busy}
                maskClosable={!busy}
                onCancel={() => {
                    if (!busy) setDraft(null);
                }}
                onOk={() => void saveDraft()}
            >
                {draft ? (
                    <div className="max-h-[65vh] space-y-4 overflow-y-auto py-2">
                        {error ? <Alert title={error} type="error" showIcon /> : null}
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Input aria-label="代理组名称" placeholder="代理组名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                            <Select aria-label="轮换策略" value={draft.strategy} options={strategies} onChange={(strategy) => setDraft({ ...draft, strategy })} />
                            {draft.strategy === "time_window" ? (
                                <InputNumber aria-label="轮换间隔分钟" min={0} max={1440} value={draft.rotation_interval_minutes} addonAfter="分钟" onChange={(value) => setDraft({ ...draft, rotation_interval_minutes: value || 0 })} />
                            ) : null}
                        </div>
                        <Input aria-label="代理组备注" placeholder="备注" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
                        <p className="text-xs text-zinc-500">支持 HTTP/HTTPS 与 SOCKS5；可直接选择协议并填写 用户名:密码@主机:端口、主机:端口:用户名:密码，或直接粘贴完整链接。图片并发 0 表示不限。</p>
                        {draft.nodes.map((node, index) => {
                            const { protocol: nodeProto, rest: nodeRest } = extractProxyProtocol(node.url || "");
                            return (
                                <div key={node.id || index} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <div className="flex items-center gap-2">
                                        <Input aria-label={`节点 ${index + 1} 名称`} placeholder="节点名称" value={node.name} onChange={(event) => updateNode(index, { name: event.target.value })} />
                                        <Switch aria-label={`启用节点 ${index + 1}`} checked={node.enabled} onChange={(enabled) => updateNode(index, { enabled })} />
                                        <Button danger aria-label={`删除节点 ${index + 1}`} icon={<Trash2 className="size-4" />} onClick={() => setDraft({ ...draft, nodes: draft.nodes.filter((_, cursor) => cursor !== index) })} />
                                    </div>
                                    <Input
                                        aria-label={`节点 ${index + 1} 代理地址`}
                                        addonBefore={
                                            <Select
                                                value={nodeProto}
                                                onChange={(newProto: ProxyProtocol) => {
                                                    updateNode(index, { url: assembleProxyUrl(newProto, nodeRest) });
                                                }}
                                                options={protocolOptions}
                                                style={{ width: 125 }}
                                            />
                                        }
                                        placeholder="用户名:密码@主机:端口 或 主机:端口"
                                        value={nodeRest}
                                        onChange={(event) => {
                                            const inputVal = event.target.value.trim();
                                            if (/^socks5h?:\/\//i.test(inputVal) || /^https?:\/\//i.test(inputVal)) {
                                                updateNode(index, { url: inputVal });
                                            } else {
                                                updateNode(index, { url: assembleProxyUrl(nodeProto, inputVal) });
                                            }
                                        }}
                                    />
                                    <div className="flex flex-wrap items-center gap-2">
                                        <label className="text-xs text-zinc-500">图片并发</label>
                                        <InputNumber aria-label={`节点 ${index + 1} 图片并发`} min={0} max={10000} value={node.image_concurrency_limit} onChange={(value) => updateNode(index, { image_concurrency_limit: value || 0 })} />
                                    </div>
                                </div>
                            );
                        })}
                        <div className="flex gap-2">
                            <Button icon={<Plus className="size-4" />} onClick={() => setDraft({ ...draft, nodes: [...draft.nodes, newNode()] })}>
                                添加节点
                            </Button>
                            <Button
                                onClick={() => {
                                    setImportText("");
                                    setImportOpen(true);
                                }}
                            >
                                批量导入节点
                            </Button>
                        </div>
                    </div>
                ) : null}
            </Modal>
            <Modal
                title="批量导入代理节点"
                open={importOpen}
                width={640}
                style={{ maxWidth: "calc(100vw - 24px)" }}
                okText="解析并添加"
                cancelText="取消"
                confirmLoading={busy === "import"}
                cancelButtonProps={{ disabled: Boolean(busy) }}
                closable={!busy}
                maskClosable={!busy}
                onCancel={() => {
                    if (!busy) {
                        setImportOpen(false);
                        setImportText("");
                    }
                }}
                onOk={() => void importNodes()}
            >
                <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs text-zinc-500">无协议前缀行默认使用：</span>
                    <Select
                        size="small"
                        value={importProtocol}
                        onChange={(val: ProxyProtocol) => setImportProtocol(val)}
                        options={protocolOptions}
                        style={{ width: 125 }}
                    />
                </div>
                <p className="mb-2 text-xs text-zinc-500">每行一个代理地址，可在地址后空格填写图片并发数量。仅解析，保存代理组后生效。</p>
                {error ? <Alert type="error" title={error} showIcon /> : null}
                <Input.TextArea aria-label="代理节点批量内容" rows={8} value={importText} onChange={(event) => setImportText(event.target.value)} />
            </Modal>
            <ChatGptProxyDiagnosticModal node={diagnosticNode} onClose={() => setDiagnosticNode(null)} />
        </Panel>
    );
}
