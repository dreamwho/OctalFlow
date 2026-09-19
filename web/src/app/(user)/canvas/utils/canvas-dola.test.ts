import { describe, expect, it } from "vitest";

import { canvasDolaVideoProfile } from "./canvas-dola";

describe("Dola Canvas video profile", () => {
    it("exposes four durations for Seedance 2.5 and three for Fast", () => {
        expect(canvasDolaVideoProfile("dola-seedance-2-5")?.durations.map((item) => item.value)).toEqual([5, 10, 15, 30]);
        expect(canvasDolaVideoProfile("dola-seedance-2-0-fast")?.durations.map((item) => item.value)).toEqual([5, 10, 15]);
    });
    it("exposes the six verified ratios", () => {
        expect(canvasDolaVideoProfile("dola-seedance-2-5")?.ratios.map((item) => item.value)).toEqual(["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]);
    });
});

