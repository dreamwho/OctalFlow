import { describe, expect, it } from "vitest";

import { creativeComposerPopoverOverflow, creativeComposerPopoverPanelMaxHeight, resolveCreativeComposerPopoverPlacement, resolveCreativeComposerPopoverViewportLayout } from "@/components/creative-composer-popover";

describe("creative composer popover positioning", () => {
    it("keeps the preferred desktop direction while allowing viewport flipping", () => {
        expect(resolveCreativeComposerPopoverPlacement("bottomLeft", false)).toBe("bottomLeft");
        expect(creativeComposerPopoverOverflow("bottomLeft")).toEqual({ adjustX: 1, adjustY: 1 });
    });

    it("centers narrow popovers and keeps both axes inside the viewport", () => {
        expect(resolveCreativeComposerPopoverPlacement("bottomLeft", true)).toBe("bottom");
        expect(resolveCreativeComposerPopoverPlacement("topLeft", true)).toBe("top");
        expect(resolveCreativeComposerPopoverPlacement("topRight", true)).toBe("top");
        expect(resolveCreativeComposerPopoverPlacement("bottomRight", true)).toBe("bottom");
        expect(creativeComposerPopoverOverflow("bottom")).toEqual({ adjustX: 1, adjustY: 1 });
    });

    it("limits a panel to the actual space beside its trigger", () => {
        expect(creativeComposerPopoverPanelMaxHeight("bottom", { top: 280, bottom: 320 }, { top: 0, bottom: 844 }, 520)).toBe(500);
        expect(creativeComposerPopoverPanelMaxHeight("top", { top: 280, bottom: 320 }, { top: 20, bottom: 844 }, 520)).toBe(236);
    });

    it("opens below a top-edge trigger when the full panel fits there", () => {
        expect(resolveCreativeComposerPopoverViewportLayout("topLeft", { top: 228, bottom: 264 }, { top: 0, bottom: 791 }, 381, 520)).toEqual({
            placement: "bottomLeft",
            maxHeight: 503,
            topHeight: 204,
            bottomHeight: 503,
        });
    });

    it("uses the roomier side and limits height only when neither side fits", () => {
        expect(resolveCreativeComposerPopoverViewportLayout("bottomRight", { top: 390, bottom: 430 }, { top: 20, bottom: 760 }, 520, 520)).toEqual({
            placement: "topRight",
            maxHeight: 346,
            topHeight: 346,
            bottomHeight: 306,
        });
    });
});
