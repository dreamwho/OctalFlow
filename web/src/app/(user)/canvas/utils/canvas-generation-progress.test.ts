import { describe, expect, it } from "vitest";
import { canvasExpectedDuration, estimateCanvasProgress, stampCanvasGenerationStarts } from "./canvas-generation-progress";
import { CanvasNodeType, type CanvasNodeData } from "../types";

describe("Canvas estimated progress", () => {
    it("advances quickly then slows down without promising completion", () => {
        expect([0, 30, 60, 120, 300].map((seconds) => estimateCanvasProgress(seconds * 1000, "image").percent)).toEqual([1, 64, 90, 92, 94]);
        expect(estimateCanvasProgress(24 * 3600_000, "image")).toMatchObject({ percent: 95, waiting: true, elapsed: "1440:00" });
        expect(estimateCanvasProgress(-1000).percent).toBe(1);
        expect(estimateCanvasProgress(60_000, "text").percent).toBeGreaterThan(estimateCanvasProgress(60_000, "video").percent);
    });
    const node: CanvasNodeData = { id: "one", type: CanvasNodeType.Image, title: "one", position: { x: 0, y: 0 }, width: 340, height: 191, metadata: { status: "loading" } };
    it("calibrates to same-model median and ignores failed tasks and extreme outliers", () => {
        const history = [20_000, 35_000, 1_000_000].map((duration, index) => ({ ...node, id: `past-${index}`, metadata: { status: "success" as const, model: "fast", generationStartedAt: 1000, generationFinishedAt: 1000 + duration } }));
        history.push({ ...node, id: "other-model", metadata: { status: "success", model: "slow", generationStartedAt: 1000, generationFinishedAt: 601_000 } });
        const target = { ...node, metadata: { ...node.metadata, model: "fast" } };
        expect(canvasExpectedDuration(target, history)).toBe(35_000);
        expect(estimateCanvasProgress(35_000, "image", canvasExpectedDuration(target, history)).percent).toBe(90);
        const failed = { ...history[0], id: "failed", metadata: { ...history[0].metadata, status: "error" as const } };
        expect(canvasExpectedDuration(target, [...history, failed])).toBe(35_000);
    });
    it("records confirmed completion duration once and uses it for the next attempt", () => {
        const running = stampCanvasGenerationStarts([], [node], 1000);
        const finished = stampCanvasGenerationStarts(running, [{ ...running[0], metadata: { ...running[0].metadata, status: "success" } }], 21_000);
        expect(finished[0].metadata?.generationFinishedAt).toBe(21_000);
        expect(stampCanvasGenerationStarts(finished, finished, 99_000)).toBe(finished);
        const next = stampCanvasGenerationStarts(finished, [...finished, { ...node, id: "next" }], 22_000);
        expect(next[1].metadata?.generationExpectedMs).toBe(20_000);
        const restored = stampCanvasGenerationStarts([], [...finished, { ...node, id: "restored-pending" }], 24_000);
        expect(restored[1].metadata?.generationExpectedMs).toBe(20_000);
        const regenerated = stampCanvasGenerationStarts(finished, [{ ...finished[0], metadata: { ...finished[0].metadata, status: "loading" } }], 25_000);
        expect(regenerated[0].metadata).toMatchObject({ generationExpectedMs: 20_000, generationStartedAt: 25_000, generationFinishedAt: undefined });
    });
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
