import { describe, expect, it } from "vitest";

import { canvasSelectionBorderStyle, canvasSelectionGradient, canvasThemes } from "./canvas-theme";

describe("canvas theme backgrounds", () => {
    it("uses a warm-white light workspace and a dark workspace", () => {
        expect(canvasThemes.light.canvas.background).toBe("#f5f8ff");
        expect(canvasThemes.light.canvas.backdrop).toBe("#f5f8ff");
        expect(canvasThemes.dark.canvas.background).toBe("#061326");
        expect(canvasThemes.dark.canvas.backdrop).toBe("#061326");
    });

    it("keeps the established cool blue-gray canvas palette", () => {
        expect(canvasThemes.light.node.fill).toBe("#f8fbff");
        expect(canvasThemes.light.node.stroke).toBe("#dfe7f3");
        expect(canvasThemes.light.toolbar.itemHover).toBe("#edf5ff");
        expect(canvasThemes.light.node.activeStroke).toBe("#2f6fff");
        expect(canvasThemes.dark.node.fill).toBe("#0d1b33");
        expect(canvasThemes.dark.node.activeStroke).toBe("#70d9ff");
    });

    it("shares the selected-node gradient and glow with canvas popovers", () => {
        const style = canvasSelectionBorderStyle(canvasThemes.dark.toolbar.panel);
        expect(canvasSelectionGradient).toContain("#67e8f9");
        expect(canvasSelectionGradient).toContain("#5f85ff");
        expect(canvasSelectionGradient).toContain("#8b7dff");
        expect(style.border).toBe("1px solid transparent");
        expect(style.background).toContain(canvasSelectionGradient);
        expect(style.boxShadow).toContain("rgba(47,111,255,.28)");
    });
});
