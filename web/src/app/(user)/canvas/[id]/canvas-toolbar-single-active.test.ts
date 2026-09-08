import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Canvas active toolbar", () => {
    it("hides the global canvas toolbar while a node toolbar or prompt panel is active", () => {
        const source = readFileSync(new URL("./canvas-client-page.tsx", import.meta.url), "utf8");

        expect(source).toContain("const showCanvasToolbar = !toolbarNode && !promptComposerOpen;");
        expect(source).toContain("{showCanvasToolbar ? (");
    });
});
