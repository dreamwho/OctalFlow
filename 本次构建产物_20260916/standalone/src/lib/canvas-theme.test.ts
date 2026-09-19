import { describe, expect, it } from "vitest";

import { canvasSelectionBorderStyle, canvasSelectionGradient, canvasThemes } from "./canvas-theme";

describe("canvas theme backgrounds", () => {
    it("uses a warm-white light workspace and a dark workspace", () => {
        expect(canvasThemes.light.canvas.background).toBe("#f4f8ff");
        expect(canvasThemes.light.canvas.backdrop).toBe("#f4f8ff");
        expect(canvasThemes.dark.canvas.background).toBe("#080f20");
        expect(canvasThemes.dark.canvas.backdrop).toBe("#080f20");
    });

    it("keeps the established cool blue-gray canvas palette", () => {
        expect(canvasThemes.light.node.fill).toBe("#f8fbff");
        expect(canvasThemes.light.node.stroke).toBe("#d8e2f2");
        expect(canvasThemes.light.toolbar.itemHover).toBe("#edf5ff");
        expect(canvasThemes.light.node.activeStroke).toBe("#5e7ff1");
        expect(canvasThemes.dark.node.fill).toBe("#0e1c3a");
        expect(canvasThemes.dark.node.activeStroke).toBe("#35cce1");
    });

    it("shares the selected-node gradient and glow with canvas popovers", () => {
        const style = canvasSelectionBorderStyle(canvasThemes.dark.toolbar.panel);
        expect(canvasSelectionGradient).toContain("#35cce1");
        expect(canvasSelectionGradient).toContain("#5e7ff1");
        expect(canvasSelectionGradient).toContain("#b9b3f7");
        expect(style.border).toBe("1px solid transparent");
        expect(style.background).toContain(canvasSelectionGradient);
        expect(style.boxShadow).toContain("rgba(99,102,241,.28)");
    });
});
