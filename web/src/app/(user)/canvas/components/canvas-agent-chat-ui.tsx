"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode, type RefObject } from "react";
import { Button, Popover, Tooltip } from "antd";
import { ArrowUp, Check, CheckCircle2, Circle, CircleAlert, Crosshair, FileText, LoaderCircle, Maximize2, Minimize2, MousePointer2, Pause, Play, RotateCcw, Sparkles, Upload, Wrench, X, XCircle } from "lucide-react";

import { AgentMessageActions } from "@/components/agent/agent-message-actions";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { AgentMediaPreview } from "@/components/agent/agent-media-preview";
import { SiteLogo } from "@/components/layout/site-logo";
import { canvasThemes } from "@/lib/canvas-theme";
import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { droppedFiles, leftDropTarget, preventFileDragEvent } from "@/lib/file-drop";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { userAvatarFallback } from "@/lib/user-avatar";
import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import type { LocalUser } from "@/stores/use-user-store";
import type { CreativeAgentRun } from "@/services/api/creative";
import { canvasAgentMentionCandidates, canvasAgentMentionDraftAtCursor, canvasAgentMentionSegments, canvasAgentReferenceAliases, replaceCanvasAgentMention, type CanvasAgentMentionAsset } from "./canvas-agent-mention";
import { CanvasAgentMentionPicker, CanvasAgentMentionPreview } from "./canvas-agent-mention-picker";
import { CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT } from "./canvas-agent-panel-layout";
import { canvasAgentProgressSteps, type CanvasAgentRunStage } from "./canvas-agent-progress";
import { isCanvasAgentAttachmentFile } from "./canvas-agent-attachment-files";

export type CanvasAgentChatAttachment = {
    id: string;
    name: string;
    url?: string;
    type?: "image" | "video" | "text";
    text?: string;
    label?: string;
    status?: "uploading" | "ready" | "failed";
    error?: string;
};
export type CanvasAgentChatMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    attachments?: CanvasAgentChatAttachment[];
    skills?: Array<{ id: string; name: string }>;
    createdAt?: string;
};

export function AgentChatMessage({
    item,
    theme,
    user,
    onRejectTool,
    onApproveTool,
    onLocateNode,
    onRetryTask,
    onEditMessage,
}: {
    item: CanvasAgentChatMessage;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    user: LocalUser | null;
    onRejectTool?: (id: string) => void;
    onApproveTool?: (id: string) => void;
    onLocateNode?: (nodeId: string) => void;
    onRetryTask?: (runId: string, taskId?: string) => void;
    onEditMessage?: (text: string) => void;
}) {
    const isUser = item.role === "user";
    const isSystem = item.role === "system";
    const color = item.role === "error" ? theme.node.infoText : item.role === "tool" ? "#2563eb" : theme.node.text;
    if (isSystem) {
        return (
            <div className="flex justify-center text-xs">
                <div className="max-w-[88%] px-3 py-1.5 text-center" style={{ color: theme.node.muted }}>
                    {item.text}
                    {item.meta ? <span className="ml-2 opacity-60">{item.meta}</span> : null}
                    <MessageTime createdAt={item.createdAt} align="center" />
                </div>
            </div>
        );
    }
    if (item.role === "tool") {
        if (objectField(item.detail, "status") === "pending")
            return <AgentPendingToolCard summary={item.text} detail={item.detail} theme={theme} createdAt={item.createdAt} onReject={() => onRejectTool?.(item.id)} onApprove={() => onApproveTool?.(item.id)} />;
        return (
            <div className="flex items-start gap-3">
                <AgentAvatar theme={theme} />
                <AgentToolCard title={item.title || "工具调用"} text={item.text} detail={item.detail} theme={theme} createdAt={item.createdAt} />
            </div>
        );
    }
    if (isUser) {
        return (
            <div className="canvas-agent-message group/message flex min-w-0 justify-end">
                <div className="grid min-w-0 max-w-[82%] grid-cols-[minmax(0,1fr)_auto] gap-x-3" style={{ color }}>
                    {item.attachments?.length ? (
                        <div className="col-start-1 row-start-1">
                            <AgentMessageAttachments attachments={item.attachments} align="end" />
                        </div>
                    ) : null}
                    <div className="col-start-1 row-start-2 min-w-0 text-right text-sm leading-6">
                        {item.skills?.length ? (
                            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5" aria-label="本轮调用的 Skill">
                                {item.skills.map((skill) => (
                                    <span
                                        key={skill.id}
                                        data-canvas-agent-used-skill={skill.id}
                                        className="inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4"
                                        style={{ borderColor: theme.node.activeStroke, background: theme.node.fill, color: theme.node.text }}
                                    >
                                        <Sparkles className="size-3 shrink-0" />
                                        <span className="truncate">已调用 · {skill.name}</span>
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        <div className="whitespace-pre-wrap break-words text-left" style={item.role === "error" ? agentErrorFlowTextStyle(theme) : undefined}>
                            {item.text}
                        </div>
                        {item.meta ? <div className="mt-1 text-[11px] opacity-45">{item.meta}</div> : null}
                        <MessageTime createdAt={item.createdAt} align="end" />
                        <AgentMessageActions text={item.text} onEdit={onEditMessage} align="end" className="text-current" style={{ color: theme.node.muted }} />
                    </div>
                    <div className="col-start-2 row-start-2">
                        <AgentUserAvatar user={user} theme={theme} />
                    </div>
                </div>
            </div>
        );
    }
    const resultNodeIds = objectField(item.detail, "taskType") === "text" ? [] : objectStringArray(item.detail, "nodeIds");
    return (
        <div className="canvas-agent-message group/message flex min-w-0 items-start justify-start gap-3">
            <AgentAvatar theme={theme} />
            <div className="min-w-0 max-w-[82%] text-left text-sm leading-6" style={{ color }}>
                <div className="flex min-w-0 items-start gap-1">
                    <div className="min-w-0 flex-1" style={item.role === "error" ? agentErrorFlowTextStyle(theme) : undefined}>
                        <AgentMarkdown className="text-left">{item.text}</AgentMarkdown>
                    </div>
                    {resultNodeIds.length ? (
                        <div className="flex shrink-0 items-center gap-0.5">
                            {resultNodeIds.map((nodeId, index, nodeIds) => {
                                const locateLabel = nodeIds.length > 1 ? `定位结果 ${index + 1}` : "定位到画布结果";
                                return (
                                    <Tooltip key={nodeId} title={locateLabel} placement="top" mouseEnterDelay={0.2}>
                                        <button type="button" className="mt-0.5 grid size-7 place-items-center opacity-55 transition hover:opacity-100 focus-visible:opacity-100" onClick={() => onLocateNode?.(nodeId)} aria-label={locateLabel}>
                                            <Crosshair className="size-4" />
                                        </button>
                                    </Tooltip>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
                {objectField(item.detail, "runId") ? (
                    <button
                        type="button"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium transition hover:opacity-70"
                        style={{ color: theme.node.infoText }}
                        onClick={() => onRetryTask?.(String(objectField(item.detail, "runId")), objectField(item.detail, "taskId") ? String(objectField(item.detail, "taskId")) : undefined)}
                    >
                        <RotateCcw className="size-3.5" />
                        {objectField(item.detail, "taskId") ? "只重试此任务" : "重试"}
                    </button>
                ) : null}
                {item.attachments?.length ? <AgentMessageAttachments attachments={item.attachments} /> : null}
                {item.meta ? (
                    <div
                        data-canvas-agent-plan-summary
                        className="mt-2 inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4"
                        style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                    >
                        {item.meta}
                    </div>
                ) : null}
                <MessageTime createdAt={item.createdAt} align="start" />
                <AgentMessageActions
                    text={item.text}
                    downloads={item.attachments?.flatMap((attachment) => (attachment.type === "text" || !attachment.url ? [] : [{ type: attachment.type || "image", url: attachment.url, title: attachment.name }]))}
                    align="start"
                    className="text-current"
                    style={{ color: theme.node.muted }}
                />
            </div>
        </div>
    );
}

function AgentPendingToolCard({ summary, detail, theme, createdAt, onReject, onApprove }: { summary: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; createdAt?: string; onReject?: () => void; onApprove?: () => void }) {
    return (
        <div className="flex items-start gap-3">
            <AgentAvatar theme={theme} />
            <div className="min-w-0 flex-1 rounded-xl border p-4" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
                <details>
                    <summary className="cursor-pointer list-none">
                        <div className="flex items-start gap-3">
                            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border" style={{ borderColor: "rgba(217,119,6,.24)", color: "#d97706", background: "rgba(217,119,6,.04)" }}>
                                <CircleAlert className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5">
                                    <span>确认工具调用</span>
                                    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ borderColor: "rgba(217,119,6,.22)", color: "#d97706", background: "rgba(217,119,6,.04)" }}>
                                        等待确认
                                    </span>
                                    {detail ? (
                                        <span className="ml-auto text-xs font-normal" style={{ color: theme.node.muted }}>
                                            详情
                                        </span>
                                    ) : null}
                                </div>
                                <div className="mt-2 text-sm leading-6" style={{ color: theme.node.text }}>
                                    {summary}
                                </div>
                            </div>
                        </div>
                    </summary>
                    {detail ? <AgentDetailBlock detail={detail} theme={theme} /> : null}
                </details>
                {onReject || onApprove ? (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                        <Button danger className="!h-9" icon={<XCircle className="size-4" />} onClick={() => onReject?.()}>
                            拒绝执行
                        </Button>
                        <Button className="!h-9" icon={<CheckCircle2 className="size-4" />} style={{ borderColor: "rgba(22,163,74,.42)", color: "#16a34a", background: "transparent" }} onClick={() => onApprove?.()}>
                            批准执行
                        </Button>
                    </div>
                ) : null}
                <MessageTime createdAt={createdAt} align="start" />
            </div>
        </div>
    );
}

function AgentToolCard({ title, text, detail, theme, createdAt }: { title: string; text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; createdAt?: string }) {
    const state = toolCardState(title, text, detail, theme);
    return (
        <details className="min-w-0 flex-1 rounded-xl border px-4 py-3.5 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <summary className="cursor-pointer list-none">
                <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border" style={{ borderColor: state.softBorder, color: state.color, background: state.softBg }}>
                        {state.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5">
                            <span className="min-w-0 truncate">{title}</span>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ borderColor: state.softBorder, color: state.color, background: state.softBg }}>
                                {state.label}
                            </span>
                            {detail ? (
                                <span className="ml-auto text-xs font-normal" style={{ color: theme.node.muted }}>
                                    详情
                                </span>
                            ) : null}
                        </div>
                        <div className="mt-2 text-sm leading-6" style={{ color: state.isError ? state.color : theme.node.muted }}>
                            {text}
                        </div>
                    </div>
                </div>
            </summary>
            {detail ? <AgentDetailBlock detail={detail} theme={theme} /> : null}
            <MessageTime createdAt={createdAt} align="start" />
        </details>
    );
}

export function AgentWorkingMessage({
    theme,
    stage,
    tasks = [],
    startedAt,
    completedAt,
    status,
    runId,
    onLocateNode,
    onRetryTask,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    stage: CanvasAgentRunStage;
    tasks?: CreativeAgentRun["tasks"];
    startedAt?: number;
    completedAt?: number;
    status?: Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled">;
    runId?: string;
    onLocateNode?: (nodeId: string) => void;
    onRetryTask?: (taskId: string) => void;
}) {
    const terminal = Boolean(status);
    const steps = canvasAgentProgressSteps(stage);
    const taskProgressItems = expandAgentTaskProgress(tasks, runId);
    const now = useLiveAgentClock(!terminal && (tasks.some((task) => task.status === "running") || Boolean(startedAt)));
    const displayEndAt = terminal ? completedAt || startedAt || now : now;
    const title = status === "completed" ? "任务已完成" : status === "failed" ? "任务执行失败" : status === "cancelled" ? "任务已取消" : stage.text;
    return (
        <div className="flex items-start gap-3" aria-live={terminal ? "off" : "polite"} data-canvas-agent-run-status={status || "active"}>
            <AgentAvatar theme={theme} />
            <div className="min-w-0 w-[340px] max-w-[86%] rounded-xl border p-4 antialiased" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                <div className="text-sm font-semibold tracking-[0.005em]">{title}</div>
                {startedAt ? (
                    <div className="mt-1 text-[11px]" style={{ color: theme.node.muted }}>
                        开始 {formatAgentClock(startedAt)} · {terminal ? `${status === "completed" ? "总耗时" : "截至"} ${formatAgentDuration(Math.max(0, displayEndAt - startedAt))}` : `已持续 ${formatAgentDuration(Math.max(0, now - startedAt))}`}
                    </div>
                ) : null}
                <div className="mt-3 space-y-2">
                    {steps.map((step) => (
                        <div key={step.key} className="flex items-center gap-2 text-xs" style={{ color: step.status === "pending" ? theme.node.muted : theme.node.text, opacity: step.status === "pending" ? 0.58 : 1 }}>
                            {step.status === "completed" ? <Check className="size-3.5 shrink-0 text-emerald-500" /> : null}
                            {step.status === "running" ? terminal ? <Circle className="size-3.5 shrink-0" /> : <LoaderCircle className="size-3.5 shrink-0 animate-spin text-sky-500" /> : null}
                            {step.status === "paused" ? <Pause className="size-3.5 shrink-0 text-amber-500" /> : null}
                            {step.status === "pending" ? <Circle className="size-3.5 shrink-0" /> : null}
                            <span>{step.label}</span>
                        </div>
                    ))}
                </div>
                {taskProgressItems.length ? (
                    <div data-canvas-agent-task-progress className="mt-4 space-y-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <div className="text-[11px] font-medium" style={{ color: theme.node.muted }}>
                            子任务进度 {taskProgressItems.filter((task) => task.status === "completed").length}/{taskProgressItems.length}
                        </div>
                        {taskProgressItems.map((task) => (
                            <AgentTaskTimingRow key={task.id} task={task} fallbackStartedAt={startedAt} now={displayEndAt} theme={theme} terminal={terminal} onLocate={task.nodeId ? () => onLocateNode?.(task.nodeId!) : undefined} onRetry={task.status === "failed" ? () => onRetryTask?.(task.retryTaskId) : undefined} />
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

type AgentTaskProgressItem = Pick<CreativeAgentRun["tasks"][number], "id" | "title" | "type" | "status" | "error" | "startedAt" | "completedAt" | "retryAfterAt" | "submittedParameters"> & { retryTaskId: string; nodeId?: string };

function expandAgentTaskProgress(tasks: CreativeAgentRun["tasks"], runId?: string): AgentTaskProgressItem[] {
    return tasks.flatMap((task) => {
        const taskIndex = tasks.indexOf(task);
        const outputNodeId = (copyIndex: number) => (runId && task.type !== "text" ? `output-${runId}-${taskIndex}-${copyIndex}` : undefined);
        if (!task.childTasks?.length) return [{ id: task.id, title: task.title, type: task.type, status: task.status, error: task.error, startedAt: task.startedAt, completedAt: task.completedAt, retryAfterAt: task.retryAfterAt, submittedParameters: task.submittedParameters, retryTaskId: task.id, nodeId: outputNodeId(0) }];
        const type = task.type === "image" ? "生图" : task.type === "video" ? "生视频" : task.type === "audio" ? "音频" : "文本";
        return task.childTasks.map((child, index) => ({
            id: `${task.id}:${child.id}`,
            title: `${type} ${index + 1}｜${task.title}`,
            type: task.type,
            status: child.status === "pending" ? "ready" : child.status,
            error: child.error || (child.status === "failed" ? task.error : undefined),
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            retryAfterAt: task.retryAfterAt,
            submittedParameters: task.submittedParameters,
            retryTaskId: task.id,
            nodeId: outputNodeId(index),
        }));
    });
}

function AgentTaskTimingRow({
    task,
    fallbackStartedAt,
    now,
    theme,
    terminal,
    onLocate,
    onRetry,
}: {
    task: AgentTaskProgressItem;
    fallbackStartedAt?: number;
    now: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    terminal: boolean;
    onLocate?: () => void;
    onRetry?: () => void;
}) {
    const taskStartedAt = task.startedAt || (task.status !== "ready" ? fallbackStartedAt : undefined);
    const taskEndedAt = task.completedAt || (task.status === "running" ? now : undefined);
    const duration = taskStartedAt && taskEndedAt ? formatAgentDuration(Math.max(0, taskEndedAt - taskStartedAt)) : "";
    const state = agentTaskDisplayState(task.status, terminal, Boolean(task.retryAfterAt));
    return (
        <div
            data-agent-task-node-id={task.nodeId}
            className={`rounded-lg border px-2.5 py-2 ${onLocate ? "cursor-pointer transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300" : ""}`}
            style={{ borderColor: task.retryAfterAt ? "rgba(245,158,11,.55)" : theme.node.stroke, background: theme.node.fill }}
            role={onLocate ? "button" : undefined}
            tabIndex={onLocate ? 0 : undefined}
            onClick={onLocate}
            onKeyDown={(event) => {
                if (onLocate && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onLocate();
                }
            }}
        >
            <div className="flex min-w-0 items-center gap-2 text-xs">
                {state.icon}
                <span className="min-w-0 flex-1 truncate" title={task.title}>
                    {task.title}
                </span>
                <span className="shrink-0 text-[11px]" style={{ color: state.color }}>
                    {state.label}
                </span>
            </div>
            <div className="mt-1 pl-5 text-[10px] leading-4" style={{ color: theme.node.muted }}>
                {taskStartedAt ? `开始 ${formatAgentClock(taskStartedAt)}${duration ? ` · ${task.status === "running" ? "已运行" : "耗时"} ${duration}` : ""}` : "等待开始"}
            </div>
            {task.status === "failed" && task.error ? (
                <div
                    data-agent-task-error
                    role="alert"
                    className="mt-2 rounded-md border px-2 py-1.5 text-[10px] leading-4 whitespace-pre-wrap break-words"
                    style={{
                        borderColor: "color-mix(in srgb, #67e8f9 44%, #c084fc)",
                        background: "linear-gradient(90deg, color-mix(in srgb, #67e8f9 10%, transparent), color-mix(in srgb, #818cf8 10%, transparent), color-mix(in srgb, #c084fc 10%, transparent))",
                        color: theme.node.text,
                    }}
                >
                    <span className="font-medium">失败原因：</span>
                    {task.error}
                </div>
            ) : null}
            {task.status === "ready" && task.retryAfterAt && task.error ? (
                <div data-agent-task-waiting className="mt-2 rounded-md border px-2 py-1.5 text-[10px] leading-4" style={{ borderColor: "rgba(245,158,11,.48)", background: "rgba(245,158,11,.09)", color: theme.node.text }}>
                    <span className="font-medium">等待提交：</span>
                    {task.error}
                </div>
            ) : null}
            {(task.status === "failed" || task.retryAfterAt) && task.submittedParameters ? <AgentSubmittedParameters parameters={task.submittedParameters} theme={theme} /> : null}
            {onRetry ? (
                <button type="button" className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium transition hover:opacity-70" style={{ color: theme.node.infoText }} onClick={(event) => { event.stopPropagation(); onRetry(); }}>
                    <RotateCcw className="size-3" />
                    重新尝试
                </button>
            ) : null}
        </div>
    );
}

function AgentSubmittedParameters({ parameters, theme }: { parameters: NonNullable<AgentTaskProgressItem["submittedParameters"]>; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const entries = [parameters.model ? `模型 ${parameters.model}` : "", parameters.ratio ? `比例 ${parameters.ratio}` : "", parameters.quality ? `清晰度 ${parameters.quality}` : "", parameters.duration ? `时长 ${parameters.duration} 秒` : "", parameters.referenceMode ? parameters.referenceMode : ""].filter(Boolean);
    if (!entries.length) return null;
    return (
        <div data-agent-task-submitted-parameters className="mt-2 rounded-md border px-2 py-1.5 text-[10px] leading-4" style={{ borderColor: theme.node.infoBorder, background: theme.node.infoSurface, color: theme.node.text }}>
            <span className="font-medium">实际提交参数：</span>
            {entries.join(" · ")}
        </div>
    );
}

function agentTaskDisplayState(status: CreativeAgentRun["tasks"][number]["status"], terminal = false, retryScheduled = false) {
    if (status === "completed") return { label: "已完成", color: "#16a34a", icon: <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" /> };
    if (status === "failed") return { label: "失败", color: "#dc2626", icon: <XCircle className="size-3.5 shrink-0 text-red-500" /> };
    if (status === "cancelled") return { label: "已取消", color: "#d97706", icon: <CircleAlert className="size-3.5 shrink-0 text-amber-500" /> };
    if (status === "running") return terminal ? { label: "已结束", color: "#64748b", icon: <Circle className="size-3.5 shrink-0" /> } : { label: "执行中", color: "#0284c7", icon: <LoaderCircle className="size-3.5 shrink-0 animate-spin text-sky-500" /> };
    if (!terminal && retryScheduled) return { label: "等待账号释放", color: "#d97706", icon: <LoaderCircle className="size-3.5 shrink-0 animate-spin text-amber-500" /> };
    return terminal ? { label: "未执行", color: "#64748b", icon: <Circle className="size-3.5 shrink-0" /> } : { label: "排队等待", color: "#64748b", icon: <LoaderCircle className="size-3.5 shrink-0 animate-spin text-slate-400" /> };
}

function useLiveAgentClock(active: boolean) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [active]);
    return now;
}

function MessageTime({ createdAt, align }: { createdAt?: string; align: "start" | "center" | "end" }) {
    if (!createdAt) return null;
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) return null;
    return (
        <time dateTime={createdAt} data-canvas-agent-message-time title={new Date(timestamp).toLocaleString("zh-CN")} className={`mt-1 block text-[11px] font-medium leading-4 opacity-65 ${align === "center" ? "text-center" : align === "end" ? "text-right" : "text-left"}`}>
            {formatAgentClock(timestamp, false)}
        </time>
    );
}

function formatAgentClock(timestamp: number, withSeconds = true) {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}), hour12: false }).format(new Date(timestamp));
}

function formatAgentDuration(durationMs: number) {
    const seconds = Math.max(0, Math.floor(durationMs / 1_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const restSeconds = seconds % 60;
    return hours ? `${hours}小时${minutes}分${restSeconds}秒` : minutes ? `${minutes}分${restSeconds}秒` : `${restSeconds}秒`;
}

const EMPTY_MENTION_ASSETS: CanvasAgentMentionAsset[] = [];
const EMPTY_REFERENCE_IDS: string[] = [];

export type CanvasAgentSkillToken = { id: string; name: string };

export function insertCanvasAgentSkillToken(value: string, cursor: number, skill: CanvasAgentSkillToken) {
    const safeId = encodeURIComponent(skill.id);
    const token = `[[skill:${safeId}]]`;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const separator = before && !/\s$/u.test(before) ? " " : "";
    const trailing = after && !/^\s/u.test(after) ? " " : "";
    const nextValue = `${before}${separator}${token}${trailing}${after}`;
    return { value: nextValue, cursor: before.length + separator.length + token.length + trailing.length };
}

export function stripCanvasAgentSkillTokens(value: string) {
    return value.replace(/\[\[skill:[^\]]+\]\]/gu, "").replace(/[ \t]{2,}/gu, " ").trim();
}

function CanvasAgentSkillPreview({ prompt, skillsById, previewRef, theme }: { prompt: string; skillsById: ReadonlyMap<string, CanvasAgentSkillToken>; previewRef: RefObject<HTMLDivElement | null>; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const match of prompt.matchAll(/\[\[skill:([^\]]+)\]\]/gu)) {
        const start = match.index ?? 0;
        if (start > offset) parts.push(<span key={`text-${offset}`}>{prompt.slice(offset, start)}</span>);
        let skillId = match[1];
        try {
            skillId = decodeURIComponent(skillId);
        } catch {
            // Keep malformed user-edited tokens as plain text.
        }
        const skill = skillsById.get(skillId);
        if (!skill) {
            parts.push(<span key={`unknown-${start}`}>{match[0]}</span>);
        } else {
            parts.push(
                <span key={`skill-${start}`} className="relative inline-block align-baseline font-normal text-transparent">
                    <span className="whitespace-pre">{match[0]}</span>
                    <span data-canvas-agent-inline-skill className="absolute left-0 top-0 inline-flex h-5 w-max max-w-full items-center gap-1 overflow-hidden rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap" style={{ color: theme.node.text, background: theme.toolbar.itemHover, borderColor: theme.toolbar.border }}>
                        <Sparkles className="size-3 shrink-0" />
                        <span className="min-w-0 truncate">{skill.name}</span>
                    </span>
                </span>,
            );
        }
        offset = start + match[0].length;
    }
    if (offset < prompt.length) parts.push(<span key={`text-${offset}`}>{prompt.slice(offset)}</span>);
    return (
        <div ref={previewRef} aria-hidden="true" data-testid="canvas-agent-skill-preview" className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words px-1 py-1 text-sm leading-5 [font-family:inherit]" style={{ color: theme.node.text }}>
            {parts}
        </div>
    );
}

export function AgentChatComposer({
    prompt,
    attachments = [],
    mentionAssets = EMPTY_MENTION_ASSETS,
    selectedReferenceIds = EMPTY_REFERENCE_IDS,
    canSubmitWithContext = false,
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onAddFiles,
    onRemoveAttachment,
    onRetryAttachment,
    onSelectReference,
    onPickCanvasReference,
    onCancelCanvasReferencePicker,
    canvasReferencePicking = false,
    beforeInput,
    left,
    expanded = false,
    onExpandedChange,
    skills = [],
    skillInserterRef,
}: {
    prompt: string;
    attachments?: CanvasAgentChatAttachment[];
    mentionAssets?: CanvasAgentMentionAsset[];
    selectedReferenceIds?: string[];
    canSubmitWithContext?: boolean;
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    onRetryAttachment?: (id: string) => void;
    onSelectReference?: (id: string) => void;
    onPickCanvasReference?: () => void;
    onCancelCanvasReferencePicker?: () => void;
    canvasReferencePicking?: boolean;
    beforeInput?: ReactNode;
    left?: ReactNode;
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    skills?: CanvasAgentSkillToken[];
    skillInserterRef?: { current: (skill: CanvasAgentSkillToken) => void };
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const caretRef = useRef(0);
    const mentionHighlightRef = useRef<HTMLDivElement>(null);
    const [isDragActive, setIsDragActive] = useState(false);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const uploading = attachments.some((item) => item.status === "uploading");
    const hasFailedUpload = attachments.some((item) => item.status === "failed");
    const canSubmit = !disabled && !sending && !uploading && !hasFailedUpload && Boolean(prompt.trim() || attachments.length || canSubmitWithContext);
    const mentionAssetsById = useMemo(() => new Map(mentionAssets.map((asset) => [asset.id, asset])), [mentionAssets]);
    const skillsById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
    const referenceAliases = useMemo(() => canvasAgentReferenceAliases(mentionAssets, selectedReferenceIds), [mentionAssets, selectedReferenceIds]);
    const mentionCandidates = useMemo(() => canvasAgentMentionCandidates(mentionAssets, mentionQuery || "", referenceAliases), [mentionAssets, mentionQuery, referenceAliases]);
    const mentionSegments = useMemo(() => canvasAgentMentionSegments(prompt, referenceAliases), [prompt, referenceAliases]);
    const hasMentionReferences = mentionSegments.some((segment) => segment.referenced);
    const hasSkillTokens = /\[\[skill:[^\]]+\]\]/u.test(prompt);
    const promptRef = useRef(prompt);
    const onPromptChangeRef = useRef(onPromptChange);
    useEffect(() => {
        promptRef.current = prompt;
        onPromptChangeRef.current = onPromptChange;
    }, [onPromptChange, prompt]);
    useEffect(() => {
        if (!skillInserterRef) return;
        skillInserterRef.current = (skill) => {
            const result = insertCanvasAgentSkillToken(promptRef.current, caretRef.current, skill);
            caretRef.current = result.cursor;
            onPromptChangeRef.current(result.value);
            focusComposerAt(result.cursor);
        };
        return () => {
            skillInserterRef.current = () => undefined;
        };
    }, [skillInserterRef]);
    const updateComposerValue = (value: string, cursor: number) => {
        caretRef.current = cursor;
        onPromptChange(value);
        setMentionQuery(canvasAgentMentionDraftAtCursor(value, cursor, referenceAliases)?.query ?? null);
    };
    const updateMentionCursor = (value: string, cursor: number) => {
        caretRef.current = cursor;
        setMentionQuery(canvasAgentMentionDraftAtCursor(value, cursor, referenceAliases)?.query ?? null);
    };
    const focusComposerAt = (cursor: number) => {
        window.requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(cursor, cursor);
        });
    };
    const selectMentionAsset = (asset: CanvasAgentMentionAsset) => {
        const nextReferenceIds = selectedReferenceIds.includes(asset.id) ? selectedReferenceIds : [...selectedReferenceIds, asset.id];
        const alias = canvasAgentReferenceAliases(mentionAssets, nextReferenceIds).get(asset.id);
        if (!alias) return;
        const result = replaceCanvasAgentMention(prompt, caretRef.current, alias);
        onSelectReference?.(asset.id);
        onPromptChange(result.value);
        setMentionQuery(null);
        focusComposerAt(result.cursor);
    };
    const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!onAddFiles || sending || !preventFileDragEvent(event)) return;
        setIsDragActive(true);
    };
    const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!onAddFiles || !preventFileDragEvent(event) || !leftDropTarget(event)) return;
        setIsDragActive(false);
    };
    const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!onAddFiles || sending || !preventFileDragEvent(event)) return;
        setIsDragActive(false);
        const files = droppedFiles(event, isCanvasAgentAttachmentFile);
        if (!files.length) return;
        void onAddFiles(files);
    };
    const openLocalFilePicker = () => {
        fileInputRef.current?.click();
    };
    const hasAttachments = attachments.length > 0;
    return (
        <div data-canvas-agent-composer className="shrink-0 px-4 pb-4 pt-2" data-canvas-agent-composer-expanded={expanded || undefined} style={expanded ? { width: "100%", padding: 0 } : undefined} onWheelCapture={(event) => event.stopPropagation()}>
            <div
                className="relative flex flex-col rounded-2xl border px-3 pb-3 pt-3 shadow-none transition"
                style={{ background: theme.toolbar.panel, borderColor: isDragActive ? "#22d3ee" : theme.node.stroke, boxShadow: expanded ? "0 16px 50px rgba(15,23,42,.32)" : undefined, height: expanded ? `min(${CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT}px, calc(100dvh - 4rem))` : undefined }}
                onDragEnter={handleDragOver}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {onExpandedChange ? (
                    <Tooltip title={expanded ? "缩小输入面板" : "放大输入面板"}>
                        <Button
                            type="text"
                            className="!absolute !right-3 !top-3 z-10 !size-8 !min-w-8 !shrink-0 !rounded-md !border !p-0"
                            style={{ position: "absolute", top: 12, right: 12, color: theme.node.muted, background: theme.toolbar.itemHover, borderColor: theme.toolbar.border }}
                            icon={expanded ? <Minimize2 className="size-3.5" strokeWidth={1.7} /> : <Maximize2 className="size-3.5" strokeWidth={1.7} />}
                            onClick={() => onExpandedChange(!expanded)}
                            aria-label={expanded ? "缩小输入面板" : "放大输入面板"}
                        />
                    </Tooltip>
                ) : null}
                {onAddFiles ? (
                    <input
                        ref={fileInputRef}
                        hidden
                        type="file"
                        accept="image/*,video/*,text/plain,text/markdown,.md,.markdown,.txt"
                        multiple
                        onChange={(event) => {
                            void onAddFiles(event.target.files);
                            event.target.value = "";
                        }}
                    />
                ) : null}
                <div className={`flex min-w-0 gap-2 pr-10 ${expanded ? "min-h-0 flex-1" : ""} ${hasAttachments ? "flex-col" : "items-start"}`} data-canvas-agent-input-row>
                    {onAddFiles || attachments.length ? (
                        <div className={`hide-scrollbar flex items-start gap-1.5 overflow-x-auto overflow-y-hidden px-0.5 py-0.5 ${hasAttachments ? "w-full" : "shrink-0"}`} aria-label="本轮参考素材" aria-live="polite">
                            {onPickCanvasReference ? (
                                <Tooltip title={canvasReferencePicking ? "正在从画布选择素材" : "从画布选择"}>
                                    <Button
                                        type="text"
                                        className="!size-8 !min-w-8 !shrink-0 !rounded-md !border !p-0"
                                        disabled={sending}
                                        style={{
                                            color: canvasReferencePicking ? theme.node.infoText : theme.node.muted,
                                            background: canvasReferencePicking ? theme.node.infoSurface : theme.toolbar.itemHover,
                                            borderColor: canvasReferencePicking ? theme.node.infoBorder : theme.toolbar.border,
                                        }}
                                        icon={<MousePointer2 className="size-3.5" strokeWidth={1.7} />}
                                        onClick={canvasReferencePicking ? onCancelCanvasReferencePicker : onPickCanvasReference}
                                        aria-label={canvasReferencePicking ? "正在从画布选择素材" : "从画布选择"}
                                    />
                                </Tooltip>
                            ) : null}
                            {onAddFiles ? (
                                <Tooltip title={uploading ? "正在上传参考素材" : "上传本地素材"}>
                                    <Button
                                        type="text"
                                        className="!size-8 !min-w-8 !shrink-0 !rounded-md !border !p-0"
                                        disabled={sending}
                                        style={{ color: theme.node.muted, background: theme.node.fill, borderColor: theme.node.stroke }}
                                        icon={uploading ? <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.7} /> : <Upload className="size-3.5" strokeWidth={1.7} />}
                                        onClick={openLocalFilePicker}
                                        aria-label={uploading ? "正在上传参考素材" : "上传本地素材"}
                                    />
                                </Tooltip>
                            ) : null}
                            {attachments.map((item) => (
                                <div
                                    key={item.id}
                                    className="group relative size-8 shrink-0 overflow-visible rounded-md border border-transparent p-px"
                                    style={{ borderColor: item.status === "failed" ? theme.node.danger : "transparent", background: theme.toolbar.itemHover }}
                                    title={item.error || item.name}
                                >
                                    <div className="size-full overflow-hidden rounded-[5px]" style={{ background: theme.node.fill }}>
                                        {item.type === "text" ? (
                                            <span className="grid size-full place-items-center" style={{ color: theme.node.muted }}>
                                                <FileText className="size-4" strokeWidth={1.7} />
                                            </span>
                                        ) : item.type === "video" ? (
                                            <>
                                                <video src={item.url} muted playsInline preload="metadata" aria-label={item.name} className="pointer-events-none size-full object-cover" />
                                                <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/10 text-white">
                                                    <Play className="size-3 fill-current" strokeWidth={1.7} />
                                                </span>
                                            </>
                                        ) : (
                                            <img src={imagePreviewUrl(item.url || "", 256)} alt={item.name} className="block size-full bg-transparent object-cover" />
                                        )}
                                    </div>
                                    {item.label ? <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1 py-0.5 text-[9px] font-medium leading-none text-white">{item.label}</span> : null}
                                    {item.status === "uploading" ? (
                                        <span className="absolute inset-0 grid place-items-center rounded-[5px] bg-black/50 text-white" role="status" aria-label={`${item.name} 上传中`}>
                                            <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.7} />
                                        </span>
                                    ) : null}
                                    {item.status === "failed" && onRetryAttachment ? (
                                        <button
                                            type="button"
                                            className="absolute inset-0 grid place-items-center rounded-[5px] bg-black/55 text-white transition hover:bg-black/65"
                                            onClick={() => onRetryAttachment(item.id)}
                                            aria-label={`重试上传参考素材：${item.name}`}
                                        >
                                            <RotateCcw className="size-3.5" strokeWidth={1.7} />
                                        </button>
                                    ) : null}
                                    {onRemoveAttachment && item.status !== "uploading" ? (
                                        <button
                                            type="button"
                                            className="group/remove absolute -right-1 -top-1 z-10 flex size-7 items-start justify-end rounded-full bg-transparent p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                            style={
                                                {
                                                    "--remove-surface": theme.node.removeSurface,
                                                    "--remove-border": theme.node.removeBorder,
                                                    "--remove-text": theme.node.removeText,
                                                    "--remove-hover-surface": theme.node.dangerSurface,
                                                    "--remove-hover-border": theme.node.dangerBorder,
                                                    "--remove-hover-text": theme.node.danger,
                                                    outlineColor: theme.node.dangerBorder,
                                                } as React.CSSProperties
                                            }
                                            onClick={() => onRemoveAttachment(item.id)}
                                            aria-label={`移除参考素材：${item.name}`}
                                        >
                                            <span className="grid size-4 place-items-center rounded-full border border-[var(--remove-border)] bg-[var(--remove-surface)] text-[var(--remove-text)] opacity-90 shadow-[0_1px_5px_rgba(15,23,42,.14)] backdrop-blur-md transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 group-hover/remove:scale-105 group-hover/remove:border-[var(--remove-hover-border)] group-hover/remove:bg-[var(--remove-hover-surface)] group-hover/remove:text-[var(--remove-hover-text)] group-hover/remove:opacity-100 group-focus-visible/remove:border-[var(--remove-hover-border)] group-focus-visible/remove:bg-[var(--remove-hover-surface)] group-focus-visible/remove:text-[var(--remove-hover-text)] group-focus-visible/remove:opacity-100">
                                                <X className="size-2" strokeWidth={1.8} aria-hidden="true" />
                                            </span>
                                        </button>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {beforeInput}
                    <Popover
                        trigger={[]}
                        placement="topLeft"
                        arrow={false}
                        open={mentionQuery !== null}
                        onOpenChange={(open: boolean) => {
                            if (!open) setMentionQuery(null);
                        }}
                        styles={{ container: { padding: 0, borderRadius: 12, overflow: "hidden", background: theme.node.panel, border: `1px solid ${theme.toolbar.border}` } }}
                        content={<CanvasAgentMentionPicker assets={mentionCandidates} selectedNodeIds={selectedReferenceIds} theme={theme} onSelect={selectMentionAsset} />}
                    >
                        <div className={`relative min-w-0 ${hasAttachments ? "w-full" : "min-w-0 flex-1"}`} style={expanded ? { minHeight: 0, flex: 1 } : undefined}>
                            {hasSkillTokens ? <CanvasAgentSkillPreview prompt={prompt} skillsById={skillsById} previewRef={mentionHighlightRef} theme={theme} /> : hasMentionReferences ? <CanvasAgentMentionPreview segments={mentionSegments} assetsById={mentionAssetsById} previewRef={mentionHighlightRef} theme={theme} /> : null}
                            <textarea
                                ref={textareaRef}
                                value={prompt}
                                onChange={(event) => updateComposerValue(event.target.value, event.target.selectionStart)}
                                onClick={(event) => updateMentionCursor(event.currentTarget.value, event.currentTarget.selectionStart)}
                                onKeyUp={(event) => {
                                    if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
                                    updateMentionCursor(event.currentTarget.value, event.currentTarget.selectionStart);
                                }}
                                onScroll={(event) => {
                                    if (mentionHighlightRef.current) mentionHighlightRef.current.style.transform = `translate3d(0, -${event.currentTarget.scrollTop}px, 0)`;
                                }}
                                onPaste={(event) => {
                                    if (!onAddFiles) return;
                                    const images = clipboardImageFiles(event.clipboardData);
                                    if (!images.length) return;
                                    event.preventDefault();
                                    void onAddFiles(images);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape" && mentionQuery !== null) {
                                        event.preventDefault();
                                        setMentionQuery(null);
                                        return;
                                    }
                                    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
                                    event.preventDefault();
                                    if (mentionQuery !== null && mentionCandidates.length) {
                                        selectMentionAsset(mentionCandidates[0]);
                                        return;
                                    }
                                    void onSubmit();
                                }}
                                className={`thin-scrollbar relative z-[1] w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 tracking-[0.005em] outline-none placeholder:opacity-45 ${expanded ? "h-full min-h-0 max-h-none" : "min-h-16 max-h-32"}`}
                                style={{ color: hasMentionReferences || hasSkillTokens ? "transparent" : theme.node.text, caretColor: theme.node.text }}
                                placeholder={placeholder}
                            />
                        </div>
                    </Popover>
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-1" data-canvas-agent-toolbar>
                    <div className="min-w-0 flex-1 overflow-hidden py-0.5">{left}</div>
                    <Button
                        type="text"
                        shape="circle"
                        className="!size-8 !min-w-8 !shrink-0 !border-0 !bg-[#20242a] !p-0 !text-white !shadow-none hover:!bg-[#30363e] disabled:!bg-[#eef1f3] disabled:!text-[#aab2ba] dark:!bg-white dark:!text-[#17191d] dark:hover:!bg-[#e7eaed] dark:disabled:!bg-[#2b3036] dark:disabled:!text-[#68717b]"
                        disabled={!canSubmit}
                        icon={sending ? <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.7} /> : <ArrowUp className="size-3.5" strokeWidth={1.7} />}
                        onClick={() => void onSubmit()}
                        aria-label="发送"
                    />
                </div>
            </div>
        </div>
    );
}

export function AgentPanelTabs<T extends string>({
    value,
    items,
    theme,
    right,
    onChange,
}: {
    value: T;
    items: { value: T; label: string; icon?: ReactNode; count?: number }[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    right?: ReactNode;
    onChange: (value: T) => void;
}) {
    return (
        <div className="border-b px-3" style={{ borderColor: theme.node.stroke }}>
            <div className="flex min-h-11 items-center justify-between gap-3">
                <nav className="thin-scrollbar flex min-w-0 flex-1 items-center gap-3 overflow-x-auto text-sm" role="tablist" aria-label="Agent 面板">
                    {items.map((item) => (
                        <button
                            key={item.value}
                            type="button"
                            role="tab"
                            aria-selected={value === item.value}
                            className={`inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-0.5 transition ${value === item.value ? "font-medium" : "font-normal"}`}
                            style={{ borderColor: value === item.value ? theme.node.text : "transparent", color: value === item.value ? theme.node.text : theme.node.muted }}
                            onClick={() => onChange(item.value)}
                        >
                            {item.icon}
                            {item.label}
                            {item.count ? ` ${item.count}` : ""}
                        </button>
                    ))}
                </nav>
                {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
            </div>
        </div>
    );
}

function AgentDetailBlock({ detail, theme }: { detail: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <pre className="thin-scrollbar mt-3 max-h-64 overflow-auto rounded-lg border p-3 text-[11px] leading-4" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.muted }}>
            {JSON.stringify(detail, null, 2)}
        </pre>
    );
}

function AgentAvatar({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    return (
        <span className="grid size-8 shrink-0 place-items-center" role="img" aria-label={`${resolveSiteTitle(site.title)} Agent`} style={{ color: theme.node.text }}>
            <SiteLogo logoUrl={site.logoUrl} className="size-5" />
        </span>
    );
}

function AgentUserAvatar({ user, theme }: { user: LocalUser | null; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const avatarUrl = user?.avatarUrl?.trim();
    const label = user?.displayName || user?.username || "用户";
    return (
        <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full" role="img" aria-label={label} style={{ color: theme.node.text }}>
            {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
            ) : (
                <span className="grid size-full place-items-center text-[11px] font-semibold" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} aria-hidden="true">
                    {userAvatarFallback(label)}
                </span>
            )}
        </span>
    );
}

function AgentMessageAttachments({ attachments, align = "start" }: { attachments: CanvasAgentChatAttachment[]; align?: "start" | "end" }) {
    return (
        <div className={`mb-2 flex flex-wrap gap-1.5 ${align === "end" ? "justify-end" : "justify-start"}`}>
            {attachments.map((item) =>
                item.type === "text" ? (
                    <span key={item.id} className="inline-flex h-8 max-w-56 items-center gap-1.5 rounded-lg border px-2 text-xs" title={item.name}>
                        <FileText className="size-3.5 shrink-0" />
                        <span className="truncate">{item.name}</span>
                    </span>
                ) : (
                    <AgentMediaPreview key={item.id} type={item.type || "image"} url={item.url || ""} title={item.name} className="size-12 rounded-lg" />
                ),
            )}
        </div>
    );
}

function agentErrorFlowTextStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]): CSSProperties {
    if (theme !== canvasThemes.dark) return { color: theme.node.infoText };
    return {
        color: "transparent",
        backgroundImage: "linear-gradient(90deg, #67e8f9 0%, #818cf8 48%, #c084fc 100%)",
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
    };
}

function toolCardState(title: string, text: string, detail: unknown, theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    const raw = `${title} ${text} ${normalizeText(objectField(detail, "error"))}`;
    const lower = raw.toLowerCase();
    const tool = String(objectField(detail, "name") || objectField(detail, "tool") || "");
    const errorTone = { color: theme.node.infoText, softBorder: theme.node.infoBorder, softBg: theme.node.infoSurface, icon: <XCircle className="size-4" />, isError: true };
    if (objectField(detail, "status") === "noop" || /未生效|无需|没有找到|没有.*可|已存在/.test(raw))
        return { label: "未生效", color: "#d97706", softBorder: "rgba(217,119,6,.22)", softBg: "rgba(217,119,6,.04)", icon: <CircleAlert className="size-4" />, isError: false };
    if (/拒绝|取消/.test(raw) || lower.includes("rejected")) return { label: "拒绝执行", ...errorTone };
    if (/失败|错误/.test(raw) || lower.includes("failed") || lower.includes("error")) return { label: "执行失败", ...errorTone };
    if (/完成|成功/.test(raw) || lower.includes("completed") || lower.includes("succeeded"))
        return { label: tool === "canvas_apply_ops" || /画布操作/.test(title) ? "已批准执行" : "执行完成", color: "#16a34a", softBorder: "rgba(22,163,74,.20)", softBg: "rgba(22,163,74,.04)", icon: <CheckCircle2 className="size-4" />, isError: false };
    return { label: "工具调用", color: "#2563eb", softBorder: "rgba(37,99,235,.20)", softBg: "rgba(37,99,235,.04)", icon: <Wrench className="size-4" />, isError: false };
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function objectStringArray(value: unknown, key: string) {
    const field = objectField(value, key);
    return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}
