import { getAuthSettings } from "@/lib/auth/store";
import { nanoid } from "nanoid";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { getAgentRun, updateAgentRunById, type AgentRun, type AgentRunFailurePhase } from "@/lib/server/agent-run-store";
import { agentPlannerSystemPrompt, agentPlanReply, buildAgentPlannerInput, conversationFallbackReply, plannerAgentSkills, prioritizeAgentPlannerModels, selectAgentSkills, taskPlanSummary } from "@/lib/server/agent-run-surface-policy";
import { getCreativeAssetsByIds, getCreativeConversationContext, listRecentCreativeMediaAssets } from "@/lib/server/creative-runtime-store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { parseAgentPlanCall, type AgentFunctionCallResult } from "./agent-function-call";
import { agentModelOptions, agentPlanFallbackExample, agentPlanTool, canContinue, directAgentPlan, executeTasks, normalizeTasks, planToOps, refundFunctionCall, requestFunctionCall } from "./agent-run-execution";
import { layoutCanvasAgentTasks } from "./agent-run-canvas-ops";
import { isExplicitProjectHandoffRequest, normalizeAgentProjectHandoff } from "./agent-run-project-handoff";
import { normalizeCanvasPlanForSelection, selectedCanvasReferenceNodes } from "./agent-run-task-input";
import { GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";
import { filterAgentPlannerModels } from "@/lib/server/agent-run-planning-profile";
import { buildAgentRunPlannerAudit } from "@/lib/server/agent-run-audit";
import { orderCreativeAssetsByIds } from "@/lib/creative-asset-references";
import { finalizeVideoRemakeTasks, normalizeVideoRemakePlan } from "@/lib/server/video-remake-orchestration";
import { canvasVideoRemakeSourceAsset, enrichVideoRemakeSourceAssets, videoRemakeStoryboardFrames } from "@/lib/server/video-remake-source-analysis";
import { inlineAgentReferenceImage } from "@/lib/server/agent-run-reference-image";
import type { AgentPlan } from "@/lib/server/agent-run-validation";

const globalAgentExecutors = globalThis as typeof globalThis & { __octalaicanvasProAgentRunControllers?: Map<string, AbortController> };
const controllers = (globalAgentExecutors.__octalaicanvasProAgentRunControllers ??= new Map<string, AbortController>());

export function abortAgentRun(id: string) {
    controllers.get(id)?.abort();
}

export async function executeAgentRun(run: AgentRun, origin: string, cookie: string) {
    abortAgentRun(run.id);
    const controller = new AbortController();
    const executionId = nanoid();
    let failurePhase: AgentRunFailurePhase = "planning";
    let acceptedPlan: { userId: string; model: string; channelId: string; upstreamModel: string; call: AgentFunctionCallResult } | undefined;
    let planningPersisted = false;
    const refundAcceptedPlan = async () => {
        if (!acceptedPlan || planningPersisted) return;
        await refundFunctionCall(acceptedPlan.userId, acceptedPlan.model, acceptedPlan.call);
        acceptedPlan = undefined;
    };
    controllers.set(run.id, controller);
    try {
        const claimed = await updateAgentRunById(
            run.id,
            { status: "running", executionId, timings: { ...(run.timings || { requestAcceptedAt: run.createdAt }), ...(run.tasks.length ? {} : { planningStartedAt: Date.now() }) } },
            { type: run.tasks.length ? "run.resumed" : "run.planning" },
            ["planning", "running"],
        );
        if (!claimed) return;
        if (claimed.tasks.length) {
            const settings = await getAuthSettings();
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        const directModelSelection = Boolean(claimed.requestedModelIds?.length);
        const usesMemoryCandidates = !directModelSelection && claimed.surface === "chat" && claimed.referencedAssetIds.length === 0;
        const needsPlannerContext = !directModelSelection || Boolean(claimed.selectedSkillIds?.length);
        const [settings, loadedExplicitAssets, conversationContext, memoryAssets] = await Promise.all([
            getAuthSettings(),
            getCreativeAssetsByIds(claimed.referencedAssetIds, claimed.userId),
            needsPlannerContext ? getCreativeConversationContext(claimed.conversationId, claimed.userId, claimed.id) : Promise.resolve(undefined),
            usesMemoryCandidates ? listRecentCreativeMediaAssets(claimed.conversationId, claimed.userId, 6) : Promise.resolve([]),
        ]);
        let explicitAssets = orderCreativeAssetsByIds(loadedExplicitAssets, claimed.referencedAssetIds);
        const allModels = agentModelOptions(settings);
        const plannerModelOptions = filterAgentPlannerModels(allModels, claimed);
        const directModelOptions = claimed.generationPreferences?.mode ? plannerModelOptions : allModels;
        const selectedModels = (claimed.requestedModelIds || []).map((id) => directModelOptions.find((item) => item.id === id && item.capability !== "text")).filter((item): item is ReturnType<typeof agentModelOptions>[number] => Boolean(item));
        if (directModelSelection && selectedModels.length !== claimed.requestedModelIds?.length) throw new Error("部分所选模型当前不可用，请重新选择");
        const availableModels = prioritizeAgentPlannerModels(directModelSelection ? selectedModels : plannerModelOptions, claimed, settings);
        const skillOptions = plannerAgentSkills(settings, claimed);
        const skills = selectAgentSkills(settings, claimed.surface, claimed.selectedSkillIds);
        const canvasSource = claimed.surface === "canvas" ? canvasVideoRemakeSourceAsset(claimed.snapshot, claimed.userId, claimed.conversationId) : undefined;
        if (canvasSource && !explicitAssets.some((asset) => asset.type === "video")) explicitAssets = [canvasSource, ...explicitAssets];
        explicitAssets = await enrichVideoRemakeSourceAssets(explicitAssets, skills, origin, cookie, controller.signal);
        if (!(await canContinue(run.id, executionId))) return;
        if (directModelSelection && !skills.length) {
            const plan = normalizeVideoRemakePlan(directAgentPlan(selectedModels, claimed.prompt, claimed.referencedAssetIds), skills, explicitAssets, claimed.prompt);
            const normalizedTasks = finalizeVideoRemakeTasks(normalizeTasks(plan, skills, settings, claimed.snapshot, claimed.prompt, claimed.surface, explicitAssets, claimed.requestedImageSize, claimed.generationPreferences), skills);
            const tasks = claimed.surface === "canvas" ? layoutCanvasAgentTasks(normalizedTasks, claimed.snapshot) : normalizedTasks;
            await updateAgentRunById(run.id, {}, { type: "skills.selected", data: { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) } }, ["running"], executionId);
            const event = claimed.surface === "canvas" ? { type: "canvas.ops", data: { ops: planToOps(plan, tasks, run.id, claimed.snapshot), reply: plan.reply } } : { type: "run.planned", data: { reply: plan.reply, tasks: tasks.map(taskPlanSummary) } };
            await updateAgentRunById(
                run.id,
                { tasks, foundation: plan.foundation, reviewed: false, plannerAudit: buildAgentRunPlannerAudit({ mode: "direct", skills }), timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() } },
                event,
                ["running"],
                executionId,
            );
            failurePhase = "execution";
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        const referencedAssets = usesMemoryCandidates ? memoryAssets : explicitAssets;
        const referenceSource = claimed.referencedAssetIds.length ? "current-turn-explicit" : usesMemoryCandidates && referencedAssets.length ? "conversation-memory-candidates" : "none";
        const model = settings.defaultModels.textModel;
        const candidates = resolveLogicalModelCandidates(settings, "text", model);
        if (!model || !candidates.length) throw new Error("后台尚未配置可用的默认文本模型");
        const fallbackExample = agentPlanFallbackExample(availableModels);
        const plannerContext = buildAgentPlannerInput(claimed, conversationContext!, referencedAssets, referenceSource, skillOptions, availableModels, settings);
        if (!(await updateAgentRunById(run.id, { plannerContext: plannerContext.summary }, { type: "skills.selected", data: { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) } }, ["running"], executionId))) return;
        const planningSystemPrompt = agentPlannerSystemPrompt(claimed.surface, fallbackExample, { hasSelectedSkills: skills.length > 0 });
        const planningPayload = JSON.stringify(plannerContext.input);
        const storyboardFrames = videoRemakeStoryboardFrames(referencedAssets);
        const currentImageUrls = Array.from(
            new Set(
                [
                    ...(claimed.surface === "canvas"
                        ? selectedCanvasReferenceNodes(claimed.snapshot)
                              .filter((reference) => reference.type === "image")
                              .map((reference) => reference.url)
                        : []),
                ].filter((url): url is string => Boolean(url)),
            ),
        );
        const referenceImages = await Promise.all(currentImageUrls.map((url) => inlineAgentReferenceImage(url, origin, cookie, controller.signal)));
        const visualFrames = [...referenceImages, ...storyboardFrames];
        const visualInstruction = referenceImages.length
            ? `${planningPayload}\n\n以下图片是用户本轮明确选中的真实参考图。必须先观察图片像素，再规划回答或任务；不得声称没有附件，不得改用示例图片，也不得凭空替换主体、服装或场景。${storyboardFrames.length ? "后续图片按时间顺序截取自参考视频，请同时分析镜头、动作、场景与转场。" : ""}`
            : `${planningPayload}\n\n以下图片按时间顺序截取自用户本轮选中的参考视频。请结合它们分析镜头景别、构图、人物动作、场景变化、屏幕方向、光影与转场结构；不得声称没有附件，也不得改用示例素材。`;
        let plan: Awaited<ReturnType<typeof parseAgentPlanCall>> | undefined;
        let latestPlanningError: unknown;
        for (const candidate of rankTextPlanningCandidates(candidates.map((candidate) => ({ ...candidate, channelId: candidate.channel.id })))) {
            try {
                if (visualFrames.length && !candidate.capabilityProfile?.supportsReferenceImage) {
                    latestPlanningError = new Error("默认文本模型没有可用的视觉理解渠道");
                    continue;
                }
                const planningInput = [
                    { role: "system", content: planningSystemPrompt },
                    {
                        role: "user",
                        content: visualFrames.length ? [{ type: "text" as const, text: visualInstruction }, ...visualFrames.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : planningPayload,
                    },
                ];
                const planCall = await requestFunctionCall(
                    origin,
                    cookie,
                    candidate,
                    planningInput,
                    agentPlanTool,
                    "create_agent_plan",
                    controller.signal,
                    run.userId,
                    model,
                    false,
                    systemAiIdempotencyKey("agent-plan", run.userId, run.id, candidate.channel.id, candidate.upstreamModel),
                );
                plan = await parseAgentPlanCall(planCall, () => refundFunctionCall(claimed.userId, model, planCall), undefined, {
                    allowProjectHandoff: claimed.surface === "chat" && isExplicitProjectHandoffRequest(claimed.prompt),
                    requiredGenerationMode: claimed.generationPreferences?.mode,
                });
                if (plan) acceptedPlan = { userId: claimed.userId, model, channelId: candidate.channel.id, upstreamModel: candidate.upstreamModel, call: planCall };
                break;
            } catch (error) {
                if (controller.signal.aborted) throw error;
                if (error instanceof GenerationSubmissionUncertainError) throw error;
                latestPlanningError = error;
            }
        }
        if (!plan) throw latestPlanningError instanceof Error ? latestPlanningError : new Error("没有可用的文本模型渠道");
        if (directModelSelection) plan = applyRequestedMediaModels(plan, selectedModels, claimed.prompt, claimed.referencedAssetIds);
        if (claimed.surface === "canvas") plan = normalizeCanvasPlanForSelection(plan, claimed.snapshot, claimed.prompt);
        const plannerAudit = buildAgentRunPlannerAudit({
            mode: "model",
            logicalModelId: model,
            channelId: acceptedPlan?.channelId,
            upstreamModel: acceptedPlan?.upstreamModel,
            protocol: acceptedPlan?.call.protocol,
            elapsedMs: acceptedPlan?.call.elapsedMs,
            pointsCost: acceptedPlan?.call.pointsCost,
            pointsRecordId: acceptedPlan?.call.pointsRecordId,
            skills,
        });
        if (!(await canContinue(run.id, executionId))) {
            await refundAcceptedPlan();
            return;
        }
        if (plan.intent === "conversation") {
            const completed = await updateAgentRunById(
                run.id,
                {
                    status: "completed",
                    tasks: [],
                    reviewed: true,
                    plannerAudit,
                    executionId: undefined,
                    timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now(), allResultsReadyAt: Date.now(), runCompletedAt: Date.now() },
                },
                { type: "run.completed", data: { completed: 0, reply: plan.reply?.trim() || conversationFallbackReply(claimed.surface) } },
                ["running"],
                executionId,
            );
            if (!completed) {
                await refundAcceptedPlan();
                return;
            }
            planningPersisted = true;
            return;
        }
        plan = normalizeVideoRemakePlan(plan, skills, referencedAssets, claimed.prompt);
        const normalizedTasks = finalizeVideoRemakeTasks(normalizeTasks(plan, skills, settings, claimed.snapshot, claimed.prompt, claimed.surface, referencedAssets, claimed.requestedImageSize, claimed.generationPreferences), skills);
        const tasks = claimed.surface === "canvas" ? layoutCanvasAgentTasks(normalizedTasks, claimed.snapshot) : normalizedTasks;
        const projectHandoff = normalizeAgentProjectHandoff(plan, claimed.surface, referencedAssets, claimed.prompt);
        const reply = agentPlanReply({ ...plan, projectHandoff }, tasks, claimed.surface);
        const event = claimed.surface === "canvas" ? { type: "canvas.ops", data: { ops: planToOps(plan, tasks, run.id, claimed.snapshot), reply } } : { type: "run.planned", data: { reply, tasks: tasks.map(taskPlanSummary), projectHandoff } };
        const planned = await updateAgentRunById(
            run.id,
            { tasks, foundation: plan.foundation, projectHandoff, reviewed: tasks.length ? claimed.reviewed : true, plannerAudit, timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() } },
            event,
            ["running"],
            executionId,
        );
        if (!planned) {
            await refundAcceptedPlan();
            return;
        }
        planningPersisted = true;
        failurePhase = "execution";
        await executeTasks(run.id, origin, cookie, executionId, settings);
    } catch (error) {
        const message = toSafeGenerationErrorMessage(error, "Agent 执行失败");
        console.error("Agent Run 执行失败", {
            runId: run.id,
            userId: run.userId,
            surface: run.surface,
            phase: failurePhase,
            error: message,
            errorName: error instanceof Error ? error.name : typeof error,
            stack: error instanceof Error ? error.stack : undefined,
        });
        let failure = error;
        try {
            await refundAcceptedPlan();
        } catch (refundError) {
            console.error("Agent planning refund failed", refundError instanceof Error ? refundError.message : refundError);
            failure = refundError;
        }
        const latest = await getAgentRun(run.id);
        if (latest && !["paused", "cancelled"].includes(latest.status))
            await updateAgentRunById(
                run.id,
                { status: "failed", error: toSafeGenerationErrorMessage(failure, message), failurePhase, executionId: undefined, timings: { ...(latest.timings || { requestAcceptedAt: latest.createdAt }), runCompletedAt: Date.now() } },
                { type: "run.failed", data: { message: toSafeGenerationErrorMessage(failure, message) } },
                ["planning", "running"],
                executionId,
            );
    } finally {
        if (controllers.get(run.id) === controller) controllers.delete(run.id);
    }
}

function applyRequestedMediaModels(plan: AgentPlan, selectedModels: Array<ReturnType<typeof agentModelOptions>[number]>, requestPrompt: string, referencedAssetIds: string[]): AgentPlan {
    if (plan.intent === "conversation") return directAgentPlan(selectedModels, requestPrompt, referencedAssetIds);
    const byCapability = new Map<string, typeof selectedModels>();
    for (const model of selectedModels) byCapability.set(model.capability, [...(byCapability.get(model.capability) || []), model]);
    const selectedCapabilities = new Set(byCapability.keys());
    const eligibleDeliverables = plan.deliverables.filter((deliverable) => deliverable.type === "text" || selectedCapabilities.has(deliverable.type));
    const eligibleIds = new Set(eligibleDeliverables.map((deliverable, index) => deliverable.id?.trim() || `task-${index}`));
    const deliverables = eligibleDeliverables.map((deliverable) => {
        if (deliverable.type === "text") return deliverable;
        const candidates = byCapability.get(deliverable.type) || [];
        if (candidates.length === 1) return { ...deliverable, model: candidates[0].id };
        return { ...deliverable, model: candidates.some((model) => model.id === deliverable.model) ? deliverable.model : candidates[0].id, dependencies: deliverable.dependencies?.filter((dependency) => eligibleIds.has(dependency)) };
    });
    const used = new Set(deliverables.flatMap((deliverable) => (deliverable.type === "text" ? [] : [deliverable.model])));
    const missing = selectedModels.filter((model) => !used.has(model.id));
    if (!missing.length) return { ...plan, deliverables };
    const fallback = directAgentPlan(missing, requestPrompt, referencedAssetIds);
    const fallbackDeliverables = fallback.deliverables.map((deliverable, index) => ({ ...deliverable, id: `requested-model-${index + 1}` }));
    const prerequisiteImageIds = fallbackDeliverables.filter((deliverable) => deliverable.type === "image").map((deliverable) => deliverable.id);
    return {
        ...plan,
        intent: "generation",
        deliverables: [
            ...deliverables.map((deliverable) =>
                deliverable.type === "video" && prerequisiteImageIds.length ? { ...deliverable, dependencies: Array.from(new Set([...(deliverable.dependencies || []), ...prerequisiteImageIds])) } : deliverable,
            ),
            ...fallbackDeliverables,
        ],
    };
}
