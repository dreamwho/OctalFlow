import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { publicNodePrompt, updateCanvasSelectedSkillIds } from "./canvas-node-prompt-panel";

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

    it("uses the compact bottom scene composer with inline references and controls", () => {
        const source = readFileSync(new URL("./canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
        expect(source).toContain("canvas-scene-composer");
        expect(source).toContain("data-canvas-composer-quick-tools");
        expect(source).toContain('data-testid="canvas-node-prompt-editor"');
        expect(source).not.toContain('shape="circle"');
        expect(source).toContain("CanvasPromptEditorHandle");
        expect(source).toContain("tokenSnapshot={promptTokenSnapshot}");
        expect(source).toContain("onTokenSnapshotChange={updatePromptTokenSnapshot}");
        expect(source).toContain("data-canvas-credit-cost");
        expect(source).toContain("<Coins className=\"size-3.5 shrink-0\" strokeWidth={2} />");
        expect(source).toContain("text-[13px] font-semibold tabular-nums text-white/95");
        expect(source).not.toContain("rgba(255, 255, 255, 0.15)");
        expect(source).not.toContain("<CreditSymbol");
        expect(source).toContain("onDoubleClick={stopCanvasInteraction}");
        expect(source).toContain("<GenerationActionButton");
        expect(source).toContain("box-border flex h-14 min-w-0 shrink-0 items-center");
        expect(source).toContain("flex-nowrap items-center");
        expect(source).toContain("overflow-x-auto overflow-y-hidden whitespace-nowrap");
        expect(source).toContain("!w-auto !shrink-0 !flex-nowrap !items-center !justify-start !overflow-hidden");
        expect(source).toContain("[&>span:last-child]:!inline-flex");
        expect(source).toContain("data-canvas-reference-picker");
        expect(source).toContain('trigger="click"');
        expect(source).toContain("参考{visibleReferences.length ?");
        expect(source).not.toContain("data-canvas-prompt-context");
        expect(source).toContain("aria-label={`插入 ${reference.label}`}");
        expect(source).toContain('<ReferencePreview reference={reference} fit="cover" />');
        expect(source).toContain('fit === "cover" ? "object-cover" : "object-contain"');
        expect(source).not.toContain(">生成设置<");
        expect(source).not.toContain(">引用素材<");
        expect(source).not.toContain("使用 / 插入引用");
        expect(source).not.toContain("data-canvas-composer-resize-handle");
        expect(source).not.toContain("场记编排台 · Composer");
        expect(source).toContain("listNodeAgentSkills(mode)");
        expect(source).toContain("eligibleSelectedSkillIds");
        expect(source).toContain("{ size: value, sizeUserSelected: true }");
        expect(source).not.toContain("listAgentSkills(mode)");
        expect(source).toContain("insertCameraMotionAtCursor");
        expect(source).toContain("cameraMotionPromptToken(motion)");
        expect(source).toContain("inlineTokens={cameraMotionTokens}");
        expect(source).toContain("cameraMotions: nextMotions");
        expect(source).toContain("value.includes(cameraMotionPromptToken(motion))");
        expect(source).not.toContain("cameraMotionPatch");
        expect(source).toContain("onOpen={capturePromptSelection}");
        expect(source).toContain("onSelect={insertSkillAtCursor}");
        expect(source).toContain("focusAt");
        expect(source).not.toContain("selectionStart");
        expect(source).not.toContain("setSelectionRange");

        const settingsRenderer = source.slice(source.indexOf("const renderModelAndSettings"), source.indexOf("const generateButton"));
        const videoSettingsBranch = settingsRenderer.slice(settingsRenderer.indexOf(') : mode === "video" ? ('), settingsRenderer.indexOf(') : mode === "audio" ?'));
        expect(videoSettingsBranch).not.toContain("<CanvasCameraControl");
        expect(videoSettingsBranch).not.toContain("<CanvasCameraMotionPicker");
    });

    it("renders media prompt editing as a canvas-level overlay instead of a node-attached panel", () => {
        const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
        expect(source).toContain("node.type === CanvasNodeType.Config");
        expect(source).toContain("composerOpen={promptComposerOpen}");
        expect(source).toContain("promptComposer={");
        const surface = readFileSync(new URL("./canvas-surface.tsx", import.meta.url), "utf8");
        expect(surface).toContain("resolvePromptComposerOverlay");
        expect(surface).toContain("data-canvas-prompt-composer-overlay");
        expect(surface).toContain("data-canvas-prompt-panel");
        expect(surface).not.toContain("data-canvas-focus-tether");
        expect(surface).not.toContain("resolvePromptComposerTether");
    });
});

describe("Canvas prompt Skill persistence", () => {
    it("deduplicates insertions and persists removal as an empty selection for remount round-trips", () => {
        const persisted: Array<string[] | undefined> = [];
        let selected = updateCanvasSelectedSkillIds([], "skill-natural-beauty", "add");
        persisted.push(selected.length ? selected : undefined);
        selected = updateCanvasSelectedSkillIds(selected, "skill-natural-beauty", "add");
        expect(selected).toEqual(["skill-natural-beauty"]);

        const remountedSelection = [...selected];
        selected = updateCanvasSelectedSkillIds(remountedSelection, "skill-natural-beauty", "remove");
        persisted.push(selected.length ? selected : undefined);

        expect(remountedSelection).toEqual(["skill-natural-beauty"]);
        expect(persisted).toEqual([["skill-natural-beauty"], undefined]);
        expect(selected).toEqual([]);
    });

    it("persists the selectedSkillIds patch from both inline insertion and atom removal", () => {
        const source = readFileSync(new URL("./canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
        expect(source).toContain("onConfigChange(node.id, { selectedSkillIds: normalized.length ? normalized : undefined })");
        expect(source).toContain("selectedSkillIdsRef.current");
        expect(source).toContain("onRemoveSkill={removeSkill}");
    });
});
