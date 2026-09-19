import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Canvas active toolbar", () => {
    it("prioritizes a selected node toolbar over the generic dock", () => {
        const source = readFileSync(new URL("./canvas-client-page.tsx", import.meta.url), "utf8");

        expect(source).toContain("const activeToolbarNode = toolbarNode || selectedToolbarNode;");
        expect(source).toContain("const showCanvasToolbar = !activeToolbarNode && !promptComposerOpen && !agentReferencePicking;");
        expect(source).toContain("node={agentReferencePicking || isNodeDragging || nodeImageSettingsOpen ? null : activeToolbarNode}");
        expect(source).toContain("{showCanvasToolbar ? (");
    });
});
