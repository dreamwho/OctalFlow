import { describe, expect, it } from "vitest";

import { canvasThemes } from "./canvas-theme";

describe("canvas theme backgrounds", () => {
    it("uses a warm-white light workspace and a dark workspace", () => {
        expect(canvasThemes.light.canvas.background).toBe("#fbfbfd");
        expect(canvasThemes.light.canvas.backdrop).toBe("#fbfbfd");
        expect(canvasThemes.dark.canvas.background).toBe("#090b10");
        expect(canvasThemes.dark.canvas.backdrop).toBe("#090b10");
    });

    it("keeps the established cool blue-gray canvas palette", () => {
        expect(canvasThemes.light.node.fill).toBe("#f6f7fb");
        expect(canvasThemes.light.node.stroke).toBe("#e2e5ef");
        expect(canvasThemes.light.toolbar.itemHover).toBe("#f1f2ff");
        expect(canvasThemes.light.node.activeStroke).toBe("#5b5ce2");
        expect(canvasThemes.dark.node.fill).toBe("#111318");
        expect(canvasThemes.dark.node.activeStroke).toBe("#ffffff");
    });
});
