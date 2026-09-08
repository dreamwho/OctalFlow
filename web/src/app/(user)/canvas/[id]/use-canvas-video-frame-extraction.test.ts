import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { videoStorageKey } from "./use-canvas-video-frame-extraction";

function video(content: string, storageKey = "") {
    return {
        id: "video-one",
        type: CanvasNodeType.Video,
        title: "视频",
        position: { x: 0, y: 0 },
        width: 420,
        height: 236,
        metadata: { content, storageKey },
    } satisfies CanvasNodeData;
}

describe("videoStorageKey", () => {
    it("uses the explicit stable storage key first", () => {
        expect(videoStorageKey(video("/api/reference-assets/permanent/old.mp4", "permanent/new.mp4"))).toBe("permanent/new.mp4");
    });

    it("accepts both reference and generation media routes", () => {
        expect(videoStorageKey(video("/api/reference-assets/permanent/2026/09/08/video.mp4"))).toBe("permanent/2026/09/08/video.mp4");
        expect(videoStorageKey(video("/api/generation-log-assets/permanent/2026/09/08/video.mp4"))).toBe("permanent/2026/09/08/video.mp4");
    });
});
