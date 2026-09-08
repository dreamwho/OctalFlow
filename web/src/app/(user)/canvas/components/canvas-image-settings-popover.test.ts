import { describe, expect, it } from "vitest";

import { canvasImagePreferenceSummary } from "./canvas-image-settings-popover";

describe("Canvas GeminiAI image settings", () => {
    it("marks the GeminiAI quality tiers with their real output resolutions", () => {
        expect(canvasImagePreferenceSummary({ mode: "image", image: { size: "auto", quality: "medium", count: 1 } }, undefined, true)).toBe("Auto · 中·2K");
        expect(canvasImagePreferenceSummary({ mode: "image", image: { size: "9:16", quality: "high", count: 1 } }, undefined, true)).toBe("9:16 · 高·4K");
        expect(canvasImagePreferenceSummary({ mode: "image", image: { size: "3:4", quality: "medium", count: 1 } }, undefined, true)).toBe("3:4 · 中·2K");
        expect(canvasImagePreferenceSummary({ mode: "image", image: { size: "1:1", quality: "low", count: 2 } }, undefined, true)).toBe("1:1 · 低·1K · 2张");
    });

    it("uses the selected Dreamina resolution label", () => {
        expect(canvasImagePreferenceSummary({ mode: "image", image: { size: "4:3", quality: "low", count: 1 } }, undefined, false, [{ value: "low", label: "1.5K", shortLabel: "1.5K" }])).toBe("4:3 · 1.5K");
    });
});
