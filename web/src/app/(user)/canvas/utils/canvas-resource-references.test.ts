import { describe, expect, it } from "vitest";

import { buildNodeGenerationContext } from "../components/canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { buildNodeMentionReferences, getRegenerationSourceNodes } from "./canvas-resource-references";

const image = (id: string): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { content: `/api/reference-assets/${id}.png` },
});

const result = (id: string, type: CanvasNodeType): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 400, y: 0 },
    width: 320,
    height: 180,
    metadata: { content: type === CanvasNodeType.Text ? "已生成正文" : `/api/reference-assets/${id}`, prompt: "原提示词", status: "success", ...(type === CanvasNodeType.Text ? {} : { model: "generation-model" }) },
});

describe("canvas regeneration source references", () => {
    it.each([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text])("reuses the original input when a completed %s result is generated again", (type) => {
        const source = image("original-image");
        const output = result("completed-output", type);
        const connections: CanvasConnection[] = [{ id: "original-link", fromNodeId: source.id, toNodeId: output.id }];

        expect(getRegenerationSourceNodes(output, [source, output], connections).map((node) => node.id)).toEqual([source.id]);
    });

    it("keeps every original image when a completed video is generated again", () => {
        const first = image("first-image");
        const second = image("second-image");
        const video = result("completed-video", CanvasNodeType.Video);
        const laterConfig = { ...result("later-config", CanvasNodeType.Config), metadata: { composerContent: "其他任务" } };
        const nodes = [first, second, video, laterConfig];
        const connections: CanvasConnection[] = [
            { id: "first-link", fromNodeId: first.id, toNodeId: video.id },
            { id: "second-link", fromNodeId: second.id, toNodeId: video.id },
            { id: "later-link", fromNodeId: video.id, toNodeId: laterConfig.id },
        ];

        expect(getRegenerationSourceNodes(video, nodes, connections).map((node) => node.id)).toEqual([first.id, second.id]);
        expect(buildNodeGenerationContext(video.id, nodes, connections, "原提示词").referenceImages.map((reference) => reference.id)).toEqual([first.id, second.id]);
        expect(buildNodeMentionReferences(video, nodes, connections).filter((reference) => reference.active).map((reference) => reference.id)).toEqual([first.id, second.id]);
    });

    it("follows a configuration node back to its original references", () => {
        const source = image("original-image");
        const config: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 350, y: 0 }, width: 320, height: 180, metadata: { composerContent: "原提示词" } };
        const output = result("completed-output", CanvasNodeType.Image);
        const nodes = [source, config, output];
        const connections: CanvasConnection[] = [
            { id: "input", fromNodeId: source.id, toNodeId: config.id },
            { id: "output", fromNodeId: config.id, toNodeId: output.id },
        ];

        expect(getRegenerationSourceNodes(output, nodes, connections).map((node) => node.id)).toEqual([source.id]);
        expect(buildNodeGenerationContext(output.id, nodes, connections, "原提示词").referenceImages.map((reference) => reference.id)).toEqual([source.id]);
    });

    it("keeps an uploaded video as the direct source for a new generation", () => {
        const uploaded = { ...result("uploaded-video", CanvasNodeType.Video), metadata: { content: "/api/reference-assets/upload.mp4", status: "success" as const } };
        expect(getRegenerationSourceNodes(uploaded, [uploaded], [])).toEqual([uploaded]);
        expect(getRegenerationSourceNodes(result("text-only-video", CanvasNodeType.Video), [result("text-only-video", CanvasNodeType.Video)], [])).toEqual([]);
    });

    it("does not borrow references from a later configuration when the original result had none", () => {
        const video = result("text-only-video", CanvasNodeType.Video);
        const imageInput = image("later-image");
        const config: CanvasNodeData = { id: "later-config", type: CanvasNodeType.Config, title: "后续配置", position: { x: 400, y: 0 }, width: 320, height: 180, metadata: {} };
        const nodes = [video, imageInput, config];
        const connections: CanvasConnection[] = [
            { id: "video-to-config", fromNodeId: video.id, toNodeId: config.id },
            { id: "image-to-config", fromNodeId: imageInput.id, toNodeId: config.id },
        ];
        expect(getRegenerationSourceNodes(video, nodes, connections)).toEqual([]);
        expect(buildNodeGenerationContext(video.id, nodes, connections, "原提示词").referenceImages).toEqual([]);
    });
});
