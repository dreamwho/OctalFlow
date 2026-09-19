import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";

const mocks = vi.hoisted(() => ({ getServerMediaBlob: vi.fn() }));

vi.mock("@/services/server-media-storage", () => ({ getServerMediaBlob: mocks.getServerMediaBlob }));

import { prepareCanvasNodeDownload } from "./canvas-node-download";

describe("Canvas node download", () => {
    beforeEach(() => vi.clearAllMocks());

    it("reads a generated image through its authenticated same-origin media route before saving", async () => {
        mocks.getServerMediaBlob.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
        const node: CanvasNodeData = {
            id: "image-result",
            type: CanvasNodeType.Image,
            title: "图片生成",
            position: { x: 0, y: 0 },
            width: 340,
            height: 191,
            metadata: {
                content: "/api/generation-log-assets/permanent/2026/09/07/images/result.jpg?format=webp&width=1920",
                serverUrl: "/api/generation-log-assets/permanent/2026/09/07/images/result.jpg",
                storageKey: "permanent/2026/09/07/images/result.jpg",
                mimeType: "image/jpeg",
            },
        };

        const result = await prepareCanvasNodeDownload(node);

        expect(mocks.getServerMediaBlob).toHaveBeenCalledWith(node.metadata!.storageKey, node.metadata!.serverUrl);
        expect(result.blob).toMatchObject({ size: 4, type: "image/jpeg" });
        expect(result.fileName).toMatch(/\.jpg$/);
    });

    it("reports an unavailable media body instead of starting an invalid browser download", async () => {
        mocks.getServerMediaBlob.mockResolvedValue(null);
        const node: CanvasNodeData = {
            id: "missing",
            type: CanvasNodeType.Image,
            title: "图片生成",
            position: { x: 0, y: 0 },
            width: 340,
            height: 191,
            metadata: { content: "/api/generation-log-assets/permanent/missing.jpg", mimeType: "image/jpeg" },
        };

        await expect(prepareCanvasNodeDownload(node)).rejects.toThrow("媒体文件读取失败");
    });
});
