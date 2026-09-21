import { after, NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { findStoredGenerationTaskByUpstream, getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { transitionVideoTask } from "@/lib/server/video-task-store";
import { cancellationExecutionPatch, type GenerationCancellationTarget } from "@/lib/server/generation-task-cancellation-service";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { advanceDolaTaskLog, findDolaTaskLogIdByTaskId } from "@/lib/server/dola/log-store";
import { auditDolaAdminAction, auditDolaAdminFailure } from "@/lib/server/dola/admin";
import type { VideoTask } from "@/lib/server/video-task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 管理员按上游任务 ID 取消对应的 Dola 生成任务（用于长时间无结果的任务）。 */
export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (currentUser.role !== "admin") return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    const parsed = await readJsonBodyResult<{ taskId?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const taskId = typeof parsed.data.taskId === "string" ? parsed.data.taskId.trim().slice(0, 300) : "";
    if (!taskId) return NextResponse.json({ error: "缺少上游任务 ID" }, { status: 400 });

    try {
        const task = await findStoredGenerationTaskByUpstream<VideoTask>("video", taskId);
        if (!task) return NextResponse.json({ error: "未找到对应的站内生成任务（可能已结束或不是站内生成任务）" }, { status: 404 });

        // 已取消：幂等成功，并顺带纠正可能滞后的请求日志。
        if (task.status === "cancelled") {
            for (const source of ["runtime", "admin-test", "external"] as const) {
                const logId = await findDolaTaskLogIdByTaskId(taskId, source).catch(() => "");
                if (logId) {
                    await advanceDolaTaskLog(logId, { phase: "failed", message: "任务已被管理员取消", error: "admin_cancel", statusCode: 0 }).catch(() => undefined);
                    break;
                }
            }
            await auditDolaAdminAction(request, currentUser, "admin.dola.log.cancelTask", { type: "dola_task", id: taskId });
            return NextResponse.json({ videoTaskId: task.id, alreadyCancelled: true, message: "该任务已处于取消状态" });
        }
        if (task.status === "success") return NextResponse.json({ error: "该任务已生成完成，无需取消" }, { status: 409 });
        if (task.status === "error") return NextResponse.json({ error: "该任务已失败结束，无需取消" }, { status: 409 });
        if (task.status !== "running") return NextResponse.json({ error: `任务当前状态（${task.status}）不可取消` }, { status: 409 });

        const schedule = await getStoredGenerationTaskRecord("video", task.id);
        const executionPhase = schedule?.executionPhase || (task.status === "running" || task.status === "pending" ? "created" : "completed");
        const target: GenerationCancellationTarget = {
            type: "video",
            taskId: task.id,
            userId: task.userId,
            executionPhase,
            upstreamTaskId: task.upstream.id,
            queryPath: task.upstream.queryPath || task.config?.advancedConfig?.queryPath,
            config: task.config,
        };
        const next = await transitionVideoTask(task, { status: "cancelled", error: "任务已被管理员取消", retryable: false }, cancellationExecutionPatch(target));
        if (!next) return NextResponse.json({ error: "任务状态已变化，取消失败" }, { status: 409 });

        // 同步请求日志：终止状态 + 取消原因，后台列表即时可见。
        for (const source of ["runtime", "admin-test", "external"] as const) {
            const logId = await findDolaTaskLogIdByTaskId(taskId, source).catch(() => "");
            if (logId) {
                await advanceDolaTaskLog(logId, {
                    phase: "failed",
                    message: "任务已被管理员取消",
                    error: "admin_cancel",
                    detail: `管理员 ${currentUser.username || currentUser.id} 取消了该任务`,
                    statusCode: 0,
                }).catch(() => undefined);
                break;
            }
        }

        const origin = resolveInternalOrigin(new URL(request.url).origin);
        after(() => runGenerationTaskRecoveryBatch({ origin, limit: 1, taskIds: [task.id] }));

        await auditDolaAdminAction(request, currentUser, "admin.dola.log.cancelTask", { type: "dola_task", id: taskId, label: task.title || task.id });
        return NextResponse.json({ videoTaskId: task.id, status: next.status });
    } catch (error) {
        await auditDolaAdminFailure(request, currentUser, "admin.dola.log.cancelTask", { type: "dola_task", id: taskId });
        console.error("[dola] admin cancel task failed:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "取消任务失败" }, { status: 500 });
    }
}
