import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { publicNodePrompt } from "./canvas-node-prompt-panel";

const node = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id: "generated-media",
    type: CanvasNodeType.Image,
    title: "生成图片",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata,
});

describe("publicNodePrompt", () => {
    it("shows the public source prompt for a generated media node", () => {
        expect(publicNodePrompt(node({ content: "/generated.png", sourcePrompt: "用户可见的原始提示词", prompt: "执行提示词" }))).toBe("用户可见的原始提示词");
    });

    it("falls back to the persisted prompt without exposing a missing value", () => {
        expect(publicNodePrompt(node({ content: "/generated.mp4", prompt: "镜头缓慢推进" }))).toBe("镜头缓慢推进");
        expect(publicNodePrompt(node({ composerContent: "创建电影感分镜" }))).toBe("创建电影感分镜");
    });

    it("uses the bottom scene composer layout with editable prompt and generation summary", () => {
        const source = readFileSync(new URL("./canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
        expect(source).toContain("canvas-scene-composer");
        expect(source).toContain("场记编排台 · Composer");
        expect(source).toContain("data-testid=\"canvas-node-prompt-editor\"");
        expect(source).toContain("<SummaryRow label=\"参考素材\"");
        expect(source).toContain("xl:grid-cols-[220px_minmax(0,1fr)_250px]");
        expect(source).toContain("gap-y-1.5 text-xs leading-4");
        expect(source).toContain("data-canvas-composer-resize-handle");
        expect(source).toContain("role=\"separator\"");
        expect(source).toContain("resolvePromptComposerHeight");
    });

    it("renders media prompt editing as a canvas-level overlay instead of a node-attached panel", () => {
        const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
        expect(source).toContain("data-canvas-prompt-composer-overlay");
        expect(source).toContain("node.type === CanvasNodeType.Config");
        expect(source).toContain("composerOpen={promptComposerOpen}");
        expect(source).toContain("promptComposerHeight={promptComposerHeight}");
        expect(source).toContain("onHeightChange={setPromptComposerHeight}");
        expect(source).toContain("onClose={() => setDialogNodeId(null)}");
        const surface = readFileSync(new URL("./canvas-surface.tsx", import.meta.url), "utf8");
        expect(surface).toContain("data-canvas-focus-tether");
        expect(surface).toContain("resolvePromptComposerTether");
        expect(source).not.toContain("canvas-composer-tether pointer-events-none absolute");
    });
});
