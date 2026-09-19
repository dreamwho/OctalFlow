import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("Canvas model parameter popover variants", () => {
    it("uses the Canvas-only image and video panels without changing the shared control contract", () => {
        const image = source("canvas-image-settings-popover.tsx");
        const video = source("canvas-video-settings-popover.tsx");
        const shared = readFileSync(new URL("../../../../components/creative-generation-preferences.tsx", import.meta.url), "utf8");

        expect(image).toContain('title: "图片生成参数"');
        expect(image).toContain('ratioGridClassName="grid-cols-3"');
        expect(video).toContain('title: "视频生成参数"');
        expect(video).toContain('ratioGridClassName="grid-cols-2 sm:grid-cols-4"');
        expect(video).toContain("CanvasVideoReferenceSettings");
        expect(shared).toContain("export type CanvasGenerationPanel");
        expect(shared).toContain('aria-label="关闭参数设置"');
        expect(shared).toContain('canvasPanel.applyLabel || "应用"');
    });

    it("keeps the audio provider branches inside the Canvas shell", () => {
        const audio = source("canvas-audio-settings-popover.tsx");
        const shell = source("canvas-settings-popover-shell.tsx");

        expect(audio).toContain("<AudioSettingsPanel");
        expect(audio).toContain('title: "音频模型参数设置"');
        expect(audio).toContain("autoOpenVoiceModal");
        expect(shell).toContain("panelMaxHeight");
        expect(shell).toContain('CanvasSettingsPopoverShellProps["canvasPanel"]');
        expect(shell).toContain('<DreamyoIcon name="audio" size={18} />');
    });
});
