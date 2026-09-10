"use client";

import { Alert, App, Button, Empty, Input, InputNumber, Modal, Popconfirm, Select, Switch, Tag } from "antd";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { chatGptApiRequest, type ChatGptProxyGroup, type ChatGptProxyNode, type ChatGptProxyReference, type ChatGptProxyView } from "@/services/api/chatgpt-api";
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
                <Input.Password aria-label={`${label}代理地址`} autoComplete="off" placeholder="填写代理 URL；已保存的凭据不回显" value={value.url} onChange={(event) => onChange({ mode: "custom", url: event.target.value })} />
            ) : null}
        </div>
    );
}

export type ProxyManagerRequest = <T,>(path: string, init?: RequestInit) => Promise<T>;

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
    const [importOpen, setImportOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [nodeTests, setNodeTests] = useState<Record<string, NonNullable<ChatGptProxyNode["health"]>>>({});
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
        request<{ summary: { message: string }; results: Array<{ node_id: string; result: { ok: boolean; latency_ms: number; error?: string | null } }> }>("proxies/groups/test", json({ id, ...(nodeId ? { node_id: nodeId } : {}) }));
    const applyGroupTest = async (id: string, nodeId?: string) => {
        const outcome = await act(`test-${nodeId || id}`, () => testGroup(id, nodeId), false);
        if (!outcome.ok) return;
        const result = outcome.result;
        setNodeTests((current) => ({ ...current, ...Object.fromEntries(result.results.map(({ node_id, result: test }) => [node_id, { state: test.ok ? "healthy" : "unhealthy", latency_ms: test.latency_ms, error: test.error }])) }));
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
        const outcome = await act(
            "import",
            async () => {
                const result = await request<{ nodes: Array<{ url: string; image_concurrency_limit: number }>; invalid_count: number; duplicate_count: number }>("proxies/nodes/import", json({ text: importText }));
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
                                <Button
                                    type="primary"
                                    loading={busy === "defaults"}
                                    disabled={Boolean(busy)}
                                    onClick={() =>
                                        void act("defaults", () => request("proxies/defaults", json(defaults))).then((outcome) => {
                                            if (outcome.ok) message.success("代理出口已保存");
                                        })
                                    }
                                >
                                    保存出口
                                </Button>
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
                                                <Button disabled={Boolean(busy)} onClick={() => setDraft({ ...group, nodes: group.nodes.map((node) => ({ ...node, url: "" })) })}>
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
                                            return (
                                                <div key={node.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                                    <span className="break-all">{node.name || "未命名节点"}</span>
                                                    <span className="flex items-center gap-2 text-xs text-zinc-500">
                                                        <Tag>{node.health?.state === "healthy" ? "可用" : node.health?.state === "unhealthy" ? "异常" : "未检测"}</Tag>
                                                        {node.health?.latency_ms != null ? `${node.health.latency_ms} ms` : null} · 图片并发 {node.image_concurrency_limit || "不限"}
                                                        <Button size="small" disabled={Boolean(busy)} loading={busy === `test-${node.id}`} onClick={() => void applyGroupTest(group.id, node.id)}>
                                                            测试节点
                                                        </Button>
                                                    </span>
                                                    {node.health?.error ? <p className="w-full break-all text-xs text-red-500">{node.health.error}</p> : null}
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
                        <p className="text-xs text-zinc-500">支持 HTTP、HTTPS、SOCKS5；地址可填 http://用户名:密码@主机:端口、socks5://… 或 主机:端口:用户名:密码（默认按 HTTP）。已有节点地址不回显，留空保留；填写新地址则替换。图片并发 0 表示不限。</p>
                        {draft.nodes.map((node, index) => (
                            <div key={node.id || index} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <div className="flex items-center gap-2">
                                    <Input aria-label={`节点 ${index + 1} 名称`} placeholder="节点名称" value={node.name} onChange={(event) => updateNode(index, { name: event.target.value })} />
                                    <Switch aria-label={`启用节点 ${index + 1}`} checked={node.enabled} onChange={(enabled) => updateNode(index, { enabled })} />
                                    <Button danger aria-label={`删除节点 ${index + 1}`} icon={<Trash2 className="size-4" />} onClick={() => setDraft({ ...draft, nodes: draft.nodes.filter((_, cursor) => cursor !== index) })} />
                                </div>
                                <Input.Password
                                    aria-label={`节点 ${index + 1} 代理地址`}
                                    autoComplete="off"
                                    placeholder={node.id ? "留空保留现有地址" : "http://用户名:密码@主机:端口 或 主机:端口:用户名:密码"}
                                    value={node.url}
                                    onChange={(event) => updateNode(index, { url: event.target.value })}
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                    <label className="text-xs text-zinc-500">图片并发</label>
                                    <InputNumber aria-label={`节点 ${index + 1} 图片并发`} min={0} max={10000} value={node.image_concurrency_limit} onChange={(value) => updateNode(index, { image_concurrency_limit: value || 0 })} />
                                </div>
                            </div>
                        ))}
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
                <p className="mb-2 text-xs text-zinc-500">每行一个代理地址，可在地址后空格填写图片并发数量。仅解析，保存代理组后生效。</p>
                {error ? <Alert type="error" title={error} showIcon /> : null}
                <Input.TextArea aria-label="代理节点批量内容" rows={8} value={importText} onChange={(event) => setImportText(event.target.value)} />
            </Modal>
        </Panel>
    );
}
