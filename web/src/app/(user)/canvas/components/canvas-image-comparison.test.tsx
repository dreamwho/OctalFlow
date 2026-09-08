import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasImageComparison, clampImageComparisonSplit, sourceImageComparisonClip } from "./canvas-image-comparison";

describe("Canvas image comparison", () => {
    it("clamps the draggable divider away from both image edges", () => {
        const rect = { left: 100, width: 400 } as DOMRect;

        expect(clampImageComparisonSplit(20, rect)).toBe(4);
        expect(clampImageComparisonSplit(300, rect)).toBe(50);
        expect(clampImageComparisonSplit(800, rect)).toBe(96);
    });

    it("keeps the original image on the left side of the divider", () => {
        expect(sourceImageComparisonClip(50)).toBe("inset(0 50% 0 0)");
        expect(sourceImageComparisonClip(72)).toBe("inset(0 28% 0 0)");
    });

    it("renders a node-safe original comparison trigger with explicit source and result identities", () => {
        const markup = renderToStaticMarkup(<CanvasImageComparison sourceUrl="/api/reference-assets/original.png" resultUrl="/api/reference-assets/upscaled.png" alt="高清图片" fill />);

        expect(markup).toContain("data-canvas-image-comparison");
        expect(markup).toContain("data-canvas-image-comparison-result");
        expect(markup).toContain("data-canvas-no-drag");
        expect(markup).toContain('title="对比原图"');
    });
});
