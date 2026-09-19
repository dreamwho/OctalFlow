import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GenerationActionButton", () => {
    it("keeps one global generation CTA contract and complete motion states", () => {
        const source = readFileSync(new URL("./generation-action-button.tsx", import.meta.url), "utf8");
        const styles = readFileSync(new URL("../app/styles/global-generation-actions.css", import.meta.url), "utf8");
        const composer = readFileSync(new URL("../app/(user)/create/components/creative-composer.tsx", import.meta.url), "utf8");

        expect(source).toContain("data-generation-action");
        expect(source).toContain("data-state={state}");
        expect(source).toContain("data-appearance={appearance}");
        expect(source).toContain('"/brand/dreamyo/generation/generate-glyph.png"');
        expect(source).toContain('density?: "compact" | "standard"');
        expect(source).toContain("data-density={density}");
        expect(source).toContain("icon === undefined");
        expect(source).toContain("icon={actionIcon ?");
        expect(styles).toContain("prefers-reduced-motion: reduce");
        expect(styles).toContain('data-appearance="icon"');
        expect(styles).toContain("button-surface.png");
        expect(styles).toContain("linear-gradient(108deg, #5e7ff1 0%, #35cce1 52%, #58dec9 74%, #b9b3f7 100%)");
        expect(styles).toContain('data-density="compact"');
        expect(styles).toContain("min-height: 40px");
        expect(composer).not.toContain('shape="circle"');
        expect(composer).toContain('className="shrink-0"');
        const canvasConfigPanel = readFileSync(new URL("../app/(user)/canvas/components/canvas-config-node-panel.tsx", import.meta.url), "utf8");
        expect(canvasConfigPanel).toContain("data-canvas-credit-cost");
        expect(canvasConfigPanel).not.toContain("icon={null}");

        for (const relativePath of [
            "../app/(user)/canvas/components/canvas-config-node-panel.tsx",
            "../app/(user)/canvas/components/canvas-interior-design-node-panel.tsx",
            "../app/(user)/canvas/components/canvas-node-angle-dialog.tsx",
            "../app/(user)/canvas/components/canvas-node-mask-edit-dialog.tsx",
            "../app/(user)/canvas/components/canvas-node-prompt-panel.tsx",
            "../app/(user)/canvas/components/canvas-node-upscale-dialog.tsx",
            "../app/(user)/create/components/creative-composer.tsx",
            "../app/(user)/drama/[id]/drama-asset-editor-drawer.tsx",
            "../app/(user)/drama/[id]/drama-generation-panel.tsx",
            "../app/(user)/drama/[id]/drama-project-sections.tsx",
            "../app/(user)/drama/[id]/drama-review-panel.tsx",
            "../app/(user)/drama/[id]/drama-scene-structure.tsx",
        ]) {
            expect(readFileSync(new URL(relativePath, import.meta.url), "utf8")).toContain("GenerationActionButton");
        }
    });
});
