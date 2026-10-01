"use client";

import { Alert, App, Button, Checkbox, Input, Modal, Switch, Table, Tabs, Tag, Tooltip, type TableProps } from "antd";
import {
    Activity,
    AlertCircle,
    CheckCircle2,
    Clock,
    ExternalLink,
    Film,
    Play,
    RefreshCw,
    Save,
    Sparkles,
    Video,
    XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminTrafficPanel } from "@/components/admin/admin-traffic-panel";
import type { SystemModelChannel } from "@/lib/auth/store-types";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import {
    MINIMAX_H3_DEFAULT_BASE_URL,
    MINIMAX_H3_MODEL_METAS,
    MINIMAX_H3_MODELS,
    promoteMinimaxH3LogicalModels,
    type MinimaxH3ModelMeta,
} from "@/lib/minimax-h3";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

type MinimaxH3TaskRecord = {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    accountId: string;
    model: string;
    prompt: string;
    status: "pending" | "running" | "success" | "failed";
    durationMs?: number;
    error?: string;
    createdAt: string;
    updatedAt: string;
    resultUrl?: string;
    params?: {
        resolution?: string;
        aspectRatio?: string;
        duration?: number;
        mode?: string;
    };
};

type LogicalModelStatus = {
    id: string;
    name: string;
    capability: string;
    enabled: boolean;
    resolvable: boolean;
    resolvedChannel: { id: string; name: string } | null;
    isBoundToChannel: boolean;
    bindingsCount: number;
};

type MinimaxH3State = {
    channel: (Partial<SystemModelChannel> & { hasApiKey?: boolean }) | null;
    defaultBaseUrl: string;
    logicalModels: LogicalModelStatus[];
    modelMetas: readonly MinimaxH3ModelMeta[];
    videoTasks: {
        items: MinimaxH3TaskRecord[];
        total: number;
        page: number;
        pageSize: number;
    };
};

export function AdminMinimaxH3Section({ controller }: { controller: AdminDashboardController }) {
    const { message } = App.useApp();
    const { settings, setSettings, saveSettings, settingsLoading } = controller;
    const [state, setState] = useState<MinimaxH3State | null>(null);
    const [tab, setTab] = useState("models");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
        ok: boolean;
        message: string;
        latencyMs?: number;
        models?: string[];
    } | null>(null);
    const [selectedVideo, setSelectedVideo] = useState<{ url: string; prompt: string; model: string } | null>(null);
    const [selectedTask, setSelectedTask] = useState<MinimaxH3TaskRecord | null>(null);

    const channel = useMemo(() => {
        const current = settings.systemChannels.find(
            (item) => item.id === "easyframe-minimax-h3" || item.advancedConfig?.protocol === "minimax-h3",
        );
        return current || createMinimaxH3Channel();
    }, [settings.systemChannels]);

    const load = useCallback(async (page = 1) => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`/api/admin/minimax-h3?page=${page}`, { cache: "no-store" });
            const payload = (await response.json()) as MinimaxH3State & { error?: string };
            if (!response.ok) throw new Error(payload.error || "读取 MiniMax H3 配置失败");
            setState(payload);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取 MiniMax H3 配置失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const updateChannel = (patch: Partial<SystemModelChannel>) => {
        setSettings((current) => {
            const next = applyChannelProtocol({ ...channel, ...patch }, "minimax-h3");
            const exists = current.systemChannels.some((item) => item.id === channel.id);
            const channels = exists
                ? current.systemChannels.map((item) => (item.id === channel.id ? next : item))
                : [...current.systemChannels, next];
            const { logicalModels } = promoteMinimaxH3LogicalModels(current.logicalModels, next);
            return {
                ...current,
                systemChannels: channels,
                logicalModels,
            };
        });
    };

    const save = async () => {
        const exists = settings.systemChannels.some((item) => item.id === channel.id);
        const systemChannels = exists
            ? settings.systemChannels.map((item) => (item.id === channel.id ? channel : item))
            : [...settings.systemChannels, channel];
        const { logicalModels } = promoteMinimaxH3LogicalModels(settings.logicalModels, channel);

        if (await saveSettings({ systemChannels, logicalModels }, "easyframe MiniMaxH3 渠道与逻辑模型已保存")) {
            await load(state?.videoTasks.page || 1);
        }
    };

    const testConnectivity = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const response = await fetch("/api/admin/minimax-h3", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "test",
                    baseUrl: channel.baseUrl,
                    apiKey: channel.apiKey,
                    channelId: channel.id,
                }),
            });
            const data = (await response.json()) as { ok: boolean; message: string; latencyMs?: number; models?: string[]; error?: string };
            if (!response.ok) {
                setTestResult({ ok: false, message: data.error || data.message || "请求失败" });
                message.error(data.error || data.message || "连通性测试未通过");
            } else {
                setTestResult(data);
                if (data.ok) {
                    message.success(data.message);
                } else {
                    message.warning(data.message);
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "网络连接异常";
            setTestResult({ ok: false, message: msg });
            message.error(`测试失败：${msg}`);
        } finally {
            setTesting(false);
        }
    };

    const enabledModelSet = useMemo(() => new Set(channel.models.map((m) => m.trim().toLowerCase())), [channel.models]);

    return (
        <div className="space-y-4">
            {error ? (
                <Alert
                    type="error"
                    showIcon
                    message="MiniMax H3 控制台读取失败"
                    description={error}
                    action={
                        <Button size="small" onClick={() => void load()}>
                            重试
                        </Button>
                    }
                />
            ) : null}

            <Panel>
                <PanelHeader
                    title="easyframe MiniMax H3 视频控制台"
                    description="管理 easyframe MiniMax H3 视频模型（mini / fast / base / pro）、API 密钥、渠道状态与生成记录。"
                    actions={
                        <div className="flex flex-wrap gap-2">
                            <Button
                                icon={<Activity className="size-4" />}
                                loading={testing}
                                onClick={() => void testConnectivity()}
                            >
                                测试连通性
                            </Button>
                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                                刷新
                            </Button>
                            <Button
                                type="primary"
                                icon={<Save className="size-4" />}
                                loading={settingsLoading}
                                onClick={() => void save()}
                            >
                                保存配置
                            </Button>
                        </div>
                    }
                />

                <div className="space-y-5 p-4 sm:p-5">
                    {testResult ? (
                        <Alert
                            type={testResult.ok ? "success" : "error"}
                            showIcon
                            closable
                            onClose={() => setTestResult(null)}
                            message={
                                <div className="flex items-center justify-between">
                                    <span className="font-semibold">{testResult.ok ? "接口拨号成功" : "接口拨号异常"}</span>
                                    {testResult.latencyMs !== undefined ? (
                                        <span className="text-xs text-zinc-500">耗时 {testResult.latencyMs} ms</span>
                                    ) : null}
                                </div>
                            }
                            description={
                                <div className="space-y-1 text-xs">
                                    <div>{testResult.message}</div>
                                    {testResult.models && testResult.models.length > 0 ? (
                                        <div className="mt-1 flex flex-wrap items-center gap-1">
                                            <span className="text-zinc-500">上游可用模型：</span>
                                            {testResult.models.map((m) => (
                                                <Tag key={m} className="font-mono text-[10px]">
                                                    {m}
                                                </Tag>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            }
                        />
                    ) : null}

                    {/* 渠道基础信息 */}
                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className="space-y-1.5 text-sm">
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">渠道名称</span>
                            <Input
                                value={channel.name}
                                placeholder="easyframe MiniMaxH3"
                                onChange={(event) => updateChannel({ name: event.target.value })}
                            />
                        </label>
                        <label className="space-y-1.5 text-sm">
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">Base URL</span>
                            <Input
                                value={channel.baseUrl}
                                placeholder={MINIMAX_H3_DEFAULT_BASE_URL}
                                onChange={(event) => updateChannel({ baseUrl: event.target.value })}
                            />
                        </label>
                        <label className="space-y-1.5 text-sm">
                            <span className="flex items-center justify-between font-medium text-zinc-700 dark:text-zinc-300">
                                <span>API Key</span>
                                {channel.hasApiKey ? <Tag color="green">已配置</Tag> : <Tag color="default">未设置</Tag>}
                            </span>
                            <Input.Password
                                value={channel.apiKey}
                                placeholder={channel.hasApiKey ? "留空保持已保存密钥" : "请输入 easyframe API Key"}
                                onChange={(event) => updateChannel({ apiKey: event.target.value, enabled: true })}
                            />
                        </label>
                    </div>

                    {/* 渠道总开关 */}
                    <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50/50 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/50">
                        <div className="flex items-center gap-3">
                            <Switch checked={channel.enabled} onChange={(enabled) => updateChannel({ enabled })} />
                            <div>
                                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                    启用 easyframe MiniMaxH3 渠道
                                </div>
                                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                                    开启后，绑定的 H3 视频模型将接入此渠道提供视频生成服务；保存时会自动关联并激活对应逻辑模型。
                                </div>
                            </div>
                        </div>
                        <Tag color={channel.enabled ? "green" : "default"}>{channel.enabled ? "已启用" : "已停用"}</Tag>
                    </div>

                    {/* 模型可用性多选与层级 */}
                    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                        <div className="mb-3 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                <Video className="size-4 text-emerald-500" />
                                <span>模型可用性开关（勾选即启用，取消则关闭）</span>
                            </div>
                            <div className="text-xs text-zinc-500">
                                已勾选 {channel.models.filter((m) => MINIMAX_H3_MODELS.includes(m as never)).length} / {MINIMAX_H3_MODELS.length}
                            </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {MINIMAX_H3_MODEL_METAS.map((meta) => {
                                const isChecked = enabledModelSet.has(meta.id.toLowerCase());
                                const logicalStatus = state?.logicalModels.find((lm) => lm.id.toLowerCase() === meta.id.toLowerCase());
                                return (
                                    <div
                                        key={meta.id}
                                        className={`flex flex-col justify-between rounded-lg border p-3 transition-colors ${
                                            isChecked
                                                ? "border-emerald-200 bg-emerald-50/30 dark:border-emerald-950 dark:bg-emerald-950/10"
                                                : "border-zinc-200 bg-zinc-50/20 opacity-70 dark:border-zinc-800 dark:bg-zinc-900/20"
                                        }`}
                                    >
                                        <div className="space-y-1.5">
                                            <div className="flex items-center justify-between">
                                                <Checkbox
                                                    checked={isChecked}
                                                    onChange={(e) => {
                                                        const checked = e.target.checked;
                                                        const current = channel.models;
                                                        const next = checked
                                                            ? Array.from(new Set([...current, meta.id]))
                                                            : current.filter((m) => m.toLowerCase() !== meta.id.toLowerCase());
                                                        updateChannel({ models: next });
                                                    }}
                                                >
                                                    <span className="font-mono text-xs font-semibold">{meta.label}</span>
                                                </Checkbox>
                                                <Tag color={meta.tier === "极速档" ? "cyan" : meta.tier === "高速档" ? "blue" : meta.tier === "标准档" ? "purple" : "gold"}>
                                                    {meta.tier}
                                                </Tag>
                                            </div>
                                            <p className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                                                {meta.description}
                                            </p>
                                        </div>

                                        <div className="mt-3 border-t border-zinc-200/60 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800/60">
                                            <div className="flex items-center justify-between">
                                                <span>逻辑路由状态：</span>
                                                {logicalStatus?.resolvable ? (
                                                    <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                                                        <CheckCircle2 className="size-3" /> 可调度
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
                                                        <AlertCircle className="size-3" /> 待保存生效
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Tab 分页 */}
                    <Tabs
                        activeKey={tab}
                        onChange={setTab}
                        items={[
                            {
                                key: "models",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Sparkles className="size-4" />
                                        模型与参数规格
                                    </span>
                                ),
                            },
                            {
                                key: "tasks",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Film className="size-4" />
                                        视频任务历史（{state?.videoTasks.total || 0}）
                                    </span>
                                ),
                            },
                            {
                                key: "statistics",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Activity className="size-4" />
                                        流量统计
                                    </span>
                                ),
                            },
                        ]}
                    />

                    {tab === "models" ? (
                        <ModelSpecsPanel metas={MINIMAX_H3_MODEL_METAS} logicalModels={state?.logicalModels || []} />
                    ) : tab === "tasks" ? (
                        <VideoTasksTable
                            tasks={state?.videoTasks.items || []}
                            total={state?.videoTasks.total || 0}
                            page={state?.videoTasks.page || 1}
                            pageSize={state?.videoTasks.pageSize || 20}
                            onPageChange={(page) => void load(page)}
                            onPreviewVideo={(url, prompt, model) => setSelectedVideo({ url, prompt, model })}
                            onViewTask={(task) => setSelectedTask(task)}
                        />
                    ) : (
                        <AdminTrafficPanel channelId={channel.id} protocol="minimax-h3" title="MiniMax H3 流量统计" />
                    )}
                </div>
            </Panel>

            {/* 视频播放弹层框 */}
            <Modal
                open={Boolean(selectedVideo)}
                title={
                    <div className="flex items-center gap-2">
                        <Film className="size-4 text-emerald-500" />
                        <span>视频预览：{selectedVideo?.model}</span>
                    </div>
                }
                footer={null}
                onCancel={() => setSelectedVideo(null)}
                width={680}
                centered
            >
                {selectedVideo ? (
                    <div className="space-y-3">
                        <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
                            <video
                                src={selectedVideo.url}
                                controls
                                autoPlay
                                className="h-full w-full object-contain"
                            />
                        </div>
                        <div className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                            <div className="mb-1 font-semibold text-zinc-900 dark:text-zinc-100">提示词</div>
                            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap">{selectedVideo.prompt}</div>
                        </div>
                    </div>
                ) : null}
            </Modal>

            {/* 任务详情弹层框 */}
            <Modal
                open={Boolean(selectedTask)}
                title="MiniMax H3 视频任务详情"
                footer={null}
                onCancel={() => setSelectedTask(null)}
                width={700}
            >
                {selectedTask ? (
                    <div className="space-y-4 text-xs">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <div className="text-zinc-500">任务 ID</div>
                                <div className="font-mono font-medium">{selectedTask.id}</div>
                            </div>
                            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <div className="text-zinc-500">提交用户</div>
                                <div className="font-medium">
                                    {selectedTask.displayName || selectedTask.username}
                                    {selectedTask.accountId ? ` · ID：${selectedTask.accountId}` : ""}
                                </div>
                            </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <div className="mb-1 text-zinc-500">提示词 (Prompt)</div>
                            <div className="whitespace-pre-wrap rounded bg-zinc-50 p-2 font-mono dark:bg-zinc-900">
                                {selectedTask.prompt}
                            </div>
                        </div>

                        {selectedTask.resultUrl ? (
                            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <div className="mb-2 text-zinc-500">成片视频</div>
                                <div className="aspect-video w-full overflow-hidden rounded bg-black">
                                    <video src={selectedTask.resultUrl} controls className="h-full w-full object-contain" />
                                </div>
                            </div>
                        ) : null}

                        {selectedTask.error ? (
                            <div className="rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                                <div className="mb-1 font-semibold text-red-600 dark:text-red-400">错误信息</div>
                                <pre className="whitespace-pre-wrap break-all font-mono text-red-700 dark:text-red-300">
                                    {selectedTask.error}
                                </pre>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}

function ModelSpecsPanel({
    metas,
    logicalModels,
}: {
    metas: readonly MinimaxH3ModelMeta[];
    logicalModels: LogicalModelStatus[];
}) {
    const logicalMap = useMemo(() => new Map(logicalModels.map((lm) => [lm.id.toLowerCase(), lm])), [logicalModels]);

    return (
        <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
                {metas.map((meta) => {
                    const logical = logicalMap.get(meta.id.toLowerCase());
                    return (
                        <div
                            key={meta.id}
                            className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                        >
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Film className="size-5 text-emerald-500" />
                                        <span className="font-mono text-base font-bold text-zinc-900 dark:text-zinc-100">
                                            {meta.id}
                                        </span>
                                    </div>
                                    <Tag color={meta.tier === "极速档" ? "cyan" : meta.tier === "高速档" ? "blue" : meta.tier === "标准档" ? "purple" : "gold"}>
                                        {meta.tier}
                                    </Tag>
                                </div>

                                <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                                    {meta.description}
                                </p>

                                <div className="rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-900/60">
                                    <div className="mb-1 font-semibold text-zinc-700 dark:text-zinc-300">推荐创作场景</div>
                                    <div className="text-zinc-600 dark:text-zinc-400">{meta.suggestedUse}</div>
                                </div>

                                <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div className="rounded border border-zinc-100 p-2 dark:border-zinc-800/80">
                                        <span className="text-zinc-400">清晰度档位：</span>
                                        <div className="mt-0.5 font-medium">{meta.resolutions.join(" / ")}</div>
                                    </div>
                                    <div className="rounded border border-zinc-100 p-2 dark:border-zinc-800/80">
                                        <span className="text-zinc-400">生成时长：</span>
                                        <div className="mt-0.5 font-medium">{meta.duration}</div>
                                    </div>
                                </div>

                                <div>
                                    <div className="mb-1 text-xs text-zinc-400">支持的生成模式：</div>
                                    <div className="flex flex-wrap gap-1">
                                        {meta.supportedModes.map((mode) => (
                                            <Tag key={mode} className="text-[11px]">
                                                {mode}
                                            </Tag>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-4 border-t border-zinc-100 pt-3 text-xs dark:border-zinc-800">
                                <div className="flex items-center justify-between">
                                    <span className="text-zinc-500">前端逻辑模型：</span>
                                    {logical ? (
                                        <span className="flex items-center gap-1">
                                            {logical.resolvable ? (
                                                <Tag color="success">已绑定 · 可正常调度</Tag>
                                            ) : (
                                                <Tag color="warning">已启用但未解析</Tag>
                                            )}
                                        </span>
                                    ) : (
                                        <Tag color="default">未注册逻辑模型</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* 素材规则约束说明 */}
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                <div className="mb-2 font-semibold text-zinc-800 dark:text-zinc-200">
                    MiniMax H3 素材输入规范契约：
                </div>
                <ul className="list-inside list-disc space-y-1">
                    <li>
                        <strong>模式互斥规则：</strong>首帧（i2va）与首尾帧插帧（fl2va）模式<strong>不能</strong>与普通参考素材（ref2va）混用。
                    </li>
                    <li>
                        <strong>多素材配额上限：</strong>多参考模式下，最多支持 9 张参考图、3 个参考视频、3 个参考音频，总参考素材数量不得超过 15 个。
                    </li>
                    <li>
                        <strong>时长与分辨率：</strong>生成时长支持 5-15 秒连续整数；画面分辨率支持 480p（极速/流畅）与 720p（高清）。
                    </li>
                    <li>
                        <strong>宽高比契约：</strong>文生、首帧、首尾帧模式支持 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21, 4:5, 5:4。
                    </li>
                </ul>
            </div>
        </div>
    );
}

function VideoTasksTable({
    tasks,
    total,
    page,
    pageSize,
    onPageChange,
    onPreviewVideo,
    onViewTask,
}: {
    tasks: MinimaxH3TaskRecord[];
    total: number;
    page: number;
    pageSize: number;
    onPageChange: (page: number) => void;
    onPreviewVideo: (url: string, prompt: string, model: string) => void;
    onViewTask: (task: MinimaxH3TaskRecord) => void;
}) {
    const columns: TableProps<MinimaxH3TaskRecord>["columns"] = [
        {
            title: "提交时间",
            dataIndex: "createdAt",
            width: 160,
            render: (value: string) => <span className="text-xs text-zinc-600 dark:text-zinc-400">{new Date(value).toLocaleString()}</span>,
        },
        {
            title: "提交用户",
            dataIndex: "displayName",
            width: 170,
            render: (value: string, record) => (
                <div className="text-xs">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{value || record.username || "已删除用户"}</div>
                    <div className="text-[11px] text-zinc-500">
                        {record.accountId ? `ID：${record.accountId}` : record.username || "-"}
                    </div>
                </div>
            ),
        },
        {
            title: "模型",
            dataIndex: "model",
            width: 160,
            render: (value: string) => (
                <Tag color="cyan" className="font-mono text-xs">
                    {value}
                </Tag>
            ),
        },
        {
            title: "提示词",
            dataIndex: "prompt",
            ellipsis: true,
            render: (value: string) => (
                <Tooltip title={value}>
                    <span className="line-clamp-2 max-w-sm cursor-default text-xs text-zinc-700 dark:text-zinc-300">
                        {value || "-"}
                    </span>
                </Tooltip>
            ),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (value: string, record) => {
                if (value === "success") return <Tag color="green">生成成功</Tag>;
                if (value === "failed") {
                    return (
                        <Tooltip title={record.error || "生成失败"}>
                            <Tag color="red" className="cursor-help">
                                生成失败
                            </Tag>
                        </Tooltip>
                    );
                }
                return <Tag color="processing">处理中</Tag>;
            },
        },
        {
            title: "耗时",
            dataIndex: "durationMs",
            width: 90,
            render: (value?: number) => (
                <span className="text-xs text-zinc-500">{value ? `${Math.round(value / 1000)}s` : "-"}</span>
            ),
        },
        {
            title: "操作",
            width: 140,
            render: (_: unknown, record: MinimaxH3TaskRecord) => (
                <div className="flex items-center gap-1.5">
                    {record.resultUrl ? (
                        <Button
                            size="small"
                            type="primary"
                            ghost
                            icon={<Play className="size-3" />}
                            onClick={() => onPreviewVideo(record.resultUrl!, record.prompt, record.model)}
                        >
                            预览
                        </Button>
                    ) : null}
                    <Button size="small" onClick={() => onViewTask(record)}>
                        详情
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <Table
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={tasks}
            pagination={{
                current: page,
                pageSize,
                total,
                showSizeChanger: false,
                showTotal: (totalCount) => `共 ${totalCount} 条记录`,
                onChange: onPageChange,
            }}
            locale={{ emptyText: "暂无 MiniMax H3 视频生成任务" }}
        />
    );
}

function createMinimaxH3Channel(): SystemModelChannel {
    return applyChannelProtocol(
        {
            id: "easyframe-minimax-h3",
            name: "easyframe MiniMaxH3",
            baseUrl: MINIMAX_H3_DEFAULT_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [...MINIMAX_H3_MODELS],
            enabled: true,
        },
        "minimax-h3",
    );
}
