import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Canvas interior design node panel", () => {
    it("keeps explicit control spacing and generation states", () => {
        const source = readFileSync(new URL("./canvas-interior-design-node-panel.tsx", import.meta.url), "utf8");
        const styles = readFileSync(new URL("../../../styles/global-generation-actions.css", import.meta.url), "utf8");

        expect(source).toContain("data-canvas-interior-generate");
        expect(source).toContain("data-canvas-interior-controls");
        expect(source).toContain("data-canvas-interior-parameter-row");
        expect(source).toContain("data-canvas-interior-actions");
        expect(source).toContain("style={{ gap: 8");
        expect(source).toContain('className="mt-2.5"');
        expect(source).toContain("<CanvasImageSettingsPopover");
        expect(source).toContain('compactTriggerLabel="模型参数"');
        expect(source).toContain("showTriggerChevron={false}");
        expect(source).toContain("w-full cursor-pointer items-center justify-center");
        expect(source).toContain("grid-cols-2");
        expect(source).toContain("!text-[11px]");
        expect(source).toContain('if (key === "size") return { size: value, sizeUserSelected: value !== "auto" };');
        expect(source).toContain('if (key === "quality") return { quality: value };');
        expect(source).toContain('if (key === "count") return { count: Math.max(1, Math.floor(Number(value) || 1)) };');
        expect(source).toContain("<GenerationActionButton");
        expect(source).toContain("running={isRunning}");
        expect(source).toContain("cancellable");
        expect(source).not.toContain("mt-auto");
        expect(source).toContain("停止生成");
        expect(source).toContain("canvas-interior-design-icon");
        expect(styles).toContain('.generation-action-button.ant-btn[data-state="disabled"]');
        expect(styles).toContain('.generation-action-button.ant-btn[data-tone="danger"]');
        expect(styles).toContain("linear-gradient(108deg, #5e7ff1 0%, #35cce1 52%, #58dec9 74%, #b9b3f7 100%)");
        expect(styles).toContain("prefers-reduced-motion: reduce");
    });
});
