import { describe, expect, it } from "vitest";

import { VIDEO_REMAKE_SKILLS } from "./agent-skills/video-remake";
import { finalizeVideoRemakeTasks, isVideoRemakeComposeTask, normalizeVideoRemakePlan, planVideoRemakeSegments } from "./video-remake-orchestration";

describe("video remake orchestration", () => {
    it("prefers semantic boundaries while keeping every segment within 15 seconds", () => {
        const segments = planVideoRemakeSegments(45, [
            { atSeconds: 7, kind: "action_end" },
            { atSeconds: 15, kind: "hard_cut" },
            { atSeconds: 20, kind: "transition" },
            { atSeconds: 30, kind: "continuous_action" },
            { atSeconds: 39, kind: "hard_cut" },
        ]);
        expect(segments.every((segment) => segment.seconds <= 15)).toBe(true);
        expect(segments.reduce((sum, segment) => sum + segment.seconds, 0)).toBe(45);
        expect(segments.map((segment) => segment.endSeconds)).toContain(39);
    });

    it("adds replacement assets, chained H3 segments and final composition", () => {
        const plan = normalizeVideoRemakePlan(
            {
                objective: "复刻设计师 VLOG",
                foundation: { complexity: "complex", brief: { objective: "复刻设计师 VLOG" }, direction: { summary: "生活化电影感" } },
                deliverables: [{ id: "video", title: "完整 VLOG", type: "video", prompt: "A designer moves from studio to construction site.", seconds: 45, dependencies: [] }],
            },
            [VIDEO_REMAKE_SKILLS[1]],
            [{ id: "source", userId: "u", conversationId: "c", ordinal: 0, type: "video", status: "ready", title: "source", durationMs: 45_000, metadata: {}, createdAt: 1, updatedAt: 1 }],
            "设计师的一天 VLOG",
        );
        const videos = plan.deliverables.filter((item) => item.type === "video");
        expect(plan.deliverables.filter((item) => item.type === "image")).toHaveLength(2);
        expect(videos.at(-1)?.id).toBe("video-remake-final-compose");
        expect(videos.slice(0, -1).every((item) => Number(item.seconds) <= 15)).toBe(true);
        expect(videos[0].prompt).toContain("subject_definitions:");
        expect(videos[1].dependencies).toContain(videos[0].id);
    });

    it("uses detected source cuts and re-splits every oversized planned clip", () => {
        const plan = normalizeVideoRemakePlan(
            {
                objective: "复刻 36 秒视频",
                foundation: { complexity: "complex", brief: { objective: "复刻" }, direction: { summary: "原创替换" } },
                deliverables: [
                    { id: "a", title: "前半段", type: "video", prompt: "Opening sequence", seconds: 18 },
                    { id: "b", title: "后半段", type: "video", prompt: "Closing sequence", seconds: 18 },
                ],
            },
            [VIDEO_REMAKE_SKILLS[0]],
            [
                {
                    id: "source",
                    userId: "u",
                    conversationId: "c",
                    ordinal: 0,
                    type: "video",
                    status: "ready",
                    title: "source",
                    durationMs: 36_000,
                    metadata: { videoRemakeAnalysis: { boundaries: [{ atSeconds: 9, kind: "hard_cut" }, { atSeconds: 27, kind: "hard_cut" }] } },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            "复刻",
        );
        const clips = plan.deliverables.filter((item) => item.type === "video" && item.id !== "video-remake-final-compose");
        expect(clips).toHaveLength(4);
        expect(clips.map((item) => item.seconds)).toEqual([9, 9, 9, 9]);
        expect(clips.every((item) => Number(item.seconds) <= 15)).toBe(true);
        expect(clips[1].dependencies).not.toContain(clips[0].id);
        expect(clips[3].dependencies).not.toContain(clips[2].id);
    });

    it("marks only the synthetic final task as composition", () => {
        const tasks = finalizeVideoRemakeTasks(
            [
                { id: "segment", title: "片段", type: "video", model: "h3", prompt: "p", count: 1, dependencies: [], status: "ready", attempts: 0 },
                { id: "video-remake-final-compose", title: "成片", type: "video", model: "h3", prompt: "p", count: 1, dependencies: ["segment"], status: "ready", attempts: 0 },
            ],
            [VIDEO_REMAKE_SKILLS[0]],
        );
        expect(isVideoRemakeComposeTask(tasks[0])).toBe(false);
        expect(isVideoRemakeComposeTask(tasks[1])).toBe(true);
    });
});
