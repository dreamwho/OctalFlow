import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Canvas surface pane interactions", () => {
    it("closes node UI before preserving reference-picker selection on a real blank-pane click", () => {
        const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
        const surface = readFileSync(new URL("./canvas-surface.tsx", import.meta.url), "utf8");

        expect(page).toMatch(/onPaneClick=\{\(\) => \{[\s\S]*?setDialogNodeId\(null\);[\s\S]*?setContextMenu\(null\);[\s\S]*?if \(agentReferencePicking\) return;[\s\S]*?deselectCanvas\(\);/);
        expect(surface).toContain("if (event.button === 0 && !target?.closest");
        expect(surface).toContain("[data-canvas-node-prompt-panel],[data-canvas-upscale-panel]");
    });

    it("ends transient pointer interactions even when pointer capture or browser focus is lost", () => {
        const surface = readFileSync(new URL("./canvas-surface.tsx", import.meta.url), "utf8");

        expect(surface).toContain('window.addEventListener("mouseup", handleMouseUpFallback)');
        expect(surface).toContain('window.addEventListener("blur", cancelTransientInteraction)');
        expect(surface).toContain('document.addEventListener("visibilitychange", handleVisibilityChange)');
        expect(surface).toContain('surfaceRef.current?.addEventListener("lostpointercapture", cancelTransientInteraction)');
    });
});
