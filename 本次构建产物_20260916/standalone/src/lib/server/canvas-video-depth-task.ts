import { randomUUID } from "node:crypto";
import { extractCanvasVideoDepth, type DepthProgress } from "./canvas-video-depth-service";
import { createStoredGenerationTask, transitionStoredGenerationTask } from "./generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { authorizeCanvasVideoSource } from "./canvas-video-source-service";

type DepthTask = { id: string; userId: string; status: string; createdAt: number; updatedAt: number; progress?: DepthProgress; result?: Awaited<ReturnType<typeof extractCanvasVideoDepth>>; error?: string };

// Local media processing uses the existing render task category, not an upstream model worker.
export async function runCanvasVideoDepthTask(input: { ownerUserId: string; storageKey: string }, onProgress?: (progress: DepthProgress) => void) {
    const now = Date.now();
    const source = await authorizeCanvasVideoSource(input);
    const task = await createStoredGenerationTask(
        "render",
        {
            id: `video-depth-${randomUUID()}`,
            userId: input.ownerUserId,
            status: "running",
            createdAt: now,
            updatedAt: now,
            surface: "canvas",
            prompt: "深度提取",
            model: "Depth Anything V2 Small",
            storageKey: input.storageKey,
            projectId: source.registration.projectId,
        },
        GENERATION_TASK_RETENTION_MS,
    );
    const report = async (progress: DepthProgress) => {
        const detail = `${progress.stage}${progress.percent === undefined ? "" : ` ${progress.percent}%`}`;
        await transitionStoredGenerationTask<DepthTask>("render", task.id, task.userId, ["running"], { status: "running", progress }, GENERATION_TASK_RETENTION_MS, { executionPhase: "submitting", provider: "local-depth", lastUpstreamStatus: detail });
        console.info(`[video-depth] ${task.id} ${detail}`);
        onProgress?.(progress);
    };
    try {
        await report({ stage: "开始深度提取" });
        const result = await extractCanvasVideoDepth({ ...input, taskId: task.id, onProgress: report });
        await transitionStoredGenerationTask<DepthTask>("render", task.id, task.userId, ["running"], { status: "success", result }, GENERATION_TASK_RETENTION_MS, { executionPhase: "completed", lastUpstreamStatus: "完成 100%" });
        console.info(`[video-depth] ${task.id} 完成 100% 耗时 ${Date.now() - now}ms`);
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : "深度提取失败";
        console.error(`[video-depth] ${task.id} 失败: ${message}`);
        await transitionStoredGenerationTask<DepthTask>("render", task.id, task.userId, ["running"], { status: "error", error: message }, GENERATION_TASK_RETENTION_MS, { executionPhase: "completed", lastUpstreamStatus: "失败" });
        throw error;
    }
}
