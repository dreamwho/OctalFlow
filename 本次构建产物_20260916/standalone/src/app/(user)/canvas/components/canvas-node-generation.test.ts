import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { buildNodeGenerationContext, buildNodeGenerationInputs } from "./canvas-node-generation";

describe("canvas node generation mentions", () => {
    it("uses the dragged-from image as input for a node created from either connection handle", () => {
        const source: CanvasNodeData = {
            id: "source",
            type: CanvasNodeType.Image,
            title: "原图",
            position: { x: 500, y: 0 },
            width: 340,
            height: 191,
            metadata: { content: "/api/reference-assets/permanent/source.jpg", storageKey: "permanent/source.jpg", mimeType: "image/jpeg" },
        };
        const created: CanvasNodeData = {
            id: "created",
            type: CanvasNodeType.Image,
            title: "图片生成",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: {},
        };

        expect(buildNodeGenerationInputs(created.id, [source, created], [{ id: "connection", fromNodeId: source.id, toNodeId: created.id }])).toMatchObject([{ nodeId: source.id, type: "image" }]);
    });

    it("binds a visible @ image mention to the real connected image", () => {
        const image: CanvasNodeData = {
            id: "image-source",
            type: CanvasNodeType.Image,
            title: "人物参考图",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { content: "data:image/png;base64,AAAA", mimeType: "image/png" },
        };
        const config: CanvasNodeData = {
            id: "config-target",
            type: CanvasNodeType.Config,
            title: "生成配置",
            position: { x: 400, y: 0 },
            width: 320,
            height: 220,
            metadata: { composerContent: "让@图片1保持人物并改成夜景" },
        };
        const connections: CanvasConnection[] = [{ id: "connection", fromNodeId: image.id, toNodeId: config.id }];

        const context = buildNodeGenerationContext(config.id, [image, config], connections, config.metadata!.composerContent!);

        expect(context.referenceImages).toHaveLength(1);
        expect(context.referenceImages[0].id).toBe(image.id);
        expect(context.prompt).toBe("让图片1保持人物并改成夜景");
    });

    it("uses the persisted tail frame for one direct video-to-video handoff instead of resubmitting the source video", () => {
        const source: CanvasNodeData = {
            id: "previous-shot",
            type: CanvasNodeType.Video,
            title: "上一镜头",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: {
                content: "/api/reference-assets/permanent/source.mp4",
                storageKey: "permanent/source.mp4",
                status: "success",
                videoFrameExtraction: {
                    sourceStorageKey: "permanent/source.mp4",
                    firstFrame: { nodeId: "previous-shot", title: "上一镜头首帧", source: "permanent/first.jpg", storageKey: "permanent/first.jpg" },
                    lastFrame: {
                        nodeId: "previous-shot",
                        title: "上一镜头尾帧",
                        source: "permanent/last.jpg",
                        storageKey: "permanent/last.jpg",
                        serverUrl: "/api/reference-assets/permanent/last.jpg",
                        previewUrl: "/api/reference-assets/permanent/last.jpg",
                        mimeType: "image/jpeg",
                    },
                },
            },
        };
        const target: CanvasNodeData = {
            id: "next-shot",
            type: CanvasNodeType.Video,
            title: "下一镜头",
            position: { x: 500, y: 0 },
            width: 320,
            height: 180,
            metadata: { status: "idle" },
        };

        const context = buildNodeGenerationContext(target.id, [source, target], [{ id: "handoff", fromNodeId: source.id, toNodeId: target.id }], "继续下一镜头");

        expect(context.referenceVideos).toEqual([]);
        expect(context.referenceImages).toMatchObject([{ storageKey: "permanent/last.jpg" }]);
        expect(context.continuityFirstFrame).toMatchObject({ nodeId: source.id, storageKey: "permanent/last.jpg" });
    });

    it("waits for a direct source tail frame instead of downgrading it to a normal video reference", () => {
        const source: CanvasNodeData = {
            id: "previous-shot",
            type: CanvasNodeType.Video,
            title: "上一镜头",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { content: "/api/reference-assets/permanent/source.mp4", storageKey: "permanent/source.mp4", status: "success" },
        };
        const target: CanvasNodeData = {
            id: "next-shot",
            type: CanvasNodeType.Video,
            title: "下一镜头",
            position: { x: 500, y: 0 },
            width: 320,
            height: 180,
            metadata: { status: "idle" },
        };

        const context = buildNodeGenerationContext(target.id, [source, target], [{ id: "handoff", fromNodeId: source.id, toNodeId: target.id }], "继续下一镜头");

        expect(context.continuityPending).toBe(true);
        expect(context.referenceVideos).toEqual([]);
        expect(context.referenceImages).toEqual([]);
    });

    it("does not infer continuity from mixed direct inputs", () => {
        const source: CanvasNodeData = {
            id: "previous-shot",
            type: CanvasNodeType.Video,
            title: "上一镜头",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { content: "/api/reference-assets/permanent/source.mp4", storageKey: "permanent/source.mp4", status: "success" },
        };
        const image: CanvasNodeData = {
            id: "style",
            type: CanvasNodeType.Image,
            title: "风格参考",
            position: { x: 0, y: 300 },
            width: 320,
            height: 180,
            metadata: { content: "data:image/png;base64,AAAA", mimeType: "image/png" },
        };
        const target: CanvasNodeData = {
            id: "next-shot",
            type: CanvasNodeType.Video,
            title: "下一镜头",
            position: { x: 500, y: 0 },
            width: 320,
            height: 180,
            metadata: { status: "idle" },
        };

        const context = buildNodeGenerationContext(
            target.id,
            [source, image, target],
            [
                { id: "video", fromNodeId: source.id, toNodeId: target.id },
                { id: "image", fromNodeId: image.id, toNodeId: target.id },
            ],
            "继续下一镜头",
        );

        expect(context.continuityFirstFrame).toBeUndefined();
        expect(context.continuityPending).toBe(false);
        expect(context.referenceVideos).toMatchObject([{ id: source.id }]);
        expect(context.referenceImages).toMatchObject([{ id: image.id }]);
    });
});
