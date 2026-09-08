import { getAuthSettings, refundUserPoints, type LogicalModelCapability } from "@/lib/auth/store";
import { withCreativeFoundation, type CreativeReview } from "@/lib/creative-agent-contract";
import type { CreativeAsset, CreativeGenerationPreferences, CreativeSurface } from "@/lib/creative-runtime-contract";
import { creativeAssetReferenceAliases } from "@/lib/creative-asset-references";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { resolveLogicalModel, resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { reviewCreativeOutputs } from "@/lib/server/creative-review-service";
import { requestStructuredText, type TextPlanningCandidate, type TextPlanningMessage } from "@/lib/server/text-planning-runtime";
import { registerAgentTaskAssets } from "@/lib/server/agent-run-assets";
import { buildAgentProjectHandoff } from "@/lib/server/agent-run-project-handoff";
import { agentRunTasksCompleted, agentRunTasksTerminal, agentTaskHasPendingChildren, getAgentRun, updateAgentRunById, updateAgentRunTaskById, type AgentRun, type AgentRunChildTask, type AgentRunReference, type AgentRunTask } from "@/lib/server/agent-run-store";
import { assetAccessUrl, creativeAssetContext, resolveTaskReferences } from "@/lib/server/agent-run-surface-policy";
import { selectedCanvasNodeIds } from "@/lib/server/agent-run-canvas-snapshot";
import { agentChildTaskTerminal, agentTaskCopies, resolveAgentTaskCount, resolveAgentVideoSeconds, segmentSkillStoryboardVideoTasks, stageStoryboardAgentTasks, validateAgentTaskResult, type AgentPlan } from "@/lib/server/agent-run-validation";
import { agentRunCompletionReply, agentRunFailureMessage, resultSummary } from "@/lib/server/agent-run-messages";
import { getCreativeAssetsByIds } from "@/lib/server/creative-runtime-store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { linkStoredGenerationTask } from "@/lib/server/generation-task-store";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { videoFrameAssetIds, type VideoReferenceRole } from "@/lib/video-reference-contract";
import type { AgentFunctionCallResult } from "./agent-function-call";
import { agentSurfaceImageSize, canvasReferenceContext, canvasReferenceSupportsTask, canvasSnapshotNodes, isMediaReferenceType, resolveAgentTaskRatio, resolveCanvasTaskTargetNodeId, selectedCanvasReferenceNodes } from "./agent-run-task-input";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders } from "./system-ai-billing";
import { acceptsMediaReference, mergeTaskReferences, taskImageUrls, taskReferences, textConstraintInstruction } from "./agent-run-execution-helpers";
import { isVideoRemakeComposeTask } from "./video-remake-orchestration";
import { composeVideoRemakeTask } from "./video-remake-compose";
import { inlineAgentReferenceImage } from "./agent-run-reference-image";
import { analyzeVideoRemakeSource } from "./video-remake-source-analysis";
import { dreaminaCliVideoCapabilities, normalizeDreaminaCliVideoParameters } from "./dreamina-cli-catalog";
import { resolveModelAdvancedConfig } from "./generation-channel";
import { normalizeVideoAspectRatioForCapability, normalizeVideoQualityForCapability, resolveUpstreamVideoDuration, resolveVideoDurationCapability } from "./video-task-config";
import { isMinimaxH3Protocol } from "./minimax-h3-prompt-compiler";

export { planToOps, taskResultOps } from "./agent-run-canvas-ops";
export { acceptsMediaReference, mergeTaskReferences, requestedTextLimit, reviewCorrection, taskImageUrls, taskReferences, taskResultItems, textConstraintInstruction } from "./agent-run-execution-helpers";

class AgentChildTaskTerminalError extends Error {}
class AgentChildTaskDeferredError extends Error {}
class AgentChildTaskCreateRetryError extends AgentChildTaskDeferredError {
    constructor(
        message: string,
        readonly retryAfterAt: number,
    ) {
        super(message);
    }
}

async function generationResponseMessage(response: Response, fallback: string) {
    const body = await response.text();
    if (!body.trim()) return fallback;
    try {
        const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
        if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
    } catch {}
    return body;
}

export async function canContinue(id: string, executionId: string) {
    const run = await getAgentRun(id);
    return Boolean(run && run.executionId === executionId && !["paused", "cancelled", "completed"].includes(run.status));
}

export const agentPlanTool = {
    type: "function",
    name: "create_agent_plan",
    description: "创建创作计划",
    parameters: {
        type: "object",
        properties: {
            intent: { type: "string", enum: ["conversation", "generation"] },
            objective: { type: "string" },
            audience: { type: "string" },
            reply: { type: "string" },
            skillIds: { type: "array", items: { type: "string" } },
            decisions: {
                type: "array",
                items: {
                    type: "object",
                    properties: { label: { type: "string" }, value: { type: "string" }, reason: { type: "string" } },
                    required: ["label", "value", "reason"],
                    additionalProperties: false,
                },
            },
            foundation: {
                type: "object",
                properties: {
                    complexity: { type: "string", enum: ["simple", "complex"] },
                    brief: {
                        type: "object",
                        properties: {
                            objective: { type: "string" },
                            audience: { type: "string" },
                            usage: { type: "string" },
                            coreMessage: { type: "string" },
                            constraints: { type: "array", items: { type: "string" } },
                            referenceStrategy: { type: "string" },
                        },
                        required: ["objective"],
                        additionalProperties: false,
                    },
                    direction: {
                        type: "object",
                        properties: {
                            summary: { type: "string" },
                            style: { type: "string" },
                            composition: { type: "string" },
                            colors: { type: "array", items: { type: "string" } },
                            lighting: { type: "string" },
                            keywords: { type: "array", items: { type: "string" } },
                            avoid: { type: "array", items: { type: "string" } },
                        },
                        required: ["summary"],
                        additionalProperties: false,
                    },
                },
                required: ["complexity", "brief", "direction"],
                additionalProperties: false,
            },
            brand: {
                type: "object",
                properties: { summary: { type: "string" }, colors: { type: "array", items: { type: "string" } }, visualKeywords: { type: "array", items: { type: "string" } } },
                additionalProperties: false,
            },
            projectHandoff: {
                type: "object",
                properties: {
                    surface: { type: "string", enum: ["canvas", "drama"] },
                    title: { type: "string" },
                    summary: { type: "string" },
                    style: { type: "string" },
                    ratio: { type: "string", enum: ["9:16", "16:9"] },
                    assetIds: { type: "array", items: { type: "string" } },
                },
                required: ["surface", "title"],
                additionalProperties: false,
            },
            deliverables: {
                type: "array",
                minItems: 0,
                items: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        id: { type: "string" },
                        targetNodeId: { type: "string" },
                        type: { type: "string", enum: ["text", "image", "video", "audio"] },
                        model: { type: "string" },
                        prompt: { type: "string" },
                        count: { type: "integer", minimum: 1 },
                        ratio: { type: "string" },
                        quality: { type: "string" },
                        seconds: { type: "number", minimum: 1 },
                        voice: { type: "string" },
                        format: { type: "string" },
                        generateAudio: { type: "boolean" },
                        watermark: { type: "boolean" },
                        speed: { type: "number", exclusiveMinimum: 0 },
                        dependencies: { type: "array", items: { type: "string" } },
                        assetIds: { type: "array", items: { type: "string" } },
                    },
                    required: ["title", "type", "model", "prompt"],
                    additionalProperties: false,
                },
            },
        },
        required: ["intent", "objective", "reply", "decisions", "foundation", "deliverables"],
        additionalProperties: false,
    },
};

export function normalizeTasks(
    plan: AgentPlan,
    skills: Awaited<ReturnType<typeof getAuthSettings>>["agentSkills"],
    settings: Awaited<ReturnType<typeof getAuthSettings>>,
    snapshot: unknown,
    requestPrompt: string,
    surface: CreativeSurface,
    referencedAssets: CreativeAsset[],
    requestedImageSize?: string,
    generationPreferences?: CreativeGenerationPreferences,
): AgentRunTask[] {
    const defaults = Object.assign({}, ...skills.map((skill) => skill.defaultConfig || {})) as Record<string, unknown>;
    const skillExecutionContext = skills.length
        ? `\n\n本任务已选择 Skill：${skills.map((skill) => skill.name).join("、")}。完整 Skill 规则已经在规划阶段落实到当前产物的提示词、依赖顺序和参数；这里只执行当前标题对应的单个产物。除非当前产物明确要求，不得把整套流程、多个分镜、角色板、场景板或说明文字合并进一个媒体结果；但服务端标注“导演分段”的视频任务必须作为一条连续成片覆盖所列分镜，不能再机械地按每张分镜图拆成多个视频。`
        : "";
    const globalDefaults = settings.generationDefaults;
    const mediaDeliverableCount = plan.deliverables.filter((item) => item.type !== "text").length;
    const nodes = canvasSnapshotNodes(snapshot);
    const selectedNodeIds = new Set(selectedCanvasNodeIds(snapshot).filter((id) => nodes.has(id)));
    const selectedCanvasReferences = surface === "canvas" ? selectedCanvasReferenceNodes(snapshot) : [];
    const assets = new Map(referencedAssets.map((asset) => [asset.id, asset]));
    const referenceAliases = creativeAssetReferenceAliases(
        referencedAssets,
        referencedAssets.map((asset) => asset.id),
    );
    const configuredImageSize = agentSurfaceImageSize(surface, snapshot);
    const tasks = plan.deliverables.map((item, index) => {
        const optimizedPrompt = item.prompt.trim();
        const preferredSize = item.type === "image" ? generationPreferences?.image?.size : item.type === "video" ? generationPreferences?.video?.size : undefined;
        const preferredQuality = item.type === "image" ? generationPreferences?.image?.quality : item.type === "video" ? generationPreferences?.video?.quality : undefined;
        const targetNodeId = surface === "canvas" ? resolveCanvasTaskTargetNodeId(item.targetNodeId, item.type, selectedNodeIds, nodes, plan.deliverables.length === 1) : undefined;
        const target = targetNodeId ? nodes.get(targetNodeId) : undefined;
        const canvasReferences = selectedCanvasReferences.filter((reference) => canvasReferenceSupportsTask(reference.type, item.type));
        const canvasAliases = new Map(canvasReferences.map((reference) => [reference.nodeId, reference.alias]));
        const frameIds = item.type === "video" ? videoFrameAssetIds(generationPreferences?.video) : [];
        const frameIdSet = new Set(frameIds);
        const explicitFrameAssets = resolveTaskReferences(frameIds, assets, item.type);
        const plannedAssets = target ? [] : resolveTaskReferences(item.assetIds, assets, item.type).filter((asset) => !frameIdSet.has(asset.id));
        const selectedAssets = [...explicitFrameAssets, ...plannedAssets];
        const frameRoles = new Map<string, VideoReferenceRole>([
            ...(generationPreferences?.video?.firstFrameAssetId ? ([[generationPreferences.video.firstFrameAssetId, "first_frame"]] as const) : []),
            ...(generationPreferences?.video?.lastFrameAssetId ? ([[generationPreferences.video.lastFrameAssetId, "last_frame"]] as const) : []),
        ]);
        const references = [
            ...(canvasReferences.length
                ? canvasReferences.map((reference) => ({ nodeId: reference.nodeId, url: reference.url, type: reference.type, alias: reference.alias }))
                : target?.url && isMediaReferenceType(target.type)
                  ? [{ nodeId: targetNodeId, url: target.url, type: target.type, ...(targetNodeId && canvasAliases.get(targetNodeId) ? { alias: canvasAliases.get(targetNodeId) } : {}) }]
                  : []),
            ...selectedAssets.flatMap((asset) => {
                const url = assetAccessUrl(asset);
                const role = frameRoles.get(asset.id);
                return url && asset.type !== "text" ? [{ assetId: asset.id, url, type: asset.type, ...(role ? { role } : {}), ...(referenceAliases.get(asset.id) ? { alias: referenceAliases.get(asset.id) } : {}) }] : [];
            }),
        ] satisfies AgentRunReference[];
        const primaryReference = references[0];
        const referenceContext = selectedAssets.map((asset) => creativeAssetContext(asset, referenceAliases.get(asset.id))).join("\n");
        const selectedCanvasContext = canvasReferenceContext(canvasReferences);
        const canvasReferenceRole = !target && canvasReferences.length ? "画布引用只用于保持人物或主体身份、外观与已明确要求复用的风格；当前分镜提示词中的场景、动作、道具、构图和光线优先，除非当前分镜明确要求，否则不得复制参考图的背景、动作或构图。" : "";
        const executionPrompt = item.type !== "text" && mediaDeliverableCount > 1 ? optimizedPrompt : withCreativeFoundation(optimizedPrompt, plan.foundation);
        return {
            id: item.id?.trim() || `task-${index}`,
            targetNodeId: target ? targetNodeId : undefined,
            referenceAssetId: selectedAssets[0]?.id,
            referenceUrl: primaryReference?.url,
            referenceType: primaryReference?.type,
            references,
            title: item.title.trim(),
            type: item.type,
            model: resolvePlannedModel(settings, item.type, item.model),
            optimizedPrompt,
            prompt: `${executionPrompt}${skillExecutionContext}${textConstraintInstruction(requestPrompt, item.type)}${target ? `\n\n基于画布已有节点进行局部修改：${target.summary}` : ""}${canvasReferenceRole ? `\n\n${canvasReferenceRole}` : ""}${selectedCanvasContext ? `\n\n使用本轮画布引用：\n${selectedCanvasContext}` : ""}${referenceContext ? `\n\n使用已引用创作资产：${referenceContext}` : ""}`,
            count: resolveAgentTaskCount(
                item.type,
                item.type === "image" ? generationPreferences?.image?.count || item.count : item.type === "video" ? generationPreferences?.video?.count || item.count : item.count,
                item.type === "video" ? defaults.videoCount || defaults.count : defaults.count,
                item.type === "image" ? globalDefaults.canvasImageCount : undefined,
            ),
            ratio: resolveAgentTaskRatio({
                type: item.type,
                requestedImageSize,
                configuredImageSize: preferredSize || configuredImageSize,
                plannedRatio: item.ratio,
                defaultSize: textDefault(defaults.size),
                globalSize: ["image", "video"].includes(item.type) ? globalDefaults.imageSize : undefined,
                reference: target || canvasReferences.find((reference) => reference.type === "image") || (selectedAssets[0]?.type === "image" ? selectedAssets[0] : undefined),
            }),
            quality:
                preferredQuality ||
                item.quality?.trim() ||
                textDefault(item.type === "video" ? defaults.vquality : defaults.quality) ||
                (item.type === "video" ? globalDefaults.videoQuality : item.type === "image" ? globalDefaults.imageQuality : undefined),
            seconds: item.type === "video" && !skills.length && generationPreferences?.video?.seconds ? generationPreferences.video.seconds : resolveAgentVideoSeconds(item.type, item.seconds, defaults.videoSeconds, globalDefaults.videoSeconds),
            voice: item.type === "audio" ? generationPreferences?.audio?.voice || item.voice?.trim() || textDefault(defaults.voice) || globalDefaults.audioVoice : item.voice?.trim() || textDefault(defaults.voice),
            format: item.type === "audio" ? generationPreferences?.audio?.format || item.format?.trim() || textDefault(defaults.format) || globalDefaults.audioFormat : item.format?.trim() || textDefault(defaults.format),
            generateAudio: item.type === "video" ? (generationPreferences?.video?.generateAudio ?? item.generateAudio) : undefined,
            watermark: item.type === "video" ? (generationPreferences?.video?.watermark ?? item.watermark) : undefined,
            speed: item.type === "audio" ? (generationPreferences?.audio?.speed ?? item.speed) : undefined,
            dependencies: (item.dependencies || []).map((dependency) => dependency.trim()),
            status: "ready" as const,
            attempts: 0,
        };
    });
    const storyboardTasks =
        skills.length && generationPreferences?.mode === "video"
            ? segmentSkillStoryboardVideoTasks(tasks, {
                  totalSeconds: generationPreferences.video?.seconds,
                  resolveCapability: (task) => agentVideoDurationCapability(settings, task),
              })
            : tasks;
    return stageStoryboardAgentTasks(storyboardTasks);
}

export function agentModelOptions(settings: Awaited<ReturnType<typeof getAuthSettings>>) {
    return settings.logicalModels
        .filter((model) => model.enabled && resolveLogicalModel(settings, model.capability, model.id))
        .map((model) => {
            const resolved = resolveLogicalModel(settings, model.capability, model.id);
            return { id: model.id, name: model.name, capability: model.capability, capabilityProfile: resolved?.capabilityProfile };
        });
}

export function directAgentPlan(models: Array<ReturnType<typeof agentModelOptions>[number]>, prompt: string, assetIds: string[]): AgentPlan {
    if (!models.length || models.some((model) => model.capability === "text")) throw new Error("当前模型不支持直接生成媒体");
    return {
        intent: "generation",
        objective: prompt,
        reply: `已按你的选择使用 ${models.map((model) => `「${model.name}」`).join("、")} 分别执行生成。`,
        decisions: [{ label: "模型", value: models.map((model) => model.name).join("、"), reason: "使用你在模型面板中明确选择的模型，不再由智能规划改选" }],
        foundation: {
            complexity: "simple",
            brief: { objective: prompt, ...(assetIds.length ? { referenceStrategy: "使用已引用素材作为生成参考" } : {}) },
            direction: { summary: "严格执行用户当前描述和所选 Skill 约束" },
        },
        deliverables: models.map((model, index) => ({
            id: `direct-model-task-${index + 1}`,
            title: `${model.name} 生成`,
            type: model.capability as "image" | "video" | "audio",
            model: model.id,
            prompt,
            count: 1,
            dependencies: [],
            assetIds,
        })),
    };
}

function defaultModel(settings: Awaited<ReturnType<typeof getAuthSettings>>, capability: LogicalModelCapability) {
    const model = capability === "image" ? settings.defaultModels.imageModel : capability === "video" ? settings.defaultModels.videoModel : capability === "audio" ? settings.defaultModels.audioModel : settings.defaultModels.textModel;
    return model && resolveLogicalModel(settings, capability, model) ? model : "";
}

function resolvePlannedModel(settings: Awaited<ReturnType<typeof getAuthSettings>>, capability: LogicalModelCapability, planned: unknown) {
    const model = typeof planned === "string" ? planned.trim() : "";
    if (model && resolveLogicalModel(settings, capability, model)) return model;
    return defaultModel(settings, capability) || undefined;
}

export function assertAgentSkillModelConstraints(
    skills: Awaited<ReturnType<typeof getAuthSettings>>["agentSkills"],
    selectedSkillIds: readonly string[] | undefined,
    capability: LogicalModelCapability,
    protocol: unknown,
) {
    const required = skills.filter(
        (skill) =>
            (selectedSkillIds || []).includes(skill.id) &&
            skill.modelConstraints?.capability === capability &&
            skill.modelConstraints.requiredModelFamilies?.includes("minimax-h3"),
    );
    if (!required.length || isMinimaxH3Protocol(protocol)) return;
    throw new Error(`所选 Skill“${required.map((skill) => skill.name).join("、")}”只能使用 MiniMax H3 视频模型；请在可用模型中选择已配置的 MiniMax H3 渠道后重试`);
}

function agentTaskConcurrencyConstraint(settings: Awaited<ReturnType<typeof getAuthSettings>>, task: AgentRunTask) {
    const model = resolvePlannedModel(settings, task.type, task.model);
    const resolved = model ? resolveLogicalModel(settings, task.type, model) : null;
    if (!resolved) return null;
    const protocol = resolveModelAdvancedConfig(resolved.channel.advancedConfig, resolved.upstreamModel)?.protocol;
    const limit = protocol === "dreamina-cli" ? 1 : Number(resolved.capabilityProfile?.concurrencyLimit);
    if (!Number.isSafeInteger(limit) || limit <= 0) return null;
    return { key: `${task.type}:${resolved.channelId}:${resolved.upstreamModel}`, limit };
}

function readyAgentTasks(run: AgentRun, settings: Awaited<ReturnType<typeof getAuthSettings>>, now = Date.now()) {
    const completed = new Set(run.tasks.filter((task) => task.status === "completed" && !agentTaskHasPendingChildren(task)).map((task) => task.id));
    const selected: AgentRunTask[] = [];
    const usedByConstraint = new Map<string, number>();
    for (const task of run.tasks) {
        if (selected.length >= settings.generationConcurrency.agent) break;
        const resumableChild = task.status === "completed" && agentTaskHasPendingChildren(task);
        if ((task.status !== "ready" && task.status !== "running" && !resumableChild) || ![...task.dependencies, ...(task.stageDependencies || [])].every((id) => completed.has(id)) || isAgentTaskRetryDeferred(task, now)) continue;
        const constraint = agentTaskConcurrencyConstraint(settings, task);
        const used = constraint ? usedByConstraint.get(constraint.key) || 0 : 0;
        if (constraint && used >= constraint.limit) continue;
        selected.push(task);
        if (constraint) usedByConstraint.set(constraint.key, used + 1);
    }
    return selected;
}

function isAgentTaskRetryDeferred(task: AgentRunTask, now = Date.now()) {
    return typeof task.retryAfterAt === "number" && task.retryAfterAt > now;
}

function agentTaskCopyConcurrency(settings: Awaited<ReturnType<typeof getAuthSettings>>, task: AgentRunTask, resolved: ReturnType<typeof resolveLogicalModel>) {
    const configured = settings.generationConcurrency[task.type === "image" ? "image" : task.type === "video" ? "video" : task.type === "audio" ? "audio" : "text"];
    const limit = Number(resolved?.capabilityProfile?.concurrencyLimit);
    return Number.isSafeInteger(limit) && limit > 0 ? Math.min(configured, limit) : configured;
}

function normalizeResolvedAgentTask(task: AgentRunTask, resolved: NonNullable<ReturnType<typeof resolveLogicalModel>>) {
    if (task.type !== "video") return task;
    const advanced = resolveModelAdvancedConfig(resolved.channel.advancedConfig, resolved.upstreamModel);
    const profile = resolved.capabilityProfile;
    const quality = normalizeVideoQualityForCapability(task.quality, profile?.qualityOptions);
    const ratio = normalizeVideoAspectRatioForCapability(task.ratio, profile?.aspectRatios);
    const durationCapability = agentVideoDurationCapabilityForResolved(resolved);
    const seconds = resolveUpstreamVideoDuration(task.seconds, task.seconds || 5, {
        durationRange: durationCapability?.durationOptions?.join("、") || (durationCapability ? undefined : profile?.durationRange || advanced?.durationRange),
        minDurationSeconds: durationCapability?.minSeconds || profile?.minDurationSeconds,
        maxDurationSeconds: durationCapability?.maxSeconds || profile?.maxDurationSeconds,
    });
    const normalizedTask = {
        ...task,
        ...(quality ? { quality } : {}),
        ...(ratio ? { ratio } : {}),
        ...(seconds > 0 ? { seconds } : {}),
    };
    if (advanced?.protocol !== "dreamina-cli") return normalizedTask;
    const video = normalizeDreaminaCliVideoParameters(resolved.upstreamModel, { videoResolution: normalizedTask.quality, duration: normalizedTask.seconds });
    return video.videoResolution === normalizedTask.quality && video.duration === normalizedTask.seconds ? normalizedTask : { ...normalizedTask, quality: video.videoResolution, seconds: video.duration };
}

function agentVideoDurationCapability(settings: Awaited<ReturnType<typeof getAuthSettings>>, task: AgentRunTask) {
    const model = resolvePlannedModel(settings, "video", task.model);
    const resolved = model ? resolveLogicalModel(settings, "video", model) : null;
    return resolved ? agentVideoDurationCapabilityForResolved(resolved) : null;
}

function agentVideoDurationCapabilityForResolved(resolved: NonNullable<ReturnType<typeof resolveLogicalModel>>) {
    const advanced = resolveModelAdvancedConfig(resolved.channel.advancedConfig, resolved.upstreamModel);
    const dreamina = advanced?.protocol === "dreamina-cli" ? dreaminaCliVideoCapabilities(resolved.upstreamModel) : null;
    if (dreamina) return { minSeconds: dreamina.minDurationSeconds, maxSeconds: dreamina.maxDurationSeconds, maxReferenceImages: dreamina.maxReferenceImages };
    const profile = resolved.capabilityProfile;
    const capability = resolveVideoDurationCapability({
        durationRange: profile?.durationRange || advanced?.durationRange,
        minDurationSeconds: profile?.minDurationSeconds,
        maxDurationSeconds: profile?.maxDurationSeconds,
    });
    if (!capability.known) return null;
    const durationOptions = capability.options.length ? capability.options : undefined;
    return {
        minSeconds: durationOptions?.[0] || capability.minSeconds,
        maxSeconds: durationOptions?.at(-1) || capability.maxSeconds,
        ...(durationOptions ? { durationOptions } : {}),
        maxReferenceImages: profile?.maxReferenceImages,
    };
}

export function agentPlanFallbackExample(models: ReturnType<typeof agentModelOptions>) {
    const sample = models.find((model) => model.capability === "image") || models[0];
    return JSON.stringify({
        intent: "generation",
        objective: "为新品发布制作一套统一视觉",
        audience: "关注产品设计与科技体验的用户",
        reply: "我建议先建立横版主视觉，再基于同一风格生成配套文案，保证主体和传播语一致。",
        decisions: [
            { label: "模型", value: sample?.name || sample?.id || "可用逻辑模型", reason: "匹配当前产物类型和画面表现需求" },
            { label: "画幅", value: "16:9", reason: "适合发布会舞台、网页头图和横屏展示" },
        ],
        foundation: {
            complexity: "complex",
            brief: {
                objective: "为新品发布制作一套统一视觉",
                audience: "关注产品设计与科技体验的用户",
                usage: "发布会、官网与社交传播",
                coreMessage: "突出产品设计和可靠体验",
                constraints: ["不夸大功能"],
                referenceStrategy: "优先保持已有产品素材的外观与颜色",
            },
            direction: {
                summary: "克制、现代、可信",
                style: "纪实科技商业视觉",
                composition: "以产品为中心，保留文案和延展空间",
                colors: ["深灰", "暖白"],
                lighting: "柔和轮廓光与清晰材质光",
                keywords: ["纪实", "高级", "清晰层次"],
                avoid: ["过度赛博", "无关装饰"],
            },
        },
        brand: { summary: "克制、现代、可信", colors: ["深灰", "暖白"], visualKeywords: ["纪实", "高级", "清晰层次"] },
        deliverables: [
            {
                id: "main-visual",
                title: "发布会主视觉",
                type: sample?.capability || "image",
                model: sample?.id || "",
                prompt: "生成完整可执行的主视觉提示词",
                count: 1,
                ratio: "16:9",
                quality: "high",
                seconds: 5,
                voice: "alloy",
                format: "mp3",
                dependencies: [],
                assetIds: [],
            },
        ],
    });
}

function textDefault(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export async function executeTasks(runId: string, origin: string, cookie: string, executionId: string, executionSettings?: Awaited<ReturnType<typeof getAuthSettings>>) {
    const settings = executionSettings || (await getAuthSettings());
    while (await canContinue(runId, executionId)) {
        const run = await getAgentRun(runId);
        if (!run) return;
        const ready = readyAgentTasks(run, settings);
        if (!ready.length) {
            if (run.tasks.some((task) => (task.status === "ready" || task.status === "running") && isAgentTaskRetryDeferred(task))) return;
            if (agentRunTasksCompleted(run.tasks)) {
                if (!run.reviewed && shouldBlockOnReview(run)) {
                    const review = await reviewCompletedTasks(run, origin, cookie);
                    await updateAgentRunById(
                        runId,
                        { reviewed: true, review, reviewStatus: review.status === "unavailable" ? "review_unavailable" : "review_completed", timings: { ...(run.timings || { requestAcceptedAt: run.createdAt }), reviewCompletedAt: Date.now() } },
                        { type: review.status === "unavailable" ? "run.review.unavailable" : review.status === "needs_revision" ? "run.review.needs_revision" : "run.review.passed", data: { review } },
                        ["running"],
                        executionId,
                    );
                }
                let completedRun = (await getAgentRun(runId)) || run;
                const projectHandoff = await buildAgentProjectHandoff(completedRun);
                if (projectHandoff && !completedRun.projectHandoffEmitted) {
                    const emitted = await updateAgentRunById(runId, { projectHandoffEmitted: true }, { type: "project.handoff", data: projectHandoff }, ["running"], executionId);
                    if (!emitted) return;
                    completedRun = emitted;
                }
                const reply = `${agentRunCompletionReply(completedRun)}${projectHandoff ? `\n\n已创建${projectHandoff.surface === "canvas" ? "画布" : "短剧"}项目「${projectHandoff.title}」，可以从当前对话直接打开。` : ""}`;
                const backgroundReview = !shouldBlockOnReview(completedRun) && !completedRun.reviewed;
                const finished = await updateAgentRunById(
                    runId,
                    {
                        status: "completed",
                        executionId: undefined,
                        ...(backgroundReview ? { reviewStatus: "review_pending" as const, reviewAttempts: completedRun.reviewAttempts || 0 } : {}),
                        timings: { ...(completedRun.timings || { requestAcceptedAt: completedRun.createdAt }), allResultsReadyAt: completedRun.timings?.allResultsReadyAt || Date.now(), runCompletedAt: Date.now() },
                    },
                    { type: "run.completed", data: { completed: completedRun.tasks.length, assetIds: completedRun.assetIds, projectHandoff, reply } },
                    ["running"],
                    executionId,
                );
                if (finished && backgroundReview) await scheduleGenerationTask("agent", runId, { executionPhase: "review_pending", nextPollAt: Date.now(), lastUpstreamStatus: "review_pending" });
                return;
            }
            const blocked = run.tasks.filter((task) => task.status === "ready");
            const terminalTasks = blocked.length ? run.tasks.map((task) => (task.status === "ready" ? { ...task, status: "failed" as const, error: "前置任务未完成" } : task)) : run.tasks;
            // A parent task is never terminal while one of its provider tasks is
            // still pending.  This protects both the Run completion message and
            // restart recovery from treating a loading Canvas node as complete.
            if (!agentRunTasksTerminal(terminalTasks)) return;
            const partialSuccess = Boolean(run.assetIds.length) && terminalTasks.some((task) => task.status === "failed") && agentRunTasksTerminal(terminalTasks);
            if (partialSuccess) {
                await updateAgentRunById(
                    runId,
                    {
                        status: "completed",
                        executionId: undefined,
                        tasks: terminalTasks,
                        timings: { ...(run.timings || { requestAcceptedAt: run.createdAt }), allResultsReadyAt: run.timings?.allResultsReadyAt || Date.now(), runCompletedAt: Date.now() },
                    },
                    { type: "run.completed", data: { completed: terminalTasks.filter((task) => task.status === "completed").length, partial: true, assetIds: run.assetIds, reply: agentRunFailureMessage(terminalTasks) } },
                    ["running"],
                    executionId,
                );
                return;
            }
            const message = agentRunFailureMessage(terminalTasks);
            console.error("Agent Run 子任务执行失败", { runId, phase: "execution", error: message });
            await updateAgentRunById(runId, { status: "failed", error: message, failurePhase: "execution", executionId: undefined, tasks: terminalTasks }, { type: "run.failed", data: { message } }, ["running"], executionId);
            return;
        }
        const results = await Promise.all(ready.map((task) => runTaskWithRetry(runId, task, origin, cookie, executionId, settings)));
        if (results.some((result) => result === "deferred")) return;
    }
}

function shouldBlockOnReview(run: AgentRun) {
    return run.tasks.length > 1 || run.surface === "drama" || /严格检查|高质量模式|完整复盘/u.test(run.prompt);
}

export async function processAgentRunReview(run: AgentRun, origin: string, cookie: string) {
    if (run.status !== "completed" || run.reviewed) return { status: "completed" as const, attempts: run.reviewAttempts || 0 };
    const attempts = (run.reviewAttempts || 0) + 1;
    const started = await updateAgentRunById(run.id, { reviewStatus: "reviewing", reviewAttempts: attempts }, { type: "run.review.started", data: { attempt: attempts } }, ["completed"]);
    if (!started || started.reviewed) return { status: "completed" as const, attempts };
    try {
        const review = await reviewCompletedTasks(started, origin, cookie);
        await updateAgentRunById(
            started.id,
            { reviewed: true, review, reviewStatus: review.status === "unavailable" ? "review_unavailable" : "review_completed", timings: { ...(started.timings || { requestAcceptedAt: started.createdAt }), reviewCompletedAt: Date.now() } },
            { type: "run.review.background", data: { status: review.status, issueCount: review.issues.length } },
            ["completed"],
        );
        return { status: review.status === "unavailable" ? ("unavailable" as const) : ("completed" as const), attempts };
    } catch (error) {
        const message = toSafeGenerationErrorMessage(error, "复盘服务暂时不可用");
        const review: CreativeReview = { mode: "unavailable", status: "unavailable", summary: message, issues: [], retryTaskIds: [] };
        await updateAgentRunById(
            started.id,
            { reviewed: true, review, reviewStatus: "review_unavailable", timings: { ...(started.timings || { requestAcceptedAt: started.createdAt }), reviewCompletedAt: Date.now() } },
            { type: "run.review.background", data: { status: "unavailable", issueCount: 0 } },
            ["completed"],
        );
        return { status: "unavailable" as const, attempts };
    }
}

async function reviewCompletedTasks(run: AgentRun, origin: string, cookie: string) {
    const foundation = run.foundation || {
        complexity: "complex" as const,
        brief: { objective: run.prompt },
        direction: { summary: "保持所有产物的主体、信息和视觉语言一致" },
    };
    return reviewCreativeOutputs({
        origin,
        cookie,
        userId: run.userId,
        billingId: run.id,
        foundation,
        tasks: run.tasks.map((task) => ({ id: task.id, title: task.title, type: task.type, prompt: task.prompt, resultSummary: resultSummary(task.result), imageUrls: task.type === "image" ? taskImageUrls(task.result) : [] })),
    });
}

export async function requestFunctionCall(
    origin: string,
    cookie: string,
    candidate: TextPlanningCandidate,
    input: TextPlanningMessage[],
    tool: typeof agentPlanTool,
    name: string,
    signal: AbortSignal,
    userId: string,
    billingModel: string,
    allowNaturalLanguage = false,
    pointsIdempotencyKey?: string,
) {
    const requestHeaders = runtimeRequestHeaders(cookie, {
        "Content-Type": "application/json",
        ...(pointsIdempotencyKey ? { "Idempotency-Key": pointsIdempotencyKey, "X-Client-Request-Id": pointsIdempotencyKey } : {}),
        ...systemAiBillingHeaders(billingModel, pointsIdempotencyKey, candidate.upstreamModel),
    });
    const call = await requestStructuredText({
        origin,
        cookie,
        candidate,
        messages: input,
        tool: { name: tool.name, description: tool.description, parameters: tool.parameters },
        headers: requestHeaders,
        signal,
        allowNaturalLanguage,
        onInvalidResponse: (headers) => refundTextResponse(userId, billingModel, headers),
    });
    return readFunctionCallResult(call.arguments, call.headers, call.protocol, call.elapsedMs);
}

export function responseOutputText(payload: { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }) {
    const direct = payload.output_text?.trim();
    if (direct) return direct;
    return (
        payload.output
            ?.flatMap((item) => item.content || [])
            .find((item) => item.type === "output_text" && item.text?.trim())
            ?.text?.trim() || ""
    );
}

export function readFunctionCallResult(argumentsText: string, headers: Headers, protocol?: AgentFunctionCallResult["protocol"], elapsedMs?: number): AgentFunctionCallResult {
    const pointsRemaining = Number(headers.get("x-octalaicanvas-points-remaining"));
    return {
        arguments: argumentsText,
        protocol,
        elapsedMs,
        pointsRemaining: Number.isFinite(pointsRemaining) ? pointsRemaining : undefined,
        ...readSystemAiBilling(headers),
    };
}

export async function refundFunctionCall(userId: string, model: string, call: AgentFunctionCallResult) {
    if (hasSystemAiCharge(call)) await refundUserPoints(userId, model, call.pointsCost, "text", 1, undefined, call.pointsRecordId);
}

export async function refundTextResponse(userId: string, model: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

export async function runTaskWithRetry(runId: string, task: AgentRunTask, origin: string, cookie: string, executionId: string, settings?: Awaited<ReturnType<typeof getAuthSettings>>) {
    const resumeExisting = task.childTasks?.some((child) => child.status === "pending") || (task.status === "running" && task.taskId && !task.childTasks?.length);
    const retryingUnsubmitted = task.status === "ready" && task.retryAfterAt !== undefined;
    const attempt = resumeExisting || retryingUnsubmitted ? Math.max(1, task.attempts) : task.attempts + 1;
    if (!(await canContinue(runId, executionId))) return;
    if (retryingUnsubmitted && !(await patchTask(runId, task.id, { retryAfterAt: undefined, error: undefined }, "task.retrying", executionId))) return;
    if (
        (task.status !== "running" || !task.startedAt) &&
        !(await patchTask(runId, task.id, { status: "running", attempts: attempt, startedAt: task.startedAt || Date.now(), completedAt: undefined, error: undefined, retryAfterAt: undefined }, "task.running", executionId))
    )
        return;
    try {
        const activeRun = await getAgentRun(runId);
        if (!activeRun || activeRun.executionId !== executionId) return;
        const currentTask = activeRun.tasks.find((item) => item.id === task.id) || task;
        const executableTask = await withDependencyContext(runId, currentTask);
        const dispatched = await dispatchTask(executableTask, origin, cookie, settings || (await getAuthSettings()), activeRun, executionId, attempt);
        const result = dispatched.result;
        validateAgentTaskResult(task.type, result);
        await patchTask(runId, task.id, {}, "task.validated", executionId);
        const registeredAssetIds = dispatched.assetIds ?? (await registerAgentTaskAssets(activeRun, { ...executableTask, attempts: attempt, result }, result, dispatched.sourceTaskIds)).map((asset) => asset.id);
        await patchTask(
            runId,
            task.id,
            {
                status: "completed",
                result,
                error: undefined,
                taskId: dispatched.sourceTaskIds.at(-1),
                taskIds: dispatched.sourceTaskIds,
                assetIds: registeredAssetIds,
                referenceAssetId: executableTask.referenceAssetId,
                referenceUrl: executableTask.referenceUrl,
                referenceType: executableTask.referenceType,
                references: executableTask.references,
                completedAt: Date.now(),
            },
            "task.completed",
            executionId,
        );
        return "completed" as const;
    } catch (error) {
        if (error instanceof AgentChildTaskCreateRetryError) {
            if (await canContinue(runId, executionId)) {
                await patchTask(runId, task.id, { status: "ready", error: error.message, retryAfterAt: error.retryAfterAt }, "task.retry.scheduled", executionId);
            }
            return "deferred" as const;
        }
        if (error instanceof AgentChildTaskDeferredError) {
            const latest = await getAgentRun(runId);
            const latestTask = latest?.tasks.find((item) => item.id === task.id);
            if (latestTask && latestTask.error !== error.message && (await canContinue(runId, executionId))) {
                await patchTask(runId, task.id, { error: error.message }, "task.waiting", executionId);
            }
            return "deferred" as const;
        }
        const message = toSafeGenerationErrorMessage(error, "生成任务失败");
        if (await canContinue(runId, executionId)) {
            const latest = await getAgentRun(runId);
            const childTasks = latest?.tasks.find((item) => item.id === task.id)?.childTasks?.map((child) => (child.status === "pending" ? { ...child, status: "failed" as const, error: message } : child));
            await patchTask(runId, task.id, { status: "failed", completedAt: Date.now(), error: message, ...(childTasks ? { childTasks } : {}) }, "task.failed", executionId);
        }
        return "failed" as const;
    }
}

export async function resumeDispatchedTask(run: AgentRun, task: AgentRunTask, taskId: string, attempt: number, origin: string, cookie: string, executionId: string) {
    await linkAgentChildTask(run, task, taskId, attempt);
    return { result: await pollTask(origin, taskPath(task.type), taskId, cookie, run.id, task.type, executionId), sourceTaskIds: [taskId] };
}

export async function withDependencyContext(runId: string, task: AgentRunTask): Promise<AgentRunTask> {
    const run = await getAgentRun(runId);
    if (!run || !task.dependencies.length) return task;
    const dependencies = run?.tasks.filter((item) => task.dependencies.includes(item.id) && item.status === "completed") || [];
    const dependencyAssets = await getCreativeAssetsByIds(Array.from(new Set(dependencies.flatMap((item) => item.assetIds || []))), run?.userId);
    const dependencyReferences = dependencyAssets.flatMap((asset) => {
        const url = assetAccessUrl(asset);
        if (!url || !acceptsMediaReference(task.type, asset.type)) return [];
        return [{ assetId: asset.id, sourceTaskId: asset.sourceTaskId, url, type: asset.type }] satisfies AgentRunReference[];
    });
    const directReferences = taskReferences(task);
    const references = mergeTaskReferences(directReferences, dependencyReferences);
    const taskContext = dependencies
        .map((item) => `【${item.title}】${resultSummary(item.result)}`)
        .filter((item) => item.length > 4)
        .join("\n");
    const assetContext = dependencyAssets.map((asset) => creativeAssetContext(asset)).join("\n");
    const context = [taskContext, assetContext].filter(Boolean).join("\n");
    const primaryReference = references[0];
    return {
        ...task,
        referenceAssetId: primaryReference?.assetId || task.referenceAssetId,
        referenceUrl: primaryReference?.url || task.referenceUrl,
        referenceType: primaryReference?.type || task.referenceType,
        references,
        prompt: context ? `${task.prompt}\n\n请保持与以下已完成产物一致，并将依赖媒体作为真实生成参考：\n${context}` : task.prompt,
    };
}

export function taskPath(type: AgentRunTask["type"]) {
    return type === "image" ? "/api/image-tasks" : type === "video" ? "/api/video-tasks" : type === "audio" ? "/api/audio-tasks" : "/api/text-tasks";
}

export async function dispatchTask(task: AgentRunTask, origin: string, cookie: string, settings: Awaited<ReturnType<typeof getAuthSettings>>, run: AgentRun, executionId: string, attempt: number) {
    const directTextContent = run.surface === "canvas" ? directCanvasTextContent(task) : null;
    if (directTextContent) return { result: { content: directTextContent }, sourceTaskIds: [`direct-${run.id}-${task.id}`] };
    if (isVideoRemakeComposeTask(task)) {
        const result = await composeVideoRemakeTask(task, run, origin, cookie);
        return { result, sourceTaskIds: [`compose-${run.id}-${task.id}`] };
    }
    const model = resolvePlannedModel(settings, task.type, task.model);
    const references = taskReferences(task);
    const needsTextVision = task.type === "text" && references.some((reference) => reference.type === "image" || reference.type === "video");
    const resolved = needsTextVision ? resolveLogicalModelCandidates(settings, "text", model || "").find((candidate) => candidate.capabilityProfile?.supportsReferenceImage) : resolveLogicalModel(settings, task.type, model || "");
    const channel = resolved?.channel;
    if (!model || !channel || !resolved)
        throw new Error(needsTextVision ? "后台默认文本模型没有可用的视觉理解渠道" : `后台尚未配置可用的默认${task.type === "image" ? "图片" : task.type === "video" ? "视频" : task.type === "audio" ? "音频" : "文本"}模型`);
    assertAgentSkillModelConstraints(settings.agentSkills || [], run.selectedSkillIds, task.type, resolveModelAdvancedConfig(resolved.channel.advancedConfig, resolved.upstreamModel)?.protocol);
    const resolvedTask = normalizeResolvedAgentTask(task, resolved);
    if (resolvedTask !== task && !(await patchTask(run.id, task.id, { ratio: resolvedTask.ratio, quality: resolvedTask.quality, seconds: resolvedTask.seconds }, "task.parameters.normalized", executionId))) throw new Error("Agent Run 已由新执行器接管");
    task = resolvedTask;
    const config = {
        apiSource: "system",
        baseUrl: `/api/ai/system/${encodeURIComponent(channel.id)}`,
        apiKey: "",
        apiFormat: channel.apiFormat || "openai",
        model,
        ...(task.type === "image" ? { ...(task.quality ? { quality: task.quality } : {}), ...(task.ratio ? { size: task.ratio } : {}) } : {}),
        ...(task.type === "video"
            ? {
                  ...(task.ratio ? { size: task.ratio } : {}),
                  ...(task.seconds ? { videoSeconds: String(task.seconds) } : {}),
                  ...(task.quality ? { vquality: task.quality } : {}),
                  ...(task.generateAudio !== undefined ? { videoGenerateAudio: String(task.generateAudio) } : {}),
                  ...(task.watermark !== undefined ? { videoWatermark: String(task.watermark) } : {}),
              }
            : {}),
        ...(task.type === "audio" ? { ...(task.voice ? { voice: task.voice } : {}), ...(task.format ? { format: task.format } : {}), ...(task.speed ? { speed: String(task.speed) } : {}) } : {}),
    };
    const submittedParameters =
        task.type === "video"
            ? {
                  model: model,
                  ...(task.ratio ? { ratio: task.ratio } : {}),
                  ...(task.quality ? { quality: task.quality } : {}),
                  ...(task.seconds ? { duration: task.seconds } : {}),
                  referenceMode: videoReferenceMode(references),
              }
            : undefined;
    if (submittedParameters && !(await patchTask(run.id, task.id, { submittedParameters }, "task.parameters.submitted", executionId))) throw new Error("Agent Run 已由新执行器接管");
    const path = task.type === "image" ? "/api/image-tasks" : task.type === "video" ? "/api/video-generation-tasks" : task.type === "audio" ? "/api/audio-tasks" : "/api/text-tasks";
    const textReferenceImages = needsTextVision ? await textTaskReferenceImages(references, run, origin, cookie) : [];
    const source = run.surface === "canvas" ? "canvas" : run.surface === "drama" ? "drama" : "agent";
    const context = { conversationId: run.conversationId, runId: run.id, surface: run.surface, projectId: run.projectId, parentTaskId: task.id, attemptNo: attempt, clientRequestId: `${run.clientRequestId}:${task.id}:${attempt}` };
    const body =
        task.type === "image"
            ? {
                  config,
                  prompt: task.prompt,
                  source,
                  title: task.title,
                  kind: references.length ? "edit" : "generation",
                  references: references.filter((item) => item.type === "image").map((item) => ({ dataUrl: "", url: item.url })),
                  context,
              }
            : task.type === "video"
              ? {
                    config,
                    prompt: task.prompt,
                    references: references.map((item) => ({
                        type: item.type,
                        url: item.url,
                        ...(item.role ? { role: item.role } : {}),
                        ...(item.assetId ? { assetId: item.assetId } : {}),
                        ...(item.nodeId ? { nodeId: item.nodeId } : {}),
                        ...(item.sourceTaskId ? { sourceTaskId: item.sourceTaskId } : {}),
                        ...(item.alias ? { alias: item.alias } : {}),
                    })),
                    source,
                    context,
                }
              : task.type === "audio"
                ? { config, prompt: task.prompt, source, context }
                : {
                      config,
                      messages: [
                          {
                              role: "user",
                              content: textReferenceImages.length
                                  ? [
                                        { type: "text" as const, text: `${task.prompt}\n\n请基于随本条消息一同发送的真实参考图或视频抽帧完成任务；不得声称没有附件，不得改用示例素材。` },
                                        ...textReferenceImages.map((url) => ({ type: "image_url" as const, image_url: { url } })),
                                    ]
                                  : task.prompt,
                          },
                      ],
                  };
    const copies = agentTaskCopies(task.type, task.count);
    const initialChildren = normalizeChildTasks(task);
    const outcomes = await mapWithConcurrency(copies, agentTaskCopyConcurrency(settings, task, resolved), async (index) => {
        if (!(await canContinue(run.id, executionId))) throw new Error("Agent Run 已暂停、取消或已由新执行器接管");
        let child = initialChildren[index];
        let taskId = child?.id;
        if (!taskId) {
            const bodyForCopy = {
                ...body,
                context: { ...context, clientRequestId: `${run.clientRequestId}:${task.id}:${attempt}:${index + 1}` },
            };
            const response = await fetchInternalApi(`${origin}${path}`, { method: "POST", headers: runtimeRequestHeaders(cookie, { "Content-Type": "application/json" }), body: JSON.stringify(bodyForCopy), cache: "no-store" });
            if (response.status === 429) {
                const message = toSafeGenerationErrorMessage(new Error(await generationResponseMessage(response, "生成服务暂时繁忙")), "生成服务暂时繁忙");
                const retryAt = retryAfterAt(response.headers);
                if (!retryAt) throw new AgentChildTaskTerminalError(`${message}；上游未提供可安全重试时间，请单独重试此任务`);
                throw new AgentChildTaskCreateRetryError(message, retryAt);
            }
            if (!response.ok) throw new Error(await generationResponseMessage(response, "生成任务创建失败"));
            const payload = (await response.json()) as { task?: { id?: string; needsReview?: boolean } };
            if (payload.task?.needsReview) throw new AgentChildTaskTerminalError("上游提交结果无法确认，系统已停止自动重提以避免重复生成和扣费，请单独重试此任务");
            const createdTaskId = payload.task?.id;
            if (!createdTaskId) throw new Error("生成任务未返回任务 ID");
            taskId = createdTaskId;
            await linkAgentChildTask(run, task, taskId, attempt);
            child = { id: taskId, status: "pending", attempt };
            if (!(await patchTask(run.id, task.id, { taskId, taskIds: [taskId], childTasks: [child] }, "task.created", executionId))) throw new Error("Agent Run 已由新执行器接管");
        }
        try {
            if (child?.status === "completed") {
                const registered = await registerAgentTaskAssets(run, { ...task, title: copies > 1 ? `${task.title} ${index + 1}` : task.title, count: 1, attempts: attempt, result: child.result }, child.result, [taskId]);
                const assetIds = registered.map((asset) => asset.id);
                await patchTask(run.id, task.id, { assetIds }, "task.child.restored", executionId);
                return { index, result: child.result, taskId, assetIds };
            }
            const result = await pollTask(origin, task.type === "video" ? "/api/video-tasks" : path, taskId, cookie, run.id, task.type, executionId);
            const registered = await registerAgentTaskAssets(run, { ...task, title: copies > 1 ? `${task.title} ${index + 1}` : task.title, count: 1, attempts: attempt, result }, result, [taskId]);
            const assetIds = registered.map((asset) => asset.id);
            const completedChild = { id: taskId, status: "completed" as const, attempt: child?.attempt || attempt, result };
            if (!(await patchTask(run.id, task.id, { taskId, taskIds: [taskId], childTasks: [completedChild], assetIds }, "task.child.completed", executionId))) throw new Error("Agent Run 已由新执行器接管");
            return { index, result, taskId, assetIds };
        } catch (error) {
            if (error instanceof AgentChildTaskDeferredError) throw error;
            const message = toSafeGenerationErrorMessage(error, "生成任务失败");
            if (taskId) await patchTask(run.id, task.id, { taskIds: [taskId], childTasks: [{ id: taskId, status: "failed", attempt: child?.attempt || attempt, error: message }] }, "task.child.failed", executionId);
            throw error;
        }
    });
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const completed = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])).sort((left, right) => left.index - right.index);
    const results = completed.map((outcome) => outcome.result);
    return {
        result: results.length === 1 ? results[0] : { results },
        sourceTaskIds: Array.from(new Set([...(task.taskIds || []), ...completed.map((outcome) => outcome.taskId)])),
        assetIds: Array.from(new Set([...(task.assetIds || []), ...completed.flatMap((outcome) => outcome.assetIds)])),
    };
}

function videoReferenceMode(references: AgentRunReference[]) {
    if (references.some((reference) => reference.role === "first_frame") && references.some((reference) => reference.role === "last_frame")) return "首尾帧";
    const images = references.filter((reference) => reference.type === "image").length;
    if (images > 1) return `多帧参考（${images} 张）`;
    if (images === 1) return "单分镜图";
    return references.length ? "多模态参考" : "文生视频";
}

async function textTaskReferenceImages(references: AgentRunReference[], run: AgentRun, origin: string, cookie: string) {
    const images: string[] = [];
    for (const reference of references) {
        if (reference.type === "image") {
            images.push(await inlineAgentReferenceImage(reference.url, origin, cookie));
            continue;
        }
        if (reference.type !== "video") continue;
        const now = Date.now();
        const analysis = await analyzeVideoRemakeSource(
            {
                id: reference.assetId || reference.nodeId || `video-reference-${images.length + 1}`,
                userId: run.userId,
                conversationId: run.conversationId,
                ordinal: images.length,
                type: "video",
                status: "ready",
                title: "Agent 参考视频",
                serverUrl: reference.url.startsWith("/") ? reference.url : undefined,
                remoteUrl: reference.url.startsWith("https://") ? reference.url : undefined,
                metadata: { source: "canvas-video-reference" },
                createdAt: now,
                updatedAt: now,
            },
            origin,
            cookie,
        );
        if (!analysis.storyboardFrames?.length) throw new Error("参考视频没有可用于理解的画面");
        images.push(...analysis.storyboardFrames);
    }
    if (!images.length && references.length) throw new Error("参考素材没有可用于视觉理解的画面");
    return images;
}

async function mapWithConcurrency<R>(count: number, concurrency: number, worker: (index: number) => Promise<R>): Promise<Array<PromiseSettledResult<R> & { index: number }>> {
    const results: Array<PromiseSettledResult<R> & { index: number }> = [];
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, count) }, async () => {
            while (cursor < count) {
                const index = cursor++;
                try {
                    results.push({ index, status: "fulfilled", value: await worker(index) });
                } catch (reason) {
                    results.push({ index, status: "rejected", reason });
                }
            }
        }),
    );
    return results;
}

function retryAfterAt(headers: Headers, now = Date.now()) {
    const value = headers.get("retry-after")?.trim();
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return now + Math.ceil(seconds * 1_000);
    const date = Date.parse(value);
    return Number.isFinite(date) && date > now ? date : undefined;
}

function normalizeChildTasks(task: AgentRunTask): AgentRunChildTask[] {
    if (task.childTasks?.length) return task.childTasks;
    const ids = task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : [];
    return ids.map((id) => ({ id, status: "pending", attempt: Math.max(1, task.attempts) }));
}

export function linkAgentChildTask(run: AgentRun, task: AgentRunTask, taskId: string, attempt: number) {
    return linkStoredGenerationTask(task.type, taskId, {
        conversationId: run.conversationId,
        runId: run.id,
        surface: run.surface,
        projectId: run.projectId,
        parentTaskId: run.id,
        attemptNo: attempt,
    });
}

export function directCanvasTextContent(task: AgentRunTask) {
    if (task.type !== "text") return null;
    const prompt = task.prompt.split(/\n\n(?:严格输出要求|基于画布已有节点|请保持与以下已完成产物一致)：/u)[0]?.trim() || "";
    if (!/(?:文字|文本|内容|文案|标题).{0,16}(?:节点|卡片|便签)|(?:节点|卡片|便签).{0,16}(?:文字|文本|内容|文案|标题)|画布/u.test(prompt)) return null;
    const quoted = prompt.match(/(?:内容|文字|文本|文案|标题)[^“"「『'`]{0,18}(?:写(?:着|成)?|写为|为|是|设置为|设为|改为|改成|填(?:写)?为)[:：\s]*[“"「『'`]([^”"」』'`]{1,500})[”"」』'`]/u);
    if (quoted?.[1]?.trim()) return quoted[1].trim();
    const displayed = prompt.match(/(?:写着|写有|显示|展示)[:：\s]*[“"「『'`]([^”"」』'`]{1,500})[”"」』'`]/u);
    if (displayed?.[1]?.trim()) return displayed[1].trim();
    const plain = prompt.match(/(?:内容|文字|文本|文案|标题)[^，。；;\n]{0,18}(?:写(?:成)?|写为|为|是|设置为|设为|改为|改成|填(?:写)?为)[:：\s]*([^，。；;\n]{1,160})/u);
    return plain?.[1]?.trim() || null;
}

export async function pollTask(origin: string, path: string, taskId: string, cookie: string, runId: string, type: AgentRunTask["type"], executionId: string) {
    void type;
    if (!(await canContinue(runId, executionId))) throw new Error("Agent Run 已暂停、取消或已由新执行器接管");
    let response: Response;
    try {
        response = await fetchInternalApi(`${origin}${path}/${encodeURIComponent(taskId)}`, { headers: runtimeRequestHeaders(cookie), cache: "no-store" });
    } catch (error) {
        throw new AgentChildTaskDeferredError(error instanceof Error ? error.message : "生成任务查询暂时不可用");
    }
    if (!response.ok) {
        if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new AgentChildTaskDeferredError("生成任务查询暂时不可用");
        throw new AgentChildTaskTerminalError((await response.text()) || "生成任务查询失败");
    }
    let payload: { task?: { status?: string; result?: unknown; error?: string; needsReview?: boolean } };
    try {
        payload = (await response.json()) as typeof payload;
    } catch {
        throw new AgentChildTaskDeferredError("生成任务状态暂时无法解析");
    }
    if (payload.task?.needsReview) throw new AgentChildTaskTerminalError("上游提交结果无法确认，系统已停止等待以避免重复生成和扣费，请单独重试此任务");
    const terminal = agentChildTaskTerminal(payload.task?.status);
    if (terminal === "success") return payload.task?.result;
    if (terminal === "error") throw new AgentChildTaskTerminalError(payload.task?.error || "生成任务失败");
    if (terminal === "cancelled") throw new AgentChildTaskTerminalError(payload.task?.error || "生成任务已取消");
    throw new AgentChildTaskDeferredError("生成任务仍在处理中");
}

export async function patchTask(runId: string, taskId: string, patch: Partial<AgentRunTask>, eventType: string, executionId: string) {
    return updateAgentRunTaskById(runId, taskId, patch, eventType, executionId);
}

function runtimeRequestHeaders(cookie: string, initial?: HeadersInit) {
    const headers = new Headers(initial);
    const workerHeaders = maintenanceWorkerContextHeaders(cookie);
    if (workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
    else if (cookie) headers.set("cookie", cookie);
    return headers;
}
