import { describe, expect, it } from "vitest";
import { MODEL_ICON_MAX_BYTES, normalizeModelIconUrl } from "./model-icons";

describe("uploaded model icons", () => {
    it.each(["png", "jpeg", "webp", "svg+xml", "x-icon", "vnd.microsoft.icon"])("accepts an uploaded %s image", (type) => {
        const url = `data:image/${type};base64,${Buffer.from("fixture").toString("base64")}`;
        expect(normalizeModelIconUrl(url)).toBe(url);
    });

    it.each([undefined, "", "javascript:alert(1)", "https://example.com/icon.png", "data:text/html;base64,YQ==", "data:image/png;base64,%%%", "data:image/png;base64,A"])("rejects invalid or non-uploaded icon %s", (value) => {
        expect(normalizeModelIconUrl(value)).toBeUndefined();
    });

    it("accepts the branding upload boundary and rejects oversized images without truncation", () => {
        const atBoundary = `data:image/png;base64,${Buffer.alloc(MODEL_ICON_MAX_BYTES).toString("base64")}`;
        expect(normalizeModelIconUrl(atBoundary)).toBe(atBoundary);
        expect(normalizeModelIconUrl(`data:image/png;base64,${Buffer.alloc(MODEL_ICON_MAX_BYTES + 1).toString("base64")}`)).toBeUndefined();
    });
});
