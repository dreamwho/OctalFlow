import type { StoredGenerationLog } from "@/lib/server/generation-log-types";
import { getImageTask, transitionImageTask } from "@/lib/server/image-task-store";
import { getStoredGenerationTaskByRequest, getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { cancellationExecutionPatch, type GenerationCancellationTarget } from "@/lib/server/generation-task-cancellation-service";
import { getVideoTask, transitionVideoTask } from "@/lib/server/video-task-store";
import { getGenerationLogForUser } from "@/lib/server/generation-log-store";

export async function isActiveGenerationLogSlot(userId: string, logId: string, slotId: string, clientRequestId: string, kind: "image" | "video") {
    if (!userId || !logId || !slotId || !clientRequestId) return false;
    const log = await getGenerationLogForUser(userId, logId);
    if (!log || log.kind !== kind || log.source !== `${kind}-workbench`) return false;
    return Boolean(log.requestSnapshot?.slots.some((slot) => slot.id === slotId && slot.clientRequestId === clientRequestId && slot.status === "pending"));
}

export async function cancelGenerationTaskById(type: "image" | "video", userId: string, taskId: string) {
    if (type === "image") {
        const current = await getImageTask(taskId);
        if (!current || current.userId !== userId || !["pending", "running"].includes(current.status)) return false;
        const schedule = await getStoredGenerationTaskRecord("image", current.id);
        const target: GenerationCancellationTarget = {
            type: "image", taskId: current.id, userId,
            executionPhase: schedule?.executionPhase,
            upstreamTaskId: current.upstream?.id || current.runningHub?.localTaskId,
            queryPath: current.config.advancedConfig?.queryPath,
            config: current.config,
        };
        return Boolean(await transitionImageTask(current, ["pending", "running"], { status: "cancelled", error: "任务已取消", retryable: false }, cancellationExecutionPatch(target)));
    }
    const current = await getVideoTask(taskId);
    if (!current || current.userId !== userId || current.status !== "running") return false;
    const schedule = await getStoredGenerationTaskRecord("video", current.id);
    const target: GenerationCancellationTarget = {
        type: "video", taskId: current.id, userId,
        executionPhase: schedule?.executionPhase,
        upstreamTaskId: current.upstream.id,
        queryPath: current.config.advancedConfig?.queryPath,
        config: current.config,
    };
    return Boolean(await transitionVideoTask(current, { status: "cancelled", error: "任务已取消", retryable: false }, cancellationExecutionPatch(target)));
}

export async function cancelActiveGenerationLogSlots(userId: string, logs: StoredGenerationLog[], selectedSlots?: Map<string, Set<string>>) {
    const cancelled: Array<{ type: "image" | "video"; id: string }> = [];
    for (const log of logs) {
        const selected = selectedSlots?.get(log.id);
        for (const slot of log.requestSnapshot?.slots || []) {
            if (!slot.clientRequestId || (selected && !selected.has(slot.id)) || slot.status !== "pending") continue;
            if (log.kind === "image") {
                const task = await getStoredGenerationTaskByRequest<{ id: string }>("image", userId, slot.clientRequestId);
                if (!task) continue;
                const current = await getImageTask(task.id);
                if (!current || current.userId !== userId || !["pending", "running"].includes(current.status)) continue;
                if (await cancelGenerationTaskById("image", userId, current.id)) cancelled.push({ type: "image", id: current.id });
            } else {
                const task = await getStoredGenerationTaskByRequest<{ id: string }>("video", userId, slot.clientRequestId);
                if (!task) continue;
                const current = await getVideoTask(task.id);
                if (!current || current.userId !== userId || current.status !== "running") continue;
                if (await cancelGenerationTaskById("video", userId, current.id)) cancelled.push({ type: "video", id: current.id });
            }
        }
    }
    return cancelled;
}
