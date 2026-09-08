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
        expect(source).toContain("<Sparkles");
        expect(source).toContain("icon === undefined");
        expect(source).toContain("icon={actionIcon ?");
        expect(styles).toContain("generation-action-ready");
        expect(styles).toContain("generation-action-running");
        expect(styles).toContain("generation-action-sheen");
        expect(styles).toContain("prefers-reduced-motion: reduce");
        expect(styles).toContain('data-appearance="icon"');
        expect(styles).toContain("border-radius: 0.75rem !important");
        expect(styles).toContain("width: 3rem");
        expect(styles).toContain("height: 2.5rem");
        expect(composer).not.toContain('shape="circle"');
        expect(composer).toContain('className="shrink-0"');
        expect(readFileSync(new URL("../app/(user)/canvas/components/canvas-config-node-panel.tsx", import.meta.url), "utf8")).toContain("icon={null}");

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
