import { describe, expect, it } from "vitest";

import { CanvasNodeType } from "@/app/(user)/canvas/types";
import { createWorkbenchCanvasNode } from "./image-video-workbench-utils";

describe("createWorkbenchCanvasNode", () => {
    it.each([
        { type: "image" as const, nodeType: CanvasNodeType.Image },
        { type: "video" as const, nodeType: CanvasNodeType.Video },
    ])("adds the selected $type media as a completed node and retains its stored-media identity", ({ type, nodeType }) => {
        const node = createWorkbenchCanvasNode({
            id: "media-node",
            asset: { type, url: "/api/media/preview", serverUrl: "/api/media/source", remoteUrl: "https://media.example/source", storageKey: "permanent/media/source", mimeType: `${type}/webp`, width: 1600, height: 900, bytes: 128 },
            prompt: "夜色中的城市",
            model: "model-one",
            size: "16:9",
        });

        expect(node).toMatchObject({
            id: "media-node",
            type: nodeType,
            width: 420,
            height: 236,
            metadata: {
                content: "/api/media/preview",
                serverUrl: "/api/media/source",
                remoteUrl: "https://media.example/source",
                storageKey: "permanent/media/source",
                naturalWidth: 1600,
                naturalHeight: 900,
                prompt: "夜色中的城市",
                model: "model-one",
                size: "16:9",
                status: "success",
            },
        });
    });
});
