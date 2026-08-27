import { after, NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { getAgentRun, updateAgentRunById, type AgentRunTask } from "@/lib/server/agent-run-store";
import { failedAgentTaskRetryOps, prepareFailedAgentTaskRetry } from "@/lib/server/agent-run-task-input";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { effectiveGenerationConcurrencyLimit, withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { publicAgentRun } from "@/lib/server/agent-run-public";
import { taskCanvasEventOps } from "@/lib/server/agent-run-canvas-ops";

export const maxDuration = 2400;

export async function POST(request: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const { id, taskId } = await params;
    const parsed = await readJsonBodyResult<{ conversationId?: unknown; taskIds?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const expectedConversationId = typeof parsed.data?.conversationId === "string" ? parsed.data.conversationId.trim() : "";
    if (parsed.data?.conversationId !== undefined && !expectedConversationId) return NextResponse.json({ code: 400, data: null, msg: "对话标识无效" }, { status: 400 });
    const run = await getAgentRun(id);
    if (!run || (run.userId !== user.id && user.role !== "admin")) return NextResponse.json({ code: 404, data: null, msg: "Agent 任务不存在" }, { status: 404 });
    if (expectedConversationId && run.conversationId !== expectedConversationId) return NextResponse.json({ code: 409, data: null, msg: "当前对话与 Agent 任务不匹配" }, { status: 409 });
    const requestedTaskIds = normalizeTaskIds(parsed.data?.taskIds, taskId);
    if (!requestedTaskIds || requestedTaskIds[0] !== taskId) return NextResponse.json({ code: 400, data: null, msg: "失败任务标识无效" }, { status: 400 });
    const requestedTaskIdSet = new Set(requestedTaskIds);
    const requestedTasks = run.tasks.filter((item) => requestedTaskIdSet.has(item.id));
    if (requestedTasks.length !== requestedTaskIds.length) return NextResponse.json({ code: 404, data: null, msg: "Agent 子任务不存在" }, { status: 404 });
    if (requestedTasks.some((task) => task.status === "cancelled")) return NextResponse.json({ code: 409, data: null, msg: "已取消任务不能重试" }, { status: 409 });
    const failedTaskIdSet = new Set(requestedTasks.filter((task) => task.status === "failed").map((task) => task.id));
    const reconciledOps = currentTaskOps(run.id, run.tasks, requestedTaskIdSet);
    if (!failedTaskIdSet.size) {
        return NextResponse.json({ code: 0, data: { run: publicAgentRun(run), ops: reconciledOps, reconciled: true, retriedTaskIds: [] }, msg: "OK" });
    }
    const settings = await getAuthSettings();
    const rawLimit = settings.generationConcurrency.agent;
    const limit = effectiveGenerationConcurrencyLimit(user.role, rawLimit);
    const tasks = run.tasks.map((item) => {
        if (!failedTaskIdSet.has(item.id)) return item;
        const completedChildren = item.childTasks?.filter((child) => child.status === "completed") || [];
        return prepareFailedAgentTaskRetry(
            run,
            {
                ...item,
                status: "ready" as const,
                attempts: Math.max(1, item.attempts || 0),
                taskId: completedChildren.at(-1)?.id,
                taskIds: completedChildren.length ? completedChildren.map((child) => child.id) : undefined,
                childTasks: completedChildren.length ? completedChildren : undefined,
                result: undefined,
                error: undefined,
                startedAt: undefined,
                completedAt: undefined,
            },
            settings,
        );
    });
    const retriedTasks = tasks.filter((item) => failedTaskIdSet.has(item.id));
    const retriedTaskIds = retriedTasks.map((item) => item.id);
    const retryOps = retriedTasks.flatMap((task) => failedAgentTaskRetryOps(run, task));
    const result = await withGenerationConcurrencyLimit(
        run.userId,
        "agent",
        10 * 60 * 1000,
        limit,
        async () => ({
            updated: await updateAgentRunById(run.id, { status: "running", tasks }, { type: "task.retry.requested", data: { taskId: retriedTaskIds[0], taskIds: retriedTaskIds, ops: retryOps } }, [run.status]),
        }),
        run.id,
    );
    if (result === null) return NextResponse.json({ code: 429, data: null, msg: `当前最多同时运行 ${rawLimit} 个 Agent 任务` }, { status: 429 });
    const { updated } = result;
    if (!updated) {
        const current = await getAgentRun(id);
        const currentTasks = current?.tasks.filter((item) => requestedTaskIdSet.has(item.id)) || [];
        if (current && currentTasks.length === requestedTaskIds.length && currentTasks.every((item) => item.status === "ready" || item.status === "running" || item.status === "completed")) {
            return NextResponse.json({ code: 0, data: { run: publicAgentRun(current), ops: currentTaskOps(current.id, current.tasks, requestedTaskIdSet), reconciled: true, retriedTaskIds: [] }, msg: "OK" });
        }
        return NextResponse.json({ code: 409, data: null, msg: "任务状态已变化，请重新操作" }, { status: 409 });
    }
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    const cookie = request.headers.get("cookie") || "";
    await scheduleGenerationTask("agent", updated.id, { executionPhase: "created", nextPollAt: Date.now(), lastUpstreamStatus: "task_retry" });
    after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [updated.id] }));
    return NextResponse.json({ code: 0, data: { run: publicAgentRun(updated), ops: [...reconciledOps, ...retryOps], reconciled: requestedTasks.length !== retriedTasks.length, retriedTaskIds }, msg: "OK" });
}

function currentTaskOps(runId: string, tasks: AgentRunTask[], taskIds: Set<string>) {
    return tasks.flatMap((task, index) => {
        if (!taskIds.has(task.id) || task.status === "failed" || task.status === "cancelled") return [];
        const eventType = task.status === "completed" ? "task.completed" : task.status === "running" ? "task.running" : "task.created";
        return taskCanvasEventOps(runId, index, task, eventType)?.ops || [];
    });
}

function normalizeTaskIds(value: unknown, fallbackTaskId: string) {
    if (value === undefined) return [fallbackTaskId];
    if (!Array.isArray(value)) return null;
    const taskIds = Array.from(new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)));
    return taskIds.length ? taskIds : null;
}
