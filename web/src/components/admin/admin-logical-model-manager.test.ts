import { describe, expect, it } from "vitest";

import { parseCommaSeparatedValues } from "./admin-logical-model-manager";

describe("logical model capability list input", () => {
    it("keeps comma-separated text parseable while removing blank and duplicate values on save", () => {
        expect(parseCommaSeparatedValues("1024x1024, ,16:9，16:9, 9:16,, ")).toEqual(["1024x1024", "16:9", "9:16"]);
        expect(parseCommaSeparatedValues("480p, 720p，1080p,720p")).toEqual(["480p", "720p", "1080p"]);
    });

    it("clears the saved list when the input is cleared", () => {
        expect(parseCommaSeparatedValues("")).toEqual([]);
        expect(parseCommaSeparatedValues(" , ， ")).toEqual([]);
    });
});
