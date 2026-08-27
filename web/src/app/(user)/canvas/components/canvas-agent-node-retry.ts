import { retryCreativeAgentTaskWithState } from "@/services/api/creative";

import type { CanvasNodeData } from "../types";
import type { CanvasAgentOp } from "../utils/canvas-agent-ops";
import { watchCanvasAgentRun } from "./canvas-agent-run-client";

export async function retryCanvasAgentNode(node: CanvasNodeData, applyOps: (ops?: CanvasAgentOp[]) => unknown) {
    const runId = node.metadata?.agentRunId?.trim();
    const taskId = node.metadata?.agentTaskId?.trim();
    if (!runId || !taskId) return false;

    const retry = await retryCreativeAgentTaskWithState(runId, taskId);
    if (retry.ops?.length) applyOps(retry.ops as CanvasAgentOp[]);
    if (retry.run.tasks.find((task) => task.id === taskId)?.status === "completed") return true;
    let failure = "";
    await watchCanvasAgentRun(runId, {
        onPlan: (ops) => applyOps(ops),
        onAssistant: (text, detail) => {
            if (detail?.runId) failure = text;
        },
        onStage: () => undefined,
        onPaused: () => undefined,
        onOps: (ops) => applyOps(ops),
    });
    if (failure) throw new Error(failure);
    return true;
}
