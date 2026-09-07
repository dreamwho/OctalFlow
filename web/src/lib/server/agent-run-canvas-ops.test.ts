import { describe, expect, it } from "vitest";

import type { AgentRunTask } from "./agent-run-store";
import { layoutCanvasAgentTasks, planToOps, taskCanvasEventOps, taskResultOps } from "./agent-run-canvas-ops";

describe("Agent Canvas result operations", () => {
    it("lays out references, image work, and video work in stable stage columns", () => {
        const reference = [{ nodeId: "reference", url: "/reference.webp", type: "image" as const }];
        const tasks = layoutCanvasAgentTasks([imageTask({ id: "image-one", title: "分镜图一", count: 2, references: reference }), imageTask({ id: "image-two", title: "分镜图二", references: reference }), { ...imageTask({ id: "video-one", title: "分镜视频一", dependencies: ["image-two"], references: reference }), type: "video" as const }], {
            nodes: [
                { id: "reference", type: "image", title: "参考图", position: { x: 0, y: 96 }, width: 340, height: 240, metadata: { serverUrl: "/reference.webp" } },
                { id: "unrelated", type: "image", title: "历史节点", position: { x: 5000, y: 0 }, width: 340, height: 240, metadata: { serverUrl: "/older.webp" } },
            ],
        });
        const ops = planToOps({ foundation: { brief: { objective: "制作分镜" }, direction: {} } } as never, tasks, "run", {
            nodes: [
                { id: "reference", type: "image", title: "参考图", position: { x: 0, y: 96 }, width: 340, height: 240, metadata: { serverUrl: "/reference.webp" } },
                { id: "unrelated", type: "image", title: "历史节点", position: { x: 5000, y: 0 }, width: 340, height: 240, metadata: { serverUrl: "/older.webp" } },
            ],
        });
        const position = (id: string) => (ops.find((op) => op.type === "add_node" && op.id === id) as { position?: { x: number; y: number } } | undefined)?.position;

        expect(position("output-run-0-0")).toEqual({ x: 406, y: 96 });
        expect(position("output-run-0-1")).toEqual({ x: 406, y: 576 });
        expect(position("output-run-1-0")).toEqual({ x: 406, y: 1056 });
        expect(position("output-run-2-0")).toEqual({ x: 812, y: 1056 });
        expect(position("task-run-0")).toBeUndefined();
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "reference", toNodeId: "output-run-0-0" });
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "output-run-1-0", toNodeId: "output-run-2-0" });
        expect(position("brief-run")).toBeUndefined();
        expect(position("brand-run")).toBeUndefined();
    });

    it("creates additional nodes when one upstream task returns multiple images", () => {
        const task = imageTask({
            status: "completed",
            attempts: 1,
            taskId: "child-one",
            taskIds: ["child-one"],
            result: {
                results: [
                    { serverUrl: "/api/generation-log-assets/one.webp", width: 1600, height: 900 },
                    { serverUrl: "/api/generation-log-assets/two.webp", width: 900, height: 1600 },
                ],
            },
        });

        const output = taskResultOps("run", 0, task);

        expect(output.nodeIds).toEqual(["output-run-0-0", "output-run-0-1"]);
        expect(output.ops).toContainEqual(expect.objectContaining({ type: "update_node", id: "output-run-0-0", metadata: expect.objectContaining({ serverUrl: "/api/generation-log-assets/one.webp" }) }));
        expect(output.ops).toContainEqual(expect.objectContaining({ type: "add_node", id: "output-run-0-1", metadata: expect.objectContaining({ serverUrl: "/api/generation-log-assets/two.webp" }) }));
    });

    it("places portrait storyboard images horizontally and starts video on the next type row", () => {
        const reference = [{ nodeId: "reference", url: "/reference.webp", type: "image" as const }];
        const tasks = layoutCanvasAgentTasks(
            [
                ...Array.from({ length: 4 }, (_, index) => imageTask({ id: `shot-${index + 1}`, title: `分镜图 ${index + 1}`, ratio: "9:16", references: reference })),
                { ...imageTask({ id: "video", title: "分镜视频", type: "video", ratio: "9:16", dependencies: ["shot-1", "shot-2", "shot-3", "shot-4"], references: reference }), type: "video" as const },
            ],
            { nodes: [{ id: "reference", type: "image", title: "参考图", position: { x: 0, y: 96 }, width: 340, height: 240, metadata: { serverUrl: "/reference.webp" } }] },
        );
        const ops = planToOps({ foundation: { brief: { objective: "制作视频" }, direction: {} } } as never, tasks, "portrait", {
            nodes: [{ id: "reference", type: "image", title: "参考图", position: { x: 0, y: 96 }, width: 340, height: 240, metadata: { serverUrl: "/reference.webp" } }],
        });
        const position = (id: string) => (ops.find((op) => op.type === "add_node" && op.id === id) as { position?: { x: number; y: number } } | undefined)?.position;

        expect(position("output-portrait-0-0")).toEqual({ x: 406, y: 96 });
        expect(position("output-portrait-1-0")).toEqual({ x: 607, y: 96 });
        expect(position("output-portrait-2-0")).toEqual({ x: 808, y: 96 });
        expect(position("output-portrait-3-0")).toEqual({ x: 1009, y: 96 });
        expect(position("output-portrait-4-0")).toEqual({ x: 406, y: 402 });
    });

    it("accumulates each portrait node's real width before the next horizontal card", () => {
        const reference = [{ nodeId: "reference", url: "/reference.webp", type: "image" as const }];
        const tasks = layoutCanvasAgentTasks(
            [
                imageTask({ id: "nine-sixteen", ratio: "9:16", references: reference }),
                imageTask({ id: "three-four", ratio: "3:4", references: reference }),
                imageTask({ id: "two-three", ratio: "2:3", references: reference }),
                { ...imageTask({ id: "video", type: "video", ratio: "9:16", dependencies: ["nine-sixteen", "three-four", "two-three"], references: reference }), type: "video" as const },
            ],
            { nodes: [{ id: "reference", type: "image", title: "参考图", position: { x: 0, y: 96 }, width: 340, height: 240, metadata: { serverUrl: "/reference.webp" } }] },
        );
        const ops = planToOps({ foundation: { brief: { objective: "制作视频" }, direction: {} } } as never, tasks, "widths", { nodes: [{ id: "reference", type: "image", title: "参考图", position: { x: 0, y: 96 }, width: 340, height: 240, metadata: { serverUrl: "/reference.webp" } }] });
        const position = (id: string) => (ops.find((op) => op.type === "add_node" && op.id === id) as { position?: { x: number; y: number } } | undefined)?.position;

        expect(position("output-widths-0-0")).toEqual({ x: 406, y: 96 });
        expect(position("output-widths-1-0")).toEqual({ x: 607, y: 96 });
        expect(position("output-widths-2-0")).toEqual({ x: 853, y: 96 });
        expect(position("output-widths-3-0")).toEqual({ x: 406, y: 402 });
    });

    it("preserves every successful result when another child in the batch fails", () => {
        const task = imageTask({
            count: 2,
            status: "failed",
            attempts: 1,
            error: "部分图片生成失败",
            childTasks: [
                {
                    id: "child-success",
                    status: "completed",
                    attempt: 1,
                    result: { results: [{ serverUrl: "/one.webp" }, { serverUrl: "/two.webp" }] },
                },
                { id: "child-failed", status: "failed", attempt: 1, error: "第二个上游任务失败" },
            ],
        });

        const output = taskCanvasEventOps("run", 0, task, "task.failed");

        expect(output?.nodeIds).toEqual(["output-run-0-0", "output-run-0-1", "output-run-0-2"]);
        expect(output?.ops).toContainEqual(expect.objectContaining({ id: "output-run-0-0", metadata: expect.objectContaining({ status: "success", serverUrl: "/one.webp" }) }));
        expect(output?.ops).toContainEqual(expect.objectContaining({ id: "output-run-0-1", metadata: expect.objectContaining({ status: "success", serverUrl: "/two.webp" }) }));
        expect(output?.ops).toContainEqual(expect.objectContaining({ type: "add_node", id: "output-run-0-2", metadata: expect.objectContaining({ status: "error", errorDetails: "第二个上游任务失败" }) }));
    });
});

function imageTask(patch: Partial<AgentRunTask>): AgentRunTask {
    return {
        id: "image-task",
        title: "角色图",
        type: "image",
        prompt: "生成角色图",
        count: 1,
        dependencies: [],
        status: "ready",
        attempts: 0,
        ...patch,
    };
}
