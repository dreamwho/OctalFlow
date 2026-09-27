import { createHash } from "node:crypto";
import { after, NextResponse } from "next/server";

import { normalizeCreativeRunRequest, CreativeRuntimeInputError } from "@/lib/creative-runtime-contract";
import { canvasExternalApiUser } from "@/lib/server/canvas-external-auth";
import { createCanvasProjectForUser, getCanvasProjectForUser, updateCanvasProjectForUser, canvasProjectError } from "@/lib/server/canvas-project-service";
import { createAgentRun, getAgentRun, getAgentRunByClientRequestId } from "@/lib/server/agent-run-store";
import { publicAgentRun } from "@/lib/server/agent-run-public";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { checkRateLimit } from "@/lib/server/security";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getAuthSettings } from "@/lib/auth/store";
import { effectiveGenerationConcurrencyLimit, withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { applyCanvasAgentOps, type CanvasAgentOp } from "@/app/(user)/canvas/utils/canvas-agent-ops";

export const maxDuration = 2400;

export async function POST(request: Request) {
    const userId = canvasExternalApiUser(request);
    if (!userId) return reply(401, null, "画布外部 API 未授权");
    try {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return reply(parsed.status, null, parsed.message);
        const body = parsed.data;
        if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, null, "请求正文必须是 JSON 对象");
        const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!clientRequestId || !prompt) return reply(400, null, "缺少 clientRequestId 或 prompt");
        const existing = await getAgentRunByClientRequestId(userId, clientRequestId);
        if (existing) {
            if (existing.prompt !== prompt || (typeof body.projectId === "string" && body.projectId.trim() !== existing.projectId)
                || !sameList(body.assetIds, existing.referencedAssetIds)
                || !sameList(body.skillIds, existing.selectedSkillIds || [])
                || !sameList(body.modelIds, existing.requestedModelIds || [])) return reply(409, null, "clientRequestId 已用于不同的画布请求");
            return reply(200, { run: publicAgentRun(existing), projectId: existing.projectId, projectUrl: `/canvas/${existing.projectId}`, created: false }, "任务已存在");
        }
        const rate = await checkRateLimit(`canvas-external:${userId}`, { maxRequests: 10, windowMs: 60_000 });
        if (!rate.allowed) return reply(429, null, "画布任务请求过于频繁");
        const settings = await getAuthSettings();
        const response = await withGenerationConcurrencyLimit(userId, "agent", 10 * 60_000, effectiveGenerationConcurrencyLimit("user", settings.generationConcurrency.agent), async () => {
            const requestedProjectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
            const project = requestedProjectId
                ? await getCanvasProjectForUser(userId, requestedProjectId)
                : await createCanvasProjectForUser(userId, {
                      title: typeof body.title === "string" ? body.title : "Agent 画布",
                      sourceHandoffId: `external-${createHash("sha256").update(`${userId}:${clientRequestId}`).digest("hex").slice(0, 32)}`,
                  });
            const selectedNodeIds = Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds.filter((id): id is string => typeof id === "string" && project.nodes.some((node) => node.id === id)) : [];
            const input = normalizeCreativeRunRequest({
                clientRequestId,
                surface: "canvas",
                projectId: project.id,
                conversationId: project.creativeConversationId,
                prompt,
                snapshot: { projectId: project.id, title: project.title, nodes: project.nodes, connections: project.connections, selectedNodeIds },
                assetIds: body.assetIds,
                skillIds: body.skillIds,
                modelIds: body.modelIds,
                preferences: body.preferences,
            });
            const created = await createAgentRun(userId, input);
            if (created.created) {
                const origin = resolveInternalOrigin(new URL(request.url).origin);
                after(() => runGenerationTaskRecoveryBatch({ origin, taskIds: [created.run.id], limit: 1 }));
            }
            return reply(202, { run: publicAgentRun(created.run), projectId: project.id, projectUrl: `/canvas/${project.id}`, created: created.created }, "画布任务已创建");
        });
        return response || reply(429, null, "当前 Agent 并发额度已满");
    } catch (error) {
        if (error instanceof SyntaxError) return reply(400, null, "JSON 请求格式无效");
        if (error instanceof CreativeRuntimeInputError) return reply(error.status, null, error.message);
        const known = canvasProjectError(error);
        if (known) return reply(known.status, null, known.message);
        throw error;
    }
}

export async function GET(request: Request) {
    const userId = canvasExternalApiUser(request);
    if (!userId) return reply(401, null, "画布外部 API 未授权");
    const params = new URL(request.url).searchParams;
    const runId = params.get("runId")?.trim();
    const projectId = params.get("projectId")?.trim();
    try {
        if (runId) {
            const run = await getAgentRun(runId);
            if (!run || run.userId !== userId || run.surface !== "canvas" || !run.projectId) return reply(404, null, "画布任务不存在");
            const project = await materializeCanvasRun(userId, run.projectId, run);
            if (run.status === "planning" || run.status === "running") {
                const origin = resolveInternalOrigin(new URL(request.url).origin);
                after(() => runGenerationTaskRecoveryBatch({ origin, taskIds: [run.id], limit: 1 }));
            }
            return reply(200, { run: publicAgentRun(run), projectId: project.id, projectUrl: `/canvas/${project.id}`, nodeCount: project.nodes.length, connectionCount: project.connections.length }, "OK");
        }
        if (projectId) {
            const project = await getCanvasProjectForUser(userId, projectId);
            return reply(200, { project }, "OK");
        }
        return reply(400, null, "请提供 runId 或 projectId");
    } catch (error) {
        const known = canvasProjectError(error);
        if (known) return reply(known.status, null, known.message);
        throw error;
    }
}

async function materializeCanvasRun(userId: string, projectId: string, run: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>) {
    const project = await getCanvasProjectForUser(userId, projectId);
    const ops = publicAgentRun(run).recoveryOps as CanvasAgentOp[];
    if (!ops?.length) return project;
    const projected = applyCanvasAgentOps({ ...project, projectId: project.id, imageSize: "", selectedNodeIds: [] }, ops);
    if (JSON.stringify(project.nodes) === JSON.stringify(projected.nodes) && JSON.stringify(project.connections) === JSON.stringify(projected.connections)) return project;
    await updateCanvasProjectForUser(userId, projectId, { expectedUpdatedAt: project.updatedAt, project: { ...project, nodes: projected.nodes, connections: projected.connections } });
    return getCanvasProjectForUser(userId, projectId);
}

function reply(status: number, data: unknown, msg: string) {
    return NextResponse.json({ code: status < 300 ? 0 : status, data, msg }, { status });
}

function sameList(candidate: unknown, stored: string[]) {
    const values = Array.isArray(candidate) ? candidate : [];
    return values.length === stored.length && values.every((value, index) => value === stored[index]);
}
