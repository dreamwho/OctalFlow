import type { AgentRun, AgentRunTask } from "@/lib/server/agent-run-store";
import type { AgentPlan } from "@/lib/server/agent-run-validation";

import { agentCanvasOutputNodeIds, agentCanvasTaskNodeId } from "./agent-run-canvas-node-ids";
import { agentTaskResultItems } from "./agent-run-result-items";
import { canvasSnapshotNodes } from "./agent-run-task-input";

const START_Y = 96;
// Keep this aligned with canvas-surface.tsx's world-space dot grid (22px).
const CANVAS_GRID_STEP = 22;
const COLUMN_GAP = CANVAS_GRID_STEP * 3;
const ROW_GAP = 480;
const DEFAULT_SOURCE_COLUMN_WIDTH = 340;

export function layoutCanvasAgentTasks(tasks: AgentRunTask[], snapshot: unknown): AgentRunTask[] {
    const nodes = canvasSnapshotNodes(snapshot);
    const referencedNodeIds = new Set(tasks.flatMap((task) => [task.targetNodeId, ...(task.references || []).map((reference) => reference.nodeId)]).filter((id): id is string => Boolean(id)));
    const nodeValues = Array.from(nodes.values());
    const referencedNodes = Array.from(referencedNodeIds).map((id) => nodes.get(id)).filter((node): node is NonNullable<typeof node> => Boolean(node));
    const baseX = referencedNodes.length
        ? Math.max(...referencedNodes.map((node) => (node.position?.x || 0) + (node.displayWidth || node.width || DEFAULT_SOURCE_COLUMN_WIDTH) + COLUMN_GAP))
        : Math.max(400, ...nodeValues.map((node) => (node.position?.x || 0) + (node.displayWidth || node.width || DEFAULT_SOURCE_COLUMN_WIDTH) + COLUMN_GAP));
    const referenceYs = referencedNodes.map((node) => node.position?.y).filter((value): value is number => Number.isFinite(value));
    const baseY = referenceYs.length ? Math.min(...referenceYs) : START_Y;
    if (usesPortraitStoryboardFlow(tasks)) return layoutPortraitStoryboardTasks(tasks, baseX, baseY);
    const sourceTasksForWidth = tasks.filter((task) => task.type !== "video" && task.type !== "audio");
    const sourceColumnWidth = sourceTasksForWidth.length ? Math.max(...sourceTasksForWidth.map(canvasTaskWidth)) : DEFAULT_SOURCE_COLUMN_WIDTH;
    const sourceRows = new Map<string, number>();
    let nextSourceRow = 0;
    const sourceTasks = tasks.map((task) => {
        const lane = task.type === "video" || task.type === "audio" ? "media" : "source";
        if (lane === "media") return task;
        const row = nextSourceRow;
        nextSourceRow += Math.max(1, task.count || 1);
        sourceRows.set(task.id, row);
        return { ...task, canvasLayout: { baseX, baseY, lane: "source" as const, row, sourceColumnWidth } };
    });
    let nextMediaRow = 0;
    return sourceTasks.map((task) => {
        if (task.canvasLayout) return task;
        const dependencyRows = task.dependencies.map((id) => sourceRows.get(id)).filter((row): row is number => Number.isFinite(row));
        const row = dependencyRows.length ? Math.min(...dependencyRows) : nextMediaRow;
        nextMediaRow = Math.max(nextMediaRow, row + Math.max(1, task.count || 1));
        return { ...task, canvasLayout: { baseX, baseY, lane: "media", row, sourceColumnWidth } };
    });
}

/**
 * Portrait storyboard cards are tall enough that the regular vertical lane
 * consumes the whole canvas.  When every visible media output is portrait,
 * keep each node type on one compact row and place the next type under it.
 * Other mixed/landscape plans retain the existing dependency-column layout.
 */
function usesPortraitStoryboardFlow(tasks: AgentRunTask[]) {
    const visible = tasks.filter((task) => task.type === "image" || task.type === "video");
    return visible.length > 1 && visible.some((task) => task.type === "image") && visible.every((task) => canvasTaskRatio(task) > 0 && canvasTaskRatio(task) < 1);
}

function layoutPortraitStoryboardTasks(tasks: AgentRunTask[], baseX: number, baseY: number) {
    const grouped = new Map<AgentRunTask["type"], Array<{ task: AgentRunTask; index: number }>>();
    tasks.forEach((task, index) => {
        if (task.type !== "image" && task.type !== "video") return;
        const group = grouped.get(task.type) || [];
        group.push({ task, index });
        grouped.set(task.type, group);
    });
    const outputPositions = new Map<number, Array<{ x: number; y: number }>>();
    let y = baseY;
    grouped.forEach((group) => {
        let x = baseX;
        let rowHeight = 0;
        group.forEach(({ task, index }) => {
            const size = canvasTaskSize(task);
            const positions = Array.from({ length: Math.max(1, task.count || 1) }, () => {
                const position = { x, y };
                x += size.width + COLUMN_GAP;
                rowHeight = Math.max(rowHeight, size.height);
                return position;
            });
            outputPositions.set(index, positions);
        });
        y += rowHeight + COLUMN_GAP;
    });
    return tasks.map((task, index) => {
        const positions = outputPositions.get(index);
        if (!positions) return task;
        return {
            ...task,
            canvasLayout: {
                baseX,
                baseY,
                lane: task.type === "video" || task.type === "audio" ? ("media" as const) : ("source" as const),
                row: 0,
                outputPositions: positions,
            },
        };
    });
}

export function planToOps(plan: AgentPlan, tasks: AgentRunTask[], runId: string, snapshot: unknown) {
    const snapshotNodeMap = canvasSnapshotNodes(snapshot);
    if (tasks.length === 1 && tasks[0]?.type === "text" && tasks[0].targetNodeId && snapshotNodeMap.get(tasks[0].targetNodeId)?.type === "text") return [];
    // The brief and visual direction remain in the persisted run.  They are not
    // canvas nodes: invisible synthetic nodes used to pull visible task graphs
    // above the selected reference and made the graph look disconnected.
    const ops: Array<Record<string, unknown>> = [];
    const taskNodeIds = new Map(tasks.map((task, index) => [task.id, agentCanvasTaskNodeId(runId, index)]));
    const taskOutputIds = new Map(tasks.map((task, index) => [task.id, task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task)]));
    const existingNodeIds = new Set(snapshotNodeMap.keys());

    tasks.forEach((task, index) => {
        const taskNodeId = agentCanvasTaskNodeId(runId, index);
        const targetNodeId = task.targetNodeId && existingNodeIds.has(task.targetNodeId) ? task.targetNodeId : undefined;
        const outputNodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task);
        if (task.type === "text") {
            ops.push({
                type: "add_node",
                id: taskNodeId,
                nodeType: "task",
                title: task.title,
                position: taskPosition(task, index),
                metadata: {
                    agentRunId: runId,
                    agentTaskId: task.id,
                    targetNodeId,
                    model: task.model,
                    prompt: task.prompt,
                    agentTaskType: task.type,
                    agentTaskStatus: "ready",
                    agentTaskAttempts: 0,
                    agentTaskDependencies: task.dependencies,
                    agentTaskStageDependencies: task.stageDependencies || [],
                    agentTaskOutputNodeIds: outputNodeIds,
                },
            });
            if (targetNodeId) ops.push({ type: "connect_nodes", fromNodeId: targetNodeId, toNodeId: taskNodeId });
        }
        const visibleInputs = new Set<string>([
            ...(targetNodeId ? [targetNodeId] : []),
            ...(task.references || []).map((reference) => reference.nodeId).filter((id): id is string => Boolean(id && existingNodeIds.has(id))),
            ...task.dependencies.flatMap((dependency) => {
                const outputNodeId = taskOutputIds.get(dependency)?.[0];
                const taskNodeId = taskNodeIds.get(dependency);
                return outputNodeId ? [outputNodeId] : taskNodeId ? [taskNodeId] : [];
            }),
        ]);
        outputNodeIds.forEach((outputNodeId, copyIndex) => {
            ops.push(
                {
                    type: "add_node",
                    id: outputNodeId,
                    nodeType: task.type,
                    title: outputNodeIds.length > 1 ? `${task.title} ${copyIndex + 1}` : task.title,
                    position: taskOutputPosition(task, index, copyIndex),
                    metadata: outputMetadata(runId, task, "loading"),
                },
                ...Array.from(visibleInputs).map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: outputNodeId })),
            );
        });
    });
    return ops;
}

/**
 * Rebuild the public Canvas projection from persisted Run state.  The returned
 * operations deliberately reuse stable node ids, so applying them after an SSE
 * gap or process restart is safe: add_node upserts and final update_node ops
 * replace stale loading metadata without creating another provider request.
 */
export function agentRunRecoveryOps(run: Pick<AgentRun, "id" | "surface" | "snapshot" | "tasks">) {
    if (run.surface !== "canvas") return [];
    const ops: Array<Record<string, unknown>> = [...planToOps({} as AgentPlan, run.tasks, run.id, run.snapshot)];
    run.tasks.forEach((task, index) => {
        const active = taskCanvasEventOps(run.id, index, task, task.status === "failed" ? "task.failed" : "task.running");
        if (task.status === "cancelled") {
            const nodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(run.id, index, task);
            if (task.type === "text") ops.push({ type: "update_node", id: agentCanvasTaskNodeId(run.id, index), metadata: { agentTaskStatus: "cancelled", agentTaskError: "任务已取消" } });
            else nodeIds.forEach((id) => ops.push({ type: "update_node", id, metadata: { status: "cancelled", agentTaskStatus: "cancelled", errorDetails: "任务已取消" } }));
            return;
        }
        if (active?.ops?.length) ops.push(...active.ops);
        if (task.status !== "failed") {
            for (const child of task.childTasks || []) {
                if (child.status === "completed" || child.status === "failed" || child.status === "cancelled") {
                    const childOps = taskCanvasEventOps(run.id, index, task, `task.child.${child.status}`, child.id);
                    if (childOps?.ops?.length) ops.push(...childOps.ops);
                }
            }
        }
        if (task.status === "completed") {
            const resultOps = taskResultOps(run.id, index, task);
            if (resultOps.ops.length) ops.push(...resultOps.ops);
        }
    });
    return ops;
}

export function taskCanvasEventOps(runId: string, index: number, task: AgentRunTask, eventType: string, childTaskId?: string) {
    if (eventType === "task.completed") return taskResultOps(runId, index, task);
    if (eventType === "task.child.completed" || eventType === "task.child.failed" || eventType === "task.child.cancelled") return taskChildResultOps(runId, index, task, eventType, childTaskId);
    if (!new Set(["task.running", "task.created", "task.failed"]).has(eventType)) return null;
    const nodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task);
    const failed = eventType === "task.failed";
    const taskIds = task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : undefined;
    const partialFailure = failed && task.type !== "text" && task.childTasks?.some((child) => child.status === "completed") ? failedTaskOutputOps(runId, index, task) : null;
    const ops: Array<Record<string, unknown>> = [
        ...(task.type === "text"
            ? [{
            type: "update_node",
            id: agentCanvasTaskNodeId(runId, index),
            metadata: {
                agentTaskStatus: failed ? "failed" : "running",
                agentTaskAttempts: task.attempts,
                agentTaskError: failed ? task.error : "",
                agentTaskSubmittedParameters: task.submittedParameters,
                agentTaskOutputNodeIds: nodeIds,
                agentGenerationTaskIds: taskIds || [],
            },
        }]
            : []),
        ...(partialFailure?.ops ||
            nodeIds.map((id) => ({
                type: "update_node",
                id,
                metadata: {
                    ...outputMetadata(runId, task, failed ? "error" : "loading"),
                    errorDetails: failed ? task.error || "生成任务失败" : undefined,
                    agentTaskSubmittedParameters: task.submittedParameters,
                    agentGenerationTaskIds: taskIds || [],
                },
            }))),
    ];
    return { nodeIds: partialFailure?.nodeIds || nodeIds, ops };
}

function taskChildResultOps(runId: string, index: number, task: AgentRunTask, eventType: string, childTaskId?: string) {
    if (task.type === "text") return null;
    const childIndex = task.childTasks?.findIndex((child) => child.id === childTaskId) ?? -1;
    const outputNodeId = childIndex >= 0 ? agentCanvasOutputNodeIds(runId, index, task)[childIndex] : undefined;
    if (!outputNodeId) return null;
    const child = task.childTasks?.[childIndex];
    const failed = eventType === "task.child.failed";
    const cancelled = eventType === "task.child.cancelled";
    return {
        nodeIds: [outputNodeId],
        ops: [
            {
                type: "update_node",
                id: outputNodeId,
                metadata: cancelled
                    ? { ...outputMetadata(runId, task, "error"), status: "cancelled", agentTaskStatus: "cancelled", errorDetails: child?.error || "任务已取消", agentTaskSubmittedParameters: task.submittedParameters, agentGenerationTaskIds: child?.id ? [child.id] : [] }
                    : failed
                    ? { ...outputMetadata(runId, task, "error"), errorDetails: child?.error || "生成任务失败", agentTaskSubmittedParameters: task.submittedParameters, agentGenerationTaskIds: child?.id ? [child.id] : [] }
                    : { ...completedMediaMetadata(task, agentTaskResultItems(child?.result)[0] || {}), agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: child?.id ? [child.id] : [] },
            },
        ],
    };
}

export function cancelledRunCanvasOps(runId: string, tasks: AgentRunTask[]) {
    return tasks.flatMap((task, index) => {
        if (task.status !== "cancelled") return [];
        const outputNodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task);
        return [
            ...(task.type === "text"
                ? [{
                type: "update_node",
                id: agentCanvasTaskNodeId(runId, index),
                metadata: { agentTaskStatus: "cancelled", agentTaskError: "任务已取消" },
            }]
                : []),
            ...outputNodeIds.map((id) => ({
                type: "update_node",
                id,
                metadata: { status: "cancelled", agentTaskStatus: "cancelled", errorDetails: "任务已取消" },
            })),
        ];
    });
}

export function taskResultOps(runId: string, index: number, task: AgentRunTask) {
    const taskNodeId = agentCanvasTaskNodeId(runId, index);
    const results = agentTaskResultItems(task.result);
    if (task.type === "text" && task.targetNodeId) {
        const content = String(results[0]?.content || "").trim();
        const nodeIds = [task.targetNodeId];
        return {
            nodeIds,
            ops: [
                { type: "update_node", id: task.targetNodeId, metadata: { content, prompt: content, status: "success", agentRunId: runId } },
                { type: "select_nodes", ids: nodeIds },
            ],
        };
    }

    const plannedNodeIds = agentCanvasOutputNodeIds(runId, index, task);
    const nodeIds = results.map((_, resultIndex) => `output-${runId}-${index}-${resultIndex}`);
    const ops: Array<Record<string, unknown>> = results.flatMap((record, resultIndex) => {
        const outputNodeId = nodeIds[resultIndex];
        const metadata = task.type === "text" ? { content: String(record.content || ""), status: "success" } : completedMediaMetadata(task, record);
        const nodeOp =
            task.type === "text"
                ? {
                      type: "add_node",
                      id: outputNodeId,
                      nodeType: task.type,
                      title: results.length > 1 ? `${task.title} ${resultIndex + 1}` : task.title,
                      position: taskOutputPosition(task, index, resultIndex),
                      metadata: { ...metadata, agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type },
                  }
                : plannedNodeIds.includes(outputNodeId)
                  ? {
                        type: "update_node",
                        id: outputNodeId,
                        patch: { title: results.length > 1 ? `${task.title} ${resultIndex + 1}` : task.title },
                        metadata: { ...metadata, agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : [] },
                    }
                  : {
                        type: "add_node",
                        id: outputNodeId,
                        nodeType: task.type,
                        title: `${task.title} ${resultIndex + 1}`,
                        position: taskOutputPosition(task, index, resultIndex),
                        metadata: { ...metadata, agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : [] },
                    };
        return [nodeOp];
    });
    if (task.type === "text") ops.push({ type: "update_node", id: taskNodeId, metadata: { agentTaskStatus: "completed", agentTaskOutputNodeIds: nodeIds, agentTaskAttempts: task.attempts, agentTaskError: "" } });
    if (task.type === "text" && nodeIds.length) ops.push({ type: "select_nodes", ids: nodeIds });
    return { nodeIds, ops };
}

function outputMetadata(runId: string, task: AgentRunTask, status: "loading" | "error") {
    return {
        agentRunId: runId,
        agentTaskId: task.id,
        agentTaskType: task.type,
        model: task.model,
        prompt: task.prompt,
        size: task.ratio,
        quality: task.quality,
        count: task.count,
        seconds: task.seconds ? String(task.seconds) : undefined,
        audioVoice: task.voice,
        audioFormat: task.format,
        status,
        errorDetails: "",
        agentTaskSubmittedParameters: task.submittedParameters,
    };
}

function completedMediaMetadata(task: AgentRunTask, record: Record<string, unknown>) {
    const content = [record.serverUrl, record.dataUrl, record.remoteUrl, record.url].find((item) => typeof item === "string" && item.trim());
    return {
        content: typeof content === "string" ? content : "",
        storageKey: text(record.storageKey),
        remoteUrl: text(record.remoteUrl) || (typeof record.url === "string" && /^https?:\/\//i.test(record.url) ? record.url : undefined),
        serverUrl: text(record.serverUrl) || (typeof record.url === "string" && !/^https?:\/\//i.test(record.url) ? record.url : undefined),
        mimeType: text(record.mimeType),
        naturalWidth: positiveNumber(record.width),
        naturalHeight: positiveNumber(record.height),
        bytes: positiveNumber(record.bytes),
        durationMs: positiveNumber(record.durationMs),
        size: task.ratio,
        status: "success",
        errorDetails: "",
    };
}

function positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() || undefined : undefined;
}

function failedTaskOutputOps(runId: string, index: number, task: AgentRunTask) {
    const plannedCount = agentCanvasOutputNodeIds(runId, index, task).length;
    const entries: Array<{ status: "completed"; result: Record<string, unknown>; taskId: string } | { status: "failed"; error: string; taskId: string }> = [];
    for (const child of task.childTasks || []) {
        if (child.status === "completed") entries.push(...agentTaskResultItems(child.result).map((result) => ({ status: "completed" as const, result, taskId: child.id })));
        else entries.push({ status: "failed", error: child.error || task.error || "生成任务失败", taskId: child.id });
    }
    const missingChildren = Math.max(0, plannedCount - (task.childTasks?.length || 0));
    entries.push(...Array.from({ length: missingChildren }, () => ({ status: "failed" as const, error: task.error || "生成任务失败", taskId: "" })));
    const nodeIds = entries.map((_, resultIndex) => `output-${runId}-${index}-${resultIndex}`);
    const ops = entries.map((entry, resultIndex) => {
        const id = nodeIds[resultIndex];
        const metadata =
            entry.status === "completed"
                ? { ...completedMediaMetadata(task, entry.result), agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: entry.taskId ? [entry.taskId] : [] }
                : { ...outputMetadata(runId, task, "error"), errorDetails: entry.error, agentTaskSubmittedParameters: task.submittedParameters, agentGenerationTaskIds: entry.taskId ? [entry.taskId] : [] };
        if (resultIndex < plannedCount) return { type: "update_node", id, patch: { title: entries.length > 1 ? `${task.title} ${resultIndex + 1}` : task.title }, metadata };
        return { type: "add_node", id, nodeType: task.type, title: `${task.title} ${resultIndex + 1}`, position: taskOutputPosition(task, index, resultIndex), metadata };
    });
    return { nodeIds, ops };
}

function taskPosition(task: AgentRunTask, index: number) {
    const layout = task.canvasLayout;
    const baseX = layout?.baseX ?? 400;
    const baseY = layout?.baseY ?? START_Y;
    const lane = layout?.lane ?? (task.type === "video" || task.type === "audio" ? "media" : "source");
    const row = layout?.row ?? index;
    return { x: baseX + (lane === "media" ? (layout?.sourceColumnWidth || DEFAULT_SOURCE_COLUMN_WIDTH) + COLUMN_GAP : 0), y: baseY + row * ROW_GAP };
}

function taskOutputPosition(task: AgentRunTask, index: number, resultIndex: number) {
    const explicit = task.canvasLayout?.outputPositions?.[resultIndex];
    if (explicit) return explicit;
    const position = taskPosition(task, index);
    return { x: position.x, y: position.y + resultIndex * ROW_GAP };
}

function canvasTaskWidth(task: Pick<AgentRunTask, "type" | "ratio">) {
    return canvasTaskSize(task).width;
}

function canvasTaskSize(task: Pick<AgentRunTask, "type" | "ratio">) {
    if (task.type === "audio") return { width: DEFAULT_SOURCE_COLUMN_WIDTH, height: 120 };
    const maxWidth = task.type === "video" ? 420 : DEFAULT_SOURCE_COLUMN_WIDTH;
    const maxHeight = task.type === "video" ? 236 : 240;
    const ratio = canvasTaskRatio(task);
    if (!ratio) return { width: maxWidth, height: maxHeight };
    if (ratio >= 1) {
        const width = Math.min(maxWidth, maxHeight * ratio);
        return { width, height: width / ratio };
    }
    const height = Math.min(maxHeight, maxWidth / ratio);
    return { width: height * ratio, height };
}

function canvasTaskRatio(task: Pick<AgentRunTask, "ratio">) {
    const match = task.ratio?.match(/^(\d+)(?:x|:)(\d+)$/);
    if (!match) return 0;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 0;
}
