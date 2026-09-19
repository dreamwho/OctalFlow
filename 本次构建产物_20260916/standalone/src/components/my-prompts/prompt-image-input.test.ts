import { describe, expect, it } from "vitest";

import { PROMPT_COVER_MAX_BYTES, promptCoverFileError } from "./prompt-image-input";

describe("promptCoverFileError", () => {
    it("accepts supported non-empty image files", () => {
        expect(promptCoverFileError(new File(["image"], "cover.png", { type: "image/png" }))).toBe("");
    });

    it("rejects unsupported, empty and oversized files", () => {
        expect(promptCoverFileError(new File(["image"], "cover.svg", { type: "image/svg+xml" }))).toContain("PNG");
        expect(promptCoverFileError(new File([], "empty.png", { type: "image/png" }))).toContain("不能为空");
        expect(promptCoverFileError(new File([new Uint8Array(PROMPT_COVER_MAX_BYTES + 1)], "large.png", { type: "image/png" }))).toContain("20MB");
    });
});
