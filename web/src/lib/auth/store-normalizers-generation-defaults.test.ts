import { describe, expect, it } from "vitest";

import { normalizeGenerationConcurrency, normalizeGenerationDefaults } from "./store-normalizers";

describe("generation default normalization", () => {
    it("preserves administrator-defined video quality and positive duration", () => {
        expect(normalizeGenerationDefaults({ videoQuality: "1440", videoSeconds: 60, videoAnalysisModel: "gemini-video-review" })).toMatchObject({ videoQuality: "1440", videoSeconds: 60, videoAnalysisModel: "gemini-video-review" });
        expect(normalizeGenerationDefaults({ videoQuality: "2K", videoSeconds: -1 })).toMatchObject({ videoQuality: "2K", videoSeconds: -1 });
    });

    it("falls back only when the configured video duration is invalid", () => {
        expect(normalizeGenerationDefaults({ videoSeconds: 0 }).videoSeconds).toBe(5);
        expect(normalizeGenerationDefaults({ videoSeconds: 1.5 }).videoSeconds).toBe(5);
    });

    it("preserves administrator-defined positive concurrency without platform ceilings", () => {
        expect(normalizeGenerationConcurrency({ agent: 11, image: 12, video: 6, audio: 13, text: 21, render: 7, workerLanes: 4 })).toEqual({ agent: 11, image: 12, video: 6, audio: 13, text: 21, render: 7, workerLanes: 4 });
    });

    it("clamps the worker lane count into the 1-8 platform range", () => {
        expect(normalizeGenerationConcurrency({ workerLanes: 99 }).workerLanes).toBe(8);
        expect(normalizeGenerationConcurrency({ workerLanes: 0 }).workerLanes).toBe(4);
        expect(normalizeGenerationConcurrency({}).workerLanes).toBe(4);
    });
});
