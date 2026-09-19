import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { applyCanvasImageTaskResults } from "./canvas-image-task-results";

describe("canvas image task results", () => {
    it("keeps every upstream image and replays the same task idempotently", () => {
        const target: CanvasNodeData = {
            id: "target",
            type: CanvasNodeType.Image,
            title: "生成图片",
            position: { x: 0, y: 0 },
            width: 320,
            height: 320,
            metadata: { status: "loading", imageTask: { id: "task-one", kind: "edit", model: "image-model" } },
        };
        const input = {
            nodeId: target.id,
            taskId: "task-one",
            model: "image-model",
            size: "16:9",
            images: [
                { width: 1600, height: 900, metadata: { content: "/api/generation-log-assets/first.png", status: "success" as const } },
                { width: 900, height: 1600, metadata: { content: "/api/generation-log-assets/second.png", status: "success" as const } },
            ],
        };

        const first = applyCanvasImageTaskResults([target], input);
        const replay = applyCanvasImageTaskResults(first, input);

        expect(first).toHaveLength(2);
        expect(first[0]?.metadata).toMatchObject({ content: "/api/generation-log-assets/first.png", imageTask: undefined });
        expect(first[0]).toMatchObject({ width: 340, height: 191.25 });
        expect(first[1]).toMatchObject({ id: "image-result-task-one-2", metadata: { content: "/api/generation-log-assets/second.png" } });
        expect(first[1]).toMatchObject({ width: 135, height: 240 });
        expect(first[1]?.position.x).toBeGreaterThanOrEqual((first[0]?.position.x || 0) + (first[0]?.width || 0));
        expect(replay).toHaveLength(2);
    });

    it("keeps an interior design execution prompt private after task completion", () => {
        const target: CanvasNodeData = {
            id: "interior-output",
            type: CanvasNodeType.Image,
            title: "图片生成",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: {
                prompt: "SU直出摄影级照片",
                sourcePrompt: "SU直出摄影级照片",
                executionPrompt: '{"摄影参数":{"相机":"Hasselblad X2D 100C"}}',
                status: "loading",
                imageTask: { id: "interior-task", kind: "edit", model: "gemini-image" },
            },
        };

        const [completed] = applyCanvasImageTaskResults([target], {
            nodeId: target.id,
            taskId: "interior-task",
            model: "gemini-image",
            size: "16:9",
            prompt: "SU直出摄影级照片",
            images: [{ width: 1600, height: 900, metadata: { content: "/api/generation-log-assets/interior.png", status: "success" } }],
        });

        expect(completed?.metadata).toMatchObject({
            prompt: "SU直出摄影级照片",
            sourcePrompt: "SU直出摄影级照片",
            executionPrompt: '{"摄影参数":{"相机":"Hasselblad X2D 100C"}}',
            imageTask: undefined,
        });
        expect(completed?.metadata?.prompt).not.toContain("摄影参数");
    });
});
