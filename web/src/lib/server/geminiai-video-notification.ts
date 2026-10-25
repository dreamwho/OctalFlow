import { createHash, timingSafeEqual } from "node:crypto";

import { wakeGeminiAiVideoTask } from "./generation-task-scheduler";
import { runGenerationTaskRecoveryBatch } from "./generation-task-recovery-service";

export function authorizedGeminiAiVideoNotification(request: Request) {
    const key = process.env.DREAMYO_GEMINIAI_API_KEY?.trim();
    const authorization = request.headers.get("authorization") || "";
    const supplied = /^Bearer\s+(.+)$/i.exec(authorization)?.[1].trim();
    return Boolean(key && supplied && timingSafeEqual(createHash("sha256").update(key).digest(), createHash("sha256").update(supplied).digest()));
}

export async function recoverNotifiedGeminiAiVideo(upstreamTaskId: string, origin: string) {
    const tasks = await wakeGeminiAiVideoTask(upstreamTaskId);
    for (const task of tasks) {
        const input = { origin, taskIds: [task.id], limit: 1 };
        const queried = await runGenerationTaskRecoveryBatch(input);
        // Query and persistence are separate durable phases, not resubmission.
        if (queried.resultReady) await runGenerationTaskRecoveryBatch(input);
    }
    return tasks.length;
}
