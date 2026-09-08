import { describe, expect, it } from "vitest";
import { estimateCanvasProgress, stampCanvasGenerationStarts } from "./canvas-generation-progress";
import { CanvasNodeType, type CanvasNodeData } from "../types";

describe("Canvas estimated progress", () => {
    it("advances quickly then slows down without promising completion", () => {
        expect([0, 30, 60, 120, 300].map((seconds) => estimateCanvasProgress(seconds * 1000, "image").percent)).toEqual([1, 28, 48, 71, 92]);
        expect(estimateCanvasProgress(24 * 3600_000, "image")).toMatchObject({ percent: 95, waiting: true, elapsed: "1440:00" });
        expect(estimateCanvasProgress(-1000).percent).toBe(1);
        expect(estimateCanvasProgress(60_000, "text").percent).toBeGreaterThan(estimateCanvasProgress(60_000, "video").percent);
    });
    const node: CanvasNodeData = { id: "one", type: CanvasNodeType.Image, title: "one", position: { x: 0, y: 0 }, width: 340, height: 191, metadata: { status: "loading" } };
    it("persists one start time across updates and reloads but resets a failed retry", () => {
        const first = stampCanvasGenerationStarts([], [node], 1000);
        expect(first[0].metadata?.generationStartedAt).toBe(1000);
        expect(stampCanvasGenerationStarts(first, first, 2000)[0]).toBe(first[0]);
        expect(stampCanvasGenerationStarts([], first, 3000)[0]).toBe(first[0]);
        const failed = { ...first[0], metadata: { ...first[0].metadata, status: "error" as const, generationProgress: 60 } };
        const retry = stampCanvasGenerationStarts([failed], [{ ...failed, metadata: { ...failed.metadata, status: "loading" } }], 4000);
        expect(retry[0].metadata).toMatchObject({ generationStartedAt: 4000, generationProgress: undefined });
    });
});
