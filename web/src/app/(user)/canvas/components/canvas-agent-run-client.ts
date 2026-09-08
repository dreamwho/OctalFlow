import type { CanvasAgentOp } from "../utils/canvas-agent-ops";
import type { CanvasAgentRunStage, CanvasAgentStableStageKey } from "./canvas-agent-progress";
import { getCreativeAgentRun, type CreativeAgentRun } from "@/services/api/creative";
import { ClientSessionExpiredError, stopIfClientSessionExpired } from "@/services/api/session-expiration";

type RunHandlers = {
    onPlan: (ops: CanvasAgentOp[], reply: string, summary: CanvasAgentPlanSummary) => void;
    onSkills?: (skills: Array<{ id: string; name: string }>) => void;
    onAssistant: (text: string, detail?: { nodeIds?: string[]; taskType?: "text" | "image" | "video" | "audio"; runId?: string; taskId?: string; title?: string }) => void;
    onStage: (stage: CanvasAgentRunStage) => void;
    onPaused: (paused: boolean) => void;
    onOps: (ops: CanvasAgentOp[]) => void;
    onRunProgress?: (progress: CanvasAgentRunProgress) => void;
    onTerminal?: (status: Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled">) => void;
};

export type CanvasAgentPlanSummary = { taskCount: number; label: string };
export type CanvasAgentRunProgress = { tasks: CreativeAgentRun["tasks"]; startedAt?: number };
type CanvasAgentRunWithRecovery = CreativeAgentRun & { recoveryOps?: CanvasAgentOp[] };

export function watchCanvasAgentRun(runId: string, handlers: RunHandlers, options: { signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const stream = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
        let appliedPlan = false;
        let connectionInterrupted = false;
        let reconciliation: Promise<void> | null = null;
        let settled = false;
        let paused: boolean | undefined;
        let latestStageKey: CanvasAgentStableStageKey = "planning";
        let latestOutput: { nodeIds?: string[]; taskType?: "text" | "image" | "video" | "audio" } | undefined;
        let runStartedAt: number | undefined;
        const taskStates = new Map<string, CreativeAgentRun["tasks"][number]>();
        const completedOutputNodeIds = new Set<string>();
        let latestFailedTask: { taskId: string; title?: string } | undefined;
        let terminalReconciliation: Promise<void> | null = null;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            stream.close();
            options.signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve();
        };
        const finishTerminal = (status: Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled">) => {
            handlers.onTerminal?.(status);
            finish();
        };
        const abort = () => finish();
        options.signal?.addEventListener("abort", abort, { once: true });
        const listen = (type: string, listener: (event: Event) => void) =>
            stream.addEventListener(type, (event) => {
                if (!settled) listener(event);
            });
        const read = <T>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
        const setPaused = (value: boolean) => {
            if (paused === value) return;
            paused = value;
            handlers.onPaused(value);
        };
        const reportStage = (stage: CanvasAgentRunStage) => {
            if (stage.key !== "reconnecting") latestStageKey = stage.key;
            handlers.onStage(stage);
        };
        const emitRunProgress = () => handlers.onRunProgress?.({ tasks: Array.from(taskStates.values()), startedAt: runStartedAt });
        const replaceRunProgress = (tasks: CreativeAgentRun["tasks"] = [], startedAt?: number) => {
            taskStates.clear();
            tasks.forEach((task) => taskStates.set(task.id, task));
            runStartedAt = startedAt || runStartedAt;
            emitRunProgress();
        };
        const applyRecoveredRun = (run?: CanvasAgentRunWithRecovery) => {
            if (!run) return;
            replaceRunProgress(run.tasks, run.timings?.requestAcceptedAt || run.createdAt);
            if (run.recoveryOps?.length) handlers.onOps(run.recoveryOps);
        };
        const patchTaskProgress = (data?: Partial<CreativeAgentRun["tasks"][number]> & { taskId?: string }) => {
            const id = data?.taskId || data?.id;
            if (!id) return;
            const current = taskStates.get(id);
            taskStates.set(id, {
                ...current,
                id,
                title: data?.title || current?.title || "创作任务",
                status: data?.status || current?.status || "running",
                ...(data?.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
                ...(data?.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
                ...(data?.error !== undefined ? { error: data.error } : {}),
                ...(data?.childTasks !== undefined ? { childTasks: data.childTasks } : {}),
            });
            emitRunProgress();
        };
        const reconcileRun = async () => {
            if (await stopIfClientSessionExpired()) {
                reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看" });
                finish();
                return;
            }
            try {
                const run = (await getCreativeAgentRun(runId)) as CanvasAgentRunWithRecovery;
                if (settled) return;
                applyRecoveredRun(run);
                if (run.status === "completed") {
                    handlers.onAssistant("Agent 任务已完成，结果已经返回。", latestOutput);
                    finishTerminal("completed");
                    return;
                }
                if (run.status === "cancelled") {
                    handlers.onAssistant("Agent 任务已取消。");
                    finishTerminal("cancelled");
                    return;
                }
                if (run.status === "failed") {
                    const failed = run.tasks.find((task) => task.status === "failed");
                    if (!latestFailedTask && failed) handlers.onAssistant(`「${failed.title || "创作任务"}」执行失败：${failed.error || "生成服务暂时不可用"}`, { runId, taskId: failed.id, title: failed.title || "创作任务失败" });
                    else if (!latestFailedTask) handlers.onAssistant(run.error || "Agent 执行失败", { runId, title: "Agent 执行失败" });
                    finishTerminal("failed");
                    return;
                }
                setPaused(run.status === "paused");
                reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: run.status === "paused" ? "任务仍在后台保存，当前处于暂停状态" : "任务仍在后台运行，正在恢复连接" });
            } catch (error) {
                if (settled) return;
                if (error instanceof ClientSessionExpiredError) {
                    reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看" });
                    finish();
                    return;
                }
                reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "暂时无法确认实时状态，任务仍会在后台继续运行" });
            }
        };
        const settleTerminal = (fallbackStatus: Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled">, onSettled: (status: Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled">, run?: CanvasAgentRunWithRecovery) => void) => {
            if (terminalReconciliation || settled) return;
            terminalReconciliation = (async () => {
                let run: CanvasAgentRunWithRecovery | undefined;
                try {
                    run = (await getCreativeAgentRun(runId)) as CanvasAgentRunWithRecovery;
                    if (settled) return;
                    applyRecoveredRun(run);
                } catch {
                    // The terminal SSE event is authoritative.  Keep its result
                    // visible even when the immediate read races a restart.
                }
                if (run && !isTerminalRunStatus(run.status)) {
                    setPaused(run.status === "paused");
                    reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: run.status === "paused" ? "任务仍在后台保存，当前处于暂停状态" : "任务仍在后台运行，正在恢复连接" });
                    terminalReconciliation = null;
                    return;
                }
                const status = run && isTerminalRunStatus(run.status) ? run.status : fallbackStatus;
                onSettled(status, run);
                finishTerminal(status);
            })();
        };

        listen("run.planning", () => reportStage({ key: "planning", text: "正在理解需求并分析当前画布" }));
        listen("skills.selected", (event) => {
            const payload = read<{ data?: { skills?: Array<{ id?: string; name?: string }> } }>(event);
            const skills = (payload.data?.skills || []).flatMap((skill) => (skill.id?.trim() && skill.name?.trim() ? [{ id: skill.id.trim(), name: skill.name.trim() }] : []));
            if (skills.length) handlers.onSkills?.(skills);
            reportStage({ key: "skills", text: skills.length ? `正在执行 Skill「${skills.map((skill) => skill.name).join("、")}」` : "正在匹配合适的创作技能" });
        });
        listen("canvas.ops", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[]; reply?: string } }>(event);
            if (!appliedPlan && payload.data?.ops?.length) {
                appliedPlan = true;
                handlers.onPlan(payload.data.ops, payload.data.reply || "创作计划已添加到画布，后台正在执行任务。", canvasAgentPlanSummary(payload.data.ops));
            }
            reportStage({ key: "plan", text: "文本执行计划已生成，正在准备任务" });
        });
        listen("task.running", (event) => {
            const payload = read<{ data?: Partial<CreativeAgentRun["tasks"][number]> & { taskId?: string; attempts?: number; ops?: CanvasAgentOp[] } }>(event);
            patchTaskProgress(payload.data);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            reportStage({ key: "executing", text: `正在执行「${payload.data?.title || "创作任务"}」${payload.data?.attempts ? `（第 ${payload.data.attempts} 次）` : ""}` });
        });
        listen("task.created", (event) => {
            const payload = read<{ data?: Partial<CreativeAgentRun["tasks"][number]> & { taskId?: string; ops?: CanvasAgentOp[] } }>(event);
            patchTaskProgress(payload.data);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
        });
        listen("task.waiting", (event) => {
            const payload = read<{ data?: Partial<CreativeAgentRun["tasks"][number]> & { taskId?: string } }>(event);
            patchTaskProgress(payload.data);
        });
        listen("task.child.completed", (event) => {
            const payload = read<{ data?: ChildTaskEventData }>(event);
            patchTaskProgress(payload.data);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            for (const nodeId of payload.data?.outputNodeIds || []) completedOutputNodeIds.add(nodeId);
            latestOutput = { nodeIds: Array.from(completedOutputNodeIds), taskType: payload.data?.type };
            const progress = childProgressText(payload.data);
            reportStage({ key: "executing", text: progress });
            handlers.onAssistant(progress, latestOutput);
        });
        listen("task.child.failed", (event) => {
            const payload = read<{ data?: ChildTaskEventData }>(event);
            patchTaskProgress(payload.data);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            const progress = childProgressText(payload.data);
            reportStage({ key: "executing", text: progress });
            handlers.onAssistant(progress, latestOutput);
        });
        listen("task.completed", (event) => {
            const payload = read<{ data?: Partial<CreativeAgentRun["tasks"][number]> & { taskId?: string; message?: string; outputNodeIds?: string[]; ops?: CanvasAgentOp[] } }>(event);
            patchTaskProgress(payload.data);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            latestOutput = { nodeIds: payload.data?.outputNodeIds, taskType: payload.data?.type };
            handlers.onAssistant(payload.data?.message || `「${payload.data?.title || "创作任务"}」已完成，正在继续处理。`, latestOutput);
        });
        listen("task.failed", (event) => {
            const payload = read<{ data?: Partial<CreativeAgentRun["tasks"][number]> & { taskId?: string; ops?: CanvasAgentOp[] } }>(event);
            patchTaskProgress(payload.data);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            if (!payload.data?.taskId) return;
            latestFailedTask = { taskId: payload.data.taskId, title: payload.data.title };
            handlers.onAssistant(`「${payload.data.title || "创作任务"}」执行失败：${payload.data.error || "生成服务暂时不可用"}`, { taskType: undefined, nodeIds: [], ...latestFailedTask, runId });
        });
        listen("task.retry.requested", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
        });
        listen("run.review.retry", () => reportStage({ key: "reviewing", text: "发现可优化内容，正在重新生成" }));
        listen("run.review.passed", () => reportStage({ key: "finalizing", text: "检查完成，正在整理结果" }));
        listen("run.review.unavailable", () => reportStage({ key: "finalizing", text: "正在整理已完成结果" }));
        listen("run.completed", (event) => {
            const payload = read<{ data?: { reply?: string; recoveryOps?: CanvasAgentOp[] } }>(event);
            if (payload.data?.recoveryOps?.length) handlers.onOps(payload.data.recoveryOps);
            settleTerminal("completed", (status) => handlers.onAssistant(status === "completed" ? payload.data?.reply || "创作计划与后台生成任务已全部完成。" : "Agent 任务未能全部完成，已同步当前结果。", latestOutput));
        });
        listen("run.failed", (event) => {
            const payload = read<{ data?: { message?: string; recoveryOps?: CanvasAgentOp[] } }>(event);
            if (payload.data?.recoveryOps?.length) handlers.onOps(payload.data.recoveryOps);
            settleTerminal("failed", (status, run) => {
                if (status === "failed" && !latestFailedTask) {
                    const failed = run?.tasks.find((task) => task.status === "failed");
                    handlers.onAssistant(failed ? `「${failed.title || "创作任务"}」执行失败：${failed.error || "生成服务暂时不可用"}` : run?.error || payload.data?.message || "Agent 执行失败", { runId, title: failed?.title || "Agent 执行失败", ...(failed?.id ? { taskId: failed.id } : {}) });
                }
            });
        });
        listen("run.cancelled", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[]; recoveryOps?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            if (payload.data?.recoveryOps?.length) handlers.onOps(payload.data.recoveryOps);
            settleTerminal("cancelled", () => handlers.onAssistant("Agent 任务已取消。"));
        });
        listen("run.paused", () => {
            setPaused(true);
            reportStage({ key: "paused", text: "任务已暂停" });
        });
        listen("run.resumed", () => {
            setPaused(false);
            reportStage({ key: "executing", text: "任务已恢复，正在继续执行" });
        });
        listen("run.snapshot", (event) => {
            const payload = read<CanvasAgentRunWithRecovery>(event);
            applyRecoveredRun(payload);
            if (payload.status === "cancelled") {
                handlers.onAssistant("Agent 任务已取消。");
                finishTerminal("cancelled");
            }
            if (payload.status === "completed") {
                handlers.onAssistant("Agent 任务已完成，结果已经返回。");
                finishTerminal("completed");
            }
            if (payload.status === "failed") {
                const failed = payload.tasks?.find((task) => task.status === "failed" && task.id);
                if (!latestFailedTask && failed?.id) handlers.onAssistant(`「${failed.title || "创作任务"}」执行失败：${failed.error || "生成服务暂时不可用"}`, { runId, taskId: failed.id, title: failed.title || "创作任务失败" });
                else if (!latestFailedTask) handlers.onAssistant(payload.error || "Agent 执行失败", { runId, title: "Agent 执行失败" });
                finishTerminal("failed");
            }
            if (payload.status === "paused") setPaused(true);
            if (payload.status === "planning" || payload.status === "running") setPaused(false);
        });
        stream.onopen = () => {
            if (connectionInterrupted && !settled) reportStage({ key: latestStageKey, text: "连接已恢复，任务继续运行" });
            connectionInterrupted = false;
        };
        stream.onerror = () => {
            if (settled) return;
            connectionInterrupted = true;
            reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "连接暂时中断，正在确认后台任务状态" });
            reconciliation ||= reconcileRun().finally(() => {
                reconciliation = null;
            });
        };
    });
}

export function canvasAgentPlanSummary(ops: CanvasAgentOp[]): CanvasAgentPlanSummary {
    const tasks = ops.filter((op) => op.type === "add_node" && op.nodeType === "task");
    const storyboardCount = tasks.filter((op) => op.type === "add_node" && /分镜/u.test(op.title || "")).length;
    return {
        taskCount: tasks.length,
        label: storyboardCount === tasks.length && storyboardCount > 0 ? `本轮计划：${storyboardCount} 个分镜` : `本轮计划：${tasks.length} 个创作任务`,
    };
}

type ChildTaskEventData = {
    taskId?: string;
    title?: string;
    type?: "text" | "image" | "video" | "audio";
    status?: CreativeAgentRun["tasks"][number]["status"];
    startedAt?: number;
    completedAt?: number;
    error?: string;
    completedCount?: number;
    failedCount?: number;
    totalCount?: number;
    outputNodeIds?: string[];
    ops?: CanvasAgentOp[];
};

function childProgressText(data?: ChildTaskEventData) {
    const completed = nonNegativeCount(data?.completedCount);
    const failed = nonNegativeCount(data?.failedCount);
    const total = Math.max(1, nonNegativeCount(data?.totalCount));
    return `「${data?.title || "创作任务"}」已完成 ${completed}/${total}${failed ? `，失败 ${failed}` : ""}`;
}

function nonNegativeCount(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function isTerminalRunStatus(status: unknown): status is Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled"> {
    return status === "completed" || status === "failed" || status === "cancelled";
}
