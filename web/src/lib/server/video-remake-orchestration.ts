import type { AgentSkill } from "@/lib/auth/store-types";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { AgentRunTask } from "@/lib/server/agent-run-store";
import type { AgentPlan } from "@/lib/server/agent-run-validation";
import { isVideoRemakeSkillId, VIDEO_REMAKE_COMPOSE_TASK_ID, VIDEO_REMAKE_MAX_SEGMENT_SECONDS } from "@/lib/server/agent-skills/video-remake";
import { isMinimaxH3StructuredPrompt } from "@/lib/server/minimax-h3-prompt-compiler";

export type VideoRemakeBoundaryKind = "hard_cut" | "transition" | "action_end" | "beat" | "dialogue" | "continuous_action";
export type VideoRemakeBoundary = { atSeconds: number; kind: VideoRemakeBoundaryKind };
export type VideoRemakeSegment = { index: number; startSeconds: number; endSeconds: number; seconds: number; boundaryKind?: VideoRemakeBoundaryKind };

const COMPOSE_MODEL = "__octaflow_video_compose__";

export function selectedVideoRemakeSkill(skills: AgentSkill[]) {
    return skills.find((skill) => isVideoRemakeSkillId(skill.id));
}

export function planVideoRemakeSegments(totalSeconds: number, boundaries: VideoRemakeBoundary[] = [], maxSeconds = VIDEO_REMAKE_MAX_SEGMENT_SECONDS): VideoRemakeSegment[] {
    const total = positiveSeconds(totalSeconds);
    const max = positiveSeconds(maxSeconds);
    if (total <= max) return [{ index: 1, startSeconds: 0, endSeconds: total, seconds: total }];

    const points = uniquePoints([
        { atSeconds: 0, kind: "hard_cut" as const },
        ...boundaries.filter((item) => item.atSeconds > 0 && item.atSeconds < total),
        ...Array.from({ length: Math.floor(total / max) }, (_, index) => ({ atSeconds: Math.min(total, (index + 1) * max), kind: "beat" as const })),
        { atSeconds: total, kind: "hard_cut" as const },
    ]);
    const costs = new Array(points.length).fill(Number.POSITIVE_INFINITY);
    const previous = new Array<number>(points.length).fill(-1);
    costs[0] = 0;
    for (let end = 1; end < points.length; end += 1) {
        for (let start = 0; start < end; start += 1) {
            const duration = points[end].atSeconds - points[start].atSeconds;
            if (duration <= 0 || duration > max) continue;
            const cost = costs[start] + 100 + boundaryPenalty(points[end].kind) + shortSegmentPenalty(duration, max);
            if (cost < costs[end]) {
                costs[end] = cost;
                previous[end] = start;
            }
        }
    }
    if (previous.at(-1) === -1) return fallbackSegments(total, max);
    const selected: number[] = [];
    for (let cursor = points.length - 1; cursor > 0; cursor = previous[cursor]) selected.unshift(cursor);
    let start = 0;
    return selected.map((pointIndex, index) => {
        const end = points[pointIndex].atSeconds;
        const segment = { index: index + 1, startSeconds: start, endSeconds: end, seconds: roundSeconds(end - start), ...(end < total ? { boundaryKind: points[pointIndex].kind } : {}) };
        start = end;
        return segment;
    });
}

export function normalizeVideoRemakePlan(plan: AgentPlan, skills: AgentSkill[], assets: CreativeAsset[], requestPrompt: string): AgentPlan {
    if (!selectedVideoRemakeSkill(skills)) return plan;
    const sourceVideo = assets.find((asset) => asset.type === "video" && asset.status === "ready");
    if (!sourceVideo) throw new Error("视频复刻 Skill 需要先上传一条参考视频");

    const deliverables = plan.deliverables.filter((item) => item.id !== VIDEO_REMAKE_COMPOSE_TASK_ID);
    const imageTasks = deliverables.filter((item) => item.type === "image");
    const safeImageTasks = imageTasks.length ? imageTasks : fallbackAssetTasks(requestPrompt);
    const nonVideoTasks = deliverables.filter((item) => item.type !== "video" && item.type !== "image");
    const plannedVideos = deliverables.filter((item) => item.type === "video");
    const totalSeconds = resolveRemakeDurationSeconds(sourceVideo, plannedVideos, requestPrompt);
    const videoTasks = normalizeRemakeVideos(plannedVideos, totalSeconds, safeImageTasks, sourceVideo.id, requestPrompt, sourceBoundaries(sourceVideo));
    const composeDependencies = videoTasks.map((item) => item.id!).filter(Boolean);
    const composeTask: AgentPlan["deliverables"][number] = {
        id: VIDEO_REMAKE_COMPOSE_TASK_ID,
        title: "复刻成片",
        type: "video",
        prompt: "按镜头顺序无损衔接全部已完成视频片段，保留每段原始画面与声音，不重复、不丢帧、不改变人物比例。",
        count: 1,
        ratio: videoTasks[0]?.ratio || plannedVideos[0]?.ratio || "9:16",
        seconds: roundSeconds(videoTasks.reduce((sum, item) => sum + positiveSeconds(item.seconds || 0), 0)),
        dependencies: composeDependencies,
        assetIds: [],
    };
    return { ...plan, skillIds: skills.map((skill) => skill.id), deliverables: [...nonVideoTasks, ...safeImageTasks, ...videoTasks, composeTask] };
}

export function finalizeVideoRemakeTasks(tasks: AgentRunTask[], skills: AgentSkill[]) {
    if (!selectedVideoRemakeSkill(skills)) return tasks;
    return tasks.map((task) => (task.id === VIDEO_REMAKE_COMPOSE_TASK_ID ? { ...task, model: COMPOSE_MODEL, optimizedPrompt: undefined } : task));
}

export function isVideoRemakeComposeTask(task: Pick<AgentRunTask, "id" | "model">) {
    return task.id === VIDEO_REMAKE_COMPOSE_TASK_ID && task.model === COMPOSE_MODEL;
}

function normalizeRemakeVideos(planned: AgentPlan["deliverables"], totalSeconds: number, imageTasks: AgentPlan["deliverables"], sourceVideoId: string, requestPrompt: string, sourceCuts: VideoRemakeBoundary[]) {
    type Deliverable = AgentPlan["deliverables"][number];
    const imageDependencies = imageTasks.map((item, index) => item.id?.trim() || `remake-asset-${index + 1}`);
    const existing = planned.map((item, index) => ({ ...item, id: item.id?.trim() || `remake-segment-${index + 1}` }));
    const originalVideoIds = new Set(existing.map((item) => item.id));
    const plannedTotal = existing.reduce((sum, item) => sum + positiveSeconds(item.seconds || 0), 0);
    const requestedTotal = Math.max(totalSeconds, plannedTotal);
    const basePrompt = existing[0]?.prompt || requestPrompt;
    let cursor = 0;
    const plannedSource: Deliverable[] = existing.length ? existing : [{ title: "复刻视频片段", type: "video", prompt: basePrompt, seconds: requestedTotal }];
    const source = plannedSource.flatMap<Deliverable>((item, itemIndex) => {
        const duration = positiveSeconds(item.seconds || (plannedSource.length === 1 ? requestedTotal : VIDEO_REMAKE_MAX_SEGMENT_SECONDS));
        const localCuts = sourceCuts.filter((cut) => cut.atSeconds > cursor && cut.atSeconds < cursor + duration).map((cut) => ({ ...cut, atSeconds: cut.atSeconds - cursor }));
        const segments = planVideoRemakeSegments(duration, localCuts.length ? localCuts : extractBoundaries(item.prompt));
        const startOffset = cursor;
        cursor += duration;
        if (segments.length === 1 && duration <= VIDEO_REMAKE_MAX_SEGMENT_SECONDS) return [{ ...item, id: item.id || `remake-segment-${itemIndex + 1}` }];
        return segments.map((segment, segmentIndex) => {
            const start = startOffset + segment.startSeconds;
            const end = startOffset + segment.endSeconds;
            const precedingBoundary = segmentIndex > 0 ? segments[segmentIndex - 1].boundaryKind : undefined;
            const plannerRequestedContinuity = itemIndex > 0 && (item.dependencies || []).some((dependency) => originalVideoIds.has(dependency));
            const continuityRequired = plannerRequestedContinuity || precedingBoundary === "beat" || precedingBoundary === "dialogue" || precedingBoundary === "continuous_action";
            return {
                ...item,
                id: `remake-segment-${itemIndex + 1}-${segment.index}`,
                title: `复刻片段 ${itemIndex + 1}.${segment.index} · ${formatSecond(start)}–${formatSecond(end)}`,
                prompt: `${item.prompt}\nSource structure window: ${formatSecond(start)} to ${formatSecond(end)}. End only at the stated semantic boundary; preserve the next segment's action and screen-direction continuity.\nContinuity from previous generated segment: ${continuityRequired ? "required" : "not required at this semantic cut"}.`,
                seconds: segment.seconds,
            };
        });
    });

    let previousVideoId = "";
    return source.map((item, index) => {
        const id = item.id || `remake-segment-${index + 1}`;
        const continuityRequired = /Continuity from previous generated segment:\s*required/i.test(item.prompt);
        const dependencies = Array.from(new Set([...(item.dependencies || []).filter((dependency) => !originalVideoIds.has(dependency)), ...imageDependencies, ...(continuityRequired && previousVideoId ? [previousVideoId] : [])]));
        previousVideoId = id;
        return {
            ...item,
            id,
            title: item.title || `复刻片段 ${index + 1}`,
            seconds: Math.min(VIDEO_REMAKE_MAX_SEGMENT_SECONDS, positiveSeconds(item.seconds || totalSeconds)),
            count: 1,
            dependencies,
            assetIds: Array.from(new Set([sourceVideoId, ...(item.assetIds || [])])),
            prompt: compileH3RefPrompt(item.prompt, index + 1, Math.min(VIDEO_REMAKE_MAX_SEGMENT_SECONDS, positiveSeconds(item.seconds || totalSeconds))),
        };
    });
}

function sourceBoundaries(asset: CreativeAsset): VideoRemakeBoundary[] {
    const analysis = asset.metadata.videoRemakeAnalysis;
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return [];
    const boundaries = (analysis as { boundaries?: unknown }).boundaries;
    if (!Array.isArray(boundaries)) return [];
    return boundaries.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const boundary = value as Record<string, unknown>;
        const atSeconds = Number(boundary.atSeconds);
        const kind = boundary.kind;
        return Number.isFinite(atSeconds) && atSeconds > 0 && ["hard_cut", "transition", "action_end", "beat", "dialogue", "continuous_action"].includes(String(kind)) ? [{ atSeconds, kind: kind as VideoRemakeBoundaryKind }] : [];
    });
}

function fallbackAssetTasks(requestPrompt: string): AgentPlan["deliverables"] {
    return [
        {
            id: "remake-asset-character",
            title: "全新角色基准图",
            type: "image",
            prompt: `${requestPrompt}\n建立与原作者身份无关的全新人物选角与角色基准图，清楚呈现脸部、体态、发型、服装、关键道具和多角度一致性。`,
            count: 1,
            ratio: "3:4",
            quality: "high",
            dependencies: [],
            assetIds: [],
        },
        {
            id: "remake-asset-scene",
            title: "全新场景基准图",
            type: "image",
            prompt: `${requestPrompt}\n建立不含原品牌、原水印和原场地识别信息的全新场景基准图，明确空间关系、主光方向、色温、材质和可持续复用的机位。`,
            count: 1,
            ratio: "9:16",
            quality: "high",
            dependencies: [],
            assetIds: [],
        },
    ];
}

function compileH3RefPrompt(prompt: string, index: number, seconds: number) {
    if (isMinimaxH3StructuredPrompt(prompt)) return prompt;
    return `subject_definitions:\n<Video 1> is the source video used only as a weak reference for cut timing, pacing, camera grammar, and transition structure.\n<Subject 1> is the newly generated replacement cast, environment, wardrobe, props, and brand-safe visual identity supplied by the dependency assets.\n\nsummary:\n[reference generation] The target is original segment ${index} of an OctalFlow remake. It follows <Video 1>'s general structural rhythm while depicting only <Subject 1> and newly created content.\n\nretention_analysis:\n<Video 1> (cut timing, pacing, and camera grammar): weak_reference - preserve only transferable structural relationships; do not preserve faces, voices, brands, watermarks, music, dialogue wording, or uniquely expressive imagery.\n<Subject 1> (throughout the segment): fully_preserved - maintain the replacement identity, wardrobe, props, spatial layout, lighting direction, and screen direction across the full ${seconds.toFixed(2)} seconds.\n\nDetailed director brief: ${prompt}\n\ndetailed_description:\n[Shot 1] Live-action, cinematic. Execute the director brief as a continuous ${seconds.toFixed(2)}-second audiovisual segment. Establish the replacement subject, environment, composition, action state, camera position, lens behavior, and lighting immediately. Use only motivated cuts or camera movement. Continue naturally from the previous segment when dependency media is present, and finish on an action, gaze, composition, screen direction, and sound state that can connect directly into the next segment.\n\noverall_soundscape: Use newly recorded or generated ambience and synchronized physical sounds that match the replacement scene. Do not copy the source video's voiceprint, dialogue signal, music, watermark audio, or branded sonic identity.\n\nnon_diegetic_music: Use an original instrumental bed only when required by the director brief; otherwise N/A.`;
}

function resolveRemakeDurationSeconds(source: CreativeAsset, planned: AgentPlan["deliverables"], prompt: string) {
    const fromAsset = Number(source.durationMs) / 1_000;
    if (Number.isFinite(fromAsset) && fromAsset > 0) return roundSeconds(fromAsset);
    const fromPrompt = Number(prompt.match(/(?:总时长|时长|duration)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*秒/i)?.[1]);
    if (Number.isFinite(fromPrompt) && fromPrompt > 0) return roundSeconds(fromPrompt);
    const fromPlan = planned.reduce((sum, item) => sum + positiveSeconds(item.seconds || 0), 0);
    return fromPlan || VIDEO_REMAKE_MAX_SEGMENT_SECONDS;
}

function extractBoundaries(value: string): VideoRemakeBoundary[] {
    return Array.from(value.matchAll(/(?:At\s+)?(?:(\d{1,2}):)?(\d{1,2})[:.](\d{2,3})|(?:边界|切点|cut)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*s?/gi)).flatMap((match) => {
        const seconds = match[4] ? Number(match[4]) : Number(match[1] || 0) * 60 + Number(match[2] || 0) + Number(`0.${match[3] || 0}`);
        return Number.isFinite(seconds) && seconds > 0 ? [{ atSeconds: seconds, kind: "transition" as const }] : [];
    });
}

function uniquePoints(points: VideoRemakeBoundary[]) {
    const byTime = new Map<number, VideoRemakeBoundary>();
    for (const point of points) {
        const atSeconds = roundSeconds(point.atSeconds);
        const current = byTime.get(atSeconds);
        if (!current || boundaryPenalty(point.kind) < boundaryPenalty(current.kind)) byTime.set(atSeconds, { atSeconds, kind: point.kind });
    }
    return Array.from(byTime.values()).sort((left, right) => left.atSeconds - right.atSeconds);
}

function boundaryPenalty(kind: VideoRemakeBoundaryKind) {
    return { hard_cut: -120, transition: -60, action_end: -40, beat: 100, dialogue: 220, continuous_action: 360 }[kind];
}

function shortSegmentPenalty(duration: number, max: number) {
    return duration < max / 3 ? Math.round((max / 3 - duration) * 40) : 0;
}

function fallbackSegments(total: number, max: number) {
    const result: VideoRemakeSegment[] = [];
    let start = 0;
    while (start < total) {
        const end = Math.min(total, start + max);
        result.push({ index: result.length + 1, startSeconds: start, endSeconds: end, seconds: roundSeconds(end - start), ...(end < total ? { boundaryKind: "beat" as const } : {}) });
        start = end;
    }
    return result;
}

function positiveSeconds(value: number) {
    return Number.isFinite(Number(value)) && Number(value) > 0 ? roundSeconds(Number(value)) : 0;
}

function roundSeconds(value: number) {
    return Math.round(value * 100) / 100;
}

function formatSecond(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = value - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}
