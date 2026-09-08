import type { CreativeFoundation } from "@/lib/creative-agent-contract";
import type { CreativeGenerationMode, CreativeProjectHandoffPlan } from "@/lib/creative-runtime-contract";
import type { AgentRunTask } from "@/lib/server/agent-run-store";
import { agentTaskResultItems } from "@/lib/server/agent-run-result-items";

export type AgentPlan = {
    intent?: "conversation" | "generation";
    objective: string;
    audience?: string;
    reply?: string;
    skillIds?: string[];
    decisions?: Array<{ label: string; value: string; reason: string }>;
    foundation: CreativeFoundation;
    brand?: { summary?: string; colors?: string[]; visualKeywords?: string[] };
    projectHandoff?: CreativeProjectHandoffPlan;
    deliverables: Array<{
        id?: string;
        targetNodeId?: string;
        title: string;
        type: "text" | "image" | "video" | "audio";
        model?: string;
        prompt: string;
        count?: number;
        ratio?: string;
        quality?: string;
        seconds?: number;
        voice?: string;
        format?: string;
        generateAudio?: boolean;
        watermark?: boolean;
        speed?: number;
        dependencies?: string[];
        assetIds?: string[];
    }>;
};

export function validateAgentPlan(value: unknown): asserts value is AgentPlan {
    const plan = value as AgentPlan;
    if (!plan?.objective?.trim() || !Array.isArray(plan.deliverables)) throw new Error("模型返回的创作计划无效");
    if (plan.skillIds !== undefined && (!Array.isArray(plan.skillIds) || plan.skillIds.some((id) => typeof id !== "string" || !id.trim()))) throw new Error("模型返回的技能选择无效");
    if (plan.intent === "conversation") {
        if (!plan.reply?.trim() || plan.deliverables.length || plan.projectHandoff) throw new Error("模型返回的对话结果无效");
        return;
    }
    if (!plan.deliverables.length && !plan.projectHandoff) throw new Error("模型返回的创作计划无效");
    if (
        plan.projectHandoff &&
        (!["canvas", "drama"].includes(plan.projectHandoff.surface) ||
            !plan.projectHandoff.title?.trim() ||
            (plan.projectHandoff.ratio !== undefined && plan.projectHandoff.ratio !== "9:16" && plan.projectHandoff.ratio !== "16:9") ||
            (plan.projectHandoff.assetIds !== undefined && (!Array.isArray(plan.projectHandoff.assetIds) || plan.projectHandoff.assetIds.some((id) => typeof id !== "string" || !id.trim()))))
    )
        throw new Error("模型返回的项目交接参数无效");
    if (
        plan.deliverables.some(
            (item) =>
                !item?.title?.trim() ||
                !item?.prompt?.trim() ||
                !["text", "image", "video", "audio"].includes(item.type) ||
                (item.count !== undefined && (!Number.isSafeInteger(Number(item.count)) || Number(item.count) <= 0)) ||
                (item.seconds !== undefined && (!Number.isFinite(Number(item.seconds)) || Number(item.seconds) <= 0)) ||
                (item.generateAudio !== undefined && typeof item.generateAudio !== "boolean") ||
                (item.watermark !== undefined && typeof item.watermark !== "boolean") ||
                (item.speed !== undefined && (!Number.isFinite(Number(item.speed)) || Number(item.speed) <= 0)) ||
                (item.assetIds !== undefined && (!Array.isArray(item.assetIds) || item.assetIds.some((id) => typeof id !== "string" || !id.trim()))),
        )
    )
        throw new Error("模型返回的任务参数无效");
    if (plan.decisions && (!Array.isArray(plan.decisions) || plan.decisions.some((item) => !item?.label?.trim() || !item?.value?.trim() || !item?.reason?.trim()))) throw new Error("模型返回的决策摘要无效");
    const ids = new Set(plan.deliverables.map((item, index) => item.id?.trim() || `task-${index}`));
    if (ids.size !== plan.deliverables.length || plan.deliverables.some((item) => item.dependencies?.some((dependency) => typeof dependency !== "string" || !ids.has(dependency.trim())))) throw new Error("模型返回的任务依赖无效");
    assertAcyclicDependencies(plan);
}

export function validateAgentPlanGenerationMode(plan: AgentPlan, mode?: CreativeGenerationMode) {
    if (!mode) return;
    const deliverables = plan.deliverables;
    const validVideoStoryboard =
        mode === "video" &&
        deliverables.some((item) => item.type === "video") &&
        deliverables.every((item, index) => {
            if (item.type === "video") return true;
            const id = item.id?.trim() || `task-${index}`;
            return item.type === "image" && deliverables.some((video) => video.type === "video" && video.dependencies?.includes(id));
        });
    if (plan.intent === "conversation" || plan.projectHandoff || !deliverables.length || (!validVideoStoryboard && deliverables.some((item) => item.type !== mode))) throw new Error("模型返回的创作类型与用户选择不一致");
}

export function validateAgentTaskResult(type: AgentPlan["deliverables"][number]["type"], value: unknown) {
    if (!value || typeof value !== "object") throw new Error("生成任务完成但没有返回有效产物");
    const items = agentTaskResultItems(value);
    if (type === "text" && !items.some((item) => typeof item.content === "string" && item.content.trim())) throw new Error("文本任务没有返回有效内容");
    if (type !== "text" && !items.some(validMediaRecord)) throw new Error(`${type === "image" ? "图片" : type === "video" ? "视频" : "音频"}任务没有返回有效产物`);
}

export function agentTaskCopies(type: AgentPlan["deliverables"][number]["type"], count: number) {
    return type === "image" || type === "video" ? Math.max(1, Number.isSafeInteger(Number(count)) ? Math.floor(Number(count)) : 1) : 1;
}

export function resolveAgentTaskCount(type: AgentPlan["deliverables"][number]["type"], planned: unknown, skillDefault: unknown, canvasDefault: unknown) {
    if (type !== "image" && type !== "video") return 1;
    const value = Number(planned) || Number(skillDefault) || Number(canvasDefault) || 1;
    return Math.max(1, Number.isSafeInteger(value) ? Math.floor(value) : 1);
}

export function resolveAgentVideoSeconds(type: AgentPlan["deliverables"][number]["type"], planned: unknown, skillDefault: unknown, backendDefault: unknown) {
    if (type !== "video") return undefined;
    const value = [planned, skillDefault, backendDefault].map(Number).find((item) => Number.isFinite(item) && item > 0) || 5;
    return Math.max(1, Math.floor(value));
}

export type AgentVideoDurationCapability = {
    minSeconds: number;
    maxSeconds: number;
    /** Provider-declared discrete durations, when it does not accept a range. */
    durationOptions?: number[];
    maxReferenceImages?: number;
};

type StoryboardVideoCandidate = {
    task: AgentRunTask;
    imageDependency: string;
    capability: AgentVideoDurationCapability;
};

type StoryboardSegmentSource = {
    candidate: StoryboardVideoCandidate;
    seconds: number;
};

type StoryboardSegment = {
    sources: StoryboardSegmentSource[];
    seconds: number;
};

/**
 * A Skill planner may describe one image dependency per shot, but that is not
 * a provider submission contract.  Consolidate compatible storyboard shots
 * into continuous video segments after the selected model's real duration and
 * reference limits have resolved.  Direct single-video requests never enter
 * this path.
 */
export function segmentSkillStoryboardVideoTasks(
    tasks: AgentRunTask[],
    input: {
        totalSeconds?: unknown;
        resolveCapability: (task: AgentRunTask) => AgentVideoDurationCapability | null;
    },
) {
    const imageIds = new Set(tasks.filter((task) => task.type === "image").map((task) => task.id));
    const candidates = tasks.flatMap((task) => {
        const imageDependencies = task.type === "video" ? task.dependencies.filter((id) => imageIds.has(id)) : [];
        const capability = imageDependencies.length === 1 && task.count === 1 && !hasExplicitFrameReference(task) ? input.resolveCapability(task) : null;
        return capability && capability.maxSeconds >= capability.minSeconds && Math.max(0, capability.maxReferenceImages || 0) > 1 ? [{ task, imageDependency: imageDependencies[0]!, capability }] : [];
    });
    if (candidates.length < 2) return tasks;

    const totalHint = positiveInteger(input.totalSeconds);
    const replacements = new Map<string, AgentRunTask[]>();
    const consumed = new Set<string>();
    for (let start = 0; start < candidates.length;) {
        const first = candidates[start]!;
        const run = [first];
        while (start + run.length < candidates.length && sameStoryboardVideoContract(first, candidates[start + run.length]!)) run.push(candidates[start + run.length]!);
        start += run.length;
        const grouped = buildStoryboardSegments(run, run.length === candidates.length ? totalHint : undefined, new Set(tasks.map((task) => task.id)), new Set());
        if (!storyboardSegmentsChanged(grouped, run)) continue;
        replacements.set(first.task.id, grouped);
        run.slice(1).forEach((candidate) => consumed.add(candidate.task.id));
    }
    if (!replacements.size) return tasks;
    return tasks.flatMap((task) => (replacements.get(task.id) ? replacements.get(task.id)! : consumed.has(task.id) ? [] : [task]));
}

/**
 * Storyboard videos may keep their own image dependency for reference binding,
 * but the whole storyboard image batch is an execution barrier.  This keeps
 * image generation parallel while preventing image-1 -> video-1 interleaving.
 */
export function stageStoryboardAgentTasks(tasks: AgentRunTask[]) {
    const storyboardIds = new Set(
        tasks
            .filter((task) => task.type === "image")
            .filter((image) => tasks.some((task) => task.type === "video" && task.dependencies.includes(image.id)))
            .map((task) => task.id),
    );
    if (!storyboardIds.size) return tasks;
    const stagedVideoIds = new Set(tasks.filter((task) => task.type === "video" && task.dependencies.some((id) => storyboardIds.has(id))).map((task) => task.id));
    const stageDependencies = Array.from(storyboardIds);
    const withBarrier = tasks.map((task) => (stagedVideoIds.has(task.id) ? { ...task, stageDependencies } : task));
    return [...withBarrier.filter((task) => storyboardIds.has(task.id)), ...withBarrier.filter((task) => !storyboardIds.has(task.id) && !stagedVideoIds.has(task.id)), ...withBarrier.filter((task) => stagedVideoIds.has(task.id))];
}

function buildStoryboardSegments(candidates: StoryboardVideoCandidate[], totalHint: number | undefined, existingIds: Set<string>, usedOutputIds: Set<string>) {
    const baseCapability = candidates[0]!.capability;
    const reservedImageReferences = new Set(candidates.flatMap((candidate) => (candidate.task.references || []).filter((reference) => reference.type === "image").map((reference) => reference.url))).size;
    const maxReferenceImages = Math.max(0, (baseCapability.maxReferenceImages || 0) - reservedImageReferences);
    if (!maxReferenceImages) return candidates.map((candidate) => candidate.task);
    const capability = { ...baseCapability, maxReferenceImages };
    const durations = storyboardShotDurations(candidates, totalHint);
    const sources = candidates.flatMap((candidate, index) => splitStoryboardSource(candidate, durations[index]!, capability));
    const totalSeconds = sources.reduce((total, source) => total + source.seconds, 0);
    const groups = totalSeconds <= capability.maxSeconds && uniqueStoryboardImages(sources).size <= (capability.maxReferenceImages || 1) ? [{ sources, seconds: totalSeconds }] : partitionStoryboardSources(sources, capability);
    const normalized = normalizeStoryboardSegmentSeconds(groups, capability);
    return groups.map((group, index) => buildStoryboardSegmentTask(group, normalized[index]!, index, groups.length, existingIds, usedOutputIds));
}

function storyboardShotDurations(candidates: StoryboardVideoCandidate[], totalHint?: number) {
    const planned = candidates.map((candidate) => positiveInteger(candidate.task.seconds) || 1);
    const plannedTotal = planned.reduce((total, seconds) => total + seconds, 0);
    const repeatedTotal = Boolean(totalHint && planned.length > 1 && planned.every((seconds) => seconds === totalHint));
    const target = repeatedTotal ? totalHint! : plannedTotal || totalHint || candidates.length;
    const weights = repeatedTotal ? candidates.map(() => 1) : planned;
    return distributeIntegerSeconds(target, weights);
}

function splitStoryboardSource(candidate: StoryboardVideoCandidate, seconds: number, capability: AgentVideoDurationCapability): StoryboardSegmentSource[] {
    const requested = Math.max(1, seconds);
    const parts = Math.max(1, Math.ceil(requested / capability.maxSeconds));
    if (parts === 1) return [{ candidate, seconds: requested }];
    const normalizedTotal = Math.max(requested, parts * capability.minSeconds);
    return distributeIntegerSeconds(
        normalizedTotal,
        Array.from({ length: parts }, () => 1),
    ).map((partSeconds) => ({ candidate, seconds: partSeconds }));
}

function partitionStoryboardSources(sources: StoryboardSegmentSource[], capability: AgentVideoDurationCapability): StoryboardSegment[] {
    const segments: StoryboardSegment[] = [];
    let current: StoryboardSegment = { sources: [], seconds: 0 };
    sources.forEach((source) => {
        const imageCount = uniqueStoryboardImages([...current.sources, source]).size;
        const exceedsLimit = current.seconds + source.seconds > capability.maxSeconds || imageCount > (capability.maxReferenceImages || 1);
        const previous = current.sources.at(-1);
        const sceneBoundary = Boolean(previous && current.seconds >= capability.minSeconds && hasStoryboardSceneBoundary(previous.candidate.task, source.candidate.task));
        if (current.sources.length && (exceedsLimit || sceneBoundary)) {
            segments.push(current);
            current = { sources: [], seconds: 0 };
        }
        current.sources.push(source);
        current.seconds += source.seconds;
    });
    if (current.sources.length) segments.push(current);
    return segments;
}

function normalizeStoryboardSegmentSeconds(segments: StoryboardSegment[], capability: AgentVideoDurationCapability) {
    const seconds = segments.map((segment) => Math.max(1, Math.min(capability.maxSeconds, segment.seconds)));
    for (let index = 0; index < seconds.length; index += 1) {
        const shortage = capability.minSeconds - seconds[index]!;
        if (shortage <= 0) continue;
        const donorIndex = seconds.findIndex((value, candidateIndex) => candidateIndex !== index && value - capability.minSeconds >= shortage);
        if (donorIndex >= 0) {
            seconds[donorIndex]! -= shortage;
            seconds[index]! += shortage;
        } else {
            seconds[index] = capability.minSeconds;
        }
    }
    const options = Array.from(new Set(capability.durationOptions || []))
        .filter((value) => value >= capability.minSeconds && value <= capability.maxSeconds)
        .sort((left, right) => left - right);
    return options.length ? seconds.map((value) => options.find((option) => option >= value) || options.at(-1)!) : seconds;
}

function buildStoryboardSegmentTask(segment: StoryboardSegment, seconds: number, index: number, total: number, existingIds: Set<string>, usedOutputIds: Set<string>): AgentRunTask {
    const sourceTasks = uniqueSourceTasks(segment.sources);
    const first = sourceTasks[0]!;
    const last = sourceTasks.at(-1)!;
    if (segment.sources.length === 1 && sourceTasks.length === 1 && seconds === first.seconds) {
        usedOutputIds.add(first.id);
        return first;
    }
    const optimizedPrompt = sourceTasks.length === 1 ? first.optimizedPrompt || first.prompt : sourceTasks.map((task, sourceIndex) => `【分镜 ${sourceIndex + 1}】${task.optimizedPrompt || task.prompt}`).join("\n");
    const suffix = first.optimizedPrompt && first.prompt.startsWith(first.optimizedPrompt) ? first.prompt.slice(first.optimizedPrompt.length) : "";
    const id = !usedOutputIds.has(first.id) ? first.id : uniqueTaskId(`${first.id}-segment-${index + 1}`, existingIds);
    existingIds.add(id);
    usedOutputIds.add(id);
    return {
        ...first,
        id,
        title: sourceTasks.length > 1 ? `视频片段 ${index + 1}/${total}｜${first.title} → ${last.title}` : total > 1 ? `视频片段 ${index + 1}/${total}｜${first.title}` : first.title,
        optimizedPrompt,
        prompt: `${optimizedPrompt}${suffix}\n\n导演分段：本视频连续覆盖以上分镜，保持人物、场景、镜头语言与转场衔接；时长 ${seconds} 秒。`,
        count: 1,
        seconds,
        references: mergeStoryboardReferences(sourceTasks),
        dependencies: Array.from(new Set(sourceTasks.flatMap((task) => task.dependencies))),
        stageDependencies: undefined,
    };
}

function distributeIntegerSeconds(total: number, weights: number[]) {
    const safeTotal = Math.max(1, Math.floor(total));
    const requestedWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
    const safeWeights = requestedWeights.some(Boolean) ? requestedWeights : requestedWeights.map(() => 1);
    const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
    const raw = safeWeights.map((weight) => (safeTotal * weight) / weightTotal);
    const values = raw.map(Math.floor);
    let remaining = safeTotal - values.reduce((sum, value) => sum + value, 0);
    raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
        .forEach(({ index }) => {
            if (remaining <= 0) return;
            values[index]! += 1;
            remaining -= 1;
        });
    return values;
}

function sameStoryboardVideoContract(left: StoryboardVideoCandidate, right: StoryboardVideoCandidate) {
    return (
        left.task.model === right.task.model &&
        left.task.ratio === right.task.ratio &&
        left.task.quality === right.task.quality &&
        left.task.generateAudio === right.task.generateAudio &&
        left.task.watermark === right.task.watermark &&
        left.capability.minSeconds === right.capability.minSeconds &&
        left.capability.maxSeconds === right.capability.maxSeconds &&
        left.capability.durationOptions?.join(",") === right.capability.durationOptions?.join(",") &&
        left.capability.maxReferenceImages === right.capability.maxReferenceImages
    );
}

function hasExplicitFrameReference(task: AgentRunTask) {
    return task.references?.some((reference) => reference.role === "first_frame" || reference.role === "last_frame") || false;
}

function hasStoryboardSceneBoundary(left: AgentRunTask, right: AgentRunTask) {
    const continuous = /同一场景|连续镜头|无切换|接续/u;
    // Do not split merely because every planner title says “场景 1/2/3”.  A
    // boundary must be an explicit editorial transition or a clearly new
    // space/time, otherwise the duration/reference contract decides grouping.
    const boundary = /转场|(?:镜头|画面)?切换|切入|切至|切到|场景(?:转换|切换)|(?:进入|来到)(?:新的?|另一(?:个)?)?(?:场景|空间)|离开(?:当前|原)?(?:场景|空间)|(?:时间|时空)(?:跳转|推进|切换)|翌日|第二天/u;
    const leftText = `${left.title}\n${left.optimizedPrompt || left.prompt}`;
    const rightText = `${right.title}\n${right.optimizedPrompt || right.prompt}`;
    return !continuous.test(leftText) && !continuous.test(rightText) && boundary.test(rightText);
}

function uniqueStoryboardImages(sources: StoryboardSegmentSource[]) {
    return new Set(sources.map((source) => source.candidate.imageDependency));
}

function uniqueSourceTasks(sources: StoryboardSegmentSource[]) {
    return Array.from(new Map(sources.map((source) => [source.candidate.task.id, source.candidate.task])).values());
}

function mergeStoryboardReferences(tasks: AgentRunTask[]) {
    const references = new Map<string, NonNullable<AgentRunTask["references"]>[number]>();
    tasks
        .flatMap((task) => task.references || [])
        .forEach((reference) => {
            const key = `${reference.type}:${reference.url}`;
            const current = references.get(key);
            const role = current?.role === "first_frame" || current?.role === "last_frame" ? current.role : reference.role;
            references.set(key, { ...reference, ...current, ...(role ? { role } : {}) });
        });
    return Array.from(references.values());
}

function uniqueTaskId(seed: string, existing: Set<string>) {
    let id = seed;
    let suffix = 2;
    while (existing.has(id)) {
        id = `${seed}-${suffix}`;
        suffix += 1;
    }
    return id;
}

function storyboardSegmentsChanged(segments: AgentRunTask[], candidates: StoryboardVideoCandidate[]) {
    return segments.length !== candidates.length || segments.some((task, index) => task.id !== candidates[index]?.task.id || task.seconds !== candidates[index]?.task.seconds || task.dependencies.length !== candidates[index]?.task.dependencies.length);
}

function positiveInteger(value: unknown) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function assertAcyclicDependencies(plan: AgentPlan) {
    const dependencies = new Map(plan.deliverables.map((item, index) => [item.id?.trim() || `task-${index}`, (item.dependencies || []).map((dependency) => dependency.trim())]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error("模型返回的任务依赖存在循环");
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of dependencies.get(id) || []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of dependencies.keys()) visit(id);
}

export function agentChildTaskTerminal(status: unknown): "success" | "error" | "cancelled" | null {
    const value = typeof status === "string" ? status.trim().toLowerCase() : "";
    if (value === "success") return "success";
    if (value === "error") return "error";
    if (value === "cancelled" || value === "canceled") return "cancelled";
    return null;
}

function validMediaRecord(value: unknown) {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return [record.dataUrl, record.url, record.remoteUrl, record.serverUrl].some((item) => typeof item === "string" && item.trim());
}
