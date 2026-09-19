import { describe, expect, it } from "vitest";

import { canvasFloatingMenuTransform, resolveCreateMenuOffset } from "./canvas-page-elements";

describe("canvas floating menus", () => {
    it("counter-scales world-space menus so their visual size remains fixed", () => {
        expect(canvasFloatingMenuTransform(1)).toBe("scale(1)");
        expect(canvasFloatingMenuTransform(0.25)).toBe("scale(4)");
        expect(canvasFloatingMenuTransform(2)).toBe("scale(0.5)");
    });

    it("keeps compact create menus clear of the header and bottom dock", () => {
        expect(resolveCreateMenuOffset({ left: 140, right: 364, top: 640, bottom: 980 }, 1280, 900)).toEqual({ x: 0, y: -172 });
        expect(resolveCreateMenuOffset({ left: -28, right: 196, top: 24, bottom: 364 }, 1280, 900)).toEqual({ x: 44, y: 48 });
    });
});
