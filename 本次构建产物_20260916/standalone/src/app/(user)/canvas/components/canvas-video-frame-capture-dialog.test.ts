import { describe, expect, it } from "vitest";

import { formatFrameTime, mergeCapturedFrames } from "./canvas-video-frame-capture-dialog";

const frame = (atMs: number, storageKey = `frame-${atMs}`) => ({ storageKey, serverUrl: `/frame/${atMs}`, mimeType: "image/jpeg", bytes: 1, width: 640, height: 360, atMs });

describe("Canvas video frame capture dialog", () => {
    it("deduplicates captures by timestamp and keeps chronological order", () => {
        expect(mergeCapturedFrames([frame(2_000), frame(0)], [frame(1_000), frame(2_000, "replacement")]).map((item) => [item.atMs, item.storageKey])).toEqual([
            [0, "frame-0"],
            [1_000, "frame-1000"],
            [2_000, "replacement"],
        ]);
    });

    it("formats the capture timeline with tenths", () => {
        expect(formatFrameTime(0)).toBe("0:00.0");
        expect(formatFrameTime(67_250)).toBe("1:07.3");
    });
});
