import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasNodeType, type CanvasAssistantSession, type CanvasNodeData } from "../types";
import { CANVAS_CONFIG_NODE_HEIGHT } from "../constants";
import { INTERIOR_DESIGN_NODE_SIZE } from "../utils/canvas-interior-design";

const mocks = vi.hoisted(() => ({
    readImageMeta: vi.fn(),
    resolveStoredImageDataUrl: vi.fn(),
    uploadImage: vi.fn(),
}));

vi.mock("@/lib/image-utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/image-utils")>()), readImageMeta: mocks.readImageMeta }));
vi.mock("@/services/image-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/image-storage")>()),
    resolveStoredImageDataUrl: mocks.resolveStoredImageDataUrl,
    uploadImage: mocks.uploadImage,
}));

import { applyNodeConfigPatch, getGenerationCount, hydrateAssistantImages, hydrateCanvasImages, isDreaminaUpscaleImageNode, normalizeCanvasConfigNodeLayout, normalizeConnection, normalizeCreatedNodeConnection, replaceCanvasNodeMediaMetadata, resolveDreaminaUpscaleSourceNode } from "./canvas-page-utils";

describe("Canvas project hydration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readImageMeta.mockResolvedValue({ width: 1024, height: 1024, mimeType: "image/png" });
        mocks.resolveStoredImageDataUrl.mockImplementation(async (storageKey: string) => {
            if (storageKey === "broken-image") throw new Error("media unavailable");
            return `/api/reference-assets/${storageKey}`;
        });
        mocks.uploadImage.mockRejectedValue(new Error("upload unavailable"));
    });

    it("keeps the rest of the Canvas usable when one persisted node media fails to hydrate", async () => {
        const valid = imageNode("valid", "valid-image");
        const broken = imageNode("broken", "broken-image");

        const result = await hydrateCanvasImages([valid, broken, textNode()]);

        expect(result).toHaveLength(3);
        expect(result[0]?.metadata?.content).toBe("/api/reference-assets/valid-image");
        expect(result[1]).toBe(broken);
        expect(result[2]?.type).toBe(CanvasNodeType.Text);
    });

    it("preserves individual assistant references that cannot be restored", async () => {
        const sessions: CanvasAssistantSession[] = [
            {
                id: "session",
                title: "会话",
                createdAt: "2026-07-31T00:00:00.000Z",
                updatedAt: "2026-07-31T00:00:00.000Z",
                messages: [
                    {
                        id: "message",
                        role: "user",
                        text: "参考这些素材",
                        references: [
                            { id: "valid", type: CanvasNodeType.Image, title: "正常", storageKey: "valid-image" },
                            { id: "broken", type: CanvasNodeType.Image, title: "失效", storageKey: "broken-image", dataUrl: "legacy-fallback" },
                        ],
                    },
                ],
            },
        ];

        const result = await hydrateAssistantImages(sessions);
        const references = result[0]?.messages[0]?.references;

        expect(references?.[0]?.dataUrl).toBe("/api/reference-assets/valid-image");
        expect(references?.[1]).toEqual(sessions[0]?.messages[0]?.references?.[1]);
    });
});

describe("Canvas connection direction", () => {
    const left = { ...textNode(), id: "left" };
    const right = { ...textNode(), id: "right", position: { x: 500, y: 0 } };

    it("keeps a right-handle connection flowing out of the clicked node", () => {
        expect(normalizeConnection(left.id, right.id, [left, right], "source")).toEqual({ fromNodeId: left.id, toNodeId: right.id });
    });

    it("makes a node created from the left handle flow into the clicked node", () => {
        expect(normalizeConnection(right.id, left.id, [left, right], "target")).toEqual({ fromNodeId: left.id, toNodeId: right.id });
    });

    it("keeps the dragged-from node as the reference when creating from its left handle", () => {
        expect(normalizeCreatedNodeConnection(right.id, left.id, [left, right])).toEqual({ fromNodeId: right.id, toNodeId: left.id });
    });
});

describe("Canvas config node layout", () => {
    it("keeps the persisted details state and node hit box in sync", () => {
        const collapsed = normalizeCanvasConfigNodeLayout(configNode(320));
        const expanded = applyNodeConfigPatch(collapsed, { configDetailsOpen: true });

        expect(collapsed).toMatchObject({ height: CANVAS_CONFIG_NODE_HEIGHT.collapsed, metadata: { configDetailsOpen: false } });
        expect(expanded).toMatchObject({ height: CANVAS_CONFIG_NODE_HEIGHT.expanded, metadata: { configDetailsOpen: true } });
    });

    it("restores interior design nodes to the regular image 1:1 size", () => {
        const node: CanvasNodeData = {
            ...configNode(180),
            width: 340,
            metadata: { configKind: "interior-design" },
        };

        expect(normalizeCanvasConfigNodeLayout(node)).toMatchObject({ width: INTERIOR_DESIGN_NODE_SIZE.width, height: INTERIOR_DESIGN_NODE_SIZE.height });
    });

    it("keeps administrator and upstream generation counts above the former platform ceiling", () => {
        expect(getGenerationCount("16")).toBe(16);
        expect(getGenerationCount("120")).toBe(120);
        expect(getGenerationCount("0")).toBe(1);
        expect(getGenerationCount("-2")).toBe(1);
    });
});

describe("Canvas media replacement", () => {
    it("removes stale generation state while preserving the new panorama contract", () => {
        const metadata = replaceCanvasNodeMediaMetadata(
            {
                prompt: "旧提示词",
                size: "1:1",
                videoTask: { id: "video-task", provider: "generation", model: "video-model" },
                imageTask: { id: "image-task", kind: "generation", model: "image-model" },
                isBatchRoot: true,
                batchChildIds: ["child"],
            },
            { content: "/api/reference-assets/panorama.webp", storageKey: "panorama.webp", naturalWidth: 2048, naturalHeight: 1024, status: "success" },
            { size: "2048x1024", panoramaProjection: "equirectangular" },
        );

        expect(metadata).toMatchObject({ content: "/api/reference-assets/panorama.webp", size: "2048x1024", panoramaProjection: "equirectangular", status: "success" });
        expect(metadata.prompt).toBeUndefined();
        expect(metadata.imageTask).toBeUndefined();
        expect(metadata.videoTask).toBeUndefined();
        expect(metadata.isBatchRoot).toBeUndefined();
        expect(metadata.batchChildIds).toBeUndefined();
    });
});

describe("Dreamina upscale node relationships", () => {
    it("recognizes a persisted CLI upscale result and resolves only its recorded source image", () => {
        const source = imageNode("source", "source-image");
        const result: CanvasNodeData = {
            ...imageNode("upscaled", "upscaled-image"),
            metadata: {
                content: "/legacy/upscaled.png",
                upscaleTask: { id: "task-1", provider: "dreamina-cli", model: "dreamina-image-upscale", resolutionType: "4k", sourceNodeId: source.id },
            },
        };
        const missingSource: CanvasNodeData = {
            ...result,
            metadata: { ...result.metadata!, upscaleTask: { ...result.metadata!.upscaleTask!, sourceNodeId: "missing" } },
        };

        expect(isDreaminaUpscaleImageNode(result)).toBe(true);
        expect(resolveDreaminaUpscaleSourceNode(result, [result, source])).toBe(source);
        expect(resolveDreaminaUpscaleSourceNode(missingSource, [result, source])).toBeNull();
    });
});

function imageNode(id: string, storageKey: string): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 320,
        metadata: { content: `/legacy/${id}.png`, storageKey, naturalWidth: 1024, naturalHeight: 1024 },
    };
}

function textNode(): CanvasNodeData {
    return { id: "text", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "内容" } };
}

function configNode(height: number): CanvasNodeData {
    return { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 0, y: 0 }, width: 340, height, metadata: { generationMode: "image" } };
}
