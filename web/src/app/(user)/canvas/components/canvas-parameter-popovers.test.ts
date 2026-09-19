import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("Canvas model parameter popover variants", () => {
    it("uses the Canvas-only image and video panels without changing the shared control contract", () => {
        const image = source("canvas-image-settings-popover.tsx");
        const video = source("canvas-video-settings-popover.tsx");
        const shared = readFileSync(new URL("../../../../components/creative-generation-preferences.tsx", import.meta.url), "utf8");

        expect(image).toContain('canvasPanel={{}}');
        expect(image).toContain('ratioGridClassName="grid-cols-3"');
        expect(video).toContain('canvasPanel={{}}');
        expect(video).toContain('ratioGridClassName="grid-cols-2 sm:grid-cols-4"');
        expect(video).toContain("CanvasVideoReferenceSettings");
        expect(shared).toContain("export type CanvasGenerationPanel");
        // 扁平紧凑：无头部标题区、无底部应用按钮，选项点击即生效
        expect(shared).not.toContain('canvasPanel.applyLabel || "应用"');
        expect(shared).not.toContain('aria-label="关闭参数设置"');
        expect(shared).toContain("w-[400px]");
    });

    it("keeps the audio provider branches inside the Canvas shell", () => {
        const audio = source("canvas-audio-settings-popover.tsx");
        const shell = source("canvas-settings-popover-shell.tsx");

        expect(audio).toContain("<AudioSettingsPanel");
        expect(audio).toContain("autoOpenVoiceModal");
        expect(audio).toContain("panelMaxHeight={620}");
        expect(shell).toContain("panelMaxHeight");
        expect(shell).toContain('CanvasSettingsPopoverShellProps["canvasPanel"]');
        expect(shell).toContain("viewport.bottom - buttonRect.top + gap");
        expect(shell).toContain('role={canvasPanel ? "dialog" : undefined}');
        expect(shell).not.toContain('aria-label="关闭参数设置"');
        expect(shell).not.toContain("应用参数设置");
    });
});
