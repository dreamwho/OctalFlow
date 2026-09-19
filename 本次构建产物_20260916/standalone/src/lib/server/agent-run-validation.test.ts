import { describe, expect, it } from "vitest";
import {
    agentChildTaskTerminal,
    agentTaskCopies,
    resolveAgentTaskCount,
    resolveAgentVideoSeconds,
    segmentSkillStoryboardVideoTasks,
    stageStoryboardAgentTasks,
    validateAgentPlan,
    validateAgentPlanGenerationMode,
    validateAgentTaskResult,
} from "./agent-run-validation";

describe("validateAgentPlan", () => {
    it("accepts a bounded executable plan", () => {
        expect(() => validateAgentPlan({ objective: "商品发布", deliverables: [{ title: "主图", type: "image", prompt: "生成商品主图" }] })).not.toThrow();
    });

    it("accepts a direct conversation reply without deliverables", () => {
        expect(() => validateAgentPlan({ intent: "conversation", objective: "回答用户", reply: "在的，你可以直接告诉我需要什么。", decisions: [], deliverables: [] })).not.toThrow();
        expect(() => validateAgentPlan({ intent: "conversation", objective: "回答用户", reply: "", deliverables: [] })).toThrow("对话结果无效");
    });

    it("accepts a project handoff without new deliverables", () => {
        expect(() => validateAgentPlan({ intent: "generation", objective: "建立短剧项目", projectHandoff: { surface: "drama", title: "都市悬疑", ratio: "9:16", assetIds: ["asset-one"] }, deliverables: [] })).not.toThrow();
        expect(() => validateAgentPlan({ intent: "generation", objective: "建立项目", projectHandoff: { surface: "drama", title: "" }, deliverables: [] })).toThrow("项目交接参数无效");
    });

    it("rejects empty plans without imposing a fixed deliverable count", () => {
        expect(() => validateAgentPlan({ objective: "", deliverables: [] })).toThrow();
        expect(() => validateAgentPlan({ objective: "批量生成", deliverables: Array.from({ length: 51 }, (_, index) => ({ title: String(index), type: "image", prompt: "图" })) })).not.toThrow();
        expect(() => validateAgentPlan({ objective: "批量生成", deliverables: [{ title: "主图", type: "image", prompt: "图", count: Number.MAX_SAFE_INTEGER + 1 }] })).toThrow("任务参数无效");
    });

    it("accepts valid dependencies and rejects unknown ones", () => {
        expect(() =>
            validateAgentPlan({
                objective: "发布",
                deliverables: [
                    { id: "copy", title: "文案", type: "text", prompt: "写文案" },
                    { id: "image", targetNodeId: "existing-image", title: "主图", type: "image", prompt: "做图", dependencies: ["copy"] },
                ],
            }),
        ).not.toThrow();
        expect(() => validateAgentPlan({ objective: "发布", deliverables: [{ id: "image", title: "主图", type: "image", prompt: "做图", dependencies: ["missing"] }] })).toThrow("任务依赖无效");
    });

    it("rejects self and multi-task dependency cycles", () => {
        expect(() => validateAgentPlan({ objective: "发布", deliverables: [{ id: "image", title: "主图", type: "image", prompt: "做图", dependencies: ["image"] }] })).toThrow("任务依赖存在循环");
        expect(() =>
            validateAgentPlan({
                objective: "发布",
                deliverables: [
                    { id: "copy", title: "文案", type: "text", prompt: "写文案", dependencies: ["image"] },
                    { id: "image", title: "主图", type: "image", prompt: "做图", dependencies: ["copy"] },
                ],
            }),
        ).toThrow("任务依赖存在循环");
    });

    it("accepts model choices and validates visible decision summaries", () => {
        expect(() =>
            validateAgentPlan({
                objective: "发布会视觉",
                reply: "建议先生成横版主视觉。",
                decisions: [{ label: "画幅", value: "16:9", reason: "容纳舞台和观众" }],
                deliverables: [{ title: "主视觉", type: "image", model: "image-pro", prompt: "生成发布会主视觉" }],
            }),
        ).not.toThrow();
        expect(() => validateAgentPlan({ objective: "发布会视觉", decisions: [{ label: "", value: "16:9", reason: "原因" }], deliverables: [{ title: "主视觉", type: "image", prompt: "生成" }] })).toThrow("决策摘要无效");
    });

    it("rejects duplicate task ids", () => {
        expect(() =>
            validateAgentPlan({
                objective: "发布",
                deliverables: [
                    { id: "same", title: "A", type: "text", prompt: "A" },
                    { id: "same", title: "B", type: "image", prompt: "B" },
                ],
            }),
        ).toThrow("任务依赖无效");
    });

    it("keeps explicit media mode limited to final media and its image prerequisites", () => {
        const foundation = { complexity: "simple" as const, brief: { objective: "生成视频" }, direction: { summary: "视频创作" } };

        expect(() => validateAgentPlanGenerationMode({ objective: "商品视频", foundation, deliverables: [{ title: "视频", type: "video", prompt: "生成视频" }] }, "video")).not.toThrow();
        expect(() =>
            validateAgentPlanGenerationMode(
                {
                    objective: "分镜视频",
                    foundation,
                    deliverables: [
                        { id: "storyboard", title: "分镜图", type: "image", prompt: "生成竖版分镜" },
                        { id: "video", title: "视频", type: "video", prompt: "生成视频", dependencies: ["storyboard"] },
                    ],
                },
                "video",
            ),
        ).not.toThrow();
        expect(() => validateAgentPlanGenerationMode({ intent: "conversation", objective: "回答", reply: "你好", foundation, deliverables: [] }, "video")).toThrow("创作类型与用户选择不一致");
        expect(() =>
            validateAgentPlanGenerationMode(
                {
                    objective: "混合产物",
                    foundation,
                    deliverables: [
                        { title: "视频", type: "video", prompt: "生成视频" },
                        { title: "旁白", type: "audio", prompt: "生成旁白" },
                    ],
                },
                "video",
            ),
        ).toThrow("创作类型与用户选择不一致");
    });

    it("keeps valid media from a partially successful provider batch", () => {
        expect(() => validateAgentTaskResult("image", { results: [{ url: "https://example.com/1.png" }, { dataUrl: "data:image/png;base64,AA==" }] })).not.toThrow();
        expect(() => validateAgentTaskResult("image", { results: [{ url: "https://example.com/1.png" }, {}] })).not.toThrow();
        expect(() => validateAgentTaskResult("image", { results: [{}, { error: "第二张失败" }] })).toThrow("没有返回有效产物");
    });

    it("runs the configured number of image and video copies", () => {
        expect(agentTaskCopies("image", 4)).toBe(4);
        expect(agentTaskCopies("image", 99)).toBe(99);
        expect(agentTaskCopies("video", 4)).toBe(4);
    });

    it("uses plan, skill, then canvas image count defaults", () => {
        expect(resolveAgentTaskCount("image", 3, 4, 5)).toBe(3);
        expect(resolveAgentTaskCount("image", undefined, 4, 5)).toBe(4);
        expect(resolveAgentTaskCount("image", undefined, undefined, 5)).toBe(5);
        expect(resolveAgentTaskCount("video", 3, 4, 5)).toBe(3);
    });

    it("recognizes child cancellation as a terminal state", () => {
        expect(agentChildTaskTerminal("cancelled")).toBe("cancelled");
        expect(agentChildTaskTerminal("canceled")).toBe("cancelled");
        expect(agentChildTaskTerminal("running")).toBeNull();
    });

    it("keeps Agent video duration aligned with the real video task range", () => {
        expect(resolveAgentVideoSeconds("video", "5", undefined, 10)).toBe(5);
        expect(resolveAgentVideoSeconds("video", 60, 10, 5)).toBe(60);
        expect(resolveAgentVideoSeconds("video", undefined, 10, 5)).toBe(10);
        expect(resolveAgentVideoSeconds("video", undefined, undefined, 6)).toBe(6);
        expect(resolveAgentVideoSeconds("image", 10, 10, 10)).toBeUndefined();
    });

    it("holds every storyboard video until the complete image batch is ready", () => {
        const tasks = stageStoryboardAgentTasks([
            { id: "image-1", title: "分镜 1", type: "image", prompt: "图", count: 1, dependencies: [], status: "ready", attempts: 0 },
            { id: "video-1", title: "视频 1", type: "video", prompt: "视频", count: 1, dependencies: ["image-1"], status: "ready", attempts: 0 },
            { id: "image-2", title: "分镜 2", type: "image", prompt: "图", count: 1, dependencies: [], status: "ready", attempts: 0 },
            { id: "video-2", title: "视频 2", type: "video", prompt: "视频", count: 1, dependencies: ["image-2"], status: "ready", attempts: 0 },
        ]);

        expect(tasks.map((task) => task.id)).toEqual(["image-1", "image-2", "video-1", "video-2"]);
        expect(tasks.filter((task) => task.type === "video").map((task) => task.stageDependencies)).toEqual([
            ["image-1", "image-2"],
            ["image-1", "image-2"],
        ]);
    });

    it("merges a 15-second Skill storyboard into one model-supported continuous video instead of one image per video", () => {
        const tasks = storyboardTasks([4, 4, 4, 3]);

        const normalized = segmentSkillStoryboardVideoTasks(tasks, {
            totalSeconds: 15,
            resolveCapability: () => ({ minSeconds: 4, maxSeconds: 15, maxReferenceImages: 9 }),
        });

        const videos = normalized.filter((task) => task.type === "video");
        expect(videos).toHaveLength(1);
        expect(videos[0]).toMatchObject({ seconds: 15, dependencies: ["image-1", "image-2", "image-3", "image-4"] });
    });

    it("treats a repeated manual Skill duration as the storyboard total rather than four per-shot durations", () => {
        const normalized = segmentSkillStoryboardVideoTasks(storyboardTasks([15, 15, 15, 15]), {
            totalSeconds: 15,
            resolveCapability: () => ({ minSeconds: 4, maxSeconds: 15, maxReferenceImages: 9 }),
        });

        expect(normalized.filter((task) => task.type === "video")).toEqual([expect.objectContaining({ seconds: 15, dependencies: ["image-1", "image-2", "image-3", "image-4"] })]);
    });

    it("uses explicit director scene transitions to make variable 45-second video segments", () => {
        const tasks = storyboardTasks(Array.from({ length: 9 }, () => 5)).map((task) => (task.id === "video-3" ? { ...task, title: "分镜视频 3｜转场：进入另一空间", prompt: "转场后进入另一空间，人物与新空间建立关系" } : task));

        const normalized = segmentSkillStoryboardVideoTasks(tasks, {
            totalSeconds: 45,
            resolveCapability: () => ({ minSeconds: 4, maxSeconds: 15, maxReferenceImages: 9 }),
        });

        const videos = normalized.filter((task) => task.type === "video");
        expect(videos.map((task) => task.seconds)).toEqual([10, 15, 15, 5]);
        expect(videos.map((task) => task.dependencies.length)).toEqual([2, 3, 3, 1]);
    });

    it("does not treat a generic scene word as a forced storyboard boundary", () => {
        const tasks = storyboardTasks(Array.from({ length: 9 }, () => 5)).map((task) => (task.type === "video" ? { ...task, title: `${task.title}｜场景 ${task.id}`, prompt: `镜头 ${task.id}，保持人物连续性` } : task));

        const normalized = segmentSkillStoryboardVideoTasks(tasks, {
            totalSeconds: 45,
            resolveCapability: () => ({ minSeconds: 4, maxSeconds: 15, maxReferenceImages: 9 }),
        });

        const videos = normalized.filter((task) => task.type === "video");
        expect(videos.map((task) => task.seconds)).toEqual([15, 15, 15]);
        expect(videos.map((task) => task.dependencies.length)).toEqual([3, 3, 3]);
    });

    it("keeps Skill video segments inside the selected model's min/max duration contract", () => {
        const tasks = storyboardTasks([4, 4, 4, 3]);

        const normalized = segmentSkillStoryboardVideoTasks(tasks, {
            totalSeconds: 15,
            resolveCapability: () => ({ minSeconds: 4, maxSeconds: 8, maxReferenceImages: 9 }),
        });

        const videos = normalized.filter((task) => task.type === "video");
        expect(videos.map((task) => task.seconds)).toEqual([8, 7]);
        expect(videos.every((task) => (task.seconds || 0) >= 4 && (task.seconds || 0) <= 8)).toBe(true);
    });

    it("emits only declared duration options for models with discrete video lengths", () => {
        const normalized = segmentSkillStoryboardVideoTasks(storyboardTasks([4, 4, 4, 3]), {
            totalSeconds: 15,
            resolveCapability: () => ({ minSeconds: 4, maxSeconds: 8, durationOptions: [4, 6, 8], maxReferenceImages: 9 }),
        });

        expect(normalized.filter((task) => task.type === "video").map((task) => task.seconds)).toEqual([8, 8]);
    });
});

function storyboardTasks(seconds: number[]) {
    return [
        ...seconds.map((_, index) => ({ id: `image-${index + 1}`, title: `分镜图 ${index + 1}`, type: "image" as const, prompt: `分镜 ${index + 1}`, count: 1, dependencies: [], status: "ready" as const, attempts: 0 })),
        ...seconds.map((duration, index) => ({
            id: `video-${index + 1}`,
            title: `分镜视频 ${index + 1}`,
            type: "video" as const,
            model: "video-pro",
            prompt: `镜头 ${index + 1}`,
            count: 1,
            seconds: duration,
            dependencies: [`image-${index + 1}`],
            status: "ready" as const,
            attempts: 0,
        })),
    ];
}
