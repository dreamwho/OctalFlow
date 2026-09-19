"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Image as ImageIcon, LoaderCircle, Sparkles, Video } from "lucide-react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import type { AdminGenerationChannel, AdminGenerationOperationsPayload, AdminGenerationTask } from "@/lib/admin-generation-operations";

const capabilityLabels: Record<AdminGenerationChannel["capability"], string> = { text: "文本生成", image: "图像生成", video: "视频生成", audio: "音频生成" };
const taskTypeLabels: Record<string, string> = { agent: "Agent", text: "文本生成", image: "图像生成", video: "视频生成", audio: "音频生成", render: "项目渲染" };
const statusLabels: Record<AdminGenerationTask["status"], string> = {
    pending: "等待中",
    running: "进行中",
    paused: "已暂停",
    success: "已完成",
    error: "失败",
    cancelled: "已取消",
};

export function AdminOverviewOperations() {
    const [payload, setPayload] = useState<AdminGenerationOperationsPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let disposed = false;
        fetch("/api/admin/generation-operations?page=1&pageSize=4", { cache: "no-store" })
            .then(async (response) => {
                const next = (await response.json().catch(() => ({}))) as { data?: AdminGenerationOperationsPayload; msg?: string };
                if (!response.ok || !next.data) throw new Error(next.msg || "状态数据加载失败");
                if (!disposed) setPayload(next.data);
            })
            .catch((reason) => {
                if (!disposed) setError(reason instanceof Error ? reason.message : "状态数据加载失败");
            })
            .finally(() => {
                if (!disposed) setLoading(false);
            });
        return () => {
            disposed = true;
        };
    }, []);

    return (
        <div className="admin-overview-operations-grid grid min-w-0 gap-3 sm:gap-5 xl:grid-cols-[minmax(0,1.12fr)_minmax(360px,0.88fr)]">
            <ModelStatusPanel channels={payload?.channels || []} loading={loading} error={error} />
            <QueuePanel items={payload?.items || []} total={payload?.total || 0} loading={loading} error={error} />
        </div>
    );
}

function ModelStatusPanel({ channels, loading, error }: { channels: AdminGenerationChannel[]; loading: boolean; error: string }) {
    const models = useMemo(() => {
        const byModel = new Map<string, AdminGenerationChannel>();
        for (const channel of channels) {
            const current = byModel.get(channel.logicalModelId);
            if (!current || (current.runtimeHealth.status !== "healthy" && channel.runtimeHealth.status === "healthy")) byModel.set(channel.logicalModelId, channel);
        }
        return Array.from(byModel.values()).slice(0, 5);
    }, [channels]);

    return (
        <Panel>
            <PanelHeader
                title="模型服务状态"
                description="当前逻辑模型的可用状态与运行时健康信息。"
                actions={
                    <Link className="admin-reference-link inline-flex items-center gap-1 text-xs font-semibold" href="/admin?section=generationOperations">
                        查看全部 <ArrowRight className="size-3.5" />
                    </Link>
                }
            />
            <div className="admin-overview-status-list p-3 sm:p-4">
                {models.map((model) => (
                    <ModelStatusRow key={`${model.logicalModelId}:${model.id}`} channel={model} />
                ))}
                {!loading && !models.length && !error ? <EmptySnapshot label="暂无模型渠道绑定" /> : null}
                {loading ? <LoadingSnapshot label="正在读取模型状态" /> : null}
                {error ? <ErrorSnapshot label={error} /> : null}
            </div>
        </Panel>
    );
}

function ModelStatusRow({ channel }: { channel: AdminGenerationChannel }) {
    const health = channel.enabled ? channel.runtimeHealth.status : "disabled";
    const state = health === "healthy" ? "healthy" : health === "cooling" ? "cooling" : "disabled";
    const icon = channel.capability === "image" ? <ImageIcon className="size-4" /> : channel.capability === "video" ? <Video className="size-4" /> : channel.capability === "text" ? <Sparkles className="size-4" /> : <Sparkles className="size-4" />;
    return (
        <article className="admin-model-status-row flex min-w-0 items-center gap-3 rounded-[15px] border px-3 py-3 sm:px-3.5" data-admin-model-status={channel.logicalModelId}>
            <span className="admin-model-status-icon grid size-10 shrink-0 place-items-center rounded-[13px]">{icon}</span>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[#13245a] dark:text-white">{channel.logicalModelName || channel.logicalModelId}</div>
                <div className="mt-1 truncate text-[11px] text-[#8295b7] dark:text-[#9eb6dc]">
                    {capabilityLabels[channel.capability]} · {channel.upstreamModel}
                </div>
            </div>
            <div className={`admin-model-status-pill is-${state} inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold`}>
                <span className="size-1.5 rounded-full" />
                {state === "healthy" ? "正常" : state === "cooling" ? "冷却中" : "已停用"}
            </div>
        </article>
    );
}

function QueuePanel({ items, total, loading, error }: { items: AdminGenerationTask[]; total: number; loading: boolean; error: string }) {
    return (
        <Panel>
            <PanelHeader
                title="任务队列"
                description={`展示最近任务状态${total ? ` · 共 ${total} 条` : ""}。`}
                actions={
                    <Link className="admin-reference-link inline-flex items-center gap-1 text-xs font-semibold" href="/admin?section=generationOperations">
                        运维中心 <ArrowRight className="size-3.5" />
                    </Link>
                }
            />
            <div className="admin-overview-queue-list space-y-2.5 p-3 sm:p-4">
                {items.map((task) => (
                    <QueueRow key={task.id} task={task} />
                ))}
                {!loading && !items.length && !error ? <EmptySnapshot label="暂无生成任务" /> : null}
                {loading ? <LoadingSnapshot label="正在读取任务队列" /> : null}
                {error ? <ErrorSnapshot label={error} /> : null}
            </div>
        </Panel>
    );
}

function QueueRow({ task }: { task: AdminGenerationTask }) {
    const terminal = task.status === "success" || task.status === "error" || task.status === "cancelled";
    const state = task.status === "success" ? "success" : task.status === "error" ? "error" : task.status === "running" ? "running" : "pending";
    return (
        <article className="admin-queue-row rounded-[15px] border px-3 py-3" data-admin-queue-row={task.id}>
            <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#13245a] dark:text-white">{task.prompt || task.model || "未命名任务"}</div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-[#8295b7] dark:text-[#9eb6dc]">
                        <span className="rounded-full bg-[#e9f2ff] px-2 py-0.5 text-[#5878c9] dark:bg-[#15345e] dark:text-[#a8c9ff]">{taskTypeLabels[task.type] || task.type}</span>
                        <span className="truncate">{task.model || "未记录模型"}</span>
                    </div>
                </div>
                <span className={`admin-queue-status is-${state} inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold`}>
                    {state === "success" ? <CheckCircle2 className="size-3" /> : state === "error" ? <CircleAlert className="size-3" /> : state === "running" ? <LoaderCircle className="size-3 animate-spin" /> : <Clock3 className="size-3" />}
                    {statusLabels[task.status]}
                </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
                <div className={`admin-queue-progress is-${state} h-1.5 min-w-0 flex-1 overflow-hidden rounded-full`}>
                    <span />
                </div>
                <span className="shrink-0 text-[11px] font-medium text-[#8295b7] dark:text-[#9eb6dc]">
                    {terminal ? (task.status === "success" ? "完成" : task.status === "error" ? "需关注" : "已取消") : task.status === "running" ? "执行中" : "等待调度"}
                </span>
            </div>
        </article>
    );
}

function EmptySnapshot({ label }: { label: string }) {
    return <div className="admin-overview-snapshot-empty rounded-[15px] border border-dashed px-3 py-7 text-center text-xs">{label}</div>;
}

function LoadingSnapshot({ label }: { label: string }) {
    return (
        <div className="admin-overview-snapshot-empty rounded-[15px] border border-dashed px-3 py-7 text-center text-xs">
            <LoaderCircle className="mx-auto mb-2 size-4 animate-spin" />
            {label}
        </div>
    );
}

function ErrorSnapshot({ label }: { label: string }) {
    return (
        <div className="admin-overview-snapshot-empty is-error rounded-[15px] border border-dashed px-3 py-7 text-center text-xs">
            <CircleAlert className="mx-auto mb-2 size-4" />
            {label}
        </div>
    );
}
