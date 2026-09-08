import { describe, expect, it } from "vitest";

import { canvasAgentMentionCandidates, canvasAgentMentionDraftAtCursor, canvasAgentReferenceAliases, type CanvasAgentMentionAsset } from "./canvas-agent-mention";

const assets: CanvasAgentMentionAsset[] = [
    { id: "reference-one", title: "人物全身图", type: "image", url: "/api/reference-assets/one.webp" },
    { id: "reference-two", title: "人物近景图", type: "image", url: "/api/reference-assets/two.webp" },
];

describe("Canvas Agent @ references", () => {
    it("matches selected references by their visible 图片 aliases", () => {
        const aliases = canvasAgentReferenceAliases(
            assets,
            assets.map((asset) => asset.id),
        );

        expect(canvasAgentMentionCandidates(assets, "图片2", aliases)).toEqual([assets[1]]);
    });

    it("does not reopen the picker when the caret is at a completed reference", () => {
        const aliases = canvasAgentReferenceAliases(
            assets,
            assets.map((asset) => asset.id),
        );

        expect(canvasAgentMentionDraftAtCursor("人物使用 @图片1", "人物使用 @图片1".length, aliases)).toBeUndefined();
        expect(canvasAgentMentionDraftAtCursor("人物使用 @图", "人物使用 @图".length, aliases)).toMatchObject({ query: "图" });
    });
});
