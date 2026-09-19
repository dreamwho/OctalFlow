import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("global selection controls", () => {
    it("shares one luminous surface across custom and Ant Design selected states", async () => {
        const css = await readFile(resolve(process.cwd(), "src/app/styles/global-selection-controls.css"), "utf8");

        expect(css).toContain("--dreamyo-selection-surface:");
        expect(css).toContain(".dreamyo-selection-surface");
        expect(css).toContain('[role="tab"][aria-selected="true"]');
        expect(css).toContain(".ant-segmented .ant-segmented-item-selected");
        expect(css).toContain(".ant-select-item-option-selected");
        expect(css).toContain(".ant-table-row-selected");
    });

    it("covers switches, Ant sliders and every native range implementation", async () => {
        const [css, zoom, video, preview] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/styles/global-selection-controls.css"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-zoom-controls.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/create/components/creative-video-result.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-image-toolbar-settings-modal.tsx"), "utf8"),
        ]);

        expect(css).toContain(".ant-switch.ant-switch-checked");
        expect(css).toContain(".dreamyo-smart-switch.is-checked");
        expect(css).toContain(".ant-slider .ant-slider-track");
        expect(css).toContain(".dreamyo-native-range");
        expect(css).toContain(".dreamyo-media-range");
        expect(css).toContain(".dreamyo-preview-range");
        expect(zoom).toContain("dreamyo-native-range");
        expect(video).toContain("dreamyo-media-range");
        expect(preview).toContain("dreamyo-preview-range");
    });
});
